import { type MemoryStore, VERSION, VIEWER_SERVICE_DISCRIMINATOR } from "@codemem/core";
import { Hono } from "hono";

type StoreFactory = () => MemoryStore;

/**
 * Whether this process holds an open database connection. Answered from the connection
 * object in memory: no statement runs, so a busy or locked database, or other work on the
 * same connection, can never delay the health answer or turn it into a false failure.
 */
function databaseReachable(getStore: StoreFactory): boolean {
	try {
		return getStore().db.open === true;
	} catch {
		return false;
	}
}

export function healthRoutes(getStore: StoreFactory) {
	const app = new Hono();

	app.get("/api/viewer-status", (c) => {
		const store = getStore();
		store.db.pragma("schema_version", { simple: true });
		c.header("Cache-Control", "no-store");
		return c.json({ identity: { actor_id: store.actorId } });
	});

	app.get("/api/health", (c) => {
		const reachable = databaseReachable(getStore);
		c.header("Cache-Control", "no-store");
		return c.json({
			// Bound to the shared probe contract so producer and clients
			// cannot drift independently.
			service: VIEWER_SERVICE_DISCRIMINATOR,
			version: VERSION,
			pid: process.pid,
			uptime_ms: Math.max(0, Math.floor(process.uptime() * 1_000)),
			// An open database connection is the only readiness dependency in this endpoint.
			ready: reachable,
			database: { reachable },
		});
	});

	return app;
}
