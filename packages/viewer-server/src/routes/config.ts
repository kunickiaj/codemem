/**
 * Config routes — GET /api/config, POST /api/config.
 *
 * Ports the user-facing config read/write path from Python's
 * codemem/viewer_routes/config.py, scoped to the TS runtime's current needs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CODEMEM_CONFIG_ENV_OVERRIDES,
	getCodememConfigPath,
	getCodememEnvOverrides,
	listObserverProviderOptions,
	type RawEventSweeper,
	readCodememConfigFile,
	stripJsonComments,
	stripTrailingCommas,
	writeCodememConfigFile,
} from "@codemem/core";
import { Hono } from "hono";

type ConfigData = Record<string, unknown>;

const RUNTIMES = new Set(["api_http", "claude_sidecar"]);
const AUTH_SOURCES = new Set(["auto", "env", "file", "command", "none"]);
const HOT_RELOAD_KEYS = new Set(["raw_events_sweeper_interval_s"]);
const ALLOWED_KEYS = [
	"claude_command",
	"observer_base_url",
	"observer_provider",
	"observer_model",
	"observer_runtime",
	"observer_auth_source",
	"observer_auth_file",
	"observer_auth_command",
	"observer_auth_timeout_ms",
	"observer_auth_cache_ttl_s",
	"observer_headers",
	"observer_max_chars",
	"pack_observation_limit",
	"pack_session_limit",
	"sync_enabled",
	"sync_host",
	"sync_port",
	"sync_interval_s",
	"sync_mdns",
	"sync_coordinator_url",
	"sync_coordinator_group",
	"sync_coordinator_timeout_s",
	"sync_coordinator_presence_ttl_s",
	"raw_events_sweeper_interval_s",
] as const;

const DEFAULTS: ConfigData = {
	claude_command: ["claude"],
	observer_runtime: "api_http",
	observer_auth_source: "auto",
	observer_auth_command: [],
	observer_auth_timeout_ms: 1500,
	observer_auth_cache_ttl_s: 300,
	observer_headers: {},
	observer_max_chars: 12000,
	pack_observation_limit: 50,
	pack_session_limit: 10,
	sync_enabled: false,
	sync_host: "0.0.0.0",
	sync_port: 7337,
	sync_interval_s: 120,
	sync_mdns: true,
	sync_coordinator_timeout_s: 3,
	sync_coordinator_presence_ttl_s: 180,
	raw_events_sweeper_interval_s: 30,
};

export interface ConfigRouteOptions {
	getSweeper?: () => RawEventSweeper | null;
}

function loadProviderOptions(): string[] {
	return listObserverProviderOptions();
}

function getConfigPath(): string {
	const envPath = process.env.CODEMEM_CONFIG;
	if (envPath) return envPath.replace(/^~/, homedir());
	const configDir = join(homedir(), ".config", "codemem");
	const candidates = [join(configDir, "config.json"), join(configDir, "config.jsonc")];
	return candidates.find((p) => existsSync(p)) ?? join(configDir, "config.json");
}

function readConfigFile(configPath: string): ConfigData {
	if (!existsSync(configPath)) return {};
	try {
		let text = readFileSync(configPath, "utf-8").trim();
		if (!text) return {};
		try {
			return JSON.parse(text) as ConfigData;
		} catch {
			text = stripTrailingCommas(stripJsonComments(text));
			return JSON.parse(text) as ConfigData;
		}
	} catch {
		return {};
	}
}

function getEffectiveConfig(configData: ConfigData): ConfigData {
	const effective: ConfigData = { ...DEFAULTS, ...configData };
	for (const [key, envVar] of Object.entries(CODEMEM_CONFIG_ENV_OVERRIDES) as Array<
		[string, string]
	>) {
		const val = process.env[envVar];
		if (val != null && val !== "") effective[key] = val;
	}
	return effective;
}

function parsePositiveInt(value: unknown, allowZero = false): number | null {
	if (typeof value === "boolean") return null;
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && /^-?\d+$/.test(value.trim())
				? Number(value.trim())
				: Number.NaN;
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
	if (allowZero) return parsed >= 0 ? parsed : null;
	return parsed > 0 ? parsed : null;
}

function asStringMap(value: unknown): Record<string, string> | null {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
	const parsed: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") return null;
		const stripped = key.trim();
		if (!stripped) return null;
		parsed[stripped] = item;
	}
	return parsed;
}

function asExecutableArgv(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const argv: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") return null;
		const token = item.trim();
		if (!token) return null;
		argv.push(token);
	}
	return argv;
}

function validateAndApplyUpdate(
	configData: ConfigData,
	key: (typeof ALLOWED_KEYS)[number],
	value: unknown,
	providers: Set<string>,
): string | null {
	if (value == null || value === "") {
		delete configData[key];
		return null;
	}
	if (key === "observer_provider") {
		if (typeof value !== "string") return "observer_provider must be string";
		const provider = value.trim().toLowerCase();
		const savedBaseUrl = configData.observer_base_url;
		const hasSavedBaseUrl = typeof savedBaseUrl === "string" && savedBaseUrl.trim().length > 0;
		if (!providers.has(provider) && !hasSavedBaseUrl) {
			return "observer_provider must match a configured provider";
		}
		configData[key] = provider;
		return null;
	}
	if (key === "observer_runtime") {
		if (typeof value !== "string") return "observer_runtime must be string";
		const runtime = value.trim().toLowerCase();
		if (!RUNTIMES.has(runtime)) {
			return "observer_runtime must be one of: api_http, claude_sidecar";
		}
		configData[key] = runtime;
		return null;
	}
	if (key === "observer_auth_source") {
		if (typeof value !== "string") return "observer_auth_source must be string";
		const source = value.trim().toLowerCase();
		if (!AUTH_SOURCES.has(source)) {
			return "observer_auth_source must be one of: auto, env, file, command, none";
		}
		configData[key] = source;
		return null;
	}
	if (key === "claude_command" || key === "observer_auth_command") {
		const argv = asExecutableArgv(value);
		if (argv == null) return `${key} must be string array`;
		if (argv.length > 0) configData[key] = argv;
		else delete configData[key];
		return null;
	}
	if (key === "observer_headers") {
		const headers = asStringMap(value);
		if (headers == null) return "observer_headers must be object of string values";
		if (Object.keys(headers).length > 0) configData[key] = headers;
		else delete configData[key];
		return null;
	}
	if (key === "sync_enabled" || key === "sync_mdns") {
		if (typeof value !== "boolean") return `${key} must be boolean`;
		configData[key] = value;
		return null;
	}
	if (
		key === "observer_base_url" ||
		key === "observer_model" ||
		key === "observer_auth_file" ||
		key === "sync_host" ||
		key === "sync_coordinator_url" ||
		key === "sync_coordinator_group"
	) {
		if (typeof value !== "string") return `${key} must be string`;
		const trimmed = value.trim();
		if (!trimmed) delete configData[key];
		else configData[key] = trimmed;
		return null;
	}
	const allowZero = key === "observer_auth_cache_ttl_s";
	const parsed = parsePositiveInt(value, allowZero);
	if (parsed == null) return `${key} must be ${allowZero ? "non-negative int" : "int"}`;
	configData[key] = parsed;
	return null;
}

function applyRuntimeEffects(changedKeys: string[], opts: ConfigRouteOptions): string[] {
	const applied: string[] = [];
	if (changedKeys.includes("raw_events_sweeper_interval_s")) {
		const configValue = readCodememConfigFile().raw_events_sweeper_interval_s;
		const seconds =
			typeof configValue === "number"
				? configValue
				: Number.parseInt(String(configValue ?? ""), 10);
		if (Number.isFinite(seconds) && seconds > 0) {
			process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS = String(seconds * 1000);
		} else {
			delete process.env.CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_MS;
		}
		opts.getSweeper?.()?.notifyConfigChanged();
		applied.push("raw_events_sweeper_interval_s");
	}
	return applied;
}

export function configRoutes(opts: ConfigRouteOptions = {}) {
	const app = new Hono();

	app.get("/api/config", (c) => {
		const configPath = getConfigPath();
		const configData = readConfigFile(configPath);
		return c.json({
			path: configPath,
			config: configData,
			defaults: DEFAULTS,
			effective: getEffectiveConfig(configData),
			env_overrides: getCodememEnvOverrides(),
			providers: loadProviderOptions(),
		});
	});

	app.post("/api/config", async (c) => {
		let payload: unknown;
		try {
			payload = (await c.req.json()) as unknown;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
			return c.json({ error: "payload must be an object" }, 400);
		}
		if (
			"config" in payload &&
			(payload as ConfigData).config != null &&
			(typeof (payload as ConfigData).config !== "object" ||
				Array.isArray((payload as ConfigData).config))
		) {
			return c.json({ error: "config must be an object" }, 400);
		}
		const updates =
			"config" in payload &&
			(payload as ConfigData).config != null &&
			typeof (payload as ConfigData).config === "object" &&
			!Array.isArray((payload as ConfigData).config)
				? ((payload as ConfigData).config as ConfigData)
				: (payload as ConfigData);

		const configPath = getCodememConfigPath();
		const beforeConfig = readCodememConfigFile();
		const beforeEffective = getEffectiveConfig(beforeConfig);
		const nextConfig: ConfigData = { ...beforeConfig };
		const providers = new Set(loadProviderOptions());

		const touchedKeys = ALLOWED_KEYS.filter((key) => key in updates);
		for (const key of ALLOWED_KEYS) {
			if (!(key in updates)) continue;
			const error = validateAndApplyUpdate(nextConfig, key, updates[key], providers);
			if (error) return c.json({ error }, 400);
		}

		let savedPath: string;
		try {
			savedPath = writeCodememConfigFile(nextConfig, configPath);
		} catch {
			return c.json({ error: "failed to write config" }, 500);
		}

		const afterEffective = getEffectiveConfig(nextConfig);
		const savedChangedKeys = ALLOWED_KEYS.filter((key) => beforeConfig[key] !== nextConfig[key]);
		const effectiveChangedKeys = ALLOWED_KEYS.filter(
			(key) => beforeEffective[key] !== afterEffective[key],
		);
		const envOverrides = getCodememEnvOverrides();
		const ignoredByEnvKeys = savedChangedKeys.filter(
			(key) => !effectiveChangedKeys.includes(key) && key in envOverrides,
		);
		const runtimeChangedKeys = [
			...new Set([...touchedKeys, ...savedChangedKeys, ...effectiveChangedKeys]),
		];
		const hotReloadedKeys = applyRuntimeEffects(runtimeChangedKeys, opts);
		const restartRequiredKeys = effectiveChangedKeys.filter(
			(key) => !HOT_RELOAD_KEYS.has(key) && !(key in envOverrides),
		);

		return c.json({
			path: savedPath,
			config: nextConfig,
			effective: afterEffective,
			effects: {
				saved_keys: savedChangedKeys,
				effective_keys: effectiveChangedKeys,
				hot_reloaded_keys: hotReloadedKeys,
				restart_required_keys: restartRequiredKeys,
				ignored_by_env_keys: ignoredByEnvKeys,
				warnings: ignoredByEnvKeys.map(
					(key) =>
						`${key} is currently controlled by ${envOverrides[key]}; saved config will not take effect until that override is removed.`,
				),
			},
		});
	});

	return app;
}
