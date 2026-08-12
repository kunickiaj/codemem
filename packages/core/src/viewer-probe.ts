/**
 * Shared viewer liveness-probe contract.
 *
 * One implementation of the health-first probe used by every TypeScript
 * client (CLI `status`/`serve` lifecycle and the MCP stdio server):
 *
 * - Liveness requires HTTP success on `GET /api/health` plus the
 *   `codemem-viewer` service discriminator.
 * - `ready`/`database.reachable` are readiness only: a running-but-unready
 *   viewer is live and degraded, never restart-worthy.
 * - Exactly one old-viewer compatibility request to `GET /api/stats` is made,
 *   and only when the health route returns 404. The fallback requires the
 *   legacy payload's identifying `viewer_pid` evidence.
 * - Wrong service, malformed payloads, other HTTP errors, timeouts, and
 *   network failures never fall back.
 *
 * The plain-JS OpenCode plugin cannot import this module; its equivalent
 * monitor is pinned by a contract parity test in
 * `packages/cli/.opencode/tests/plugin-probe-parity.test.js`.
 */

/** Stable service discriminator returned by `GET /api/health`. */
export const VIEWER_SERVICE_DISCRIMINATOR = "codemem-viewer";

export interface ViewerTarget {
	host: string;
	port: number;
}

export interface ViewerLivenessProbeDependencies {
	fetch: typeof fetch;
	timeoutMs?: number;
}

export type ViewerLivenessProbeResult =
	| { state: "live"; degraded: boolean }
	| {
			state: "unavailable";
			reason: "unexpected_response" | "wrong_service" | "unreachable";
	  };

/**
 * Build a viewer URL with IPv6-safe host bracketing.
 *
 * Performs no host validation — callers own the trust gate (e.g. the CLI's
 * loopback-only check before probing PID-record hosts).
 */
export function viewerUrl(target: ViewerTarget, pathname: string): string {
	const host =
		target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
	return `http://${host}:${target.port}${pathname}`;
}

async function request(
	deps: ViewerLivenessProbeDependencies,
	target: ViewerTarget,
	pathname: string,
): Promise<Response> {
	// Each request gets a fresh timeout budget so the 404 compatibility
	// fallback is not starved by time already spent on the health request.
	return deps.fetch(viewerUrl(target, pathname), {
		method: "GET",
		signal: AbortSignal.timeout(deps.timeoutMs ?? 750),
	});
}

/** Release an unread response body without surfacing cancellation failures. */
function discardBody(response: Response): void {
	try {
		response.body?.cancel().catch(() => {});
	} catch {
		// Best effort — a locked or already-errored stream is fine to abandon.
	}
}

async function isLegacyViewerStatsResponse(response: Response): Promise<boolean> {
	if (!response.ok) {
		discardBody(response);
		return false;
	}
	try {
		const payload: unknown = await response.json();
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
		const viewerPid = (payload as { viewer_pid?: unknown }).viewer_pid;
		return typeof viewerPid === "number" && Number.isSafeInteger(viewerPid) && viewerPid > 0;
	} catch {
		return false;
	}
}

/**
 * Probe a viewer target for liveness. Never throws; failures map to bounded
 * `unavailable` observations.
 */
export async function probeCodememViewerLiveness(
	target: ViewerTarget,
	deps: ViewerLivenessProbeDependencies,
): Promise<ViewerLivenessProbeResult> {
	try {
		const health = await request(deps, target, "/api/health");
		if (health.status === 404) {
			// Release the unread body so repeated probes cannot pin connections.
			discardBody(health);
			// Old-viewer compatibility: every released viewer's stats payload
			// includes `viewer_pid`, so require that identifying evidence
			// rather than trusting any 2xx from an arbitrary local service.
			const stats = await request(deps, target, "/api/stats");
			return (await isLegacyViewerStatsResponse(stats))
				? { state: "live", degraded: false }
				: { state: "unavailable", reason: "unexpected_response" };
		}
		if (!health.ok) {
			discardBody(health);
			return { state: "unavailable", reason: "unexpected_response" };
		}

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
		if (healthPayload.service !== VIEWER_SERVICE_DISCRIMINATOR) {
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
