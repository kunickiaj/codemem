/**
 * Viewer HTTP transport for memory tools: target-proven JSON requests with
 * per-call timeouts and abort propagation. Hosts supply the endpoint; this
 * module never spawns processes or touches the store.
 */

import {
	isRecord,
	profileMatchesViewerTarget,
	type ViewerRequestTarget,
	viewerCapabilities,
} from "./viewer-target.js";

export interface ViewerEndpoint {
	/** `http://host:port`, no trailing slash. */
	readonly baseUrl: string;
	/** Default budget per request in milliseconds. */
	readonly timeoutMs: number;
	readonly enabled: boolean;
	/** Injectable for tests; defaults to global fetch. */
	readonly fetchImpl?: typeof fetch;
}

export type QueryValue = string | number | boolean | undefined | null;

export interface HttpJsonRequest {
	query?: Record<string, QueryValue>;
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type HttpJsonResult =
	| { ok: true; status: number; data: unknown }
	| { ok: false; error: string; safeFallback: boolean; status?: number };

export interface ViewerProof {
	proven: boolean;
	capabilities: ReadonlySet<string>;
}

const SAFE_CONNECT_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);
const PROOF_TIMEOUT_CAP_MS = 2_000;

export function apiUrl(endpoint: ViewerEndpoint, path: string): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `${endpoint.baseUrl}${normalized}`;
}

function collectErrorTokens(err: unknown): string[] {
	const tokens: string[] = [];
	let current: unknown = err;
	for (let depth = 0; depth < 6 && isRecord(current); depth++) {
		if (typeof current.code === "string") tokens.push(current.code);
		if (typeof current.name === "string") tokens.push(current.name);
		current = current.cause;
	}
	return tokens;
}

/** Connection-level failures where falling back to the CLI cannot double-apply a write. */
export function isSafeConnectFailure(err: unknown): boolean {
	return collectErrorTokens(err).some((token) => SAFE_CONNECT_CODES.has(token));
}

export function applyQuery(url: URL, query?: Record<string, QueryValue>): void {
	if (!query) return;
	for (const [key, value] of Object.entries(query)) {
		if (value == null || value === "") continue;
		url.searchParams.set(key, String(value));
	}
}

export async function readResponseData(res: Response): Promise<unknown> {
	const text = await res.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

function httpErrorMessage(data: unknown, res: Response): string {
	if (isRecord(data)) {
		return String(data.error ?? res.statusText) || `HTTP ${res.status}`;
	}
	return res.statusText || `HTTP ${res.status}`;
}

/** Abort after `timeoutMs` or when `signal` aborts, whichever comes first. */
function linkedTimeout(
	timeoutMs: number,
	signal?: AbortSignal,
): { signal: AbortSignal; release: () => void } {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	return {
		signal: controller.signal,
		release: () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

/**
 * GET /api/prompt-pack-profile and verify the viewer serves THIS target.
 * Returns the advertised capabilities so callers can refuse operations an
 * older viewer would silently mishandle (for example `directory` on writes).
 */
export async function proveViewerTarget(
	endpoint: ViewerEndpoint,
	target: ViewerRequestTarget,
	signal?: AbortSignal,
): Promise<ViewerProof> {
	const unproven: ViewerProof = { proven: false, capabilities: new Set() };
	if (!endpoint.enabled) return unproven;
	const link = linkedTimeout(Math.min(endpoint.timeoutMs, PROOF_TIMEOUT_CAP_MS), signal);
	try {
		const res = await (endpoint.fetchImpl ?? fetch)(apiUrl(endpoint, "/api/prompt-pack-profile"), {
			method: "GET",
			redirect: "manual",
			signal: link.signal,
		});
		if (!res.ok) return unproven;
		const profile = await readResponseData(res);
		if (!profileMatchesViewerTarget(profile, target.db_path, target.identity_target)) {
			return unproven;
		}
		return { proven: true, capabilities: viewerCapabilities(profile) };
	} catch {
		return unproven;
	} finally {
		link.release();
	}
}

/**
 * Target-scoped JSON request. The caller is expected to have proven the
 * target first; db_path and identity_target ride along so the viewer can
 * reject a mismatch with 409 even if the proof raced a viewer restart.
 *
 * The target goes in the query string, where the viewer's guard covers
 * `/api/memories/*` and `/api/memory`, and also in the body of POST requests,
 * because routes such as `/api/pack` validate the target from the parsed body.
 */
function withTarget(body: unknown, target: ViewerRequestTarget): unknown {
	if (!isRecord(body)) return body ?? { ...target };
	return { ...body, db_path: target.db_path, identity_target: target.identity_target };
}

export async function viewerJson(
	endpoint: ViewerEndpoint,
	target: ViewerRequestTarget,
	method: "GET" | "POST",
	path: string,
	request: HttpJsonRequest = {},
): Promise<HttpJsonResult> {
	if (!endpoint.enabled) return { ok: false, error: "viewer disabled", safeFallback: true };
	const url = new URL(apiUrl(endpoint, path));
	applyQuery(url, request.query);
	url.searchParams.set("db_path", target.db_path);
	url.searchParams.set("identity_target", JSON.stringify(target.identity_target));
	const link = linkedTimeout(request.timeoutMs ?? endpoint.timeoutMs, request.signal);
	try {
		const res = await (endpoint.fetchImpl ?? fetch)(url, {
			method,
			headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
			body: method === "POST" ? JSON.stringify(withTarget(request.body, target)) : undefined,
			signal: link.signal,
		});
		const data = await readResponseData(res);
		if (res.ok) return { ok: true, status: res.status, data };
		return {
			ok: false,
			error: httpErrorMessage(data, res),
			safeFallback: res.status >= 400 && res.status < 500,
			status: res.status,
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
			safeFallback: isSafeConnectFailure(err),
		};
	} finally {
		link.release();
	}
}
