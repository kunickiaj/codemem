/**
 * Observer client: LLM caller for analyzing coding session transcripts.
 *
 * Mirrors codemem/observer.py — resolves provider config + auth, then calls
 * an LLM (Anthropic Messages or OpenAI Chat Completions) via fetch to extract
 * memories from session transcripts.
 *
 * Phase 1 scope: api_http runtime only (no claude_sidecar, no opencode_run).
 * Non-streaming responses via fetch (no SDK deps).
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

const ANTHROPIC_MESSAGES_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";

const FETCH_TIMEOUT_MS = 60_000;

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
	observerSimpleModel?: string | null;
	observerSimpleTemperature?: number | null;
	observerRichModel?: string | null;
	observerRichTemperature?: number | null;
	observerRichOpenAIUseResponses?: boolean;
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
}

export interface ObserverResponse {
	raw: string | null;
	parsed: Record<string, unknown> | null;
	provider: string;
	model: string;
}

export interface ObserverStatus {
	provider: string;
	model: string;
	runtime: string;
	auth: { source: string; type: string; hasToken: boolean };
	lastError?: { code: string; message: string } | null;
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
		observerSimpleModel: null,
		observerSimpleTemperature: null,
		observerRichModel: null,
		observerRichTemperature: null,
		observerRichOpenAIUseResponses: false,
		observerRichReasoningEffort: null,
		observerRichReasoningSummary: null,
		observerRichMaxOutputTokens: null,
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
	const configDir = join(homedir(), ".config", "codemem");
	const envPath = process.env.CODEMEM_CONFIG;
	let configPath: string | null = null;
	if (envPath) {
		configPath = envPath.replace(/^~/, homedir());
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
	if (typeof data.observer_simple_model === "string")
		cfg.observerSimpleModel = data.observer_simple_model;
	if (data.observer_simple_temperature != null) {
		const n = Number(data.observer_simple_temperature);
		cfg.observerSimpleTemperature = Number.isFinite(n) ? n : cfg.observerSimpleTemperature;
	}
	if (typeof data.observer_rich_model === "string")
		cfg.observerRichModel = data.observer_rich_model;
	if (data.observer_rich_temperature != null) {
		const n = Number(data.observer_rich_temperature);
		cfg.observerRichTemperature = Number.isFinite(n) ? n : cfg.observerRichTemperature;
	}
	if (data.observer_rich_openai_use_responses != null) {
		cfg.observerRichOpenAIUseResponses = data.observer_rich_openai_use_responses === true;
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
	cfg.observerSimpleModel = process.env.CODEMEM_OBSERVER_SIMPLE_MODEL ?? cfg.observerSimpleModel;
	if (process.env.CODEMEM_OBSERVER_SIMPLE_TEMPERATURE != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_SIMPLE_TEMPERATURE);
		cfg.observerSimpleTemperature = Number.isFinite(n) ? n : cfg.observerSimpleTemperature;
	}
	cfg.observerRichModel = process.env.CODEMEM_OBSERVER_RICH_MODEL ?? cfg.observerRichModel;
	if (process.env.CODEMEM_OBSERVER_RICH_TEMPERATURE != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_RICH_TEMPERATURE);
		cfg.observerRichTemperature = Number.isFinite(n) ? n : cfg.observerRichTemperature;
	}
	if (process.env.CODEMEM_OBSERVER_RICH_OPENAI_USE_RESPONSES != null) {
		cfg.observerRichOpenAIUseResponses =
			process.env.CODEMEM_OBSERVER_RICH_OPENAI_USE_RESPONSES === "1" ||
			process.env.CODEMEM_OBSERVER_RICH_OPENAI_USE_RESPONSES === "true";
	}
	cfg.observerRichReasoningEffort =
		process.env.CODEMEM_OBSERVER_RICH_REASONING_EFFORT ?? cfg.observerRichReasoningEffort;
	cfg.observerRichReasoningSummary =
		process.env.CODEMEM_OBSERVER_RICH_REASONING_SUMMARY ?? cfg.observerRichReasoningSummary;
	if (process.env.CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS != null) {
		const n = Number(process.env.CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS);
		cfg.observerRichMaxOutputTokens = Number.isFinite(n) ? n : cfg.observerRichMaxOutputTokens;
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

// ---------------------------------------------------------------------------
// OpenAI helpers
// ---------------------------------------------------------------------------

function buildOpenAIHeaders(token: string): Record<string, string> {
	return {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	};
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

function parseOpenAIResponse(body: Record<string, unknown>): string | null {
	const choices = body.choices;
	if (!Array.isArray(choices) || choices.length === 0) return null;
	const first = choices[0] as Record<string, unknown> | undefined;
	if (!first) return null;
	const message = first.message as Record<string, unknown> | undefined;
	if (!message) return null;
	const content = message.content;
	return typeof content === "string" ? content : null;
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
): string | null {
	const parts: string[] = [];
	for (const line of rawText.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const event = JSON.parse(payload) as Record<string, unknown>;
			const delta = extractDelta(event);
			if (delta) parts.push(delta);
		} catch {
			// skip malformed events
		}
	}
	return parts.length > 0 ? parts.join("").trim() : null;
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
	model: string;
	readonly runtime: string;
	readonly temperature: number | null;
	readonly tierRoutingEnabled: boolean;
	readonly simpleModel: string | null;
	readonly simpleTemperature: number | null;
	readonly richModel: string | null;
	readonly richTemperature: number | null;
	readonly richOpenAIUseResponses: boolean;
	readonly richReasoningEffort: string | null;
	readonly richReasoningSummary: string | null;
	readonly richMaxOutputTokens: number | null;
	readonly openaiUseResponses: boolean;
	readonly reasoningEffort: string | null;
	readonly reasoningSummary: string | null;
	readonly maxChars: number;
	readonly maxTokens: number;
	readonly maxOutputTokens: number;

	/** Resolved auth material — updated on refresh. */
	auth: ObserverAuthMaterial;
	readonly authAdapter: ObserverAuthAdapter;

	private _observerHeaders: Record<string, string>;
	private _customBaseUrl: string | null;
	private readonly _apiKey: string | null;

	// OAuth consumer state
	private _codexAccess: string | null = null;
	private _codexAccountId: string | null = null;
	private _anthropicOAuthAccess: string | null = null;

	// Error tracking
	private _lastErrorCode: string | null = null;
	private _lastErrorMessage: string | null = null;

	constructor(config?: ObserverConfig) {
		const cfg = config ?? loadObserverConfig();

		const provider = (cfg.observerProvider ?? "").toLowerCase();
		const model = (cfg.observerModel ?? "").trim();

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

		// Resolve runtime (Phase 1: api_http only)
		const runtimeRaw = cfg.observerRuntime;
		const runtime = typeof runtimeRaw === "string" ? runtimeRaw.trim().toLowerCase() : "api_http";
		this.runtime = runtime === "api_http" ? "api_http" : "api_http"; // only api_http supported

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

		this.temperature =
			typeof cfg.observerTemperature === "number" && Number.isFinite(cfg.observerTemperature)
				? cfg.observerTemperature
				: 0.2;
		this.tierRoutingEnabled = cfg.observerTierRoutingEnabled === true;
		this.simpleModel =
			typeof cfg.observerSimpleModel === "string" && cfg.observerSimpleModel.trim()
				? cfg.observerSimpleModel.trim()
				: null;
		this.simpleTemperature =
			typeof cfg.observerSimpleTemperature === "number" &&
			Number.isFinite(cfg.observerSimpleTemperature)
				? cfg.observerSimpleTemperature
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
		this.richOpenAIUseResponses = cfg.observerRichOpenAIUseResponses === true;
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
		this.openaiUseResponses = cfg.observerOpenAIUseResponses === true;
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
		this._observerHeaders = { ...cfg.observerHeaders };
		this._apiKey = cfg.observerApiKey ?? null;

		const baseUrl = cfg.observerBaseUrl;
		this._customBaseUrl = typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim() : null;

		// Set up auth adapter
		this.authAdapter = new ObserverAuthAdapter({
			source: cfg.observerAuthSource,
			filePath: cfg.observerAuthFile,
			command: cfg.observerAuthCommand,
			timeoutMs: Math.max(100, cfg.observerAuthTimeoutMs),
			cacheTtlS: Math.max(0, cfg.observerAuthCacheTtlS),
		});
		this.auth = { token: null, authType: "none", source: "none" };

		// Initialize provider client state
		this._initProvider(false);
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
			observerSimpleModel: this.simpleModel,
			observerSimpleTemperature: this.simpleTemperature,
			observerRichModel: this.richModel,
			observerRichTemperature: this.richTemperature,
			observerRichOpenAIUseResponses: this.richOpenAIUseResponses,
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
			observerAuthSource: this.authAdapter.source,
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		};
	}

	/** Return the resolved runtime state of this observer client. */
	getStatus(): ObserverStatus {
		let method = "none";
		if (this._anthropicOAuthAccess) {
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

		const status: ObserverStatus = {
			provider: this.provider,
			model: this.model,
			runtime,
			auth: {
				source: this.auth.source,
				type: method,
				hasToken: !!this.auth.token,
			},
		};
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

	/**
	 * Call the LLM with a system prompt and user prompt, return the response.
	 *
	 * This is the main entry point. On auth errors, attempts one refresh + retry.
	 */
	async observe(systemPrompt: string, userPrompt: string): Promise<ObserverResponse> {
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
			const raw = await this._callOnce(clippedSystem, clippedUser);
			if (raw) this._clearLastError();
			return {
				raw,
				parsed: raw ? tryParseJSON(raw) : null,
				provider: this.provider,
				model: this.model,
			};
		} catch (err) {
			if (err instanceof ObserverAuthError) {
				// Attempt one auth refresh + retry
				this.refreshAuth();
				if (!this.auth.token) throw err;
				try {
					const raw = await this._callOnce(clippedSystem, clippedUser);
					if (raw) this._clearLastError();
					return {
						raw,
						parsed: raw ? tryParseJSON(raw) : null,
						provider: this.provider,
						model: this.model,
					};
				} catch {
					throw err; // re-throw original
				}
			}
			throw err;
		}
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
			if (baseUrl && !this._customBaseUrl) this._customBaseUrl = baseUrl;
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

	private async _callOnce(systemPrompt: string, userPrompt: string): Promise<string | null> {
		// Codex consumer path (OpenAI OAuth)
		if (this._codexAccess) {
			return this._callCodexConsumer(systemPrompt, userPrompt);
		}

		// Anthropic OAuth consumer path
		if (this._anthropicOAuthAccess) {
			return this._callAnthropicConsumer(systemPrompt, userPrompt);
		}

		// Refresh if we have no token
		if (!this.auth.token) {
			this._initProvider(true);
			if (this._codexAccess) return this._callCodexConsumer(systemPrompt, userPrompt);
			if (this._anthropicOAuthAccess) return this._callAnthropicConsumer(systemPrompt, userPrompt);
			if (!this.auth.token) {
				this._setLastError(`${capitalize(this.provider)} credentials are missing.`, "auth_missing");
				return null;
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
	): Promise<string | null> {
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
	): Promise<string | null> {
		let url: string;
		if (this._customBaseUrl) {
			url = `${this._customBaseUrl.replace(/\/+$/, "")}/${this.openaiUseResponses ? "responses" : "chat/completions"}`;
		} else {
			url = this.openaiUseResponses
				? "https://api.openai.com/v1/responses"
				: "https://api.openai.com/v1/chat/completions";
		}

		const headers = buildOpenAIHeaders(this.auth.token ?? "");
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
	): Promise<string | null> {
		if (!this._codexAccess) return null;

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
	): Promise<string | null> {
		if (!this._anthropicOAuthAccess) return null;

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
	): Promise<string | null> {
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
				return null;
			}

			const body = (await response.json()) as Record<string, unknown>;
			const result = opts.parseResponse(body);
			if (result === null) {
				this._setLastError(
					`${opts.providerLabel} returned 200 but response contained no extractable text.`,
					"empty_response",
				);
			}
			return result;
		} catch (err) {
			if (err instanceof ObserverAuthError) throw err;
			this._setLastError(
				`${opts.providerLabel} processing failed during observer inference.`,
				"observer_call_failed",
			);
			return null;
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
	): Promise<string | null> {
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
				return null;
			}

			// Read full response body as text and parse SSE events
			const rawText = await response.text();
			return extractTextFromSSE(rawText, extractDelta);
		} catch (err) {
			if (err instanceof ObserverAuthError) throw err;
			this._setLastError(
				`${opts.providerLabel} processing failed during observer inference.`,
				"observer_call_failed",
			);
			return null;
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
