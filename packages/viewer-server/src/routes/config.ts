/**
 * Config routes — GET /api/config, POST /api/config.
 *
 * Ports Python's viewer_routes/config.py.
 *
 * NOTE: Config persistence (read_config_file, write_config_file) and
 * runtime reloading are Python-side. This route returns stub data until
 * the config subsystem is ported to TS.
 */

import { Hono } from "hono";

export function configRoutes() {
	const app = new Hono();

	app.get("/api/config", (c) => {
		// Stub: return minimal structure matching Python's response shape.
		return c.json({
			path: "",
			config: {},
			defaults: {},
			effective: {},
			env_overrides: {},
			providers: ["openai", "anthropic"],
		});
	});

	app.post("/api/config", async (c) => {
		// Stub: config save not yet ported to TS.
		return c.json({ error: "config save not yet implemented in TS viewer" }, 501);
	});

	return app;
}
