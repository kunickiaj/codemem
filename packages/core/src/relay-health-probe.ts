import type { CoordinatorScope } from "./coordinator-store-contract.js";
import { decodeScopeCatalogue, decodeScopeMembers } from "./scope-membership-wire.js";

export type RelayHealthEndpoint = "catalogue" | "members";
/** The operator's clock source must account for rounding in its error bound. */
export interface RelayHealthClockStamp {
	readonly utcMs: number;
	readonly verified: boolean;
	readonly maxErrorMs: number;
	readonly resolutionMs: number;
}
export interface RelayHealthProbeOptions {
	readonly coordinatorOrigin: string;
	readonly groupId: string;
	readonly syntheticScopeId: string;
	readonly probeDeviceId: string;
	readonly clock: () => RelayHealthClockStamp;
	/** Normal enrolled-device v2 signing, including a fresh nonce for each exact URL. */
	readonly sign: (input: {
		url: string;
		method: "GET";
		body: Uint8Array;
	}) => Promise<Headers | Record<string, string>>;
	readonly fetch?: typeof fetch;
	readonly allowLoopbackHttpFixture?: boolean;
}
export interface RelayHealthProbeObservation {
	readonly endpoint: RelayHealthEndpoint;
	readonly completedAt: RelayHealthClockStamp;
	readonly durationMs: number;
	readonly outcome: "success" | "failure" | "denied";
}

export function verifiedRelayHealthTime(stamp: RelayHealthClockStamp): number | null {
	if (
		stamp.verified !== true ||
		!Number.isSafeInteger(stamp.utcMs) ||
		stamp.utcMs < 0 ||
		!Number.isFinite(stamp.maxErrorMs) ||
		stamp.maxErrorMs < 0 ||
		!Number.isFinite(stamp.resolutionMs) ||
		stamp.resolutionMs <= 0 ||
		stamp.maxErrorMs + stamp.resolutionMs > 5000
	)
		return null;
	return stamp.utcMs;
}

function requireProbeHeaders(response: Response): void {
	let headerBytes = 0;
	for (const [name, value] of response.headers) headerBytes += name.length + value.length;
	if (headerBytes > 8192 || !response.headers.get("content-type")?.startsWith("application/json"))
		throw new Error("relay_health_response_invalid");
}

async function readProbeResponse(
	response: Response,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	const reader = response.body?.getReader();
	if (!reader) throw new Error("relay_health_response_invalid");
	const bytes = new Uint8Array(64 * 1024);
	let size = 0;
	const cancel = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		requireProbeHeaders(response);
		while (true) {
			if (signal.aborted) throw new Error("relay_health_timeout");
			const { done, value } = await reader.read();
			if (signal.aborted) throw new Error("relay_health_timeout");
			if (done) break;
			if (size + value.byteLength > bytes.length) throw new Error("relay_health_response_large");
			bytes.set(value, size);
			size += value.byteLength;
		}
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
		);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("relay_health_response_invalid");
		return value as Record<string, unknown>;
	} finally {
		signal.removeEventListener("abort", cancel);
		cancel();
		reader.releaseLock();
	}
}

/** Internal producer. Observations are emitted only after the actual request finishes. */
function probeOrigin(options: RelayHealthProbeOptions): URL {
	const origin = new URL(options.coordinatorOrigin);
	const loopback = ["127.0.0.1", "[::1]"].includes(origin.hostname);
	if (
		origin.username ||
		origin.password ||
		origin.search ||
		origin.hash ||
		origin.pathname !== "/" ||
		(origin.protocol !== "https:" &&
			!(options.allowLoopbackHttpFixture && loopback && origin.protocol === "http:"))
	)
		throw new Error("relay_health_origin_invalid");
	return origin;
}

class HealthProbe {
	private readonly origin: URL;
	private scope: CoordinatorScope | undefined;
	constructor(
		private readonly options: RelayHealthProbeOptions,
		private readonly observe: (observation: RelayHealthProbeObservation) => void,
	) {
		this.options = Object.freeze({ ...options });
		this.origin = probeOrigin(options);
	}
	private validate(endpoint: RelayHealthEndpoint, payload: Record<string, unknown>): void {
		const options = this.options;
		if (endpoint === "catalogue") {
			this.scope = decodeScopeCatalogue(payload, options.groupId).find(
				(item) => item.scope_id === options.syntheticScopeId,
			);
			if (!this.scope) throw new Error("relay_health_scope_missing");
			return;
		}
		if (
			!decodeScopeMembers(payload, this.scope, options.groupId, options.syntheticScopeId).some(
				(member) => member.device_id === options.probeDeviceId,
			)
		)
			throw new Error("relay_health_member_missing");
	}
	private async fetchValidated(
		endpoint: RelayHealthEndpoint,
		url: URL,
		signal: AbortSignal,
	): Promise<RelayHealthProbeObservation["outcome"]> {
		const options = this.options;
		const headers = new Headers(
			await options.sign({ url: url.href, method: "GET", body: new Uint8Array() }),
		);
		if (
			headers.get("X-Opencode-Device") !== options.probeDeviceId ||
			!/^v2:[A-Za-z0-9+/]{86}==$/.test(headers.get("X-Opencode-Signature") ?? "") ||
			!/^\d{1,10}$/.test(headers.get("X-Opencode-Timestamp") ?? "") ||
			!/^[0-9a-f]{32}$/.test(headers.get("X-Opencode-Nonce") ?? "")
		)
			throw new Error("relay_health_probe_identity");
		if (signal.aborted) throw new Error("relay_health_timeout");
		const response = await (options.fetch ?? fetch)(url.href, {
			method: "GET",
			headers,
			redirect: "error",
			signal,
		});
		if (response.status !== 200) {
			void response.body?.cancel().catch(() => {});
			if (response.status === 401 || response.status === 403) return "denied";
			throw new Error("relay_health_status");
		}
		const payload = await readProbeResponse(response, signal);
		if (signal.aborted) throw new Error("relay_health_timeout");
		this.validate(endpoint, payload);
		return "success";
	}
	private async request(endpoint: RelayHealthEndpoint, signal?: AbortSignal): Promise<void> {
		const options = this.options;
		const url = new URL(
			endpoint === "catalogue"
				? "/v1/scopes"
				: `/v1/scopes/${encodeURIComponent(options.syntheticScopeId)}/members`,
			this.origin,
		);
		url.searchParams.set("group_id", options.groupId);
		const started = performance.now();
		const abort = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let outcome: RelayHealthProbeObservation["outcome"] = "failure";
		let stop = () => {};
		const expired = new Promise<never>((_, reject) => {
			stop = () => {
				abort.abort();
				reject(new Error("relay_health_timeout"));
			};
			timeout = setTimeout(stop, 3000);
			signal?.addEventListener("abort", stop, { once: true });
			if (signal?.aborted) stop();
		});
		try {
			outcome = await Promise.race([this.fetchValidated(endpoint, url, abort.signal), expired]);
		} catch {
			outcome = "failure";
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", stop);
			const durationMs = performance.now() - started;
			this.observe({
				endpoint,
				completedAt: options.clock(),
				durationMs,
				outcome: durationMs > 3000 ? "failure" : outcome,
			});
		}
	}
	async run(signal?: AbortSignal): Promise<void> {
		this.scope = undefined;
		if (!signal?.aborted) await this.request("catalogue", signal);
		if (!signal?.aborted) await this.request("members", signal);
		this.scope = undefined;
	}
}

export function createRelayHealthProbe(
	options: RelayHealthProbeOptions,
	observe: (observation: RelayHealthProbeObservation) => void,
): (signal?: AbortSignal) => Promise<void> {
	const probe = new HealthProbe(options, observe);
	return (signal) => probe.run(signal);
}
