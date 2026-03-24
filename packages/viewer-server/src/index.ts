/**
 * @codemem/server — HTTP server (viewer, sync, API).
 *
 * Single HTTP server handling viewer routes and sync daemon.
 * Shares one better-sqlite3 connection between viewer and sync.
 * Embedding inference runs in a worker_thread (lazy-started).
 *
 * Entry: `codemem serve`
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ObserverClient } from "@codemem/core";
import { MemoryStore, type RawEventSweeper, resolveDbPath, VERSION } from "@codemem/core";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { originGuard, preflightHandler } from "./middleware.js";
import { configRoutes } from "./routes/config.js";
import { memoryRoutes } from "./routes/memory.js";
import { observerStatusRoutes } from "./routes/observer-status.js";
import { rawEventsRoutes } from "./routes/raw-events.js";
import { statsRoutes } from "./routes/stats.js";
import { syncProtocolRoutes, syncRoutes } from "./routes/sync.js";

export { VERSION };

/** Shared store instance — SQLite WAL mode handles concurrent reads safely. */
let sharedStore: MemoryStore | null = null;

/** Get (or create) the shared store instance. Exported so the sweeper can share it. */
export function getStore(): MemoryStore {
	if (!sharedStore) {
		sharedStore = new MemoryStore(resolveDbPath());
	}
	return sharedStore;
}

/** Close the shared store (called on shutdown). */
export function closeStore(): void {
	sharedStore?.close();
	sharedStore = null;
}

/**
 * Create the Hono app with all viewer routes.
 * Exported for testing — pass a custom store factory to inject test DBs.
 */
export interface AppOptions {
	storeFactory?: () => MemoryStore;
	sweeper?: RawEventSweeper | null;
	observer?: ObserverClient | null;
}

export function createApp(opts?: AppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const sweeper = opts?.sweeper ?? null;
	const observer = opts?.observer ?? null;
	const app = new Hono();

	// CORS / origin guard
	app.use("*", preflightHandler());
	app.use("*", originGuard());

	// API routes
	app.route("/", statsRoutes(storeFactory));
	app.route("/", memoryRoutes(storeFactory));
	app.route(
		"/",
		observerStatusRoutes({
			getStore: storeFactory,
			getSweeper: () => sweeper,
			getObserver: () => observer,
		}),
	);
	app.route("/", configRoutes({ getSweeper: () => sweeper }));
	app.route("/", rawEventsRoutes(storeFactory, sweeper));
	app.route("/", syncRoutes(storeFactory));

	// Static assets — serve under /assets/*
	// Resolves to packages/viewer-server/static/ both in dev and when installed from npm.
	const staticRoot =
		process.env.CODEMEM_VIEWER_STATIC_DIR ?? join(import.meta.dirname ?? ".", "../static");

	app.use(
		"/assets/*",
		serveStatic({
			root: staticRoot,
			rewriteRequestPath: (path) => path.replace(/^\/assets/, ""),
		}),
	);

	// SPA — serve index.html for root and all client-side routes
	const indexHtml = readFileSync(join(staticRoot, "index.html"), "utf-8");
	app.get("*", (c) => {
		if (c.req.path.startsWith("/api/")) {
			return c.json({ error: "not found" }, 404);
		}
		return c.html(indexHtml);
	});

	return app;
}

/**
 * Create the Hono app for peer-to-peer sync protocol routes only.
 *
 * This app is bound to a separate network-accessible listener
 * (default 0.0.0.0:7337) so remote peers can reach the sync
 * endpoints without exposing the viewer UI or local API routes.
 *
 * No CORS/origin guard is applied — sync requests are authenticated
 * via cryptographic signature verification instead.
 */
export function createSyncApp(opts?: AppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const app = new Hono();
	app.route("/", syncProtocolRoutes(storeFactory));

	// Catch-all — return generic 404 to avoid fingerprinting the server.
	app.all("*", (c) => c.json({ error: "not found" }, 404));

	return app;
}

// No auto-start — the CLI's `serve` command owns server startup.
