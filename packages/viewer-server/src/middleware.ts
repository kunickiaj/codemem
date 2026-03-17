/**
 * Hono middleware for the codemem viewer server.
 *
 * - storeMiddleware: creates a MemoryStore per-request, attaches to context
 * - corsMiddleware: configures CORS for local development
 */

import { MemoryStore, resolveDbPath } from "@codemem/core";
import type { Context, MiddlewareHandler, Next } from "hono";
import { cors } from "hono/cors";

// ---------------------------------------------------------------------------
// Context variable typing
// ---------------------------------------------------------------------------

/** Hono context variables set by viewer-server middleware. */
export type ViewerVariables = {
	store: MemoryStore;
};

// ---------------------------------------------------------------------------
// Store middleware
// ---------------------------------------------------------------------------

/**
 * Attach a MemoryStore instance to Hono context.
 *
 * Opens a fresh store per-request and closes it after the response.
 * The dbPath is resolved once at server start and reused.
 */
export function storeMiddleware(dbPath?: string): MiddlewareHandler {
	const resolvedPath = resolveDbPath(dbPath);
	return async (c: Context, next: Next) => {
		const store = new MemoryStore(resolvedPath);
		c.set("store", store);
		try {
			await next();
		} finally {
			store.close();
		}
	};
}

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

/**
 * CORS middleware for local development.
 * Allows same-origin and configurable origins.
 */
export function corsMiddleware(): MiddlewareHandler {
	return cors({
		origin: (origin) => {
			// Allow same-origin requests (no Origin header) and localhost variants
			if (!origin) return "*";
			if (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:")) {
				return origin;
			}
			return null as unknown as string;
		},
		allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	});
}
