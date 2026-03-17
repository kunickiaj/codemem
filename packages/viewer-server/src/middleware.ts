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
 * Check whether a missing-Origin request looks like a cross-site browser
 * request. Matches Python's `_is_unsafe_missing_origin()`:
 *
 *   - Sec-Fetch-Site present and NOT same-origin/same-site/none → unsafe
 *   - Referer present and NOT loopback → unsafe
 *   - Otherwise → safe (CLI / programmatic caller, no browser context)
 */
function isUnsafeMissingOrigin(c: Context): boolean {
	const secFetchSite = (c.req.header("Sec-Fetch-Site") ?? "").trim().toLowerCase();
	if (secFetchSite && !["same-origin", "same-site", "none"].includes(secFetchSite)) {
		return true;
	}
	const referer = c.req.header("Referer");
	if (!referer) return false;
	return !isLoopbackOrigin(referer);
}

/**
 * Cross-origin protection middleware.
 *
 * Ports Python's `reject_cross_origin(missing_origin_policy="reject_if_unsafe")`:
 *
 * - GET/HEAD/OPTIONS: allowed from any origin (viewer is local-only).
 * - POST/DELETE/PATCH/PUT:
 *   - Origin present + loopback → allowed (browser on localhost)
 *   - Origin present + non-loopback → rejected 403
 *   - No Origin + no suspicious browser signals → allowed (CLI callers)
 *   - No Origin + suspicious Sec-Fetch-Site/Referer → rejected 403
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
			if (origin) {
				// Origin present — must be loopback
				if (!isLoopbackOrigin(origin)) {
					return c.json({ error: "forbidden" }, 403);
				}
				// Valid loopback origin — echo it for CORS
				c.header("Access-Control-Allow-Origin", origin);
				c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
				c.header("Access-Control-Allow-Headers", "Content-Type");
			} else {
				// No Origin — reject only if browser signals indicate cross-site
				// (matches Python's reject_if_unsafe policy for API endpoints)
				if (isUnsafeMissingOrigin(c)) {
					return c.json({ error: "forbidden" }, 403);
				}
				// CLI / programmatic caller — no CORS headers needed
			}
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
