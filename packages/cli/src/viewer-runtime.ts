import { probeCodememViewerLiveness, type ViewerLivenessProbeDependencies } from "@codemem/core";

// The probe contract lives in @codemem/core so the CLI and MCP server share
// one implementation; re-export it for existing CLI consumers.
export { probeCodememViewerLiveness, viewerUrl } from "@codemem/core";

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

export interface ViewerProbeDependencies extends ViewerLivenessProbeDependencies {
	isProcessRunning: (pid: number) => boolean | null;
}

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
