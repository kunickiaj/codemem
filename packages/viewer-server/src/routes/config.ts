/**
 * Config routes — GET /api/config, POST /api/config.
 *
 * Ports the user-facing config read/write path from Python's
 * codemem/viewer_routes/config.py, scoped to the TS runtime's current needs.
 */

import {
	CODEMEM_CONFIG_ENV_OVERRIDES,
	CodememConfigMutationError,
	coerceObserverCommand,
	getCodememConfigPath,
	getCodememEnvOverrides,
	listObserverProviderOptions,
	mutateCodememConfigFile,
	type RawEventSweeper,
	readCodememConfigFile,
} from "@codemem/core";
import { type Context, Hono } from "hono";

type ConfigData = Record<string, unknown>;

const REDACTED_VALUE = "[redacted]";

const RUNTIMES = new Set(["api_http", "claude_sidecar", "codex_sidecar"]);
const AUTH_SOURCES = new Set(["auto", "env", "file", "command", "none"]);
const HOT_RELOAD_KEYS = new Set(["raw_events_sweeper_interval_s"]);
const EXECUTABLE_ARGV_KEYS = new Set(["claude_command", "codex_command", "observer_auth_command"]);
const BOOLEAN_KEYS = new Set([
	"sync_enabled",
	"sync_retention_enabled",
	"sync_mdns",
	"observer_tier_routing_enabled",
]);
const STRING_KEYS = new Set([
	"observer_base_url",
	"observer_model",
	"observer_simple_model",
	"observer_reasoning_effort",
	"observer_reasoning_summary",
	"observer_rich_model",
	"observer_rich_reasoning_effort",
	"observer_rich_reasoning_summary",
	"observer_auth_file",
	"sync_host",
	"sync_coordinator_url",
	"sync_coordinator_group",
]);
const TEMPERATURE_KEYS = new Set(["observer_simple_temperature", "observer_rich_temperature"]);
const PROTECTED_WRITE_KEYS = new Set<string>([
	"claude_command",
	"codex_command",
	"observer_base_url",
	"observer_auth_file",
	"observer_auth_command",
	"observer_headers",
	"sync_coordinator_url",
] as const);
const SECRET_CONFIG_KEYS = new Set<string>([
	"observer_auth_file",
	"observer_auth_command",
	"observer_headers",
	"sync_coordinator_admin_secret",
] as const);
const REMOVED_CONFIG_KEYS = new Set<string>(["observer_rich_openai_use_responses"]);
const ALLOWED_KEYS = [
	"claude_command",
	"codex_command",
	"observer_base_url",
	"observer_provider",
	"observer_model",
	"observer_tier_routing_enabled",
	"observer_simple_model",
	"observer_simple_temperature",
	"observer_reasoning_effort",
	"observer_reasoning_summary",
	"observer_rich_model",
	"observer_rich_temperature",
	"observer_rich_reasoning_effort",
	"observer_rich_reasoning_summary",
	"observer_rich_max_output_tokens",
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
	"sync_retention_enabled",
	"sync_retention_max_age_days",
	"sync_retention_max_size_mb",
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
	codex_command: ["codex"],
	observer_runtime: "api_http",
	observer_auth_source: "auto",
	observer_tier_routing_enabled: false,
	observer_auth_command: [],
	observer_auth_timeout_ms: 1500,
	observer_auth_cache_ttl_s: 300,
	observer_headers: {},
	observer_max_chars: 12000,
	pack_observation_limit: 50,
	pack_session_limit: 10,
	sync_enabled: false,
	sync_retention_enabled: false,
	sync_retention_max_age_days: 30,
	sync_retention_max_size_mb: 512,
	sync_host: "0.0.0.0",
	sync_port: 7337,
	sync_interval_s: 120,
	sync_mdns: false,
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

function withoutRemovedConfigKeys(configData: ConfigData): ConfigData {
	const next = { ...configData };
	for (const key of REMOVED_CONFIG_KEYS) {
		delete next[key];
	}
	return next;
}

function getEffectiveConfig(configData: ConfigData): ConfigData {
	const effective: ConfigData = { ...DEFAULTS, ...configData };
	for (const key of ["claude_command", "codex_command"] as const) {
		effective[key] = coerceObserverCommand(effective[key]) ?? DEFAULTS[key];
	}
	for (const [key, envVar] of Object.entries(CODEMEM_CONFIG_ENV_OVERRIDES) as Array<
		[string, string]
	>) {
		const val = process.env[envVar];
		if (val == null || val === "") continue;
		if (key === "claude_command" || key === "codex_command") {
			effective[key] = coerceObserverCommand(val) ?? effective[key];
		} else {
			effective[key] = val;
		}
	}
	return effective;
}

function redactConfigValue(key: string, value: unknown): unknown {
	if (value == null || !SECRET_CONFIG_KEYS.has(key)) return value;
	if (Array.isArray(value)) return value.length > 0 ? REDACTED_VALUE : [];
	if (typeof value === "object") {
		return Object.keys(value as Record<string, unknown>).length > 0 ? REDACTED_VALUE : {};
	}
	if (typeof value === "string") return value.trim() ? REDACTED_VALUE : "";
	return REDACTED_VALUE;
}

function sanitizeConfigForResponse(configData: ConfigData): ConfigData {
	const sanitized: ConfigData = {};
	for (const [key, value] of Object.entries(configData)) {
		sanitized[key] = redactConfigValue(key, value);
	}
	return sanitized;
}

function configValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (left == null || right == null) return left == null && right == null;
	if (typeof left === "object" || typeof right === "object") {
		return JSON.stringify(left) === JSON.stringify(right);
	}
	return false;
}

function partitionViewerUpdates(
	updates: ConfigData,
	beforeConfig: ConfigData,
): { allowedUpdates: ConfigData; error: string | null } {
	const allowedUpdates: ConfigData = {};
	for (const [key, value] of Object.entries(updates)) {
		if (!PROTECTED_WRITE_KEYS.has(key)) {
			allowedUpdates[key] = value;
			continue;
		}
		if (SECRET_CONFIG_KEYS.has(key) && value === REDACTED_VALUE) {
			continue;
		}
		if (configValuesEqual(value, beforeConfig[key])) {
			continue;
		}
		return {
			allowedUpdates: {},
			error: `${key} cannot be changed from the viewer API; edit the config file or environment instead`,
		};
	}
	return { allowedUpdates, error: null };
}

function parsePositiveInt(value: unknown, allowZero = false): number | null {
	if (typeof value === "boolean") return null;
	let parsed = Number.NaN;
	if (typeof value === "number") parsed = value;
	else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
		parsed = Number(value.trim());
	}
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return null;
	if (allowZero) return parsed >= 0 ? parsed : null;
	return parsed > 0 ? parsed : null;
}

function parseFiniteNumber(value: unknown, allowZero = true): number | null {
	if (typeof value === "boolean") return null;
	let parsed = Number.NaN;
	if (typeof value === "number") parsed = value;
	else if (typeof value === "string" && value.trim().length > 0) {
		parsed = Number(value.trim());
	}
	if (!Number.isFinite(parsed)) return null;
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

function applyObserverProvider(
	configData: ConfigData,
	value: unknown,
	providers: Set<string>,
): string | null {
	if (typeof value !== "string") return "observer_provider must be string";
	const provider = value.trim().toLowerCase();
	const savedBaseUrl = configData.observer_base_url;
	const hasSavedBaseUrl = typeof savedBaseUrl === "string" && savedBaseUrl.trim().length > 0;
	if (!providers.has(provider) && !hasSavedBaseUrl) {
		return "observer_provider must match a configured provider";
	}
	configData.observer_provider = provider;
	return null;
}

function applyNormalizedEnum(
	configData: ConfigData,
	key: "observer_runtime" | "observer_auth_source",
	value: unknown,
	allowed: Set<string>,
): string | null {
	if (typeof value !== "string") return `${key} must be string`;
	const normalized = value.trim().toLowerCase();
	if (!allowed.has(normalized)) {
		const choices =
			key === "observer_runtime"
				? "api_http, claude_sidecar, codex_sidecar"
				: "auto, env, file, command, none";
		return `${key} must be one of: ${choices}`;
	}
	configData[key] = normalized;
	return null;
}

function applyExecutableArgv(configData: ConfigData, key: string, value: unknown): string | null {
	const argv = asExecutableArgv(value);
	if (argv == null) return `${key} must be string array`;
	if (argv.length > 0) configData[key] = argv;
	else delete configData[key];
	return null;
}

function applyHeaders(configData: ConfigData, value: unknown): string | null {
	const headers = asStringMap(value);
	if (headers == null) return "observer_headers must be object of string values";
	if (Object.keys(headers).length > 0) configData.observer_headers = headers;
	else delete configData.observer_headers;
	return null;
}

function applyBoolean(configData: ConfigData, key: string, value: unknown): string | null {
	if (typeof value !== "boolean") return `${key} must be boolean`;
	configData[key] = value;
	return null;
}

function applyString(configData: ConfigData, key: string, value: unknown): string | null {
	if (typeof value !== "string") return `${key} must be string`;
	const trimmed = value.trim();
	if (trimmed) configData[key] = trimmed;
	else delete configData[key];
	return null;
}

function applyTemperature(configData: ConfigData, key: string, value: unknown): string | null {
	const parsed = parseFiniteNumber(value, true);
	if (parsed == null) return `${key} must be non-negative number`;
	configData[key] = parsed;
	return null;
}

function applyPositiveInteger(configData: ConfigData, key: string, value: unknown): string | null {
	const allowZero = key === "observer_auth_cache_ttl_s";
	const parsed = parsePositiveInt(value, allowZero);
	if (parsed == null) return `${key} must be ${allowZero ? "non-negative int" : "int"}`;
	configData[key] = parsed;
	return null;
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
		return applyObserverProvider(configData, value, providers);
	}
	if (key === "observer_runtime") {
		return applyNormalizedEnum(configData, key, value, RUNTIMES);
	}
	if (key === "observer_auth_source") {
		return applyNormalizedEnum(configData, key, value, AUTH_SOURCES);
	}
	if (EXECUTABLE_ARGV_KEYS.has(key)) {
		return applyExecutableArgv(configData, key, value);
	}
	if (key === "observer_headers") {
		return applyHeaders(configData, value);
	}
	if (BOOLEAN_KEYS.has(key)) {
		return applyBoolean(configData, key, value);
	}
	if (STRING_KEYS.has(key)) {
		return applyString(configData, key, value);
	}
	if (TEMPERATURE_KEYS.has(key)) {
		return applyTemperature(configData, key, value);
	}
	return applyPositiveInteger(configData, key, value);
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

class ConfigUpdateError extends Error {
	readonly status: 400 | 403;

	constructor(message: string, status: 400 | 403) {
		super(message);
		this.status = status;
	}
}

async function parseConfigUpdates(c: Context): Promise<ConfigData> {
	let payload: unknown;
	try {
		payload = (await c.req.json()) as unknown;
	} catch {
		throw new ConfigUpdateError("invalid json", 400);
	}
	if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
		throw new ConfigUpdateError("payload must be an object", 400);
	}
	const config = (payload as ConfigData).config;
	if (
		"config" in payload &&
		config != null &&
		(typeof config !== "object" || Array.isArray(config))
	) {
		throw new ConfigUpdateError("config must be an object", 400);
	}
	if (config != null && typeof config === "object" && !Array.isArray(config)) {
		return config as ConfigData;
	}
	return payload as ConfigData;
}

function saveViewerConfig(
	updates: ConfigData,
	configPath: string,
	providers: Set<string>,
): {
	beforeConfig: ConfigData;
	nextConfig: ConfigData;
	touchedKeys: (typeof ALLOWED_KEYS)[number][];
	savedPath: string;
} {
	let beforeConfig: ConfigData = {};
	let nextConfig: ConfigData = {};
	let touchedKeys: (typeof ALLOWED_KEYS)[number][] = [];
	const result = mutateCodememConfigFile((currentConfig) => {
		beforeConfig = withoutRemovedConfigKeys(currentConfig);
		const partitioned = partitionViewerUpdates(updates, beforeConfig);
		if (partitioned.error) throw new ConfigUpdateError(partitioned.error, 403);
		nextConfig = { ...beforeConfig };
		touchedKeys = ALLOWED_KEYS.filter((key) => key in partitioned.allowedUpdates);
		for (const key of touchedKeys) {
			const error = validateAndApplyUpdate(
				nextConfig,
				key,
				partitioned.allowedUpdates[key],
				providers,
			);
			if (error) throw new ConfigUpdateError(error, 400);
		}
		return nextConfig;
	}, configPath);
	return { beforeConfig, nextConfig, touchedKeys, savedPath: result.path };
}

function viewerConfigSavePayload(
	saved: ReturnType<typeof saveViewerConfig>,
	opts: ConfigRouteOptions,
) {
	const { beforeConfig, nextConfig, touchedKeys, savedPath } = saved;
	const beforeEffective = getEffectiveConfig(beforeConfig);
	const afterEffective = getEffectiveConfig(nextConfig);
	const savedChangedKeys = ALLOWED_KEYS.filter((key) => beforeConfig[key] !== nextConfig[key]);
	const effectiveChangedKeys = ALLOWED_KEYS.filter(
		(key) => !configValuesEqual(beforeEffective[key], afterEffective[key]),
	);
	const envOverrides = getCodememEnvOverrides();
	const ignoredByEnvKeys = savedChangedKeys.filter(
		(key) => !effectiveChangedKeys.includes(key) && key in envOverrides,
	);
	const runtimeChangedKeys = [
		...new Set([...touchedKeys, ...savedChangedKeys, ...effectiveChangedKeys]),
	];
	return {
		path: savedPath,
		config: sanitizeConfigForResponse(nextConfig),
		effective: sanitizeConfigForResponse(afterEffective),
		protected_keys: [...PROTECTED_WRITE_KEYS].sort(),
		effects: {
			saved_keys: savedChangedKeys,
			effective_keys: effectiveChangedKeys,
			hot_reloaded_keys: applyRuntimeEffects(runtimeChangedKeys, opts),
			restart_required_keys: effectiveChangedKeys.filter(
				(key) => !HOT_RELOAD_KEYS.has(key) && !(key in envOverrides),
			),
			ignored_by_env_keys: ignoredByEnvKeys,
			warnings: ignoredByEnvKeys.map(
				(key) =>
					`${key} is currently controlled by ${envOverrides[key]}; saved config will not take effect until that override is removed.`,
			),
		},
	};
}

async function handleConfigPost(c: Context, opts: ConfigRouteOptions) {
	try {
		const updates = await parseConfigUpdates(c);
		const saved = saveViewerConfig(updates, getCodememConfigPath(), new Set(loadProviderOptions()));
		return c.json(viewerConfigSavePayload(saved, opts));
	} catch (error) {
		if (error instanceof ConfigUpdateError) return c.json({ error: error.message }, error.status);
		if (error instanceof CodememConfigMutationError) return c.json({ error: error.message }, 409);
		const message = error instanceof Error ? error.message : "failed to write config";
		return c.json({ error: message }, 500);
	}
}

export function configRoutes(opts: ConfigRouteOptions = {}) {
	const app = new Hono();

	app.get("/api/config", (c) => {
		// Resolve via the core resolver so GET reflects the same file POST
		// writes — including workspace-scoped overrides honored through
		// CODEMEM_RUNTIME_ROOT / CODEMEM_WORKSPACE_ID, which the legacy local
		// getConfigPath() ignored.
		const configPath = getCodememConfigPath();
		const configData = withoutRemovedConfigKeys(readCodememConfigFile());
		const effective = getEffectiveConfig(configData);
		return c.json({
			path: configPath,
			config: sanitizeConfigForResponse(configData),
			defaults: DEFAULTS,
			effective: sanitizeConfigForResponse(effective),
			env_overrides: getCodememEnvOverrides(),
			protected_keys: [...PROTECTED_WRITE_KEYS].sort(),
			providers: loadProviderOptions(),
		});
	});

	app.post("/api/config", (c) => handleConfigPost(c, opts));

	return app;
}
