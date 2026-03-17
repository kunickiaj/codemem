/**
 * Config routes — GET /api/config, POST /api/config.
 *
 * Ports Python's viewer_routes/config.py.
 * GET returns actual config from disk + effective values + env overrides.
 * POST is not yet fully ported — returns 501.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripJsonComments, stripTrailingCommas } from "@codemem/core";
import { Hono } from "hono";

/** Env var overrides matching Python's CONFIG_ENV_OVERRIDES. */
const CONFIG_ENV_OVERRIDES: Record<string, string> = {
	actor_id: "CODEMEM_ACTOR_ID",
	actor_display_name: "CODEMEM_ACTOR_DISPLAY_NAME",
	observer_base_url: "CODEMEM_OBSERVER_BASE_URL",
	observer_provider: "CODEMEM_OBSERVER_PROVIDER",
	observer_model: "CODEMEM_OBSERVER_MODEL",
	observer_api_key: "CODEMEM_OBSERVER_API_KEY",
	observer_runtime: "CODEMEM_OBSERVER_RUNTIME",
	observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE",
	observer_auth_file: "CODEMEM_OBSERVER_AUTH_FILE",
	observer_max_chars: "CODEMEM_OBSERVER_MAX_CHARS",
	sync_enabled: "CODEMEM_SYNC_ENABLED",
	sync_host: "CODEMEM_SYNC_HOST",
	sync_port: "CODEMEM_SYNC_PORT",
	sync_interval_s: "CODEMEM_SYNC_INTERVAL_S",
	sync_mdns: "CODEMEM_SYNC_MDNS",
	raw_events_sweeper_interval_s: "CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS",
};

/** Known provider names from OpenCode config. */
function loadProviderOptions(): string[] {
	// Simplified: return well-known providers.
	// Python loads this from OpenCode's config.json — we can match
	// that once the config subsystem is fully ported.
	return ["openai", "anthropic", "google", "xai", "groq", "deepseek", "mistral", "together"];
}

function getConfigPath(): string {
	const envPath = process.env.CODEMEM_CONFIG;
	if (envPath) return envPath.replace(/^~/, homedir());
	const configDir = join(homedir(), ".config", "codemem");
	const candidates = [join(configDir, "config.json"), join(configDir, "config.jsonc")];
	return candidates.find((p) => existsSync(p)) ?? join(configDir, "config.json");
}

function readConfigFile(configPath: string): Record<string, unknown> {
	if (!existsSync(configPath)) return {};
	try {
		let text = readFileSync(configPath, "utf-8").trim();
		if (!text) return {};
		try {
			return JSON.parse(text) as Record<string, unknown>;
		} catch {
			text = stripTrailingCommas(stripJsonComments(text));
			return JSON.parse(text) as Record<string, unknown>;
		}
	} catch {
		return {};
	}
}

function getEnvOverrides(): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const [key, envVar] of Object.entries(CONFIG_ENV_OVERRIDES)) {
		const val = process.env[envVar];
		if (val != null && val !== "") {
			overrides[key] = envVar;
		}
	}
	return overrides;
}

export function configRoutes() {
	const app = new Hono();

	app.get("/api/config", (c) => {
		const configPath = getConfigPath();
		const configData = readConfigFile(configPath);
		const envOverrides = getEnvOverrides();

		// Build effective values: config file + env overrides
		const effective = { ...configData };
		for (const [key, envVar] of Object.entries(CONFIG_ENV_OVERRIDES)) {
			const val = process.env[envVar];
			if (val != null && val !== "") {
				effective[key] = val;
			}
		}

		return c.json({
			path: configPath,
			config: configData,
			defaults: {},
			effective,
			env_overrides: envOverrides,
			providers: loadProviderOptions(),
		});
	});

	app.post("/api/config", async (c) => {
		// Config save not yet fully ported to TS.
		// Python's implementation has 300+ lines of validation + runtime effects.
		return c.json({ error: "config save not yet implemented in TS viewer" }, 501);
	});

	return app;
}
