/* Internal fetch helpers shared across the API domain modules. The
 * error shape is consistent across viewer endpoints (best-effort JSON
 * body with an `error` field, falling back to the raw body text), so
 * every per-domain module can rely on payloadError + readJsonPayload
 * instead of hand-rolling the same try/catch. */

export function payloadError(payload: unknown): string | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const maybeError = (payload as { error?: unknown }).error;
	return typeof maybeError === "string" ? maybeError : undefined;
}

export async function fetchJson<T = Record<string, unknown>>(url: string): Promise<T> {
	const resp = await fetch(url);
	if (!resp.ok) throw new Error(`${url}: ${resp.status} ${resp.statusText}`);
	return resp.json() as Promise<T>;
}

export async function readJsonPayload<T = Record<string, unknown>>(
	resp: Response,
): Promise<{ text: string; payload: T }> {
	const text = await resp.text();
	try {
		return { text, payload: (text ? JSON.parse(text) : {}) as T };
	} catch {
		return { text, payload: {} as T };
	}
}

export function buildProjectParams(
	project: string,
	limit?: number,
	offset?: number,
	scope?: string,
): string {
	const params = new URLSearchParams();
	params.set("project", project || "");
	if (typeof limit === "number") params.set("limit", String(limit));
	if (typeof offset === "number") params.set("offset", String(offset));
	if (scope) params.set("scope", scope);
	return params.toString();
}
