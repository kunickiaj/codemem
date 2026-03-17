/**
 * @codemem/viewer-server — unified viewer + sync process.
 *
 * Single HTTP server handling viewer routes and sync daemon.
 * Shares one better-sqlite3 connection between viewer and sync.
 * Embedding inference runs in a worker_thread (lazy-started).
 *
 * Entry: `codemem serve`
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore, type RawEventSweeper, resolveDbPath, VERSION } from "@codemem/core";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { originGuard, preflightHandler } from "./middleware.js";
import { configRoutes } from "./routes/config.js";
import { memoryRoutes } from "./routes/memory.js";
import { observerStatusRoutes } from "./routes/observer-status.js";
import { rawEventsRoutes } from "./routes/raw-events.js";
import { statsRoutes } from "./routes/stats.js";
import { syncRoutes } from "./routes/sync.js";

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
}

export function createApp(opts?: AppOptions) {
	const storeFactory = opts?.storeFactory ?? getStore;
	const sweeper = opts?.sweeper ?? null;
	const app = new Hono();

	// CORS / origin guard
	app.use("*", preflightHandler());
	app.use("*", originGuard());

	// API routes
	app.route("/", statsRoutes(storeFactory));
	app.route("/", memoryRoutes(storeFactory));
	app.route("/", observerStatusRoutes({ getStore: storeFactory, getSweeper: () => sweeper }));
	app.route("/", configRoutes({ getSweeper: () => sweeper }));
	app.route("/", rawEventsRoutes(storeFactory, sweeper));
	app.route("/", syncRoutes(storeFactory));

	// Static assets — serve viewer_static/ under /assets/*
	const staticRoot =
		process.env.CODEMEM_VIEWER_STATIC_DIR ??
		join(import.meta.dirname ?? ".", "../../../codemem/viewer_static");

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

// No auto-start — the CLI's `serve` command owns server startup.
