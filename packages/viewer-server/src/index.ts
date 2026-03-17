/**
 * @codemem/viewer-server — Hono HTTP server for the codemem viewer.
 *
 * Serves the existing frontend SPA (viewer_static/app.js) and all API routes.
 * Single process: viewer + API. Sync daemon management is not yet ported.
 *
 * Entry: `node dist/index.js` or via the CLI `codemem serve`
 */

import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { ViewerVariables } from "./middleware.js";
import { corsMiddleware, storeMiddleware } from "./middleware.js";
import configRoutes from "./routes/config.js";
import memoryRoutes from "./routes/memory.js";
import observerStatusRoutes from "./routes/observer-status.js";
import rawEventsRoutes from "./routes/raw-events.js";
import statsRoutes from "./routes/stats.js";
import syncRoutes from "./routes/sync.js";
import { viewerHtml } from "./viewer-html.js";

export type { ViewerVariables } from "./middleware.js";
export { corsMiddleware, storeMiddleware } from "./middleware.js";
export { viewerHtml } from "./viewer-html.js";

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 38888;

// ---------------------------------------------------------------------------
// App factory — exported for testing and composition
// ---------------------------------------------------------------------------

export interface CreateAppOptions {
	/** Database path. Resolved from CODEMEM_DB env if not provided. */
	dbPath?: string;
	/**
	 * Root directory for static assets (viewer_static/).
	 * Defaults to CODEMEM_VIEWER_STATIC_DIR env or ../../codemem/viewer_static/
	 * relative to this package.
	 */
	staticDir?: string;
}

/**
 * Create and configure the Hono app with all routes and middleware.
 *
 * Exported so tests can use `app.request()` without starting a real server.
 */
export function createApp(options: CreateAppOptions = {}): Hono<{ Variables: ViewerVariables }> {
	const app = new Hono<{ Variables: ViewerVariables }>();

	// --- Middleware ---
	app.use("*", corsMiddleware());
	app.use("/api/*", storeMiddleware(options.dbPath));

	// --- API routes ---
	app.route("/", statsRoutes);
	app.route("/", memoryRoutes);
	app.route("/", observerStatusRoutes);
	app.route("/", configRoutes);
	app.route("/", rawEventsRoutes);
	app.route("/", syncRoutes);

	// --- Static assets ---
	// Resolve static asset directory:
	// 1. Explicit option
	// 2. CODEMEM_VIEWER_STATIC_DIR env
	// 3. Default: from packages/viewer-server/dist/ → repo root → codemem/viewer_static/
	const staticRoot =
		options.staticDir ??
		process.env.CODEMEM_VIEWER_STATIC_DIR ??
		resolve(import.meta.dirname ?? ".", "../../../codemem/viewer_static");

	app.use(
		"/assets/*",
		serveStatic({
			root: staticRoot,
			rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
		}),
	);

	// --- SPA fallback: serve viewer HTML for / and unmatched paths ---
	app.get("/", (c) => {
		return c.html(viewerHtml());
	});

	// Catch-all for SPA client-side routing (non-API, non-static)
	app.get("*", (c) => {
		// Don't serve HTML for API routes that didn't match
		if (c.req.path.startsWith("/api/")) {
			return c.json({ error: "not found" }, 404);
		}
		return c.html(viewerHtml());
	});

	return app;
}

// ---------------------------------------------------------------------------
// Server entry point — only runs when executed directly
// ---------------------------------------------------------------------------

function main(): void {
	const host = process.env.CODEMEM_VIEWER_HOST ?? DEFAULT_HOST;
	const port = Number.parseInt(process.env.CODEMEM_VIEWER_PORT ?? String(DEFAULT_PORT), 10);

	const app = createApp();

	const server = serve(
		{
			fetch: app.fetch,
			hostname: host,
			port,
		},
		(info) => {
			console.log(`codemem viewer listening on http://${info.address}:${info.port}`);
		},
	);

	// Graceful shutdown
	const shutdown = () => {
		console.log("\nShutting down viewer server...");
		server.close(() => {
			process.exit(0);
		});
		// Force exit after 5s if close() hangs
		setTimeout(() => process.exit(1), 5000).unref();
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

// Run main when executed directly (not imported)
const isDirectRun =
	typeof import.meta.url === "string" &&
	(process.argv[1] === import.meta.filename ||
		process.argv[1]?.endsWith("/viewer-server/dist/index.js"));

if (isDirectRun) {
	main();
}
