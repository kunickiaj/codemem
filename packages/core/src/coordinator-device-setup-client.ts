import { normalizeCoordinatorAccountLinkOrigin } from "./coordinator-account-link-receiver.js";
import {
	readAccountLinkDevice,
	signAccountLinkRequest,
} from "./coordinator-account-link-signer.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { DeviceClaimBindingReceipt } from "./coordinator-device-claim-binding-contract.js";
import type { CoordinatorDeviceLocalEvidence } from "./coordinator-device-local.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

export interface CoordinatorDeviceSetupOptions {
	dbPath: string;
	keysDir?: string;
	coordinatorUrl: string;
	groupId: string;
	currentIdentityId: string;
	fetch?: typeof globalThis.fetch;
	signal?: AbortSignal;
}
export type CoordinatorDeviceSetupOutcome =
	| { kind: "ready" }
	| { kind: "complete" | "completed"; receipt: DeviceClaimBindingReceipt }
	| { kind: "requires_review" }
	| { kind: "connect_required" }
	| { kind: "unsupported"; cause: "coordinator_upgrade_required" }
	| { kind: "unknown"; cause: "completion_outcome_unknown" }
	| {
			kind: "unavailable";
			cause:
				| "device_unavailable"
				| "invalid_input"
				| "coordinator_unreachable"
				| "invalid_response"
				| "coordinator_rejected"
				| "rate_limited"
				| "coordinator_auth_schema_upgrade_required"
				| "coordinator_unavailable";
	  };
type FailureCause = Extract<CoordinatorDeviceSetupOutcome, { kind: "unavailable" }>["cause"];
interface Connection {
	options: CoordinatorDeviceSetupOptions;
	origin: string;
	device: CoordinatorDeviceLocalEvidence;
	keyId: string;
}
const ROOT = "/v1/auth/device-binding";
const unavailable = (cause: FailureCause): CoordinatorDeviceSetupOutcome => ({
	kind: "unavailable",
	cause,
});
const unknown = (): CoordinatorDeviceSetupOutcome => ({
	kind: "unknown",
	cause: "completion_outcome_unknown",
});
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function receipt(value: unknown, connection: Connection): DeviceClaimBindingReceipt | null {
	if (
		!record(value) ||
		Object.keys(value).length !== 8 ||
		!isAuthControllerId(value.binding_id) ||
		!isAuthControllerId(value.claim_id) ||
		!isAuthControllerId(value.coordinator_id) ||
		value.device_id !== connection.device.deviceId ||
		value.key_id !== connection.keyId ||
		value.identity_id !== connection.options.currentIdentityId ||
		typeof value.enrollment_count !== "number" ||
		!Number.isSafeInteger(value.enrollment_count) ||
		value.enrollment_count < 0 ||
		typeof value.bound_at !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.bound_at) ||
		!Number.isFinite(Date.parse(value.bound_at))
	)
		return null;
	return {
		bindingId: value.binding_id,
		claimId: value.claim_id,
		coordinatorId: value.coordinator_id,
		deviceId: connection.device.deviceId,
		keyId: connection.keyId,
		identityId: connection.options.currentIdentityId,
		enrollmentCount: value.enrollment_count,
		boundAt: value.bound_at,
	};
}

function decode(
	value: unknown,
	connection: Connection,
	method: "GET" | "POST",
): CoordinatorDeviceSetupOutcome {
	if (!record(value)) return unavailable("invalid_response");
	if (
		((value.kind === "ready" || value.kind === "connect_required") && method === "GET") ||
		value.kind === "requires_review"
	)
		return Object.keys(value).length === 1 ? { kind: value.kind } : unavailable("invalid_response");
	if (value.kind !== "complete" && !(value.kind === "completed" && method === "POST"))
		return unavailable("invalid_response");
	const parsed = receipt(value.receipt, connection);
	return parsed && Object.keys(value).length === 2
		? { kind: value.kind, receipt: parsed }
		: unavailable("invalid_response");
}

/** Race injected transports and streams too, because they may ignore AbortSignal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	let onAbort = () => {};
	try {
		const aborted = new Promise<never>((_, reject) => {
			onAbort = () => reject(new Error("Device setup stopped."));
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
		return await Promise.race([operation, aborted]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}
function discard(response: Response): void {
	void response.body?.cancel().catch(() => {});
}
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
	if (!response.body) throw new Error("Missing response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await abortable(reader.read(), signal);
			if (done) break;
			size += value.byteLength;
			if (size > 16_384) throw new Error("Response too large.");
			chunks.push(value);
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function httpFailure(
	response: Response,
	method: "GET" | "POST",
): CoordinatorDeviceSetupOutcome | null {
	if (response.status === 200) return null;
	if (method === "GET" && response.status === 404)
		return { kind: "unsupported", cause: "coordinator_upgrade_required" };
	if (
		response.status === 503 &&
		response.headers.get("X-Codemem-Auth-Error") === "coordinator_auth_schema_upgrade_required"
	)
		return unavailable("coordinator_auth_schema_upgrade_required");
	if (response.status === 429) return unavailable("rate_limited");
	if ([400, 401, 403, 409, 413, 415].includes(response.status))
		return unavailable("coordinator_rejected");
	return method === "POST" ? unknown() : unavailable("coordinator_unavailable");
}

function prepareRequest(connection: Connection, method: "GET" | "POST", signal: AbortSignal) {
	const { options, origin, device } = connection;
	const url = new URL(ROOT, origin);
	const input = { group_id: options.groupId, identity_id: options.currentIdentityId };
	if (method === "GET")
		for (const [key, value] of Object.entries(input)) url.searchParams.set(key, value);
	const body = method === "POST" ? Buffer.from(JSON.stringify(input)) : Buffer.alloc(0);
	try {
		const headers = signAccountLinkRequest({
			dbPath: options.dbPath,
			keysDir: options.keysDir,
			device,
			method,
			url: url.href,
			bodyBytes: body,
		});
		const init: RequestInit = {
			method,
			headers: { ...headers, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
			...(method === "POST" ? { body } : {}),
			redirect: "manual",
			signal,
		};
		return { url, init };
	} catch {
		return null;
	}
}

async function request(
	connection: Connection,
	method: "GET" | "POST",
): Promise<CoordinatorDeviceSetupOutcome> {
	const { options } = connection;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	const signal = options.signal
		? AbortSignal.any([controller.signal, options.signal])
		: controller.signal;
	let sent = false;
	let received = false;
	try {
		const prepared = prepareRequest(connection, method, signal);
		if (!prepared) return unavailable("device_unavailable");
		if (signal.aborted) return unavailable("coordinator_unreachable");
		sent = true;
		const pending = (options.fetch ?? globalThis.fetch)(prepared.url.href, prepared.init).then(
			(response) => {
				if (signal.aborted) discard(response);
				return response;
			},
		);
		const response = await abortable(pending, signal);
		received = true;
		const failure = httpFailure(response, method);
		if (failure) {
			discard(response);
			return failure;
		}
		const result = decode(await readJson(response, signal), connection, method);
		if (method === "POST" && result.kind === "unavailable") return unknown();
		return result;
	} catch {
		if (method === "POST" && sent) return unknown();
		return unavailable(
			!received || signal.aborted ? "coordinator_unreachable" : "invalid_response",
		);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

async function connect(
	value: CoordinatorDeviceSetupOptions,
): Promise<Connection | CoordinatorDeviceSetupOutcome> {
	const options: CoordinatorDeviceSetupOptions = {
		dbPath: value.dbPath,
		keysDir: value.keysDir,
		coordinatorUrl: value.coordinatorUrl,
		groupId: value.groupId,
		currentIdentityId: value.currentIdentityId,
		fetch: value.fetch ?? globalThis.fetch,
		signal: value.signal,
	};
	const origin = normalizeCoordinatorAccountLinkOrigin(options.coordinatorUrl);
	if (
		!origin ||
		!isAuthControllerId(options.groupId) ||
		!isAuthControllerId(options.currentIdentityId)
	)
		return unavailable("invalid_input");
	try {
		const device = readAccountLinkDevice(options.dbPath);
		const keyId = await ed25519KeyId(device.publicKey);
		if (!keyId) return unavailable("device_unavailable");
		return { options, origin, device, keyId };
	} catch {
		return unavailable("device_unavailable");
	}
}

/** Signed read only. A 404 means the route or its backend is unavailable. */
export async function readCoordinatorDeviceSetup(
	options: CoordinatorDeviceSetupOptions,
): Promise<CoordinatorDeviceSetupOutcome> {
	const connection = await connect(options);
	if ("kind" in connection) return connection;
	return request(connection, "GET");
}

/** Read before completing, including on a later invocation after an uncertain result.
 * An ambiguous POST is followed by a receipt read and never an automatic POST retry.
 */
export async function completeCoordinatorDeviceSetup(
	options: CoordinatorDeviceSetupOptions,
): Promise<CoordinatorDeviceSetupOutcome> {
	const connection = await connect(options);
	if ("kind" in connection) return connection;
	const readiness = await request(connection, "GET");
	if (readiness.kind !== "ready") return readiness;
	const result = await request(connection, "POST");
	const schemaFailure =
		result.kind === "unavailable" && result.cause === "coordinator_auth_schema_upgrade_required";
	if (result.kind !== "unknown" && !schemaFailure) return result;
	const recovered = await request(connection, "GET");
	if (recovered.kind === "complete") return recovered;
	if (
		schemaFailure &&
		recovered.kind === "unavailable" &&
		recovered.cause === "coordinator_auth_schema_upgrade_required"
	)
		return recovered;
	return unknown();
}
