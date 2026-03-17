/**
 * OpenCode provider configuration loading and resolution.
 *
 * Mirrors codemem/observer_config.py — reads ~/.config/opencode/opencode.json{c},
 * resolves custom provider settings (base URL, headers, API keys), and expands
 * environment variable / file placeholders in config values.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Resolve codemem config path with CODEMEM_CONFIG override. */
export function getCodememConfigPath(): string {
	const envPath = process.env.CODEMEM_CONFIG?.trim();
	if (envPath) return expandUserPath(envPath);
	const configDir = join(homedir(), ".config", "codemem");
	const candidates = [join(configDir, "config.json"), join(configDir, "config.jsonc")];
	return candidates.find((p) => existsSync(p)) ?? join(configDir, "config.json");
}

/** Read codemem config file with the same JSON/JSONC behavior as Python. */
export function readCodememConfigFile(): Record<string, unknown> {
	const configPath = getCodememConfigPath();
	if (!existsSync(configPath)) return {};

	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
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
