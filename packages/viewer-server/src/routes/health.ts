import { type MemoryStore, VERSION, VIEWER_SERVICE_DISCRIMINATOR } from "@codemem/core";
import { Hono } from "hono";

type StoreFactory = () => MemoryStore;

function databaseReachable(getStore: StoreFactory): boolean {
	try {
		getStore().db.pragma("schema_version", { simple: true });
		return true;
	} catch {
		return false;
	}
}

export function healthRoutes(getStore: StoreFactory) {
	const app = new Hono();

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
			// Database reachability is the only readiness dependency in this endpoint.
			ready: reachable,
			database: { reachable },
		});
	});

	return app;
}
