/**
 * OpenCode provider configuration loading and resolution.
 *
 * Mirrors codemem/observer_config.py — reads ~/.config/opencode/opencode.json{c},
 * resolves custom provider settings (base URL, headers, API keys), and expands
 * environment variable / file placeholders in config values.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// JSONC helpers
// ---------------------------------------------------------------------------

/** Strip JavaScript-style `//` line comments and `/* ... *​/` block comments from JSONC text. */
export function stripJsonComments(text: string): string {
	const result: string[] = [];
	let inString = false;
	let escapeNext = false;
	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i);
		if (escapeNext) {
			result.push(char);
			escapeNext = false;
			continue;
		}
		if (char === "\\" && inString) {
			result.push(char);
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			result.push(char);
			continue;
		}
		if (!inString && char === "/" && i + 1 < text.length) {
			const next = text.charAt(i + 1);
			if (next === "/") {
				// Line comment — skip until newline
				let j = i + 2;
				while (j < text.length && text.charAt(j) !== "\n") j++;
				i = j - 1; // outer loop will increment
				continue;
			}
			if (next === "*") {
				// Block comment — skip until */
				let j = i + 2;
				while (j < text.length - 1) {
					if (text.charAt(j) === "*" && text.charAt(j + 1) === "/") {
						j += 2;
						break;
					}
					j++;
				}
				i = j - 1; // outer loop will increment
				continue;
			}
		}
		result.push(char);
	}
	return result.join("");
}

/** Remove trailing commas before `]` or `}` (outside strings). */
export function stripTrailingCommas(text: string): string {
	const result: string[] = [];
	let inString = false;
	let escapeNext = false;
	for (let i = 0; i < text.length; i++) {
		const char = text.charAt(i);
		if (escapeNext) {
			result.push(char);
			escapeNext = false;
			continue;
		}
		if (char === "\\" && inString) {
			result.push(char);
			escapeNext = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			result.push(char);
			continue;
		}
		if (!inString && char === ",") {
			// Look ahead past whitespace for a closing bracket/brace
			let j = i + 1;
			while (j < text.length && /\s/.test(text.charAt(j))) j++;
			if (j < text.length && (text.charAt(j) === "]" || text.charAt(j) === "}")) {
				continue; // skip the trailing comma
			}
		}
		result.push(char);
	}
	return result.join("");
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/** Load OpenCode config from `~/.config/opencode/opencode.json{c}`. */
export function loadOpenCodeConfig(): Record<string, unknown> {
	const configDir = join(homedir(), ".config", "opencode");
	const candidates = [join(configDir, "opencode.json"), join(configDir, "opencode.jsonc")];

	const configPath = candidates.find((p) => existsSync(p));
	if (!configPath) return {};

	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
	} catch {
		return {};
	}

	// Try plain JSON first
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		// fall through to JSONC
	}

	try {
		const cleaned = stripTrailingCommas(stripJsonComments(text));
		return JSON.parse(cleaned) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Expand `~/...` paths like Python's `Path(...).expanduser()`. */
export function expandUserPath(value: string): string {
	return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function isSafeWorkspaceId(value: string): boolean {
	return /^[A-Za-z0-9._:-]+$/.test(value) && !/^\.+$/.test(value);
}

export function getWorkspaceCodememConfigPath(workspaceId: string): string {
	const trimmed = workspaceId.trim();
	if (!trimmed || !isSafeWorkspaceId(trimmed)) {
		throw new Error(`Invalid workspace id for config path: ${workspaceId}`);
	}
	return join(homedir(), ".codemem", "workspaces", trimmed, "config", "codemem.json");
}

export function getWorkspaceScopedCodememConfigPath(): string | null {
	const runtimeRoot = process.env.CODEMEM_RUNTIME_ROOT?.trim();
	if (runtimeRoot) {
		const expandedRoot = expandUserPath(runtimeRoot);
		if (expandedRoot.startsWith("/")) {
			return join(expandedRoot, "config", "codemem.json");
		}
		// Invalid/relative runtime root — fall through to workspace-id lookup
	}

	const workspaceId = process.env.CODEMEM_WORKSPACE_ID?.trim();
	if (!workspaceId) return null;
	if (!isSafeWorkspaceId(workspaceId)) return null;
	return getWorkspaceCodememConfigPath(workspaceId);
}

function getLegacyCodememConfigPath(): string {
	const configDir = join(homedir(), ".config", "codemem");
	const candidates = [join(configDir, "config.json"), join(configDir, "config.jsonc")];
	return candidates.find((p) => existsSync(p)) ?? join(configDir, "config.json");
}

function getCodememConfigWritePath(): string {
	return resolveCodememConfigPath(undefined, "write").resolved.path;
}

export function readWorkspaceCodememConfigFile(workspaceId: string): Record<string, unknown> {
	return readCodememConfigFileAtPath(getWorkspaceCodememConfigPath(workspaceId));
}

/** Env var overrides matching Python's CONFIG_ENV_OVERRIDES. */
export const CODEMEM_CONFIG_ENV_OVERRIDES: Record<string, string> = {
	actor_id: "CODEMEM_ACTOR_ID",
	actor_display_name: "CODEMEM_ACTOR_DISPLAY_NAME",
	claude_command: "CODEMEM_CLAUDE_COMMAND",
	observer_provider: "CODEMEM_OBSERVER_PROVIDER",
	observer_model: "CODEMEM_OBSERVER_MODEL",
	observer_base_url: "CODEMEM_OBSERVER_BASE_URL",
	observer_runtime: "CODEMEM_OBSERVER_RUNTIME",
	observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE",
	observer_auth_file: "CODEMEM_OBSERVER_AUTH_FILE",
	observer_auth_command: "CODEMEM_OBSERVER_AUTH_COMMAND",
	observer_auth_timeout_ms: "CODEMEM_OBSERVER_AUTH_TIMEOUT_MS",
	observer_auth_cache_ttl_s: "CODEMEM_OBSERVER_AUTH_CACHE_TTL_S",
	observer_headers: "CODEMEM_OBSERVER_HEADERS",
	observer_max_chars: "CODEMEM_OBSERVER_MAX_CHARS",
	pack_observation_limit: "CODEMEM_PACK_OBSERVATION_LIMIT",
	pack_session_limit: "CODEMEM_PACK_SESSION_LIMIT",
	sync_enabled: "CODEMEM_SYNC_ENABLED",
	sync_host: "CODEMEM_SYNC_HOST",
	sync_port: "CODEMEM_SYNC_PORT",
	sync_interval_s: "CODEMEM_SYNC_INTERVAL_S",
	sync_mdns: "CODEMEM_SYNC_MDNS",
	sync_advertise: "CODEMEM_SYNC_ADVERTISE",
	sync_coordinator_url: "CODEMEM_SYNC_COORDINATOR_URL",
	sync_coordinator_group: "CODEMEM_SYNC_COORDINATOR_GROUP",
	sync_coordinator_groups: "CODEMEM_SYNC_COORDINATOR_GROUPS",
	sync_coordinator_timeout_s: "CODEMEM_SYNC_COORDINATOR_TIMEOUT_S",
	sync_coordinator_presence_ttl_s: "CODEMEM_SYNC_COORDINATOR_PRESENCE_TTL_S",
	sync_coordinator_admin_secret: "CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
	sync_retention_enabled: "CODEMEM_SYNC_RETENTION_ENABLED",
	sync_retention_max_age_days: "CODEMEM_SYNC_RETENTION_MAX_AGE_DAYS",
	sync_retention_max_size_mb: "CODEMEM_SYNC_RETENTION_MAX_SIZE_MB",
	sync_retention_interval_s: "CODEMEM_SYNC_RETENTION_INTERVAL_S",
	sync_retention_max_runtime_ms: "CODEMEM_SYNC_RETENTION_MAX_RUNTIME_MS",
	sync_retention_max_ops_per_pass: "CODEMEM_SYNC_RETENTION_MAX_OPS_PER_PASS",
	sync_projects_include: "CODEMEM_SYNC_PROJECTS_INCLUDE",
	sync_projects_exclude: "CODEMEM_SYNC_PROJECTS_EXCLUDE",
	raw_events_sweeper_interval_s: "CODEMEM_RAW_EVENTS_SWEEPER_INTERVAL_S",
};

// ---------------------------------------------------------------------------
// Unified config path resolver with full traceability
// ---------------------------------------------------------------------------

export type ConfigPathSource =
	| "cli-flag"
	| "env-codemem-config"
	| "env-runtime-root"
	| "env-workspace-id"
	| "legacy-global";

export interface ConfigPathResolution {
	path: string;
	source: ConfigPathSource;
	reason: string;
	exists: boolean;
	/** Whether this candidate is structurally valid (absolute path, safe workspace id, etc.). */
	valid: boolean;
}

export interface ConfigResolutionResult {
	resolved: ConfigPathResolution;
	fallbackChain: ConfigPathResolution[];
}

/**
 * Resolve the codemem config path with full traceability.
 *
 * Every candidate in the precedence chain is evaluated and recorded.
 * The `resolved` field is the winner; `fallbackChain` holds all rejected candidates
 * with a reason string explaining why each was skipped.
 *
 * @param cliConfigPath - explicit --config flag value (highest precedence)
 * @param mode - 'read' checks existence and falls back; 'write' takes first match
 */
export function resolveCodememConfigPath(
	cliConfigPath?: string,
	mode: "read" | "write" = "read",
): ConfigResolutionResult {
	const candidates: ConfigPathResolution[] = [];

	// 1. CLI flag (highest precedence)
	if (cliConfigPath?.trim()) {
		const path = expandUserPath(cliConfigPath.trim());
		candidates.push({
			path,
			source: "cli-flag",
			reason: `--config ${cliConfigPath}`,
			exists: existsSync(path),
			valid: true,
		});
	}

	// 2. CODEMEM_CONFIG env
	const envConfig = process.env.CODEMEM_CONFIG?.trim();
	if (envConfig) {
		const path = expandUserPath(envConfig);
		candidates.push({
			path,
			source: "env-codemem-config",
			reason: `CODEMEM_CONFIG='${envConfig}'`,
			exists: existsSync(path),
			valid: true,
		});
	}

	// 3. CODEMEM_RUNTIME_ROOT env (must be absolute after expandUser)
	const runtimeRoot = process.env.CODEMEM_RUNTIME_ROOT?.trim();
	if (runtimeRoot) {
		const expandedRoot = expandUserPath(runtimeRoot);
		const isAbsolute = expandedRoot.startsWith("/");
		const path = join(expandedRoot, "config", "codemem.json");
		candidates.push({
			path,
			source: "env-runtime-root",
			reason: isAbsolute
				? `CODEMEM_RUNTIME_ROOT='${runtimeRoot}'`
				: `CODEMEM_RUNTIME_ROOT='${runtimeRoot}' is relative, not absolute`,
			exists: isAbsolute ? existsSync(path) : false,
			valid: isAbsolute,
		});
	}

	// 4. CODEMEM_WORKSPACE_ID env (must pass isSafeWorkspaceId)
	const workspaceId = process.env.CODEMEM_WORKSPACE_ID?.trim();
	if (workspaceId) {
		const safe = isSafeWorkspaceId(workspaceId);
		const path = safe
			? getWorkspaceCodememConfigPath(workspaceId)
			: join(homedir(), ".codemem", "workspaces", workspaceId, "config", "codemem.json");
		candidates.push({
			path,
			source: "env-workspace-id",
			reason: safe
				? `CODEMEM_WORKSPACE_ID='${workspaceId}'`
				: `CODEMEM_WORKSPACE_ID='${workspaceId}' failed safety check`,
			exists: safe ? existsSync(path) : false,
			valid: safe,
		});
	}

	// 5. Legacy global config (~/.config/codemem/config.json{c})
	const legacyPath = getLegacyCodememConfigPath();
	candidates.push({
		path: legacyPath,
		source: "legacy-global",
		reason: "legacy global config",
		exists: existsSync(legacyPath),
		valid: true,
	});

	// Explicit overrides (cli-flag, env-codemem-config) are authoritative:
	// they win in both read and write mode regardless of file existence.
	// This matches the original getCodememConfigPath behavior where
	// CODEMEM_CONFIG is returned immediately without an existence check.
	const isAuthoritative = (c: ConfigPathResolution): boolean =>
		c.source === "cli-flag" || c.source === "env-codemem-config";

	// Select the winner based on mode.
	// Validity is determined structurally via the `valid` flag on each candidate,
	// not by inspecting the `reason` string.
	let resolvedIndex: number;
	if (mode === "write") {
		// Write mode: first valid candidate regardless of existence
		resolvedIndex = candidates.findIndex((c) => c.valid);
	} else {
		// Read mode: authoritative sources win immediately; otherwise first existing candidate
		const authoritativeIndex = candidates.findIndex((c) => isAuthoritative(c) && c.valid);
		if (authoritativeIndex >= 0) {
			resolvedIndex = authoritativeIndex;
		} else {
			const existingIndex = candidates.findIndex((c) => c.valid && c.exists);
			// If none exist, fall back to first valid candidate (matches getCodememConfigPath behavior)
			resolvedIndex = existingIndex >= 0 ? existingIndex : candidates.findIndex((c) => c.valid);
		}
	}

	// Should always find at least the legacy candidate, but guard anyway
	if (resolvedIndex < 0) resolvedIndex = candidates.length - 1;

	const resolved = candidates[resolvedIndex]!;
	const fallbackChain = candidates.filter((_, i) => i !== resolvedIndex);

	// Annotate skipped candidates with why they were not selected
	for (const entry of fallbackChain) {
		if (entry.source === "env-runtime-root" && entry.reason.includes("is relative")) {
			// Already has a descriptive reason
		} else if (
			entry.source === "env-workspace-id" &&
			entry.reason.includes("failed safety check")
		) {
			// Already has a descriptive reason
		} else if (mode === "read" && !entry.exists) {
			entry.reason += " (does not exist)";
		}
	}

	return { resolved, fallbackChain };
}

/**
 * Resolve codemem config path with precedence:
 * 1. explicit CODEMEM_CONFIG override
 * 2. workspace-scoped config via CODEMEM_RUNTIME_ROOT or CODEMEM_WORKSPACE_ID
 * 3. legacy global config under ~/.config/codemem/
 */
export function getCodememConfigPath(): string {
	return resolveCodememConfigPath(undefined, "read").resolved.path;
}

/** Read codemem config file with the same JSON/JSONC behavior as Python. */
export function readCodememConfigFile(): Record<string, unknown> {
	const configPath = getCodememConfigPath();
	return readCodememConfigFileAtPath(configPath);
}

export function readCodememConfigFileAtPath(configPath: string): Record<string, unknown> {
	const resolvedPath = expandUserPath(configPath);
	if (!existsSync(resolvedPath)) return {};

	let text: string;
	try {
		text = readFileSync(resolvedPath, "utf-8");
	} catch {
		return {};
	}

	if (!text.trim()) return {};

	try {
		const parsed = JSON.parse(text) as unknown;
		return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		// fall through to JSONC
	}

	try {
		const cleaned = stripTrailingCommas(stripJsonComments(text));
		const parsed = JSON.parse(cleaned) as unknown;
		return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

/** Persist the codemem config file as normalized JSON. */
export function writeCodememConfigFile(data: Record<string, unknown>, configPath?: string): string {
	const targetPath = configPath ? expandUserPath(configPath) : getCodememConfigWritePath();
	mkdirSync(dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	return targetPath;
}

export function writeWorkspaceCodememConfigFile(
	workspaceId: string,
	data: Record<string, unknown>,
): string {
	return writeCodememConfigFile(data, getWorkspaceCodememConfigPath(workspaceId));
}

/** Return active env overrides for codemem config keys. */
export function getCodememEnvOverrides(): Record<string, string> {
	const overrides: Record<string, string> = {};
	for (const [key, envVar] of Object.entries(CODEMEM_CONFIG_ENV_OVERRIDES)) {
		const val = process.env[envVar];
		if (val != null && val !== "") overrides[key] = envVar;
	}
	return overrides;
}

// ---------------------------------------------------------------------------
// Provider helpers
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
	return value != null && typeof value === "object" && !Array.isArray(value)
		? (value as AnyRecord)
		: null;
}

/** Get provider-specific config block from the opencode config. */
export function getOpenCodeProviderConfig(provider: string): AnyRecord {
	const config = loadOpenCodeConfig();
	const providerConfig = asRecord(config.provider);
	if (!providerConfig) return {};
	const data = asRecord(providerConfig[provider]);
	return data ?? {};
}

/** List all custom provider keys from the opencode config. */
export function listCustomProviders(): Set<string> {
	const config = loadOpenCodeConfig();
	const providerConfig = asRecord(config.provider);
	if (!providerConfig) return new Set();
	return new Set(Object.keys(providerConfig));
}

const BUILTIN_MODEL_PREFIX_PROVIDERS = new Set(["openai", "anthropic", "opencode"]);

function extractProviderPrefix(value: unknown): string | null {
	if (typeof value !== "string" || !value.includes("/")) return null;
	const prefix = value.split("/")[0]?.trim().toLowerCase();
	return prefix ? prefix : null;
}

export function listConfiguredOpenCodeProviders(): Set<string> {
	const providers = listCustomProviders();
	const config = loadOpenCodeConfig();
	for (const key of ["model", "small_model"]) {
		const prefix = extractProviderPrefix(config[key]);
		if (prefix) providers.add(prefix);
	}
	return providers;
}

export function listObserverProviderOptions(): string[] {
	const providers = listConfiguredOpenCodeProviders();
	for (const provider of BUILTIN_MODEL_PREFIX_PROVIDERS) providers.add(provider);
	return Array.from(providers).sort((a, b) => a.localeCompare(b));
}

export function resolveBuiltInProviderFromModel(model: string): string | null {
	const prefix = extractProviderPrefix(model);
	return prefix && BUILTIN_MODEL_PREFIX_PROVIDERS.has(prefix) ? prefix : null;
}

export function resolveBuiltInProviderDefaultModel(provider: string): string | null {
	if (provider === "openai") return "gpt-5.1-codex-mini";
	if (provider === "anthropic") return "claude-sonnet-4-20250514";
	if (provider === "opencode") return "opencode/gpt-5.1-codex-mini";
	return null;
}

export function resolveBuiltInProviderModel(
	provider: string,
	modelName: string,
): [baseUrl: string | null, modelId: string | null, headers: Record<string, string>] {
	if (provider !== "opencode") {
		return [null, modelName || resolveBuiltInProviderDefaultModel(provider), {}];
	}
	const name = modelName || resolveBuiltInProviderDefaultModel(provider) || "";
	const prefix = `${provider}/`;
	const shortName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
	return ["https://opencode.ai/zen/v1", shortName || null, {}];
}

/** Extract provider prefix from a model string like `"myprovider/model-name"`. */
export function resolveCustomProviderFromModel(
	model: string,
	providers: Set<string>,
): string | null {
	if (!model || !model.includes("/")) return null;
	const prefix = model.split("/")[0] ?? "";
	return prefix && providers.has(prefix) ? prefix : null;
}

// ---------------------------------------------------------------------------
// Placeholder resolution
// ---------------------------------------------------------------------------

/**
 * Expand `$ENV_VAR` / `${ENV_VAR}` references and `{file:/path}` placeholders.
 *
 * Environment variable expansion mirrors Python's `os.path.expandvars`.
 * File placeholders read the file content and substitute it inline.
 */
export function resolvePlaceholder(value: string): string {
	const expanded = expandEnvVars(value);
	return resolveFilePlaceholder(expanded);
}

/** Expand `$VAR` and `${VAR}` environment variable references. */
function expandEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, bare) => {
		const name = braced ?? bare;
		return process.env[name] ?? match;
	});
}

/** Expand `{file:path}` placeholders by reading the referenced file. */
function resolveFilePlaceholder(value: string): string {
	if (!value.includes("{file:")) return value;
	return value.replace(/\{file:([^}]+)\}/g, (match, rawPath: string) => {
		const trimmed = rawPath.trim();
		if (!trimmed) return match;
		const resolved = expandEnvVars(trimmed).replace(/^~/, homedir());
		try {
			return readFileSync(resolved, "utf-8").trim();
		} catch {
			return match;
		}
	});
}

// ---------------------------------------------------------------------------
// Provider option extraction
// ---------------------------------------------------------------------------

/** Extract the `options` sub-object from a provider config block. */
export function getProviderOptions(providerConfig: AnyRecord): AnyRecord {
	const options = asRecord(providerConfig.options);
	return options ?? {};
}

/** Extract `baseURL` / `baseUrl` / `base_url` from provider config. */
export function getProviderBaseUrl(providerConfig: AnyRecord): string | null {
	const options = getProviderOptions(providerConfig);
	// Use || (not ??) so empty strings fall through to the next candidate (matches Python's `or`)
	const baseUrl = options.baseURL || options.baseUrl || options.base_url || providerConfig.base_url;
	return typeof baseUrl === "string" && baseUrl ? baseUrl : null;
}

/** Extract and resolve headers (with placeholder expansion) from provider config. */
export function getProviderHeaders(providerConfig: AnyRecord): Record<string, string> {
	const options = getProviderOptions(providerConfig);
	const headers = asRecord(options.headers);
	if (!headers) return {};
	const parsed: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof key !== "string" || typeof value !== "string") continue;
		parsed[key] = resolvePlaceholder(value);
	}
	return parsed;
}

/** Extract API key from provider config (direct value or env-var reference). */
export function getProviderApiKey(providerConfig: AnyRecord): string | null {
	const options = getProviderOptions(providerConfig);
	// Use || (not ??) so empty strings fall through (matches Python's `or`)
	const apiKey = options.apiKey || providerConfig.apiKey;
	if (typeof apiKey === "string" && apiKey) {
		return resolvePlaceholder(apiKey);
	}
	const apiKeyEnv = (options.apiKeyEnv ?? options.api_key_env) as string | undefined;
	if (typeof apiKeyEnv === "string" && apiKeyEnv) {
		const value = process.env[apiKeyEnv];
		if (value) return value;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Custom provider model resolution
// ---------------------------------------------------------------------------

/** Find the default model for a custom provider. */
export function resolveCustomProviderDefaultModel(provider: string): string | null {
	const providerConfig = getOpenCodeProviderConfig(provider);
	const options = getProviderOptions(providerConfig);
	const defaultModel =
		options.defaultModel ??
		options.default_model ??
		providerConfig.defaultModel ??
		providerConfig.default_model;
	if (typeof defaultModel === "string" && defaultModel) {
		return defaultModel.startsWith(`${provider}/`) ? defaultModel : `${provider}/${defaultModel}`;
	}
	const models = asRecord(providerConfig.models);
	if (models) {
		const firstKey = Object.keys(models)[0];
		if (typeof firstKey === "string" && firstKey) {
			return `${provider}/${firstKey}`;
		}
	}
	return null;
}

/**
 * Resolve base_url, model_id, and headers for a custom provider model.
 *
 * Returns `[baseUrl, modelId, headers]`.
 */
export function resolveCustomProviderModel(
	provider: string,
	modelName: string,
): [baseUrl: string | null, modelId: string | null, headers: Record<string, string>] {
	const providerConfig = getOpenCodeProviderConfig(provider);
	const baseUrl = getProviderBaseUrl(providerConfig);
	const headers = getProviderHeaders(providerConfig);

	let name = modelName;
	if (!name) {
		name = resolveCustomProviderDefaultModel(provider) ?? "";
	}

	const prefix = `${provider}/`;
	const shortName = name.startsWith(prefix) ? name.slice(prefix.length) : name;

	const models = asRecord(providerConfig.models);
	let modelId: string | null = shortName;
	if (models) {
		const modelConfig = asRecord(models[shortName]);
		if (modelConfig && typeof modelConfig.id === "string") {
			modelId = modelConfig.id;
		}
	}

	if (typeof modelId !== "string" || !modelId) {
		modelId = null;
	}

	return [baseUrl, modelId, headers];
}
