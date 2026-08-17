import { parseStrictInteger } from "@codemem/core";

/**
 * Shared helpers for viewer-server routes.
 */

/**
 * Parse a JSON string that should be an array of strings.
 * Returns an empty array on null, invalid JSON, or non-array values.
 * Mirrors Python's store._safe_json_list().
 */
export function safeJsonList(raw: string | null | undefined): string[] {
	if (raw == null) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return [];
	}
}

/**
 * Parse a query parameter as an integer, returning the default on failure.
 */
export function queryInt(value: string | undefined, defaultValue: number): number {
	if (value == null) return defaultValue;
	const parsed = parseStrictInteger(value);
	return parsed == null ? defaultValue : parsed;
}

/**
 * Parse a query parameter as a boolean flag.
 * Recognizes "1", "true", "yes" as truthy.
 */
export function queryBool(value: string | undefined): boolean {
	if (value == null) return false;
	return value === "1" || value === "true" || value === "yes";
}

/**
 * Parse and validate a JSON object body, enforcing size limits.
 * Returns the parsed payload or a Hono Response on error.
 */
export async function parseJsonObjectBody(
	c: {
		req: { header: (name: string) => string | undefined; raw: Request };
		json: (data: unknown, status?: number) => Response;
	},
	maxBytes: number,
): Promise<Record<string, unknown> | Response> {
	const contentLength = Number.parseInt(c.req.header("content-length") ?? "0", 10);
	if (Number.isNaN(contentLength) || contentLength < 0) {
		return c.json({ error: "invalid content-length" }, 400);
	}
	if (contentLength > maxBytes) {
		return c.json({ error: "payload too large", max_bytes: maxBytes }, 413);
	}
	let raw = "";
	try {
		const body = c.req.raw.body;
		if (body !== null) {
			const reader = body.getReader();
			const chunks: Uint8Array[] = [];
			let totalBytes = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					totalBytes += value.byteLength;
					if (totalBytes > maxBytes) {
						try {
							await reader.cancel();
						} catch {
							// The size rejection is authoritative even if cancellation fails.
						}
						return c.json({ error: "payload too large", max_bytes: maxBytes }, 413);
					}
					chunks.push(value);
				}
			} finally {
				reader.releaseLock();
			}

			const bytes = new Uint8Array(totalBytes);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		}
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : {};
	} catch {
		return c.json({ error: "invalid json" }, 400);
	}
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return c.json({ error: "payload must be an object" }, 400);
	}
	return parsed as Record<string, unknown>;
}
