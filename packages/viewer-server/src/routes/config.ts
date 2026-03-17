/**
 * Config routes — port of codemem/viewer_routes/config.py.
 *
 * GET  /api/config — return current config, defaults, effective values
 * POST /api/config — save config updates with effects tracking
 *
 * The Python config system (load_config, write_config_file, runtime hot-reload,
 * sync daemon management) is deeply integrated with the Python process.
 * These routes are stubbed until the config system is ported to TS.
 */

import { Hono } from "hono";
import type { ViewerVariables } from "../middleware.js";

const app = new Hono<{ Variables: ViewerVariables }>();

// TODO: Port config system to TS — load_config(), read_config_file(),
// write_config_file(), OpencodeMemConfig dataclass, CONFIG_ENV_OVERRIDES,
// runtime hot-reload, sync daemon start/stop/restart.
// Python source: codemem/viewer_routes/config.py (640 lines)
// Python source: codemem/config.py (config loading, defaults, env overrides)

app.get("/api/config", (c) => {
	return c.json({ error: "not yet implemented" }, 501);
});

app.post("/api/config", (c) => {
	return c.json({ error: "not yet implemented" }, 501);
});

export default app;
