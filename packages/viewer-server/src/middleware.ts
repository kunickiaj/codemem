/**
 * CORS and cross-origin protection middleware.
 *
 * Ports Python's reject_cross_origin() logic from codemem/viewer_http.py.
 * GETs are allowed from any origin (viewer is local-only).
 * Mutations (POST/DELETE/PATCH/PUT) require an Origin header matching a
 * loopback address, or are rejected with 403.
 */

import type { Context, Next } from "hono";
import { createMiddleware } from "hono/factory";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Check whether an Origin header value is a valid loopback URL.
 * Mirrors Python's _is_allowed_loopback_origin_url().
 */
function isLoopbackOrigin(origin: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (url.username || url.password) return false;
	return LOOPBACK_HOSTS.has(url.hostname);
}

/** HTTP methods that mutate state and require origin validation. */
const UNSAFE_METHODS = new Set(["POST", "DELETE", "PATCH", "PUT"]);

/**
 * Cross-origin protection middleware.
 *
 * - GET/HEAD/OPTIONS: allowed from any origin (viewer is local-only).
 * - POST/DELETE/PATCH/PUT: Origin header must be present and match loopback.
 *   Missing or non-loopback origins return 403.
 *
 * For same-origin requests (no Origin header) on safe methods, no
 * Access-Control-Allow-Origin is set — the browser doesn't need it.
 * For valid loopback origins, ACAO is echoed back.
 */
export function originGuard() {
	return createMiddleware(async (c: Context, next: Next) => {
		const origin = c.req.header("Origin");
		const method = c.req.method;

		if (UNSAFE_METHODS.has(method)) {
			// Mutations MUST have a valid loopback origin
			if (!origin) {
				return c.json({ error: "forbidden" }, 403);
			}
			if (!isLoopbackOrigin(origin)) {
				return c.json({ error: "forbidden" }, 403);
			}
			// Valid loopback origin — echo it for CORS
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
			c.header("Access-Control-Allow-Headers", "Content-Type");
		} else if (origin && isLoopbackOrigin(origin)) {
			// Safe method with valid origin — echo for preflight
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
			c.header("Access-Control-Allow-Headers", "Content-Type");
		}
		// No origin or non-loopback on safe method: no ACAO header set.
		// Browser enforces same-origin; we don't set permissive headers.

		await next();
	});
}

/**
 * Handle OPTIONS preflight requests.
 * Returns 204 with appropriate CORS headers for loopback origins.
 */
export function preflightHandler() {
	return createMiddleware(async (c: Context, next: Next) => {
		if (c.req.method !== "OPTIONS") {
			await next();
			return;
		}
		const origin = c.req.header("Origin");
		if (origin && isLoopbackOrigin(origin)) {
			c.header("Access-Control-Allow-Origin", origin);
			c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
			c.header("Access-Control-Allow-Headers", "Content-Type");
			c.header("Access-Control-Max-Age", "86400");
			return c.body(null, 204);
		}
		return c.body(null, 204);
	});
}
