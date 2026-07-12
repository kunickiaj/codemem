/**
 * Observer client: LLM caller for analyzing coding session transcripts.
 *
 * Mirrors codemem/observer.py — resolves provider config + auth, then calls
 * an LLM (Anthropic Messages or OpenAI Chat Completions) via fetch to extract
 * memories from session transcripts.
 *
 * Supports api_http, claude_sidecar, and codex_sidecar runtimes (no opencode_run).
 * Non-streaming responses via fetch (no SDK deps).
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { codememHomeDir } from "./home.js";

import {
	buildCodexHeaders,
	extractOAuthAccess,
	extractOAuthAccountId,
	extractOAuthExpires,
	extractProviderApiKey,
	loadOpenCodeOAuthCache,
	ObserverAuthAdapter,
	type ObserverAuthMaterial,
	redactText,
	renderObserverHeaders,
	resolveOAuthProvider,
} from "./observer-auth.js";
import {
	coerceObserverCommand,
	getOpenCodeProviderConfig,
	getProviderApiKey,
	listConfiguredOpenCodeProviders,
	resolveBuiltInProviderDefaultModel,
	resolveBuiltInProviderFromModel,
	resolveBuiltInProviderModel,
	resolveCustomProviderDefaultModel,
	resolveCustomProviderFromModel,
	resolveCustomProviderModel,
	stripJsonComments,
	stripTrailingCommas,
} from "./observer-config.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_SIDECAR_MODEL = "gpt-5.1-codex-mini";

const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const FETCH_TIMEOUT_MS = 60_000;

const CLAUDE_SIDECAR_TIMEOUT_MS = 120_000;

const CODEX_SIDECAR_TIMEOUT_MS = 120_000;

function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
	return end === value.length ? value : value.slice(0, end);
}

function isSafeCommandName(value: string): boolean {
	if (!value || value === "." || value === "..") return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		const isDigit = code >= 48 && code <= 57;
		if (!isLetter && !isDigit && code !== 45 && code !== 46 && code !== 95) return false;
	}
	return true;
}

function validateSidecarExecutable(value: string): string | null {
	const executable = value.trim();
	if (!executable) return null;
	if (isAbsolute(executable)) return executable;
	return isSafeCommandName(executable) ? executable : null;
}

// Anthropic model name aliases (friendly → API id)
const ANTHROPIC_MODEL_ALIASES: Record<string, string> = {
	"claude-4.5-haiku": "claude-haiku-4-5",
	"claude-4.5-sonnet": "claude-sonnet-4-5",
	"claude-4.5-opus": "claude-opus-4-5",
	"claude-4.6-sonnet": "claude-sonnet-4-6",
	"claude-4.6-opus": "claude-opus-4-6",
	"claude-4.1-opus": "claude-opus-4-1",
	"claude-4.0-sonnet": "claude-sonnet-4-0",
	"claude-4.0-opus": "claude-opus-4-0",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObserverConfig {
	observerProvider: string | null;
	observerModel: string | null;
	observerRuntime: string | null;
	observerApiKey: string | null;
	observerBaseUrl: string | null;
	observerTemperature?: number | null;
	observerTierRoutingEnabled?: boolean;
	observerSimpleProvider?: string | null;
	observerSimpleModel?: string | null;
	observerSimpleTemperature?: number | null;
	observerRichProvider?: string | null;
	observerRichModel?: string | null;
	observerRichTemperature?: number | null;
	observerRichReasoningEffort?: string | null;
	observerRichReasoningSummary?: string | null;
	observerRichMaxOutputTokens?: number | null;
	observerOpenAIUseResponses?: boolean;
	observerReasoningEffort?: string | null;
	observerReasoningSummary?: string | null;
	observerMaxOutputTokens?: number | null;
	observerMaxChars: number;
	observerMaxTokens: number;
	observerHeaders: Record<string, string>;
	observerAuthSource: string;
	observerAuthFile: string | null;
	observerAuthCommand: string[];
	observerAuthTimeoutMs: number;
	observerAuthCacheTtlS: number;
	claudeCommand?: string[];
	codexCommand?: string[];
	observerExplicitConfigKeys?: string[];
}

export interface ObserverResponse {
	raw: string | null;
	parsed: Record<string, unknown> | null;
	provider: string;
	model: string;
	/** Wall-clock duration for this invocation, including an auth retry when needed. */
	elapsedMs?: number;
	/** Provider-reported token usage. Null when the transport does not expose it. */
	usage?: ObserverTokenUsage | null;
}

export interface ObserverTokenUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens?: number;
	cacheReadInputTokens?: number;
	cacheCreationInputTokens?: number;
}

export interface ObserverStructuredJsonResponse extends ObserverResponse {
	usedStructuredOutputs: boolean;
}

export interface ObserverStatus {
	provider: string;
	model: string;
	runtime: string;
	auth: { source: string; type: string; hasToken: boolean };
	actualModel?: string | null;
	modelFallbackApplied?: boolean;
	modelFallbackReason?: string | null;
	lastError?: { code: string; message: string } | null;
}

interface ObserverConfigKeyMapping {
	fileKey: string;
	envKey: string;
	normalizedKey: keyof ObserverConfig;
}

const OBSERVER_CONFIG_KEY_MAPPINGS: ObserverConfigKeyMapping[] = [
	{
		fileKey: "observer_tier_routing_enabled",
		envKey: "CODEMEM_OBSERVER_TIER_ROUTING_ENABLED",
		normalizedKey: "observerTierRoutingEnabled",
	},
	{
		fileKey: "observer_provider",
		envKey: "CODEMEM_OBSERVER_PROVIDER",
		normalizedKey: "observerProvider",
	},
	{ fileKey: "observer_model", envKey: "CODEMEM_OBSERVER_MODEL", normalizedKey: "observerModel" },
	{
		fileKey: "observer_runtime",
		envKey: "CODEMEM_OBSERVER_RUNTIME",
		normalizedKey: "observerRuntime",
	},
	{
		fileKey: "observer_simple_provider",
		envKey: "CODEMEM_OBSERVER_SIMPLE_PROVIDER",
		normalizedKey: "observerSimpleProvider",
	},
	{
		fileKey: "observer_simple_model",
		envKey: "CODEMEM_OBSERVER_SIMPLE_MODEL",
		normalizedKey: "observerSimpleModel",
	},
	{
		fileKey: "observer_simple_temperature",
		envKey: "CODEMEM_OBSERVER_SIMPLE_TEMPERATURE",
		normalizedKey: "observerSimpleTemperature",
	},
	{
		fileKey: "observer_rich_provider",
		envKey: "CODEMEM_OBSERVER_RICH_PROVIDER",
		normalizedKey: "observerRichProvider",
	},
	{
		fileKey: "observer_rich_model",
		envKey: "CODEMEM_OBSERVER_RICH_MODEL",
		normalizedKey: "observerRichModel",
	},
	{
		fileKey: "observer_rich_temperature",
		envKey: "CODEMEM_OBSERVER_RICH_TEMPERATURE",
		normalizedKey: "observerRichTemperature",
	},
	{
		fileKey: "observer_rich_reasoning_effort",
		envKey: "CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
		normalizedKey: "observerRichReasoningEffort",
	},
	{
		fileKey: "observer_rich_reasoning_summary",
		envKey: "CODEMEM_OBSERVER_RICH_REASONING_SUMMARY",
		normalizedKey: "observerRichReasoningSummary",
	},
	{
		fileKey: "observer_rich_max_output_tokens",
		envKey: "CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS",
		normalizedKey: "observerRichMaxOutputTokens",
	},
	{
		fileKey: "observer_openai_use_responses",
		envKey: "CODEMEM_OBSERVER_OPENAI_USE_RESPONSES",
		normalizedKey: "observerOpenAIUseResponses",
	},
	{
		fileKey: "observer_reasoning_effort",
		envKey: "CODEMEM_OBSERVER_REASONING_EFFORT",
		normalizedKey: "observerReasoningEffort",
	},
	{
		fileKey: "observer_reasoning_summary",
		envKey: "CODEMEM_OBSERVER_REASONING_SUMMARY",
		normalizedKey: "observerReasoningSummary",
	},
	{
		fileKey: "observer_max_output_tokens",
		envKey: "CODEMEM_OBSERVER_MAX_OUTPUT_TOKENS",
		normalizedKey: "observerMaxOutputTokens",
	},
];

function collectExplicitObserverConfigKeys(
	data: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
): string[] {
	const keys = new Set<string>();
	for (const { fileKey, envKey, normalizedKey } of OBSERVER_CONFIG_KEY_MAPPINGS) {
		if (fileKey in data || env[envKey] != null) keys.add(normalizedKey);
	}
	return [...keys];
}

function resolveExplicitObserverConfigKeys(
	cfg: ObserverConfig,
	configWasProvided: boolean,
): Set<string> {
	if (Array.isArray(cfg.observerExplicitConfigKeys)) {
		return new Set(cfg.observerExplicitConfigKeys);
	}
	if (!configWasProvided) return new Set();
	return new Set(
		Object.entries(cfg)
			.filter(([, value]) => value !== undefined)
			.map(([key]) => key),
	);
}

function supportsDefaultTierRouting(
	provider: string,
	runtime: string,
	hasCustomBaseUrl: boolean,
): boolean {
	if (runtime === "claude_sidecar") return true;
	if (runtime !== "api_http") return false;
	if (provider !== "openai" && provider !== "anthropic") return false;
	// A custom base URL may point at an OpenAI-compatible gateway that only
	// implements chat/completions. Rich-tier defaults turn Responses on, so we
	// cannot assume capability-safety without an explicit user opt-in.
	if (hasCustomBaseUrl) return false;
	return true;
}

function extractClaudeReportedModel(payload: Record<string, unknown>): string | null {
	const model = payload.model;
	return typeof model === "string" && model.trim() ? model.trim() : null;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function parseIntSafe(value: unknown, fallback: number): number {
	if (value == null) return fallback;
	const n = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function coerceStringMap(value: unknown): Record<string, string> | null {
	if (value == null) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return {};
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return null;
			return parsed as Record<string, string>;
		} catch {
			return null;
		}
	}
	if (typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, string>;
	}
	return null;
}

function coerceCommand(value: unknown): string[] | null {
	if (value == null) return null;
	if (Array.isArray(value)) {
		return value.every((v) => typeof v === "string") ? (value as string[]) : null;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return [];
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.every((v: unknown) => typeof v === "string")) {
				return parsed as string[];
			}
		} catch {
			/* not JSON — ignore */
		}
		return null;
	}
	return null;
}
/**
 * True when the OpenCode OAuth cache holds usable credentials for any built-in
 * provider (openai/anthropic OAuth access, or an opencode API key). Used to
 * gate codex_sidecar auto-defaulting so we do not shell the codex CLI when a
 * direct API/OAuth path is already available.
 */
function hasUsableOpenCodeOAuthCache(): boolean {
	const cache = loadOpenCodeOAuthCache();
	if (Object.keys(cache).length === 0) return false;
	const now = nowMs();
	for (const provider of ["openai", "anthropic"]) {
		const access = extractOAuthAccess(cache, provider);
		if (!access) continue;
		const expires = extractOAuthExpires(cache, provider);
		if (expires == null || expires > now) return true;
	}
	return !!extractProviderApiKey(cache, "opencode");
}

/**
 * Decide whether to auto-select the codex_sidecar runtime. Pure/testable: the
 * caller supplies the filesystem/PATH-derived facts. Auto-selection must not
 * override an explicit runtime, available API keys, the OpenCode OAuth cache,
 * or an explicitly configured file/command auth source (those feed api_http and
 * would otherwise be silently ignored once the sidecar skips provider init).
 */
export function shouldAutoSelectCodexSidecar(opts: {
	observerRuntime: string | null;
	hasAnyApiKey: boolean;
	observerAuthSource: string | null;
	observerAuthFile: string | null;
	observerAuthCommand: string[] | null;
	hasUsableOpenCodeCache: boolean;
	codexAvailable: boolean;
	codexAuthExists: boolean;
}): boolean {
	if (opts.observerRuntime) return false;
	if (opts.hasAnyApiKey) return false;
	const hasConfiguredAuthSource =
		opts.observerAuthSource === "file" ||
		opts.observerAuthSource === "command" ||
		!!opts.observerAuthFile ||
		(Array.isArray(opts.observerAuthCommand) && opts.observerAuthCommand.length > 0);
	if (hasConfiguredAuthSource) return false;
	return !opts.hasUsableOpenCodeCache && opts.codexAvailable && opts.codexAuthExists;
}

/** True when the `codex` CLI (or configured codex command) is resolvable on PATH. */
function codexCliAvailable(command: string): boolean {
	const executable = validateSidecarExecutable(command);
	if (!executable) return false;
	if (isAbsolute(executable)) return existsSync(executable);
	try {
		execFileSync(process.platform === "win32" ? "where" : "which", [executable], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Load observer config from `~/.config/codemem/config.json{c}`.
 *
 * Reads the codemem config file (not OpenCode's) and extracts observer-related
 * fields with environment variable overrides.
 */
export function loadObserverConfig(): ObserverConfig {
	const defaults: ObserverConfig = {
		observerProvider: null,
		observerModel: null,
		observerRuntime: null,
		observerApiKey: null,
		observerBaseUrl: null,
		observerTemperature: 0.2,
		observerTierRoutingEnabled: false,
		observerSimpleProvider: null,
		observerSimpleModel: null,
		observerSimpleTemperature: null,
		observerRichProvider: null,
		observerRichModel: null,
		observerRichTemperature: null,
		observerRichReasoningEffort: null,
		observerRichReasoningSummary: null,
		observerRichMaxOutputTokens: null,
		observerOpenAIUseResponses: undefined,
		observerReasoningEffort: null,
		observerReasoningSummary: null,
		observerMaxOutputTokens: null,
		observerMaxChars: 12_000,
		observerMaxTokens: 4_000,
		observerHeaders: {},
		observerAuthSource: "auto",
		observerAuthFile: null,
		observerAuthCommand: [],
		observerAuthTimeoutMs: 1_500,
		observerAuthCacheTtlS: 300,
	};

	// Read config file
	const configDir = join(codememHomeDir(), ".config", "codemem");
	const envPath = process.env.CODEMEM_CONFIG;
	let configPath: string | null = null;
	if (envPath) {
		configPath = envPath.replace(/^~/, codememHomeDir());
	} else {
		const candidates = [join(configDir, "config.json"), join(configDir, "config.jsonc")];
		configPath = candidates.find((p) => existsSync(p)) ?? null;
	}

	let data: Record<string, unknown> = {};
	if (configPath && existsSync(configPath)) {
		try {
			let text = readFileSync(configPath, "utf-8");
			if (text.trim()) {
				try {
					data = JSON.parse(text) as Record<string, unknown>;
				} catch {
					text = stripTrailingCommas(stripJsonComments(text));
					data = JSON.parse(text) as Record<string, unknown>;
				}
				if (typeof data !== "object" || data == null || Array.isArray(data)) {
					data = {};
				}
			}
		} catch {
			data = {};
		}
	}

	// Apply config file values
	const cfg = { ...defaults };

	if (typeof data.observer_provider === "string") cfg.observerProvider = data.observer_provider;
	if (typeof data.observer_model === "string") cfg.observerModel = data.observer_model;
	if (typeof data.observer_runtime === "string") cfg.observerRuntime = data.observer_runtime;
	if (typeof data.observer_api_key === "string") cfg.observerApiKey = data.observer_api_key;
	if (typeof data.observer_base_url === "string") cfg.observerBaseUrl = data.observer_base_url;
	if (data.observer_temperature != null) {
		const n = Number(data.observer_temperature);
		cfg.observerTemperature = Number.isFinite(n) ? n : cfg.observerTemperature;
	}
	if (data.observer_tier_routing_enabled != null) {
		cfg.observerTierRoutingEnabled = data.observer_tier_routing_enabled === true;
	}
	if (typeof data.observer_simple_provider === "string")
		cfg.observerSimpleProvider = data.observer_simple_provider;
	if (typeof data.observer_simple_model === "string")
		cfg.observerSimpleModel = data.observer_simple_model;
	if (data.observer_simple_temperature != null) {
		const n = Number(data.observer_simple_temperature);
		cfg.observerSimpleTemperature = Number.isFinite(n) ? n : cfg.observerSimpleTemperature;
	}
	if (typeof data.observer_rich_provider === "string")
		cfg.observerRichProvider = data.observer_rich_provider;
	if (typeof data.observer_rich_model === "string")
		cfg.observerRichModel = data.observer_rich_model;
	if (data.observer_rich_temperature != null) {
		const n = Number(data.observer_rich_temperature);
		cfg.observerRichTemperature = Number.isFinite(n) ? n : cfg.observerRichTemperature;
	}
	if (typeof data.observer_rich_reasoning_effort === "string") {
		cfg.observerRichReasoningEffort = data.observer_rich_reasoning_effort;
	}
	if (typeof data.observer_rich_reasoning_summary === "string") {
		cfg.observerRichReasoningSummary = data.observer_rich_reasoning_summary;
	}
	if (data.observer_rich_max_output_tokens != null) {
		const n = Number(data.observer_rich_max_output_tokens);
		cfg.observerRichMaxOutputTokens = Number.isFinite(n) ? n : cfg.observerRichMaxOutputTokens;
	}
	if (data.observer_openai_use_responses != null) {
		cfg.observerOpenAIUseResponses = data.observer_openai_use_responses === true;
	}
	if (typeof data.observer_reasoning_effort === "string") {
		cfg.observerReasoningEffort = data.observer_reasoning_effort;
	}
	if (typeof data.observer_reasoning_summary === "string") {
		cfg.observerReasoningSummary = data.observer_reasoning_summary;
	}
	if (data.observer_max_output_tokens != null) {
		const n = Number(data.observer_max_output_tokens);
		cfg.observerMaxOutputTokens = Number.isFinite(n) ? n : cfg.observerMaxOutputTokens;
	}
	cfg.observerMaxChars = parseIntSafe(data.observer_max_chars, cfg.observerMaxChars);
	cfg.observerMaxTokens = parseIntSafe(data.observer_max_tokens, cfg.observerMaxTokens);
	if (typeof data.observer_auth_source === "string")
		cfg.observerAuthSource = data.observer_auth_source;
	if (typeof data.observer_auth_file === "string") cfg.observerAuthFile = data.observer_auth_file;
	cfg.observerAuthTimeoutMs = parseIntSafe(
		data.observer_auth_timeout_ms,
		cfg.observerAuthTimeoutMs,
	);
	cfg.observerAuthCacheTtlS = parseIntSafe(
		data.observer_auth_cache_ttl_s,
		cfg.observerAuthCacheTtlS,
	);

	const headers = coerceStringMap(data.observer_headers);
	if (headers) cfg.observerHeaders = headers;

	const authCmd = coerceCommand(data.observer_auth_command);
	if (authCmd) cfg.observerAuthCommand = authCmd;

	// claude_command: string or string[] → string[]
	const claudeCmd = coerceObserverCommand(data.claude_command);
	if (claudeCmd) cfg.claudeCommand = claudeCmd;

	// codex_command: string or string[] → string[]
	const codexCmd = coerceObserverCommand(data.codex_command);
	if (codexCmd) cfg.codexCommand = codexCmd;

	// Apply env var overrides (take precedence over file)
	cfg.observerProvider = process.env.CODEMEM_OBSERVER_PROVIDER ?? cfg.observerProvider;
	cfg.observerModel = process.env.CODEMEM_OBSERVER_MODEL ?? cfg.observerModel;
	cfg.observerRuntime = process.env.CODEMEM_OBSERVER_RUNTIME ?? cfg.observerRuntime;
	cfg.observerApiKey = process.env.CODEMEM_OBSERVER_API_KEY ?? cfg.observerApiKey;
	cfg.observerBaseUrl = process.env.CODEMEM_OBSERVER_BASE_URL ?? cfg.observerBaseUrl;
	if (process.env.CODEMEM_OBSERVER_TEMPERATURE != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_TEMPERATURE);
		cfg.observerTemperature = Number.isFinite(n) ? n : cfg.observerTemperature;
	}
	if (process.env.CODEMEM_OBSERVER_TIER_ROUTING_ENABLED != null) {
		cfg.observerTierRoutingEnabled =
			process.env.CODEMEM_OBSERVER_TIER_ROUTING_ENABLED === "1" ||
			process.env.CODEMEM_OBSERVER_TIER_ROUTING_ENABLED === "true";
	}
	cfg.observerSimpleProvider =
		process.env.CODEMEM_OBSERVER_SIMPLE_PROVIDER ?? cfg.observerSimpleProvider;
	cfg.observerSimpleModel = process.env.CODEMEM_OBSERVER_SIMPLE_MODEL ?? cfg.observerSimpleModel;
	if (process.env.CODEMEM_OBSERVER_SIMPLE_TEMPERATURE != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_SIMPLE_TEMPERATURE);
		cfg.observerSimpleTemperature = Number.isFinite(n) ? n : cfg.observerSimpleTemperature;
	}
	cfg.observerRichProvider = process.env.CODEMEM_OBSERVER_RICH_PROVIDER ?? cfg.observerRichProvider;
	cfg.observerRichModel = process.env.CODEMEM_OBSERVER_RICH_MODEL ?? cfg.observerRichModel;
	if (process.env.CODEMEM_OBSERVER_RICH_TEMPERATURE != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_RICH_TEMPERATURE);
		cfg.observerRichTemperature = Number.isFinite(n) ? n : cfg.observerRichTemperature;
	}
	cfg.observerRichReasoningEffort =
		process.env.CODEMEM_OBSERVER_RICH_REASONING_EFFORT ?? cfg.observerRichReasoningEffort;
	cfg.observerRichReasoningSummary =
		process.env.CODEMEM_OBSERVER_RICH_REASONING_SUMMARY ?? cfg.observerRichReasoningSummary;
	if (process.env.CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS);
		cfg.observerRichMaxOutputTokens = Number.isFinite(n) ? n : cfg.observerRichMaxOutputTokens;
	}
	if (process.env.CODEMEM_OBSERVER_OPENAI_USE_RESPONSES != null) {
		cfg.observerOpenAIUseResponses =
			process.env.CODEMEM_OBSERVER_OPENAI_USE_RESPONSES === "1" ||
			process.env.CODEMEM_OBSERVER_OPENAI_USE_RESPONSES === "true";
	}
	cfg.observerReasoningEffort =
		process.env.CODEMEM_OBSERVER_REASONING_EFFORT ?? cfg.observerReasoningEffort;
	cfg.observerReasoningSummary =
		process.env.CODEMEM_OBSERVER_REASONING_SUMMARY ?? cfg.observerReasoningSummary;
	if (process.env.CODEMEM_OBSERVER_MAX_OUTPUT_TOKENS != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_MAX_OUTPUT_TOKENS);
		cfg.observerMaxOutputTokens = Number.isFinite(n) ? n : cfg.observerMaxOutputTokens;
	}
	cfg.observerAuthSource = process.env.CODEMEM_OBSERVER_AUTH_SOURCE ?? cfg.observerAuthSource;
	cfg.observerAuthFile = process.env.CODEMEM_OBSERVER_AUTH_FILE ?? cfg.observerAuthFile;
	cfg.observerMaxChars = parseIntSafe(process.env.CODEMEM_OBSERVER_MAX_CHARS, cfg.observerMaxChars);
	cfg.observerMaxTokens = parseIntSafe(
		process.env.CODEMEM_OBSERVER_MAX_TOKENS,
		cfg.observerMaxTokens,
	);
	cfg.observerAuthTimeoutMs = parseIntSafe(
		process.env.CODEMEM_OBSERVER_AUTH_TIMEOUT_MS,
		cfg.observerAuthTimeoutMs,
	);
	cfg.observerAuthCacheTtlS = parseIntSafe(
		process.env.CODEMEM_OBSERVER_AUTH_CACHE_TTL_S,
		cfg.observerAuthCacheTtlS,
	);

	const envHeaders = coerceStringMap(process.env.CODEMEM_OBSERVER_HEADERS);
	if (envHeaders) cfg.observerHeaders = envHeaders;

	const envAuthCmd = coerceCommand(process.env.CODEMEM_OBSERVER_AUTH_COMMAND);
	if (envAuthCmd) cfg.observerAuthCommand = envAuthCmd;

	const envClaudeCmd = coerceObserverCommand(process.env.CODEMEM_CLAUDE_COMMAND);
	if (envClaudeCmd) cfg.claudeCommand = envClaudeCmd;

	const envCodexCmd = coerceObserverCommand(process.env.CODEMEM_CODEX_COMMAND);
	if (envCodexCmd) cfg.codexCommand = envCodexCmd;

	// Auto-detect Claude environment for runtime default.
	// If running inside Claude Code (CLAUDE_CODE_ENTRYPOINT or CLAUDE_CODE_SESSION set),
	// no explicit runtime configured, and no API key available from any provider,
	// default to claude_sidecar.
	const hasAnyApiKey =
		!!cfg.observerApiKey ||
		!!process.env.ANTHROPIC_API_KEY ||
		!!process.env.OPENAI_API_KEY ||
		!!process.env.OPENCODE_API_KEY ||
		!!process.env.CODEX_API_KEY;
	if (
		!cfg.observerRuntime &&
		!hasAnyApiKey &&
		(process.env.CLAUDE_CODE_ENTRYPOINT || process.env.CLAUDE_CODE_SESSION)
	) {
		cfg.observerRuntime = "claude_sidecar";
	}

	// Auto-detect Codex / ChatGPT Pro environment for runtime default.
	// claude_sidecar takes precedence (set above) because this gate requires
	// `!cfg.observerRuntime`. Gating logic lives in shouldAutoSelectCodexSidecar
	// so it stays unit-testable; we only probe the filesystem/PATH when the cheap
	// preconditions (no runtime, no API key) already hold.
	if (!cfg.observerRuntime && !hasAnyApiKey) {
		const codexCommand =
			Array.isArray(cfg.codexCommand) && cfg.codexCommand.length > 0 ? cfg.codexCommand : ["codex"];
		const codexExecutable = codexCommand[0] ?? "codex";
		const codexAuthPath = join(codememHomeDir(), ".codex", "auth.json");
		const hasConfiguredAuthSource =
			cfg.observerAuthSource === "file" ||
			cfg.observerAuthSource === "command" ||
			!!cfg.observerAuthFile ||
			(Array.isArray(cfg.observerAuthCommand) && cfg.observerAuthCommand.length > 0);
		if (
			shouldAutoSelectCodexSidecar({
				observerRuntime: cfg.observerRuntime,
				hasAnyApiKey,
				observerAuthSource: cfg.observerAuthSource,
				observerAuthFile: cfg.observerAuthFile,
				observerAuthCommand: cfg.observerAuthCommand,
				// Skip the filesystem/PATH probes when a file/command auth source is
				// configured — those feed api_http and must not be hijacked.
				hasUsableOpenCodeCache: hasConfiguredAuthSource || hasUsableOpenCodeOAuthCache(),
				codexAvailable: !hasConfiguredAuthSource && codexCliAvailable(codexExecutable),
				codexAuthExists: existsSync(codexAuthPath),
			})
		) {
			cfg.observerRuntime = "codex_sidecar";
		}
	}

	cfg.observerExplicitConfigKeys = collectExplicitObserverConfigKeys(data, process.env);

	return cfg;
}

// ---------------------------------------------------------------------------
// Auth error
// ---------------------------------------------------------------------------

export class ObserverAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ObserverAuthError";
	}
}

function isAuthStatus(status: number): boolean {
	return status === 401 || status === 403;
}

// ---------------------------------------------------------------------------
// Claude sidecar helpers
// ---------------------------------------------------------------------------

/** Extract the last `{type: "result"}` JSON object from Claude CLI stdout. */
function extractClaudeResultPayload(output: string): Record<string, unknown> | null {
	if (!output) return null;
	const lines = output.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (line == null) continue;
		const text = line.trim();
		if (!text) continue;
		try {
			const payload = JSON.parse(text) as Record<string, unknown>;
			if (typeof payload === "object" && payload !== null && payload.type === "result") {
				return payload;
			}
		} catch {}
	}
	return null;
}

/**
 * Detect model-related errors from Claude CLI output.
 * Preserves the Python implementation's generous matching strategy.
 */
export function isSidecarModelError(message: string): boolean {
	const lowered = message.toLowerCase();
	return (
		lowered.includes("issue with the selected model") ||
		lowered.includes("run --model to pick a different model") ||
		(lowered.includes("model") && lowered.includes("may not exist"))
	);
}

/**
 * Detect auth-related errors from Claude CLI output.
 * Preserves the Python implementation's broad phrase matching.
 */
export function isSidecarAuthError(message: string): boolean {
	const lowered = message.toLowerCase();
	const checks = [
		"not logged in",
		"login",
		"authentication",
		"unauthorized",
		"permission denied",
		"api key",
		"anthropic_api_key",
		"setup-token",
	];
	return checks.some((token) => lowered.includes(token));
}

// ---------------------------------------------------------------------------
// Codex sidecar helpers
// ---------------------------------------------------------------------------

/**
 * Detect model-related errors from `codex exec` output.
 * Mirrors the generous matching strategy of isSidecarModelError but tuned for
 * Codex CLI phrasings (unknown/unsupported/invalid model).
 */
export function isCodexSidecarModelError(message: string): boolean {
	const lowered = message.toLowerCase();
	if (!lowered.includes("model")) return false;
	return (
		lowered.includes("unknown model") ||
		lowered.includes("unsupported model") ||
		lowered.includes("invalid model") ||
		lowered.includes("model not found") ||
		lowered.includes("not a valid model") ||
		lowered.includes("does not exist") ||
		lowered.includes("may not exist") ||
		lowered.includes("is not supported")
	);
}

/**
 * Detect auth-related errors from `codex exec` output.
 *
 * Uses anchored phrases rather than bare substrings: codex stderr streams
 * operational logs (paths, URLs, byte offsets) that would otherwise trip loose
 * tokens like "login", "401", or "403" and surface a spurious auth failure.
 */
export function isCodexSidecarAuthError(message: string): boolean {
	const lowered = message.toLowerCase();
	const phrases = [
		"not logged in",
		"please log in",
		"please login",
		"run `codex login`",
		"run codex login",
		"unauthorized",
		"authentication",
		"invalid api key",
		"expired token",
		"token expired",
	];
	if (phrases.some((token) => lowered.includes(token))) return true;
	// HTTP auth status codes, anchored so we do not match offsets like "40123".
	return /\b(401|403)\b/.test(lowered);
}

// ---------------------------------------------------------------------------
// Anthropic helpers
// ---------------------------------------------------------------------------

function normalizeAnthropicModel(model: string): string {
	const normalized = model.trim();
	if (!normalized) return normalized;
	return ANTHROPIC_MODEL_ALIASES[normalized.toLowerCase()] ?? normalized;
}

function resolveAnthropicEndpoint(): string {
	return process.env.CODEMEM_ANTHROPIC_ENDPOINT ?? ANTHROPIC_MESSAGES_ENDPOINT;
}

function buildAnthropicHeaders(token: string, isOAuth: boolean): Record<string, string> {
	const headers: Record<string, string> = {
		"anthropic-version": ANTHROPIC_VERSION,
		"content-type": "application/json",
	};
	if (isOAuth) {
		headers.authorization = `Bearer ${token}`;
		headers["anthropic-beta"] = "oauth-2025-04-20";
	} else {
		headers["x-api-key"] = token;
	}
	return headers;
}

function buildAnthropicPayload(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
): Record<string, unknown> {
	return {
		model: normalizeAnthropicModel(model),
		max_tokens: maxTokens,
		system: systemPrompt,
		messages: [{ role: "user", content: userPrompt }],
	};
}

function buildAnthropicStructuredPayload(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	return {
		model: normalizeAnthropicModel(model),
		max_tokens: maxTokens,
		system: systemPrompt,
		messages: [{ role: "user", content: userPrompt }],
		output_config: {
			format: {
				type: "json_schema",
				schema,
			},
		},
	};
}

function parseAnthropicResponse(body: Record<string, unknown>): string | null {
	const content = body.content;
	if (!Array.isArray(content)) {
		console.warn(
			`[codemem] Anthropic response has no content array (stop_reason=${body.stop_reason ?? "unknown"}, ` +
				`keys=${Object.keys(body).join(",")})`,
		);
		return null;
	}
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block != null &&
			(block as Record<string, unknown>).type === "text"
		) {
			const text = (block as Record<string, unknown>).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	if (parts.length === 0 && content.length > 0) {
		const blockTypes = content
			.map((b) =>
				typeof b === "object" && b != null ? (b as Record<string, unknown>).type : typeof b,
			)
			.join(",");
		console.warn(
			`[codemem] Anthropic response has ${content.length} content block(s) but no text blocks (types=${blockTypes}, ` +
				`stop_reason=${body.stop_reason ?? "unknown"})`,
		);
	}
	return parts.length > 0 ? parts.join("") : null;
}

interface ObserverCallResult {
	raw: string | null;
	usage: ObserverTokenUsage | null;
}

function tokenCount(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeObserverUsage(body: Record<string, unknown>): ObserverTokenUsage | null {
	const usage = body.usage;
	if (typeof usage !== "object" || usage == null || Array.isArray(usage)) return null;
	const record = usage as Record<string, unknown>;
	const inputTokens = tokenCount(record.input_tokens) ?? tokenCount(record.prompt_tokens);
	const outputTokens = tokenCount(record.output_tokens) ?? tokenCount(record.completion_tokens);
	if (inputTokens == null || outputTokens == null) return null;

	const normalized: ObserverTokenUsage = { inputTokens, outputTokens };
	const totalTokens = tokenCount(record.total_tokens);
	if (totalTokens != null) normalized.totalTokens = totalTokens;

	const inputDetails = record.input_tokens_details ?? record.prompt_tokens_details;
	const cachedTokens =
		typeof inputDetails === "object" && inputDetails != null && !Array.isArray(inputDetails)
			? tokenCount((inputDetails as Record<string, unknown>).cached_tokens)
			: null;
	const cacheReadInputTokens = tokenCount(record.cache_read_input_tokens) ?? cachedTokens;
	if (cacheReadInputTokens != null) normalized.cacheReadInputTokens = cacheReadInputTokens;
	const cacheCreationInputTokens = tokenCount(record.cache_creation_input_tokens);
	if (cacheCreationInputTokens != null) {
		normalized.cacheCreationInputTokens = cacheCreationInputTokens;
	}
	return normalized;
}

function emptyCallResult(raw: string | null): ObserverCallResult {
	return { raw, usage: null };
}

// ---------------------------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------------------------

function buildOpenAIHeaders(token: string | null): Record<string, string> {
	return token
		? {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			}
		: { "content-type": "application/json" };
}

function mergeHeadersCaseInsensitive(
	base: Record<string, string>,
	override: Record<string, string>,
): Record<string, string> {
	const merged: Record<string, string> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const normalizedKey = key.toLowerCase();
		for (const existingKey of Object.keys(merged)) {
			if (existingKey.toLowerCase() === normalizedKey) {
				delete merged[existingKey];
			}
		}
		merged[key] = value;
	}
	return merged;
}

function replaceHeadersCaseInsensitive(
	target: Record<string, string>,
	override: Record<string, string>,
): void {
	const merged = mergeHeadersCaseInsensitive(target, override);
	for (const key of Object.keys(target)) {
		delete target[key];
	}
	Object.assign(target, merged);
}

function buildOpenAIPayload(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	maxTokens: number,
	temperature: number | null,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		model,
		max_tokens: maxTokens,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
	};
	if (typeof temperature === "number" && Number.isFinite(temperature)) {
		payload.temperature = temperature;
	}
	return payload;
}

function buildOpenAIResponsesPayload(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	maxOutputTokens: number,
	reasoningEffort: string | null,
	reasoningSummary: string | null,
	temperature: number | null,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		model,
		max_output_tokens: maxOutputTokens,
		input: [
			{
				role: "developer",
				content: [{ type: "input_text", text: systemPrompt }],
			},
			{
				role: "user",
				content: [{ type: "input_text", text: userPrompt }],
			},
		],
	};
	if (typeof temperature === "number" && Number.isFinite(temperature)) {
		payload.temperature = temperature;
	}
	if (reasoningEffort || reasoningSummary) {
		const reasoning: Record<string, unknown> = {};
		if (reasoningEffort) reasoning.effort = reasoningEffort;
		if (reasoningSummary) reasoning.summary = reasoningSummary;
		payload.reasoning = reasoning;
	}
	return payload;
}

function buildOpenAIResponsesStructuredPayload(
	model: string,
	systemPrompt: string,
	userPrompt: string,
	maxOutputTokens: number,
	reasoningEffort: string | null,
	reasoningSummary: string | null,
	temperature: number | null,
	schemaName: string,
	schema: Record<string, unknown>,
): Record<string, unknown> {
	const payload = buildOpenAIResponsesPayload(
		model,
		systemPrompt,
		userPrompt,
		maxOutputTokens,
		reasoningEffort,
		reasoningSummary,
		temperature,
	);
	payload.text = {
		format: {
			type: "json_schema",
			name: schemaName,
			schema,
			strict: true,
		},
	};
	return payload;
}

function parseOpenAIResponse(body: Record<string, unknown>): string | null {
	const choices = body.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first = choices[0] as Record<string, unknown> | undefined;
	if (!first) return null;
	const message = first.message as Record<string, unknown> | undefined;
	if (!message) return null;
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block == null) continue;
		const record = block as Record<string, unknown>;
		if (
			(record.type === "text" || record.type === "output_text") &&
			typeof record.text === "string"
		) {
			parts.push(record.text);
		}
	}
	return parts.length > 0 ? parts.join("") : null;
}

function parseOpenAIResponsesResponse(body: Record<string, unknown>): string | null {
	const outputText = body.output_text;
	if (typeof outputText === "string" && outputText.trim()) return outputText;
	const output = body.output;
	if (!Array.isArray(output)) return null;
	const parts: string[] = [];
	for (const item of output) {
		if (typeof item !== "object" || item == null) continue;
		const content = (item as Record<string, unknown>).content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block !== "object" || block == null) continue;
			const record = block as Record<string, unknown>;
			if (record.type === "output_text" && typeof record.text === "string") {
				parts.push(record.text);
			}
		}
	}
	return parts.length > 0 ? parts.join("") : null;
}

// ---------------------------------------------------------------------------
// Codex consumer helpers
// ---------------------------------------------------------------------------

function resolveCodexEndpoint(): string {
	return process.env.CODEMEM_CODEX_ENDPOINT ?? CODEX_API_ENDPOINT;
}

function buildCodexPayload(
	model: string,
	systemPrompt: string,
	userPrompt: string,
): Record<string, unknown> {
	return {
		model,
		instructions: systemPrompt,
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: userPrompt }],
			},
		],
		store: false,
		stream: true,
	};
}

// ---------------------------------------------------------------------------
// SSE stream text extraction (shared for Codex and Anthropic OAuth)
// ---------------------------------------------------------------------------

function extractTextFromSSE(
	rawText: string,
	extractDelta: (event: Record<string, unknown>) => string | null,
): ObserverCallResult {
	const parts: string[] = [];
	const usageFields: Record<string, unknown> = {};
	for (const line of rawText.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const event = JSON.parse(payload) as Record<string, unknown>;
			const delta = extractDelta(event);
			if (delta) parts.push(delta);
			for (const candidate of [event, event.response, event.message]) {
				if (typeof candidate !== "object" || candidate == null || Array.isArray(candidate))
					continue;
				const usage = (candidate as Record<string, unknown>).usage;
				if (typeof usage === "object" && usage != null && !Array.isArray(usage)) {
					Object.assign(usageFields, usage);
				}
			}
		} catch {
			// skip malformed events
		}
	}
	return {
		raw: parts.length > 0 ? parts.join("").trim() : null,
		usage: normalizeObserverUsage({ usage: usageFields }),
	};
}

function extractCodexDelta(event: Record<string, unknown>): string | null {
	if (event.type === "response.output_text.delta") {
		const delta = event.delta;
		return typeof delta === "string" && delta ? delta : null;
	}
	return null;
}

function extractAnthropicStreamDelta(event: Record<string, unknown>): string | null {
	if (event.type === "content_block_delta") {
		const delta = event.delta as Record<string, unknown> | undefined;
		if (delta && delta.type === "text_delta") {
			const text = delta.text;
			return typeof text === "string" && text ? text : null;
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// nowMs helper
// ---------------------------------------------------------------------------

function nowMs(): number {
	return Date.now();
}

// ---------------------------------------------------------------------------
// ObserverClient
// ---------------------------------------------------------------------------

/**
 * LLM client for analyzing coding session transcripts and extracting memories.
 *
 * Resolves provider + auth from codemem config, then calls the LLM via fetch.
 * Supports Anthropic Messages API, OpenAI Chat Completions, Codex consumer
 * (OpenAI OAuth + SSE), and Anthropic OAuth consumer (SSE).
 */
export class ObserverClient {
	readonly provider: string;
	readonly requestedModel: string | null;
	model: string;
	readonly runtime: string;
	readonly temperature: number | null;
	readonly tierRoutingEnabled: boolean;
	readonly simpleProvider: string | null;
	readonly simpleModel: string | null;
	readonly simpleTemperature: number | null;
	readonly richProvider: string | null;
	readonly richModel: string | null;
	readonly richTemperature: number | null;
	readonly richReasoningEffort: string | null;
	readonly richReasoningSummary: string | null;
	readonly richMaxOutputTokens: number | null;
	readonly openaiUseResponses: boolean;
	readonly reasoningEffort: string | null;
	readonly reasoningSummary: string | null;
	readonly maxChars: number;
	readonly maxTokens: number;
	readonly maxOutputTokens: number;
	readonly authSource: string;
	readonly authFile: string | null;
	readonly authCommand: string[];
	readonly authTimeoutMs: number;
	readonly authCacheTtlS: number;

	/** Resolved auth material — updated on refresh. */
	auth: ObserverAuthMaterial;
	readonly authAdapter: ObserverAuthAdapter;

	private _observerHeaders: Record<string, string>;
	private _customBaseUrl: string | null;
	private _customBaseUrlAllowsNoAuth: boolean;
	private readonly _apiKey: string | null;

	// Claude sidecar state
	private readonly _claudeCommand: string[];
	private readonly _sidecarModel: string;

	// Codex sidecar state
	private readonly _codexCommand: string[];
	private readonly _codexSidecarModel: string;

	// OAuth consumer state
	private _codexAccess: string | null = null;
	private _codexAccountId: string | null = null;
	private _anthropicOAuthAccess: string | null = null;

	// Error tracking
	private _lastErrorCode: string | null = null;
	private _lastErrorMessage: string | null = null;
	private readonly _observerExplicitConfigKeys: string[];
	private _lastResolvedModel: string | null = null;
	private _sidecarModelFallbackApplied = false;
	private _sidecarModelFallbackReason: string | null = null;
	private _codexSidecarModelFallbackApplied = false;
	private _codexSidecarModelFallbackReason: string | null = null;

	constructor(config?: ObserverConfig) {
		const configWasProvided = config !== undefined;
		const cfg = config ?? loadObserverConfig();
		const explicitConfigKeys = resolveExplicitObserverConfigKeys(cfg, configWasProvided);
		this._observerExplicitConfigKeys = [...explicitConfigKeys];

		const provider = (cfg.observerProvider ?? "").toLowerCase();
		const model = (cfg.observerModel ?? "").trim();
		this.requestedModel = model || null;

		// Collect known custom providers
		const customProviders = listConfiguredOpenCodeProviders();
		if (provider && provider !== "openai" && provider !== "anthropic") {
			customProviders.add(provider);
		}

		// Resolve provider
		let resolved = provider;
		if (!resolved) {
			const inferred = resolveCustomProviderFromModel(model, customProviders);
			if (inferred) resolved = inferred;
		}
		if (!resolved) {
			const builtIn = resolveBuiltInProviderFromModel(model);
			if (builtIn) resolved = builtIn;
		}
		if (!resolved) {
			resolved = resolveOAuthProvider(null, model || DEFAULT_OPENAI_MODEL);
		}
		if (
			resolved !== "openai" &&
			resolved !== "anthropic" &&
			resolved !== "opencode" &&
			!customProviders.has(resolved)
		) {
			resolved = "openai";
		}
		this.provider = resolved;

		// Resolve runtime
		const runtimeRaw = cfg.observerRuntime;
		const runtime = typeof runtimeRaw === "string" ? runtimeRaw.trim().toLowerCase() : "api_http";
		this.runtime =
			runtime === "claude_sidecar"
				? "claude_sidecar"
				: runtime === "codex_sidecar"
					? "codex_sidecar"
					: "api_http";

		// Resolve model
		if (model) {
			this.model = model;
		} else if (resolved === "anthropic") {
			this.model = DEFAULT_ANTHROPIC_MODEL;
		} else if (resolved === "openai") {
			this.model = DEFAULT_OPENAI_MODEL;
		} else {
			this.model =
				resolveBuiltInProviderDefaultModel(resolved) ??
				resolveCustomProviderDefaultModel(resolved) ??
				"";
		}

		// Claude sidecar config
		const claudeCmd = cfg.claudeCommand;
		this._claudeCommand =
			Array.isArray(claudeCmd) && claudeCmd.length > 0 ? [...claudeCmd] : ["claude"];
		this._sidecarModel = model || DEFAULT_ANTHROPIC_MODEL;
		if (this.runtime === "claude_sidecar") {
			this.model = this._sidecarModel;
			this._lastResolvedModel = this._sidecarModel;
		}

		// Codex sidecar config
		const codexCmd = cfg.codexCommand;
		this._codexCommand = Array.isArray(codexCmd) && codexCmd.length > 0 ? [...codexCmd] : ["codex"];
		this._codexSidecarModel = model || DEFAULT_CODEX_SIDECAR_MODEL;
		if (this.runtime === "codex_sidecar") {
			this.model = this._codexSidecarModel;
			this._lastResolvedModel = this._codexSidecarModel;
		}

		this.temperature =
			typeof cfg.observerTemperature === "number" && Number.isFinite(cfg.observerTemperature)
				? cfg.observerTemperature
				: 0.2;
		const hasCustomBaseUrl =
			typeof cfg.observerBaseUrl === "string" && cfg.observerBaseUrl.trim().length > 0;
		this.tierRoutingEnabled = explicitConfigKeys.has("observerTierRoutingEnabled")
			? cfg.observerTierRoutingEnabled === true
			: supportsDefaultTierRouting(this.provider, this.runtime, hasCustomBaseUrl);
		this.simpleProvider =
			typeof cfg.observerSimpleProvider === "string" && cfg.observerSimpleProvider.trim()
				? cfg.observerSimpleProvider.trim()
				: null;
		this.simpleModel =
			typeof cfg.observerSimpleModel === "string" && cfg.observerSimpleModel.trim()
				? cfg.observerSimpleModel.trim()
				: null;
		this.simpleTemperature =
			typeof cfg.observerSimpleTemperature === "number" &&
			Number.isFinite(cfg.observerSimpleTemperature)
				? cfg.observerSimpleTemperature
				: null;
		this.richProvider =
			typeof cfg.observerRichProvider === "string" && cfg.observerRichProvider.trim()
				? cfg.observerRichProvider.trim()
				: null;
		this.richModel =
			typeof cfg.observerRichModel === "string" && cfg.observerRichModel.trim()
				? cfg.observerRichModel.trim()
				: null;
		this.richTemperature =
			typeof cfg.observerRichTemperature === "number" &&
			Number.isFinite(cfg.observerRichTemperature)
				? cfg.observerRichTemperature
				: null;
		this.richReasoningEffort =
			typeof cfg.observerRichReasoningEffort === "string" && cfg.observerRichReasoningEffort.trim()
				? cfg.observerRichReasoningEffort.trim()
				: null;
		this.richReasoningSummary =
			typeof cfg.observerRichReasoningSummary === "string" &&
			cfg.observerRichReasoningSummary.trim()
				? cfg.observerRichReasoningSummary.trim()
				: null;
		this.richMaxOutputTokens =
			typeof cfg.observerRichMaxOutputTokens === "number" &&
			Number.isFinite(cfg.observerRichMaxOutputTokens)
				? cfg.observerRichMaxOutputTokens
				: null;
		this.openaiUseResponses = explicitConfigKeys.has("observerOpenAIUseResponses")
			? cfg.observerOpenAIUseResponses === true
			: this.provider === "openai" && this.runtime === "api_http";
		this.reasoningEffort =
			typeof cfg.observerReasoningEffort === "string" && cfg.observerReasoningEffort.trim()
				? cfg.observerReasoningEffort.trim()
				: null;
		this.reasoningSummary =
			typeof cfg.observerReasoningSummary === "string" && cfg.observerReasoningSummary.trim()
				? cfg.observerReasoningSummary.trim()
				: null;
		this.maxChars = cfg.observerMaxChars;
		this.maxTokens = cfg.observerMaxTokens;
		this.maxOutputTokens =
			typeof cfg.observerMaxOutputTokens === "number" &&
			Number.isFinite(cfg.observerMaxOutputTokens)
				? cfg.observerMaxOutputTokens
				: this.maxTokens;
		this.authSource = cfg.observerAuthSource;
		this.authFile = cfg.observerAuthFile;
		this.authCommand = [...cfg.observerAuthCommand];
		this.authTimeoutMs = cfg.observerAuthTimeoutMs;
		this.authCacheTtlS = cfg.observerAuthCacheTtlS;
		this._observerHeaders = { ...cfg.observerHeaders };
		this._apiKey = cfg.observerApiKey ?? null;

		const baseUrl = cfg.observerBaseUrl;
		this._customBaseUrl = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;
		this._customBaseUrlAllowsNoAuth = this._customBaseUrl != null;

		// Set up auth adapter
		this.authAdapter = new ObserverAuthAdapter({
			source: cfg.observerAuthSource,
			filePath: cfg.observerAuthFile,
			command: cfg.observerAuthCommand,
			timeoutMs: Math.max(100, cfg.observerAuthTimeoutMs),
			cacheTtlS: Math.max(0, cfg.observerAuthCacheTtlS),
		});
		this.auth = { token: null, authType: "none", source: "none" };

		// Initialize provider client state — skip for sidecar runtimes (no API
		// key needed; auth is delegated to the local Claude/Codex CLI).
		const isSidecarRuntime = this.runtime === "claude_sidecar" || this.runtime === "codex_sidecar";
		if (!isSidecarRuntime) {
			this._initProvider(false);
		} else if (
			cfg.observerAuthSource === "file" ||
			cfg.observerAuthSource === "command" ||
			cfg.observerAuthSource === "env"
		) {
			// The sidecar runtimes authenticate through the local CLI and do not
			// consult observer_auth_source, so flag the mismatch to avoid silently
			// ignoring user config.
			const cliName = this.runtime === "codex_sidecar" ? "Codex" : "Claude";
			console.warn(
				`[codemem] observer_auth_source="${cfg.observerAuthSource}" is ignored when ` +
					`observer_runtime="${this.runtime}"; the sidecar authenticates via the local ${cliName} CLI.`,
			);
		}
	}

	toConfig(): ObserverConfig {
		return {
			observerProvider: this.provider,
			observerModel: this.model,
			observerRuntime: this.runtime,
			observerApiKey: this._apiKey,
			observerBaseUrl: this._customBaseUrl,
			observerTemperature: this.temperature,
			observerTierRoutingEnabled: this.tierRoutingEnabled,
			observerSimpleProvider: this.simpleProvider,
			observerSimpleModel: this.simpleModel,
			observerSimpleTemperature: this.simpleTemperature,
			observerRichProvider: this.richProvider,
			observerRichModel: this.richModel,
			observerRichTemperature: this.richTemperature,
			observerRichReasoningEffort: this.richReasoningEffort,
			observerRichReasoningSummary: this.richReasoningSummary,
			observerRichMaxOutputTokens: this.richMaxOutputTokens,
			observerOpenAIUseResponses: this.openaiUseResponses,
			observerReasoningEffort: this.reasoningEffort,
			observerReasoningSummary: this.reasoningSummary,
			observerMaxOutputTokens: this.maxOutputTokens,
			observerMaxChars: this.maxChars,
			observerMaxTokens: this.maxTokens,
			observerHeaders: { ...this._observerHeaders },
			observerAuthSource: this.authSource,
			observerAuthFile: this.authFile,
			observerAuthCommand: [...this.authCommand],
			observerAuthTimeoutMs: this.authTimeoutMs,
			observerAuthCacheTtlS: this.authCacheTtlS,
			claudeCommand: [...this._claudeCommand],
			codexCommand: [...this._codexCommand],
			observerExplicitConfigKeys: [...this._observerExplicitConfigKeys],
		};
	}

	/** Return the resolved runtime state of this observer client. */
	getStatus(): ObserverStatus {
		let method = "none";
		if (this.runtime === "claude_sidecar") {
			method = "claude_sidecar";
		} else if (this.runtime === "codex_sidecar") {
			method = "codex_sidecar";
		} else if (this._anthropicOAuthAccess) {
			method = "anthropic_consumer";
		} else if (this._codexAccess) {
			method = "codex_consumer";
		} else if (this.provider === "opencode" && this.auth.token) {
			method = "sdk_client";
		} else if (this.auth.token) {
			method = "api_direct";
		}

		const runtime =
			this.provider === "openai" && this.openaiUseResponses && method === "api_direct"
				? "responses_api"
				: this.runtime;

		const isSidecarRuntime = this.runtime === "claude_sidecar" || this.runtime === "codex_sidecar";
		const status: ObserverStatus = {
			provider: this.provider,
			model: isSidecarRuntime ? (this._lastResolvedModel ?? this.model) : this.model,
			runtime,
			auth: {
				source: this.auth.source,
				type: method,
				hasToken: !!this.auth.token,
			},
		};
		if (this.runtime === "claude_sidecar") {
			status.actualModel = this._lastResolvedModel;
			status.modelFallbackApplied = this._sidecarModelFallbackApplied;
			status.modelFallbackReason = this._sidecarModelFallbackReason;
		} else if (this.runtime === "codex_sidecar") {
			status.actualModel = this._lastResolvedModel;
			status.modelFallbackApplied = this._codexSidecarModelFallbackApplied;
			status.modelFallbackReason = this._codexSidecarModelFallbackReason;
		}
		if (this._lastErrorMessage) {
			status.lastError = {
				code: this._lastErrorCode ?? "observer_error",
				message: this._lastErrorMessage,
			};
		}
		return status;
	}

	/** Force-refresh auth credentials. */
	refreshAuth(force = true): void {
		this.authAdapter.invalidateCache();
		this._initProvider(force);
	}

	private canCallOpenAIDirectWithoutAuth(): boolean {
		return this._customBaseUrlAllowsNoAuth && !this._codexAccess && this.provider !== "anthropic";
	}

	/**
	 * Call the LLM with a system prompt and user prompt, return the response.
	 *
	 * This is the main entry point. On auth errors, attempts one refresh + retry.
	 */
	async observe(systemPrompt: string, userPrompt: string): Promise<ObserverResponse> {
		const startedAt = nowMs();
		// Enforce configured prompt-length cap (matches Python behavior)
		const maxChars = this.maxChars;
		const minUserBudget = Math.floor(maxChars * 0.25);
		const systemBudget = Math.max(0, maxChars - minUserBudget);
		const clippedSystem =
			systemPrompt.length > systemBudget ? systemPrompt.slice(0, systemBudget) : systemPrompt;
		const userBudget = Math.max(minUserBudget, maxChars - clippedSystem.length);
		const clippedUser =
			userPrompt.length > userBudget ? userPrompt.slice(0, userBudget) : userPrompt;

		try {
			if (this.runtime === "claude_sidecar") {
				this._lastResolvedModel = this._sidecarModel;
				this._sidecarModelFallbackApplied = false;
				this._sidecarModelFallbackReason = null;
			} else if (this.runtime === "codex_sidecar") {
				this._lastResolvedModel = this._codexSidecarModel;
				this._codexSidecarModelFallbackApplied = false;
				this._codexSidecarModelFallbackReason = null;
			}
			const call = await this._callOnce(clippedSystem, clippedUser);
			if (call.raw) this._clearLastError();
			return this._buildResponse(call, startedAt);
		} catch (err) {
			if (err instanceof ObserverAuthError) {
				// Attempt one auth refresh + retry. Note: for sidecar runtimes
				// (claude_sidecar / codex_sidecar) auth is delegated to the local CLI
				// and this.auth.token is always null, so this retry is intentionally a
				// no-op — the error propagates and the caller backs off.
				this.refreshAuth();
				if (!this.auth.token) throw err;
				try {
					const call = await this._callOnce(clippedSystem, clippedUser);
					if (call.raw) this._clearLastError();
					return this._buildResponse(call, startedAt);
				} catch {
					throw err; // re-throw original
				}
			}
			throw err;
		}
	}

	private _buildResponse(call: ObserverCallResult, startedAt: number): ObserverResponse {
		return {
			raw: call.raw,
			parsed: call.raw ? tryParseJSON(call.raw) : null,
			provider: this.provider,
			model: this._resolvedResultModel(),
			elapsedMs: Math.max(0, nowMs() - startedAt),
			usage: call.usage,
		};
	}

	/** Model string to report for a result, accounting for sidecar fallback. */
	private _resolvedResultModel(): string {
		if (this.runtime === "claude_sidecar" || this.runtime === "codex_sidecar") {
			return this._lastResolvedModel ?? this.model;
		}
		return this.model;
	}

	/**
	 * Request structured JSON output when the current provider/runtime supports it.
	 * Falls back to plain `observe()` + caller-side parsing for unsupported paths.
	 */
	async observeStructuredJson(
		systemPrompt: string,
		userPrompt: string,
		schemaName: string,
		schema: Record<string, unknown>,
	): Promise<ObserverStructuredJsonResponse> {
		const startedAt = nowMs();
		if (this.provider === "openai" && this.openaiUseResponses && !this._codexAccess) {
			if (!this.auth.token && !this.canCallOpenAIDirectWithoutAuth()) {
				this._initProvider(true);
				if (!this.auth.token && !this.canCallOpenAIDirectWithoutAuth()) {
					return {
						raw: null,
						parsed: null,
						provider: this.provider,
						model: this.model,
						elapsedMs: Math.max(0, nowMs() - startedAt),
						usage: null,
						usedStructuredOutputs: true,
					};
				}
			}

			let url: string;
			if (this._customBaseUrl) {
				url = `${stripTrailingSlashes(this._customBaseUrl)}/responses`;
			} else {
				url = "https://api.openai.com/v1/responses";
			}
			const headers = buildOpenAIHeaders(this.auth.token);
			const mergedHeaders = mergeHeadersCaseInsensitive(
				headers,
				renderObserverHeaders(this._observerHeaders, this.auth),
			);
			const payload = buildOpenAIResponsesStructuredPayload(
				this.model,
				systemPrompt,
				userPrompt,
				this.maxOutputTokens,
				this.reasoningEffort,
				this.reasoningSummary,
				this.temperature,
				schemaName,
				schema,
			);
			const call = await this._fetchJSON(url, mergedHeaders, payload, {
				parseResponse: parseOpenAIResponsesResponse,
				providerLabel: "OpenAI",
			});
			return {
				raw: call.raw,
				parsed: call.raw ? tryParseJSON(call.raw) : null,
				provider: this.provider,
				model: this.model,
				elapsedMs: Math.max(0, nowMs() - startedAt),
				usage: call.usage,
				usedStructuredOutputs: true,
			};
		}

		if (this.provider === "anthropic") {
			// Anthropic OAuth consumer uses SSE streaming which may not support
			// structured output_config reliably. Fall back to observe() for OAuth.
			// Direct API key path supports non-streaming structured outputs.
			if (!this._anthropicOAuthAccess) {
				if (!this.auth.token) {
					this._initProvider(true);
				}
				if (this.auth.token) {
					const headers = buildAnthropicHeaders(this.auth.token, false);
					const mergedHeaders = mergeHeadersCaseInsensitive(
						headers,
						renderObserverHeaders(this._observerHeaders, this.auth),
					);
					const call = await this._fetchJSON(
						resolveAnthropicEndpoint(),
						mergedHeaders,
						buildAnthropicStructuredPayload(
							this.model,
							systemPrompt,
							userPrompt,
							this.maxTokens,
							schema,
						),
						{ parseResponse: parseAnthropicResponse, providerLabel: "Anthropic" },
					);
					return {
						raw: call.raw,
						parsed: call.raw ? tryParseJSON(call.raw) : null,
						provider: this.provider,
						model: this.model,
						elapsedMs: Math.max(0, nowMs() - startedAt),
						usage: call.usage,
						usedStructuredOutputs: true,
					};
				}
			}
			// OAuth or no token — fall through to observe() fallback below
		}

		const fallback = await this.observe(systemPrompt, userPrompt);
		return {
			raw: fallback.raw,
			parsed: fallback.parsed,
			provider: fallback.provider,
			model: fallback.model,
			elapsedMs: Math.max(0, nowMs() - startedAt),
			usage: fallback.usage,
			usedStructuredOutputs: false,
		};
	}

	// -----------------------------------------------------------------------
	// Provider initialization
	// -----------------------------------------------------------------------

	private _initProvider(forceRefresh: boolean): void {
		this._codexAccess = null;
		this._codexAccountId = null;
		this._anthropicOAuthAccess = null;

		const oauthCache = loadOpenCodeOAuthCache();
		let oauthAccess: string | null = null;
		let oauthProvider: string | null = null;

		if (this.provider === "openai" || this.provider === "anthropic") {
			oauthProvider = resolveOAuthProvider(this.provider, this.model);
			oauthAccess = extractOAuthAccess(oauthCache, oauthProvider);
			const oauthExpires = extractOAuthExpires(oauthCache, oauthProvider);
			if (oauthAccess && oauthExpires != null && oauthExpires <= nowMs()) {
				oauthAccess = null;
			}
		}

		if (this.provider !== "openai" && this.provider !== "anthropic") {
			// Custom provider — resolve base URL, model ID, and headers from OpenCode config
			const providerConfig = getOpenCodeProviderConfig(this.provider);
			const hasExplicitProviderConfig = Object.keys(providerConfig).length > 0;
			const [baseUrl, modelId, providerHeaders] = hasExplicitProviderConfig
				? resolveCustomProviderModel(this.provider, this.model)
				: resolveBuiltInProviderModel(this.provider, this.model);

			// Persist resolved values for use in _callOpenAIDirect
			if (baseUrl && !this._customBaseUrl) {
				this._customBaseUrl = baseUrl;
				this._customBaseUrlAllowsNoAuth = hasExplicitProviderConfig;
			}
			if (modelId) this.model = modelId;
			if (providerHeaders && Object.keys(providerHeaders).length > 0) {
				this._observerHeaders = { ...this._observerHeaders, ...providerHeaders };
			}

			const effectiveBaseUrl = this._customBaseUrl;
			if (!effectiveBaseUrl) return;

			const cachedApiKey =
				this.provider === "opencode" ? extractProviderApiKey(oauthCache, this.provider) : null;
			const apiKey = getProviderApiKey(providerConfig) || this._apiKey || cachedApiKey;

			this.auth = this.authAdapter.resolve({
				explicitToken: apiKey,
				envTokens: [process.env.CODEMEM_OBSERVER_API_KEY ?? ""],
				forceRefresh,
			});
		} else if (this.provider === "anthropic") {
			this.auth = this.authAdapter.resolve({
				explicitToken: this._apiKey,
				envTokens: [process.env.ANTHROPIC_API_KEY ?? ""],
				oauthToken: oauthAccess,
				forceRefresh,
			});
			if (this.auth.source === "oauth" && oauthAccess) {
				this._anthropicOAuthAccess = oauthAccess;
			}
		} else {
			// OpenAI
			this.auth = this.authAdapter.resolve({
				explicitToken: this._apiKey,
				envTokens: [
					process.env.OPENCODE_API_KEY ?? "",
					process.env.OPENAI_API_KEY ?? "",
					process.env.CODEX_API_KEY ?? "",
				],
				oauthToken: oauthAccess,
				forceRefresh,
			});
			if (this.auth.source === "oauth" && oauthAccess) {
				this._codexAccess = oauthAccess;
				this._codexAccountId = extractOAuthAccountId(oauthCache, oauthProvider ?? "openai");
			}
		}
	}

	// -----------------------------------------------------------------------
	// LLM call dispatch
	// -----------------------------------------------------------------------

	private async _callOnce(systemPrompt: string, userPrompt: string): Promise<ObserverCallResult> {
		// Claude sidecar path — dispatches before any API-based paths
		if (this.runtime === "claude_sidecar") {
			return emptyCallResult(await this._callSidecar(systemPrompt, userPrompt));
		}

		// Codex sidecar path — dispatches before any API-based paths
		if (this.runtime === "codex_sidecar") {
			return emptyCallResult(await this._callCodexSidecar(systemPrompt, userPrompt));
		}

		// Codex consumer path (OpenAI OAuth)
		if (this._codexAccess) {
			return this._callCodexConsumer(systemPrompt, userPrompt);
		}

		// Anthropic OAuth consumer path
		if (this._anthropicOAuthAccess) {
			return this._callAnthropicConsumer(systemPrompt, userPrompt);
		}

		// Refresh if we have no token
		if (!this.auth.token && !this.canCallOpenAIDirectWithoutAuth()) {
			this._initProvider(true);
			if (this._codexAccess) return this._callCodexConsumer(systemPrompt, userPrompt);
			if (this._anthropicOAuthAccess) return this._callAnthropicConsumer(systemPrompt, userPrompt);
			if (!this.auth.token && !this.canCallOpenAIDirectWithoutAuth()) {
				this._setLastError(`${capitalize(this.provider)} credentials are missing.`, "auth_missing");
				return emptyCallResult(null);
			}
		}

		// Direct API call via fetch
		if (this.provider === "anthropic") {
			return this._callAnthropicDirect(systemPrompt, userPrompt);
		}
		return this._callOpenAIDirect(systemPrompt, userPrompt);
	}

	// -----------------------------------------------------------------------
	// Anthropic direct (API key)
	// -----------------------------------------------------------------------

	private async _callAnthropicDirect(
		systemPrompt: string,
		userPrompt: string,
	): Promise<ObserverCallResult> {
		const url = resolveAnthropicEndpoint();
		const token = this.auth.token ?? "";
		const headers = buildAnthropicHeaders(token, false);
		const mergedHeaders = mergeHeadersCaseInsensitive(
			headers,
			renderObserverHeaders(this._observerHeaders, this.auth),
		);
		const payload = buildAnthropicPayload(this.model, systemPrompt, userPrompt, this.maxTokens);

		return this._fetchJSON(url, mergedHeaders, payload, {
			parseResponse: parseAnthropicResponse,
			providerLabel: "Anthropic",
		});
	}

	// -----------------------------------------------------------------------
	// OpenAI direct (API key)
	// -----------------------------------------------------------------------

	private async _callOpenAIDirect(
		systemPrompt: string,
		userPrompt: string,
	): Promise<ObserverCallResult> {
		let url: string;
		if (this._customBaseUrl) {
			url = `${stripTrailingSlashes(this._customBaseUrl)}/${this.openaiUseResponses ? "responses" : "chat/completions"}`;
		} else {
			url = this.openaiUseResponses
				? "https://api.openai.com/v1/responses"
				: "https://api.openai.com/v1/chat/completions";
		}

		const headers = buildOpenAIHeaders(this.auth.token);
		const mergedHeaders = mergeHeadersCaseInsensitive(
			headers,
			renderObserverHeaders(this._observerHeaders, this.auth),
		);
		const payload = this.openaiUseResponses
			? buildOpenAIResponsesPayload(
					this.model,
					systemPrompt,
					userPrompt,
					this.maxOutputTokens,
					this.reasoningEffort,
					this.reasoningSummary,
					this.temperature,
				)
			: buildOpenAIPayload(this.model, systemPrompt, userPrompt, this.maxTokens, this.temperature);

		return this._fetchJSON(url, mergedHeaders, payload, {
			parseResponse: this.openaiUseResponses ? parseOpenAIResponsesResponse : parseOpenAIResponse,
			providerLabel: capitalize(this.provider),
		});
	}

	// -----------------------------------------------------------------------
	// Codex consumer (OpenAI OAuth + SSE streaming)
	// -----------------------------------------------------------------------

	private async _callCodexConsumer(
		systemPrompt: string,
		userPrompt: string,
	): Promise<ObserverCallResult> {
		if (!this._codexAccess) return emptyCallResult(null);

		const headers = buildCodexHeaders(this._codexAccess, this._codexAccountId);
		if (Object.keys(this._observerHeaders).length > 0) {
			const codexAuth: ObserverAuthMaterial = {
				token: this._codexAccess,
				authType: "bearer",
				source: this.auth.source,
			};
			replaceHeadersCaseInsensitive(
				headers,
				renderObserverHeaders(this._observerHeaders, codexAuth),
			);
		}
		headers["content-type"] = "application/json";

		const payload = buildCodexPayload(this.model, systemPrompt, userPrompt);
		const url = resolveCodexEndpoint();

		return this._fetchSSE(url, headers, payload, extractCodexDelta, {
			providerLabel: "OpenAI",
			authErrorMessage: "OpenAI authentication failed. Refresh credentials and retry.",
		});
	}

	// -----------------------------------------------------------------------
	// Anthropic OAuth consumer (SSE streaming)
	// -----------------------------------------------------------------------

	private async _callAnthropicConsumer(
		systemPrompt: string,
		userPrompt: string,
	): Promise<ObserverCallResult> {
		if (!this._anthropicOAuthAccess) return emptyCallResult(null);

		const headers = buildAnthropicHeaders(this._anthropicOAuthAccess, true);
		if (Object.keys(this._observerHeaders).length > 0) {
			const anthropicAuth: ObserverAuthMaterial = {
				token: this._anthropicOAuthAccess,
				authType: "bearer",
				source: this.auth.source,
			};
			replaceHeadersCaseInsensitive(
				headers,
				renderObserverHeaders(this._observerHeaders, anthropicAuth),
			);
		}

		// Append ?beta=true to the endpoint
		const baseEndpoint = resolveAnthropicEndpoint();
		const endpointUrl = new URL(baseEndpoint);
		endpointUrl.searchParams.set("beta", "true");
		const url = endpointUrl.toString();

		const payload: Record<string, unknown> = {
			model: normalizeAnthropicModel(this.model),
			max_tokens: this.maxTokens,
			stream: true,
			messages: [{ role: "user", content: userPrompt }],
			system: systemPrompt,
		};

		return this._fetchSSE(url, headers, payload, extractAnthropicStreamDelta, {
			providerLabel: "Anthropic",
			authErrorMessage: "Anthropic authentication failed. Refresh credentials and retry.",
		});
	}

	// -----------------------------------------------------------------------
	// Claude sidecar (subprocess)
	// -----------------------------------------------------------------------

	private _buildSidecarCommand(prompt: string, useModel: boolean): string[] {
		const cmd = [
			...this._claudeCommand,
			"-p",
			"--output-format",
			"json",
			"--permission-mode",
			"bypassPermissions",
		];
		if (useModel && this._sidecarModel) {
			cmd.push("--model", this._sidecarModel);
		}
		cmd.push(prompt);
		return cmd;
	}

	private async _invokeSidecar(
		prompt: string,
		useModel: boolean,
	): Promise<{ output: string | null; error: string | null; reportedModel: string | null }> {
		const cmd = this._buildSidecarCommand(prompt, useModel);
		const executable = validateSidecarExecutable(cmd[0] ?? "claude");
		if (!executable) {
			return {
				output: null,
				error: "configured claude command is invalid",
				reportedModel: null,
			};
		}
		const args = cmd.slice(1);
		// Clear Claude-Code session markers so the spawned `claude` process starts
		// fresh rather than inheriting the parent harness's session identity.
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CODEMEM_PLUGIN_IGNORE: "1",
			CODEMEM_VIEWER: "0",
			CODEMEM_VIEWER_AUTO: "0",
			CODEMEM_VIEWER_AUTO_STOP: "0",
		};
		delete env.CLAUDE_CODE_ENTRYPOINT;
		delete env.CLAUDE_CODE_SESSION;
		delete env.CLAUDECODE;

		const execFileAsync = promisify(execFile);
		try {
			// lgtm[js/command-line-injection] execFile receives a constrained executable and argv vector; no shell is used.
			const { stdout } = await execFileAsync(executable, args, {
				env,
				timeout: CLAUDE_SIDECAR_TIMEOUT_MS,
				maxBuffer: 10 * 1024 * 1024,
			});

			const payload = extractClaudeResultPayload(stdout);
			if (payload !== null) {
				const message = String(payload.result ?? "").trim();
				const isError = Boolean(payload.is_error);
				const reportedModel = extractClaudeReportedModel(payload);
				if (isError) {
					return {
						output: null,
						error: message || "claude sidecar returned an error",
						reportedModel,
					};
				}
				return { output: message || null, error: null, reportedModel };
			}

			// No result payload found — treat non-empty stdout as raw output
			const text = (stdout || "").trim();
			return { output: text || null, error: null, reportedModel: null };
		} catch (err: unknown) {
			const error = err as NodeJS.ErrnoException & {
				killed?: boolean;
				code?: string;
				stderr?: string;
				stdout?: string;
			};

			// Command not found
			if (error.code === "ENOENT") {
				console.warn(
					"[codemem] observer claude_sidecar unavailable: configured claude command not found",
				);
				return {
					output: null,
					error: "configured claude command not found",
					reportedModel: null,
				};
			}

			// stdout exceeded the configured buffer — distinct from a timeout.
			if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
				console.warn("[codemem] observer claude_sidecar stdout exceeded buffer limit");
				return {
					output: null,
					error: "claude sidecar output exceeded buffer limit",
					reportedModel: null,
				};
			}

			// Timeout (killed by signal after CLAUDE_SIDECAR_TIMEOUT_MS)
			if (error.killed) {
				console.warn("[codemem] observer claude_sidecar timed out");
				return {
					output: null,
					error: "claude sidecar call timed out",
					reportedModel: null,
				};
			}

			// Non-zero exit — check for result payload in stdout first
			if (error.stdout) {
				const payload = extractClaudeResultPayload(error.stdout);
				if (payload !== null) {
					const message = String(payload.result ?? "").trim();
					const isError = Boolean(payload.is_error);
					const reportedModel = extractClaudeReportedModel(payload);
					if (isError) {
						return {
							output: null,
							error: message || "claude sidecar returned an error",
							reportedModel,
						};
					}
					return { output: message || null, error: null, reportedModel };
				}
			}

			const message = (error.stderr || "").trim() || (error.stdout || "").trim() || String(err);
			return { output: null, error: message, reportedModel: null };
		}
	}

	private async _callSidecar(systemPrompt: string, userPrompt: string): Promise<string | null> {
		const prompt = `${systemPrompt}\n\n${userPrompt}`;

		let { output, error, reportedModel } = await this._invokeSidecar(prompt, true);
		if (reportedModel) this._lastResolvedModel = reportedModel;
		if (error && this._sidecarModel && isSidecarModelError(error)) {
			console.warn(
				`[codemem] observer claude_sidecar model unsupported; retrying with default model (model=${this._sidecarModel})`,
			);
			this._sidecarModelFallbackApplied = true;
			this._sidecarModelFallbackReason =
				"configured sidecar tier model unavailable; retried with default Claude model";
			({ output, error, reportedModel } = await this._invokeSidecar(prompt, false));
			// Only update the resolved-model marker when the sidecar actually
			// reports one. If the retry payload omits the model, leave
			// _lastResolvedModel unchanged (or null) rather than asserting a
			// default — the sidecar's own default may differ per environment.
			if (reportedModel) this._lastResolvedModel = reportedModel;
			else this._lastResolvedModel = null;
		}
		if (error) {
			if (isSidecarAuthError(error)) {
				this._setLastError(
					"Claude authentication failed. Refresh credentials and retry.",
					"auth_failed",
				);
				throw new ObserverAuthError(error);
			}
			if (isSidecarModelError(error)) {
				this._setLastError(
					`Claude model is unavailable: ${this._sidecarModel || this.model}.`,
					"invalid_model_id",
				);
			}
			console.warn(`[codemem] observer claude_sidecar call failed: ${error}`);
			return null;
		}
		return output;
	}

	// -----------------------------------------------------------------------
	// Codex sidecar (subprocess)
	// -----------------------------------------------------------------------

	/**
	 * Build the `codex exec` argv. The final agent message is captured via the
	 * `-o/--output-last-message <FILE>` flag (caller supplies the tmp path) and
	 * the prompt is read from stdin (trailing `-`).
	 */
	private _buildCodexSidecarCommand(useModel: boolean, outputFile: string): string[] {
		const cmd = [
			...this._codexCommand,
			"exec",
			"--ephemeral",
			"--ignore-user-config",
			"--skip-git-repo-check",
			"-s",
			"read-only",
		];
		if (useModel && this._codexSidecarModel) {
			cmd.push("-m", this._codexSidecarModel);
		}
		cmd.push("-o", outputFile, "-");
		return cmd;
	}

	private async _invokeCodexSidecar(
		systemPrompt: string,
		userPrompt: string,
		useModel: boolean,
	): Promise<{ output: string | null; error: string | null; reportedModel: string | null }> {
		// Unique temp file for the captured final agent message.
		const rand = Math.random().toString(36).slice(2, 10);
		const outputFile = join(
			tmpdir(),
			`codemem-codex-sidecar-${process.pid}-${Date.now()}-${rand}.txt`,
		);

		const cmd = this._buildCodexSidecarCommand(useModel, outputFile);
		const executable = validateSidecarExecutable(cmd[0] ?? "codex");
		if (!executable) {
			return {
				output: null,
				error: "configured codex command is invalid",
				reportedModel: null,
			};
		}
		const args = cmd.slice(1);

		// The prompt is sent on stdin: system prompt, blank line, then user prompt.
		const stdinPayload = `${systemPrompt}\n\n${userPrompt}`;

		// Belt-and-suspenders against recursion: suppress codemem's own hooks and
		// viewer side effects in the spawned process. CODEX_HOME is preserved
		// implicitly via ...process.env so the codex CLI resolves ChatGPT/Codex
		// auth from ~/.codex. Scrub Claude-Code session markers so a codex_sidecar
		// run launched from inside Claude Code does not leak a stale Claude session
		// identity into the spawned process (mirrors the claude_sidecar path).
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CODEMEM_PLUGIN_IGNORE: "1",
			CODEMEM_VIEWER: "0",
			CODEMEM_VIEWER_AUTO: "0",
			CODEMEM_VIEWER_AUTO_STOP: "0",
		};
		delete env.CLAUDE_CODE_ENTRYPOINT;
		delete env.CLAUDE_CODE_SESSION;
		delete env.CLAUDECODE;

		try {
			const result = await this._spawnCodex(executable, args, env, stdinPayload);

			// Read the captured final-message file first: the file-based output is
			// the source of truth, so a usable result is honored even when stdout
			// chatter tripped the buffer cap or the process was killed late.
			let fileOutput: string | null = null;
			if (existsSync(outputFile)) {
				try {
					fileOutput = readFileSync(outputFile, "utf-8").trim() || null;
				} catch {
					fileOutput = null;
				}
			}

			// If we killed the process for our own limits (timeout / buffer cap)
			// but a final-message file was still written, honor it.
			if ((result.timedOut || result.maxBufferExceeded) && fileOutput) {
				return { output: fileOutput, error: null, reportedModel: null };
			}
			if (result.timedOut) {
				console.warn("[codemem] observer codex_sidecar timed out");
				return { output: null, error: "codex sidecar call timed out", reportedModel: null };
			}
			if (result.maxBufferExceeded) {
				console.warn("[codemem] observer codex_sidecar stdout exceeded buffer limit");
				return {
					output: null,
					error: "codex sidecar output exceeded buffer limit",
					reportedModel: null,
				};
			}

			// A genuine non-zero exit is a failure even if a (possibly stale or
			// partial) output file exists — surface the error rather than trust it.
			if (result.code !== 0) {
				const message =
					redactText((result.stderr || "").trim()) ||
					redactText((result.stdout || "").trim()) ||
					`codex sidecar exited with code ${result.code}`;
				return { output: null, error: message, reportedModel: null };
			}

			const output = fileOutput ?? ((result.stdout || "").trim() || null);
			return { output, error: null, reportedModel: null };
		} catch (err: unknown) {
			const error = err as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				console.warn(
					"[codemem] observer codex_sidecar unavailable: configured codex command not found",
				);
				return { output: null, error: "configured codex command not found", reportedModel: null };
			}
			return { output: null, error: redactText(String(err)), reportedModel: null };
		} finally {
			if (existsSync(outputFile)) {
				try {
					unlinkSync(outputFile);
				} catch {
					/* best-effort cleanup */
				}
			}
		}
	}

	/**
	 * Spawn the codex CLI, write the prompt to stdin, and collect stdout/stderr.
	 * Enforces a timeout and a stdout buffer cap mirroring _invokeSidecar.
	 */
	private _spawnCodex(
		executable: string,
		args: string[],
		env: NodeJS.ProcessEnv,
		stdinPayload: string,
	): Promise<{
		code: number | null;
		stdout: string;
		stderr: string;
		timedOut: boolean;
		maxBufferExceeded: boolean;
	}> {
		const MAX_BUFFER = 10 * 1024 * 1024;
		return new Promise((resolve, reject) => {
			// lgtm[js/command-line-injection] spawn receives a constrained executable and argv vector; no shell is used.
			const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			let stdoutBytes = 0;
			let timedOut = false;
			let maxBufferExceeded = false;
			let settled = false;

			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, CODEX_SIDECAR_TIMEOUT_MS);

			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > MAX_BUFFER) {
					if (!maxBufferExceeded) {
						maxBufferExceeded = true;
						child.kill("SIGKILL");
					}
					return;
				}
				stdout += chunk.toString("utf-8");
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (stderr.length < MAX_BUFFER) stderr += chunk.toString("utf-8");
			});

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(err);
			});
			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve({ code, stdout, stderr, timedOut, maxBufferExceeded });
			});

			// Write the prompt to stdin and close it.
			child.stdin.on("error", () => {
				/* ignore EPIPE if the child exits before consuming stdin */
			});
			child.stdin.write(stdinPayload);
			child.stdin.end();
		});
	}

	private async _callCodexSidecar(
		systemPrompt: string,
		userPrompt: string,
	): Promise<string | null> {
		let { output, error, reportedModel } = await this._invokeCodexSidecar(
			systemPrompt,
			userPrompt,
			true,
		);
		// codex exec does not report the resolved model, so reportedModel is always
		// null here; the branch is retained for parity with the claude_sidecar path.
		if (reportedModel) this._lastResolvedModel = reportedModel;
		if (error && this._codexSidecarModel && isCodexSidecarModelError(error)) {
			console.warn(
				`[codemem] observer codex_sidecar model unsupported; retrying with default model (model=${this._codexSidecarModel})`,
			);
			this._codexSidecarModelFallbackApplied = true;
			this._codexSidecarModelFallbackReason =
				"configured sidecar tier model unavailable; retried with default Codex model";
			({ output, error, reportedModel } = await this._invokeCodexSidecar(
				systemPrompt,
				userPrompt,
				false,
			));
			// The codex CLI does not report the resolved model, so clear the marker
			// rather than asserting a default that may differ per environment.
			if (reportedModel) this._lastResolvedModel = reportedModel;
			else this._lastResolvedModel = null;
		}
		if (error) {
			if (isCodexSidecarAuthError(error)) {
				this._setLastError(
					"Codex authentication failed. Refresh credentials and retry.",
					"auth_failed",
				);
				throw new ObserverAuthError(error);
			}
			if (isCodexSidecarModelError(error)) {
				this._setLastError(
					`Codex model is unavailable: ${this._codexSidecarModel || this.model}.`,
					"invalid_model_id",
				);
			}
			console.warn(`[codemem] observer codex_sidecar call failed: ${redactText(error)}`);
			return null;
		}
		return output;
	}

	// -----------------------------------------------------------------------
	// Shared fetch: JSON response (non-streaming)
	// -----------------------------------------------------------------------

	private async _fetchJSON(
		url: string,
		headers: Record<string, string>,
		payload: Record<string, unknown>,
		opts: {
			parseResponse: (body: Record<string, unknown>) => string | null;
			providerLabel: string;
		},
	): Promise<ObserverCallResult> {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});

			if (!response.ok) {
				const errorText = await response.text().catch(() => "");
				this._handleHttpError(response.status, errorText, opts.providerLabel);
				return emptyCallResult(null);
			}

			const body = (await response.json()) as Record<string, unknown>;
			const result = opts.parseResponse(body);
			if (result === null) {
				this._setLastError(
					`${opts.providerLabel} returned 200 but response contained no extractable text.`,
					"empty_response",
				);
			}
			return { raw: result, usage: normalizeObserverUsage(body) };
		} catch (err) {
			if (err instanceof ObserverAuthError) throw err;
			this._setLastError(
				`${opts.providerLabel} processing failed during observer inference.`,
				"observer_call_failed",
			);
			return emptyCallResult(null);
		}
	}

	// -----------------------------------------------------------------------
	// Shared fetch: SSE streaming response
	// -----------------------------------------------------------------------

	private async _fetchSSE(
		url: string,
		headers: Record<string, string>,
		payload: Record<string, unknown>,
		extractDelta: (event: Record<string, unknown>) => string | null,
		opts: { providerLabel: string; authErrorMessage: string },
	): Promise<ObserverCallResult> {
		try {
			const response = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});

			if (!response.ok) {
				// Consume body to avoid dangling connection
				await response.text().catch(() => "");
				if (isAuthStatus(response.status)) {
					this._setLastError(opts.authErrorMessage, "auth_failed");
					throw new ObserverAuthError(`${opts.providerLabel} auth error: ${response.status}`);
				}
				this._setLastError(
					`${opts.providerLabel} request failed during observer processing.`,
					"provider_request_failed",
				);
				return emptyCallResult(null);
			}

			// Read full response body as text and parse SSE events. Token usage is
			// collected only from parsed events, never inferred from response length.
			const rawText = await response.text();
			return extractTextFromSSE(rawText, extractDelta);
		} catch (err) {
			if (err instanceof ObserverAuthError) throw err;
			this._setLastError(
				`${opts.providerLabel} processing failed during observer inference.`,
				"observer_call_failed",
			);
			return emptyCallResult(null);
		}
	}

	// -----------------------------------------------------------------------
	// Error handling
	// -----------------------------------------------------------------------

	private _handleHttpError(status: number, errorText: string, providerLabel: string): void {
		const summary = redactText(errorText);

		if (isAuthStatus(status)) {
			this._setLastError(
				`${providerLabel} authentication failed. Refresh credentials and retry.`,
				"auth_failed",
			);
			throw new ObserverAuthError(`${providerLabel} auth error: ${status}: ${summary}`);
		}

		if (status === 429) {
			this._setLastError(`${providerLabel} rate limited. Retry later.`, "rate_limited");
			return;
		}

		// Check for model-not-found in Anthropic error responses
		if (errorText) {
			try {
				const parsed = JSON.parse(errorText) as Record<string, unknown>;
				const error = parsed.error as Record<string, unknown> | undefined;
				if (error && typeof error === "object") {
					const errorType = String(error.type ?? "").toLowerCase();
					const message = String(error.message ?? "");
					if (errorType === "not_found_error" && message.toLowerCase().startsWith("model:")) {
						this._setLastError(
							`${providerLabel} model ID not found: ${message.split(":")[1]?.trim() ?? this.model}.`,
							"invalid_model_id",
						);
						return;
					}
				}
			} catch {
				// not JSON — ignore
			}
		}

		this._setLastError(`${providerLabel} request failed (${status}).`, "provider_request_failed");
	}

	private _setLastError(message: string, code?: string): void {
		const text = message.trim();
		if (!text) return;
		this._lastErrorMessage = text;
		this._lastErrorCode = (code ?? "observer_error").trim() || "observer_error";
	}

	private _clearLastError(): void {
		this._lastErrorCode = null;
		this._lastErrorMessage = null;
	}
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function tryParseJSON(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(text);
		return typeof parsed === "object" && parsed != null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}
