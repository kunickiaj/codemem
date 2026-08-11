export interface ViewerPidRecord {
	pid: number;
	host: string;
	port: number;
}

export type ParsedViewerPidRecord =
	| { state: "missing" }
	| { state: "malformed" }
	| { state: "legacy"; pid: number }
	| { state: "valid"; record: ViewerPidRecord };

export type ViewerRuntimeState = "running" | "stopped" | "unreachable" | "unknown";

export interface ViewerRuntimeObservation {
	state: ViewerRuntimeState;
	pid?: number;
	attention_code?:
		| "viewer_pid_malformed"
		| "viewer_non_loopback"
		| "viewer_not_ready"
		| "viewer_unexpected_response"
		| "viewer_wrong_service";
}

export interface ViewerLivenessProbeDependencies {
	fetch: typeof fetch;
	timeoutMs?: number;
}

export interface ViewerProbeDependencies extends ViewerLivenessProbeDependencies {
	isProcessRunning: (pid: number) => boolean | null;
}

export type ViewerLivenessProbeResult =
	| { state: "live"; degraded: boolean }
	| {
			state: "unavailable";
			reason: "unexpected_response" | "wrong_service" | "unreachable";
	  };

function isValidPid(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
}

export function parseViewerPidRecord(raw: string | null): ParsedViewerPidRecord {
	if (raw == null) return { state: "missing" };
	const trimmed = raw.trim();
	if (!trimmed) return { state: "malformed" };
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (isValidPid(parsed)) {
			return { state: "legacy", pid: parsed };
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { state: "malformed" };
		}
		const candidate = parsed as { pid?: unknown; host?: unknown; port?: unknown };
		if (
			!isValidPid(candidate.pid) ||
			typeof candidate.host !== "string" ||
			!candidate.host.trim() ||
			!isValidPort(candidate.port)
		) {
			return { state: "malformed" };
		}
		return {
			state: "valid",
			record: { pid: candidate.pid, host: candidate.host.trim(), port: candidate.port },
		};
	} catch {
		if (!/^\d+$/.test(trimmed)) return { state: "malformed" };
		const pid = Number(trimmed);
		return isValidPid(pid) ? { state: "legacy", pid } : { state: "malformed" };
	}
}

export function isLoopbackHost(host: string): boolean {
	const normalized = host
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, "$1");
	const ipv4Parts = normalized.split(".");
	const isIpv4Loopback =
		ipv4Parts.length >= 1 &&
		ipv4Parts.length <= 4 &&
		ipv4Parts[0] === "127" &&
		ipv4Parts.every((part) => /^\d+$/.test(part) && Number(part) <= 255);
	return (
		normalized === "localhost" ||
		normalized === "::1" ||
		normalized === "0:0:0:0:0:0:0:1" ||
		isIpv4Loopback
	);
}

export type ViewerProbeTarget = Pick<ViewerPidRecord, "host" | "port"> & { pid?: number };

export function viewerUrl(record: ViewerProbeTarget, pathname: string): string {
	const host =
		record.host.includes(":") && !record.host.startsWith("[") ? `[${record.host}]` : record.host;
	return `http://${host}:${record.port}${pathname}`;
}

async function request(
	deps: ViewerLivenessProbeDependencies,
	record: ViewerProbeTarget,
	pathname: string,
): Promise<Response> {
	// Each request gets a fresh timeout budget so the 404 compatibility
	// fallback is not starved by time already spent on the health request.
	// MCP and OpenCode plugin probes use the same per-request semantics.
	return deps.fetch(viewerUrl(record, pathname), {
		method: "GET",
		signal: AbortSignal.timeout(deps.timeoutMs ?? 750),
	});
}

async function isCodememStatsResponse(response: Response): Promise<boolean> {
	if (!response.ok) return false;
	try {
		const payload: unknown = await response.json();
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
		const viewerPid = (payload as { viewer_pid?: unknown }).viewer_pid;
		return typeof viewerPid === "number" && Number.isSafeInteger(viewerPid) && viewerPid > 0;
	} catch {
		return false;
	}
}

export async function probeCodememViewerLiveness(
	record: ViewerProbeTarget,
	deps: ViewerLivenessProbeDependencies,
): Promise<ViewerLivenessProbeResult> {
	try {
		const health = await request(deps, record, "/api/health");
		if (health.status === 404) {
			const stats = await request(deps, record, "/api/stats");
			return (await isCodememStatsResponse(stats))
				? { state: "live", degraded: false }
				: { state: "unavailable", reason: "unexpected_response" };
		}
		if (!health.ok) return { state: "unavailable", reason: "unexpected_response" };

		let payload: unknown;
		try {
			payload = await health.json();
		} catch {
			return { state: "unavailable", reason: "unexpected_response" };
		}
		if (!payload || typeof payload !== "object") {
			return { state: "unavailable", reason: "unexpected_response" };
		}
		const healthPayload = payload as {
			service?: unknown;
			ready?: unknown;
			database?: { reachable?: unknown };
		};
		if (healthPayload.service !== "codemem-viewer") {
			return { state: "unavailable", reason: "wrong_service" };
		}
		// Liveness is HTTP success plus the service discriminator; `ready` and
		// `database.reachable` are readiness only. Absent or non-boolean
		// readiness fields degrade the observation instead of denying
		// liveness so the health contract stays additive.
		return {
			state: "live",
			degraded: healthPayload.ready !== true || healthPayload.database?.reachable !== true,
		};
	} catch {
		return { state: "unavailable", reason: "unreachable" };
	}
}

export async function observeViewerRuntime(
	parsed: ParsedViewerPidRecord,
	deps: ViewerProbeDependencies,
	defaultTarget: ViewerProbeTarget = { host: "127.0.0.1", port: 38_888 },
): Promise<ViewerRuntimeObservation> {
	if (parsed.state === "malformed") {
		return { state: "unknown", attention_code: "viewer_pid_malformed" };
	}
	const record: ViewerProbeTarget =
		parsed.state === "valid"
			? parsed.record
			: parsed.state === "legacy"
				? { ...defaultTarget, pid: parsed.pid }
				: defaultTarget;
	if (!isLoopbackHost(record.host)) {
		return { state: "unknown", pid: record.pid, attention_code: "viewer_non_loopback" };
	}
	if (record.pid && deps.isProcessRunning(record.pid) === false) {
		return { state: "stopped", pid: record.pid };
	}

	const probe = await probeCodememViewerLiveness(record, deps);
	if (probe.state === "live") {
		return probe.degraded
			? { state: "running", pid: record.pid, attention_code: "viewer_not_ready" }
			: record.pid
				? { state: "running", pid: record.pid }
				: { state: "running" };
	}
	if (probe.reason === "unreachable") return { state: "unreachable", pid: record.pid };
	return {
		state: "unknown",
		pid: record.pid,
		attention_code:
			probe.reason === "wrong_service" ? "viewer_wrong_service" : "viewer_unexpected_response",
	};
}
