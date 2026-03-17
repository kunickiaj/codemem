/**
 * Stats routes — port of codemem/viewer_routes/stats.py.
 *
 * GET /api/stats — database statistics
 * GET /api/usage — usage summary (stubbed — store methods not yet ported)
 */

import type { MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import type { ViewerVariables } from "../middleware.js";

const app = new Hono<{ Variables: ViewerVariables }>();

app.get("/api/stats", (c) => {
	const store = c.get("store") as MemoryStore;
	return c.json(store.stats());
});

// TODO: Port usage_summary(), usage_totals(), recent_pack_events() to TS store
// Python source: codemem/viewer_routes/stats.py lines 18-41
app.get("/api/usage", (c) => {
	return c.json({ error: "not yet implemented" }, 501);
});

export default app;
