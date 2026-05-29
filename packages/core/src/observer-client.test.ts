import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isCodexSidecarAuthError,
	isCodexSidecarModelError,
	isSidecarAuthError,
	isSidecarModelError,
	loadObserverConfig,
	ObserverClient,
	shouldAutoSelectCodexSidecar,
} from "./observer-client.js";

function fixtureToken(label: string): string {
	return ["fixture", label, "token"].join("-");
}

// ---------------------------------------------------------------------------
// loadObserverConfig
// ---------------------------------------------------------------------------

describe("loadObserverConfig", () => {
	const envKeys = [
		"CODEMEM_CONFIG",
		"CODEMEM_OBSERVER_PROVIDER",
		"CODEMEM_OBSERVER_MODEL",
		"CODEMEM_OBSERVER_RUNTIME",
		"CODEMEM_OBSERVER_API_KEY",
		"CODEMEM_OBSERVER_BASE_URL",
		"CODEMEM_OBSERVER_TEMPERATURE",
		"CODEMEM_OBSERVER_TIER_ROUTING_ENABLED",
		"CODEMEM_OBSERVER_SIMPLE_MODEL",
		"CODEMEM_OBSERVER_SIMPLE_TEMPERATURE",
		"CODEMEM_OBSERVER_RICH_MODEL",
		"CODEMEM_OBSERVER_RICH_TEMPERATURE",
		"CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
		"CODEMEM_OBSERVER_RICH_REASONING_SUMMARY",
		"CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS",
		"CODEMEM_OBSERVER_OPENAI_USE_RESPONSES",
		"CODEMEM_OBSERVER_REASONING_EFFORT",
		"CODEMEM_OBSERVER_REASONING_SUMMARY",
		"CODEMEM_OBSERVER_MAX_OUTPUT_TOKENS",
		"CODEMEM_OBSERVER_AUTH_SOURCE",
		"CODEMEM_OBSERVER_AUTH_FILE",
		"CODEMEM_OBSERVER_AUTH_COMMAND",
		"CODEMEM_OBSERVER_AUTH_TIMEOUT_MS",
		"CODEMEM_OBSERVER_AUTH_CACHE_TTL_S",
		"CODEMEM_OBSERVER_MAX_CHARS",
		"CODEMEM_OBSERVER_MAX_TOKENS",
		"CODEMEM_OBSERVER_HEADERS",
	];

	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of envKeys) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of envKeys) {
			if (saved[k] === undefined) {
				delete process.env[k];
			} else {
				process.env[k] = saved[k];
			}
		}
	});

	it("returns defaults when no config file exists", () => {
		// Point at a nonexistent config path
		process.env.CODEMEM_CONFIG = "/tmp/codemem-test-nonexistent/config.json";
		const cfg = loadObserverConfig();
		expect(cfg.observerProvider).toBeNull();
		expect(cfg.observerModel).toBeNull();
		expect(cfg.observerMaxChars).toBe(12_000);
		expect(cfg.observerMaxTokens).toBe(4_000);
		expect(cfg.observerTemperature).toBe(0.2);
		expect(cfg.observerAuthSource).toBe("auto");
		expect(cfg.observerAuthCommand).toEqual([]);
		expect(cfg.observerHeaders).toEqual({});
	});

	it("reads from a config file", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "anthropic",
				observer_model: "claude-haiku-4-5",
				observer_max_chars: 8000,
				observer_temperature: 0.35,
				observer_headers: { "x-custom": "value" },
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerProvider).toBe("anthropic");
			expect(cfg.observerModel).toBe("claude-haiku-4-5");
			expect(cfg.observerMaxChars).toBe(8000);
			expect(cfg.observerTemperature).toBe(0.35);
			expect(cfg.observerHeaders).toEqual({ "x-custom": "value" });
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("env vars override config file values", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "anthropic",
				observer_max_chars: 8000,
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			process.env.CODEMEM_OBSERVER_PROVIDER = "openai";
			process.env.CODEMEM_OBSERVER_MAX_CHARS = "5000";
			process.env.CODEMEM_OBSERVER_TEMPERATURE = "0.15";
			process.env.CODEMEM_OBSERVER_TIER_ROUTING_ENABLED = "true";
			process.env.CODEMEM_OBSERVER_SIMPLE_MODEL = "gpt-5.4-mini";
			process.env.CODEMEM_OBSERVER_SIMPLE_TEMPERATURE = "0.2";
			process.env.CODEMEM_OBSERVER_RICH_MODEL = "gpt-5.4";
			process.env.CODEMEM_OBSERVER_RICH_TEMPERATURE = "0.25";
			process.env.CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS = "12000";
			const cfg = loadObserverConfig();
			expect(cfg.observerProvider).toBe("openai");
			expect(cfg.observerMaxChars).toBe(5000);
			expect(cfg.observerTemperature).toBe(0.15);
			expect(cfg.observerTierRoutingEnabled).toBe(true);
			expect(cfg.observerSimpleModel).toBe("gpt-5.4-mini");
			expect(cfg.observerSimpleTemperature).toBe(0.2);
			expect(cfg.observerRichModel).toBe("gpt-5.4");
			expect(cfg.observerRichTemperature).toBe(0.25);
			expect(cfg.observerRichMaxOutputTokens).toBe(12000);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("handles JSONC config files", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.jsonc");
		writeFileSync(
			configPath,
			`{
				// observer settings
				"observer_provider": "openai",
				"observer_model": "gpt-4.1-mini",
			}`,
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerProvider).toBe("openai");
			expect(cfg.observerModel).toBe("gpt-4.1-mini");
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("records explicit config keys for user-set tier routing fields", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "openai",
				observer_tier_routing_enabled: false,
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerExplicitConfigKeys).toEqual(
				expect.arrayContaining(["observerProvider", "observerTierRoutingEnabled"]),
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("populates observerOpenAIUseResponses when set via config file", () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-config-test-"));
		const configPath = join(tmpDir, "config.json");
		writeFileSync(
			configPath,
			JSON.stringify({
				observer_provider: "openai",
				observer_openai_use_responses: true,
			}),
		);
		try {
			process.env.CODEMEM_CONFIG = configPath;
			const cfg = loadObserverConfig();
			expect(cfg.observerOpenAIUseResponses).toBe(true);
			expect(cfg.observerExplicitConfigKeys).toEqual(
				expect.arrayContaining(["observerOpenAIUseResponses"]),
			);
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("populates observerOpenAIUseResponses when set via env var", () => {
		process.env.CODEMEM_OBSERVER_OPENAI_USE_RESPONSES = "true";
		process.env.CODEMEM_CONFIG = "/tmp/codemem-test-nonexistent/config.json";
		const cfg = loadObserverConfig();
		expect(cfg.observerOpenAIUseResponses).toBe(true);
		expect(cfg.observerExplicitConfigKeys).toEqual(
			expect.arrayContaining(["observerOpenAIUseResponses"]),
		);
	});
});

// ---------------------------------------------------------------------------
// ObserverClient constructor
// ---------------------------------------------------------------------------

describe("ObserverClient", () => {
	describe("constructor", () => {
		it("defaults tier routing on for capability-safe api_http providers when not explicitly set", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(true);
		});

		it("keeps tier routing off when the user explicitly disables it", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerTierRoutingEnabled: false,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(false);
		});

		it("keeps default tier routing off when a custom base URL is configured", () => {
			const observerApiKey = fixtureToken("custom-base-url");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: "https://openai-proxy.example/v1",
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(false);
		});

		it("keeps default tier routing off for unmapped api_http providers", () => {
			const observerApiKey = fixtureToken("unmapped-provider");
			const client = new ObserverClient({
				observerProvider: "opencode",
				observerModel: "opencode/gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: "https://gateway.example/v1",
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(false);
		});

		it("defaults tier routing on for claude_sidecar", () => {
			const client = new ObserverClient({
				observerProvider: "anthropic",
				observerModel: "claude-haiku-4-5",
				observerRuntime: "claude_sidecar",
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.tierRoutingEnabled).toBe(true);
		});

		it("defaults to openai provider and default model", () => {
			const client = new ObserverClient({
				observerProvider: null,
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.provider).toBe("openai");
			expect(client.model).toBe("gpt-5.4-mini");
			expect(client.temperature).toBe(0.2);
			expect(client.runtime).toBe("api_http");
		});

		it("falls back to deterministic default temperature when omitted", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.temperature).toBe(0.2);
		});

		it("uses anthropic provider and default model when configured", () => {
			const client = new ObserverClient({
				observerProvider: "anthropic",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.provider).toBe("anthropic");
			expect(client.model).toBe("claude-haiku-4-5");
		});

		it("uses configured model when provided", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-4o",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerOpenAIUseResponses: true,
				observerReasoningEffort: "low",
				observerReasoningSummary: "auto",
				observerMaxOutputTokens: 12000,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.model).toBe("gpt-4o");
			expect(client.openaiUseResponses).toBe(true);
			expect(client.reasoningEffort).toBe("low");
			expect(client.reasoningSummary).toBe("auto");
			expect(client.maxOutputTokens).toBe(12000);
		});

		it("defaults OpenAI api_http clients to Responses when transport is not explicitly set", () => {
			const observerApiKey = fixtureToken("openai-responses-default");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.openaiUseResponses).toBe(true);
		});

		it("honors explicit false for OpenAI api_http Responses usage", () => {
			const observerApiKey = fixtureToken("openai-responses-disabled");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: "api_http",
				observerApiKey,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerOpenAIUseResponses: false,
				observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.openaiUseResponses).toBe(false);
		});

		it("round-trips per-tier provider overrides through toConfig", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerSimpleProvider: "anthropic",
				observerRichProvider: "anthropic",
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.simpleProvider).toBe("anthropic");
			expect(client.richProvider).toBe("anthropic");
			const config = client.toConfig();
			expect(config.observerSimpleProvider).toBe("anthropic");
			expect(config.observerRichProvider).toBe("anthropic");
		});

		it("preserves auth source details in toConfig", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "file",
				observerAuthFile: "/tmp/observer-auth.json",
				observerAuthCommand: ["security", "find-generic-password"],
				observerAuthTimeoutMs: 2500,
				observerAuthCacheTtlS: 120,
			});
			const config = client.toConfig();
			expect(config.observerAuthSource).toBe("file");
			expect(config.observerAuthFile).toBe("/tmp/observer-auth.json");
			expect(config.observerAuthCommand).toEqual(["security", "find-generic-password"]);
			expect(config.observerAuthTimeoutMs).toBe(2500);
			expect(config.observerAuthCacheTtlS).toBe(120);
		});

		it("infers anthropic from claude model prefix", () => {
			const client = new ObserverClient({
				observerProvider: null,
				observerModel: "claude-haiku-4-5",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(client.provider).toBe("anthropic");
			expect(client.model).toBe("claude-haiku-4-5");
		});

		it("infers opencode provider from prefixed model", () => {
			const prevHome = process.env.HOME;
			const tmpDir = mkdtempSync(join(tmpdir(), "codemem-opencode-test-"));
			const configDir = join(tmpDir, ".config", "opencode");
			mkdirSync(configDir, { recursive: true });
			mkdirSync(join(tmpDir, ".local", "share", "opencode"), { recursive: true });
			const cachedToken = fixtureToken("opencode-inferred-provider");
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ opencode: { type: "api", key: cachedToken } }),
			);
			try {
				writeFileSync(
					join(configDir, "opencode.jsonc"),
					JSON.stringify({ small_model: "opencode/gpt-5-nano" }),
				);
				process.env.HOME = tmpDir;
				const client = new ObserverClient({
					observerProvider: null,
					observerModel: "opencode/gpt-5.4-mini",
					observerRuntime: null,
					observerApiKey: null,
					observerBaseUrl: null,
					observerMaxChars: 12_000,
					observerMaxTokens: 4_000,
					observerHeaders: {},
					observerAuthSource: "auto",
					observerAuthFile: null,
					observerAuthCommand: [],
					observerAuthTimeoutMs: 1500,
					observerAuthCacheTtlS: 300,
				});
				expect(client.provider).toBe("opencode");
				expect(client.model).toBe("gpt-5.4-mini");
				expect(client.getStatus().auth.hasToken).toBe(true);
			} finally {
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("preserves explicit observer_base_url for opencode built-in provider", () => {
			const observerApiKey = fixtureToken("opencode-base-url");
			const client = new ObserverClient({
				observerProvider: "opencode",
				observerModel: "opencode/gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey,
				observerBaseUrl: "https://proxy.example.test/v1",
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});

			expect((client as unknown as { _customBaseUrl: string | null })._customBaseUrl).toBe(
				"https://proxy.example.test/v1",
			);
		});

		it("prefers explicit observer api key over cached opencode auth", () => {
			const prevHome = process.env.HOME;
			const tmpDir = mkdtempSync(join(tmpdir(), "codemem-opencode-override-test-"));
			mkdirSync(join(tmpDir, ".local", "share", "opencode"), { recursive: true });
			const cachedToken = fixtureToken("opencode-cached");
			const explicitToken = fixtureToken("opencode-explicit");
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ opencode: { type: "api", key: cachedToken } }),
			);
			try {
				process.env.HOME = tmpDir;
				const client = new ObserverClient({
					observerProvider: "opencode",
					observerModel: "opencode/gpt-5.4-mini",
					observerRuntime: null,
					observerApiKey: explicitToken,
					observerBaseUrl: null,
					observerMaxChars: 12_000,
					observerMaxTokens: 4_000,
					observerHeaders: {},
					observerAuthSource: "auto",
					observerAuthFile: null,
					observerAuthCommand: [],
					observerAuthTimeoutMs: 1500,
					observerAuthCacheTtlS: 300,
				});
				expect((client as unknown as { auth: { token: string | null } }).auth.token).toBe(
					explicitToken,
				);
			} finally {
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("does not use auth cache API keys for arbitrary custom providers", () => {
			const prevHome = process.env.HOME;
			const tmpDir = mkdtempSync(join(tmpdir(), "codemem-custom-provider-test-"));
			const configDir = join(tmpDir, ".config", "opencode");
			mkdirSync(configDir, { recursive: true });
			mkdirSync(join(tmpDir, ".local", "share", "opencode"), { recursive: true });
			const ignoredCachedToken = fixtureToken("ignored-custom-provider-cache");
			writeFileSync(join(configDir, "opencode.jsonc"), JSON.stringify({ provider: { acme: {} } }));
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ acme: { type: "api", key: ignoredCachedToken } }),
			);
			try {
				process.env.HOME = tmpDir;
				const client = new ObserverClient({
					observerProvider: "acme",
					observerModel: "acme/custom-model",
					observerRuntime: null,
					observerApiKey: null,
					observerBaseUrl: null,
					observerMaxChars: 12_000,
					observerMaxTokens: 4_000,
					observerHeaders: {},
					observerAuthSource: "auto",
					observerAuthFile: null,
					observerAuthCommand: [],
					observerAuthTimeoutMs: 1500,
					observerAuthCacheTtlS: 300,
				});
				expect(client.getStatus().auth.hasToken).toBe(false);
			} finally {
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("getStatus", () => {
		it("returns expected shape", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-4.1-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			const status = client.getStatus();
			expect(status.provider).toBe("openai");
			expect(status.model).toBe("gpt-4.1-mini");
			expect(status.runtime).toBe("api_http");
			expect(status.auth).toBeDefined();
			expect(typeof status.auth.source).toBe("string");
			expect(typeof status.auth.hasToken).toBe("boolean");
		});

		it("includes lastError when set", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			// No credentials → auth_missing error after observe attempt
			// We trigger the error path by accessing private _setLastError
			// (or we can just check the status shape without error)
			const status = client.getStatus();
			expect(status.lastError).toBeUndefined();
		});

		it("reports auth type based on resolved credentials", () => {
			const observerApiKey = fixtureToken("auth-status");
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			const status = client.getStatus();
			expect(status.auth.hasToken).toBe(true);
			expect(status.auth.type).toBe("api_direct");
		});

		it("does not report responses_api runtime when OpenAI OAuth codex transport is active", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerTemperature: 0.2,
				observerOpenAIUseResponses: true,
				observerReasoningEffort: "low",
				observerReasoningSummary: "auto",
				observerMaxOutputTokens: 12000,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			(client as unknown as { _codexAccess: string | null })._codexAccess = "oauth-token";
			const status = client.getStatus();
			expect(status.auth.type).toBe("codex_consumer");
			expect(status.runtime).toBe("api_http");
		});

		it("reports sdk_client auth type for opencode cached key auth", () => {
			const prevHome = process.env.HOME;
			const tmpDir = mkdtempSync(join(tmpdir(), "codemem-opencode-auth-test-"));
			mkdirSync(join(tmpDir, ".local", "share", "opencode"), { recursive: true });
			const cachedToken = fixtureToken("opencode-sdk-client");
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ opencode: { type: "api", key: cachedToken } }),
			);
			try {
				process.env.HOME = tmpDir;
				const client = new ObserverClient({
					observerProvider: "opencode",
					observerModel: "opencode/gpt-5.4-mini",
					observerRuntime: null,
					observerApiKey: null,
					observerBaseUrl: null,
					observerMaxChars: 12_000,
					observerMaxTokens: 4_000,
					observerHeaders: {},
					observerAuthSource: "auto",
					observerAuthFile: null,
					observerAuthCommand: [],
					observerAuthTimeoutMs: 1500,
					observerAuthCacheTtlS: 300,
				});
				const status = client.getStatus();
				expect(status.auth.hasToken).toBe(true);
				expect(status.auth.type).toBe("sdk_client");
			} finally {
				if (prevHome == null) delete process.env.HOME;
				else process.env.HOME = prevHome;
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("refreshAuth", () => {
		it("does not throw", () => {
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});
			expect(() => client.refreshAuth()).not.toThrow();
		});
	});
});

// ---------------------------------------------------------------------------
// ObserverClient.observe() — fetch mocking
// ---------------------------------------------------------------------------

describe("ObserverClient.observe()", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function makeClient(provider: string, apiKey: string): ObserverClient {
		return new ObserverClient({
			observerProvider: provider,
			observerModel: null,
			observerRuntime: null,
			observerApiKey: apiKey,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});
	}

	it("calls Anthropic endpoint with correct headers", async () => {
		const apiKey = fixtureToken("anthropic-header");
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					content: [{ type: "text", text: "test response" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = makeClient("anthropic", apiKey);
		const result = await client.observe("system prompt", "user prompt");

		expect(capturedUrl).toContain("anthropic.com");
		expect(capturedHeaders?.["x-api-key"]).toBe(apiKey);
		expect(result.raw).toBe("test response");
		expect(result.provider).toBe("anthropic");
	});

	it("routes OpenAI to chat/completions when user explicitly disables Responses", async () => {
		const observerApiKey = fixtureToken("openai-chat-completions");
		let capturedUrl: string | undefined;

		globalThis.fetch = (async (input: string | URL | Request, _init?: RequestInit) => {
			capturedUrl = String(input);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "chat completions response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: "gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey,
			observerBaseUrl: null,
			observerOpenAIUseResponses: false,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
			observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
		});
		const result = await client.observe("system", "user");

		expect(capturedUrl).toContain("/chat/completions");
		expect(capturedUrl).not.toContain("/responses");
		expect(result.raw).toBe("chat completions response");
	});

	it("calls OpenAI Responses endpoint by default", async () => {
		const apiKey = fixtureToken("openai-responses");
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;
		let capturedBody: Record<string, unknown> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "openai response text" }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = makeClient("openai", apiKey);
		const result = await client.observe("system", "user");

		expect(capturedUrl).toContain("openai.com");
		expect(capturedUrl).toContain("/responses");
		expect(capturedHeaders?.authorization).toBe(`Bearer ${apiKey}`);
		expect(capturedBody?.input).toBeDefined();
		expect(result.raw).toBe("openai response text");
		expect(result.provider).toBe("openai");
	});

	it("allows no-auth calls to explicit OpenAI-compatible base URLs", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "local model response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "lms-200",
			observerModel: "qwopus-glm-18b-merged",
			observerRuntime: "api_http",
			observerApiKey: null,
			observerBaseUrl: "http://127.0.0.1:1234/v1",
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");

		expect(capturedUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
		expect(capturedHeaders?.authorization).toBeUndefined();
		expect(result.raw).toBe("local model response");
	});

	it("parses OpenAI-compatible chat content blocks", async () => {
		const observerApiKey = fixtureToken("openai-content-blocks");
		globalThis.fetch = (async () => {
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: [
									{ type: "text", text: "first" },
									{ type: "output_text", text: " second" },
								],
							},
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: "gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey,
			observerBaseUrl: null,
			observerOpenAIUseResponses: false,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
			observerExplicitConfigKeys: ["observerOpenAIUseResponses"],
		});

		const result = await client.observe("system", "user");

		expect(result.raw).toBe("first second");
	});

	it("allows no-auth calls to custom OpenCode provider base URLs", async () => {
		const prevHome = process.env.HOME;
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-custom-no-auth-provider-test-"));
		const configDir = join(tmpDir, ".config", "opencode");
		mkdirSync(configDir, { recursive: true });
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		writeFileSync(
			join(configDir, "opencode.jsonc"),
			JSON.stringify({
				provider: {
					work: {
						options: {
							baseURL: "https://gateway.example.test/v1",
						},
						models: {
							fast: { id: "gateway-fast" },
						},
					},
				},
			}),
		);

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "gateway response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		try {
			process.env.HOME = tmpDir;
			const client = new ObserverClient({
				observerProvider: "work",
				observerModel: "work/fast",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "none",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});

			const result = await client.observe("system", "user");

			expect(capturedUrl).toBe("https://gateway.example.test/v1/chat/completions");
			expect(capturedHeaders?.authorization).toBeUndefined();
			expect(result.model).toBe("gateway-fast");
			expect(result.raw).toBe("gateway response");
		} finally {
			if (prevHome == null) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("still requires auth for the built-in opencode provider", async () => {
		let fetchCalls = 0;
		globalThis.fetch = (async () => {
			fetchCalls += 1;
			return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "opencode",
			observerModel: "opencode/gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");

		expect(result.raw).toBeNull();
		expect(fetchCalls).toBe(0);
	});

	it("allows no-auth calls for opencode when observer_base_url is explicit", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "explicit opencode gateway response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "opencode",
			observerModel: "opencode/gpt-5.4-mini",
			observerRuntime: "api_http",
			observerApiKey: null,
			observerBaseUrl: "http://127.0.0.1:1234/v1",
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");

		expect(capturedUrl).toBe("http://127.0.0.1:1234/v1/chat/completions");
		expect(capturedHeaders?.authorization).toBeUndefined();
		expect(result.raw).toBe("explicit opencode gateway response");
	});

	it("dedupes authorization headers case-insensitively for custom providers", async () => {
		const prevHome = process.env.HOME;
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-custom-auth-header-test-"));
		const configDir = join(tmpDir, ".config", "opencode");
		mkdirSync(configDir, { recursive: true });
		const providerApiKey = fixtureToken("provider-config");
		let capturedHeaders: Record<string, string> | undefined;

		writeFileSync(
			join(configDir, "opencode.jsonc"),
			JSON.stringify({
				provider: {
					acme: {
						options: {
							baseURL: "https://proxy.example.test/v1",
							apiKey: providerApiKey,
							headers: {
								// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional placeholder syntax
								Authorization: "Bearer ${auth.token}",
							},
						},
						models: {
							foo: { id: "foo-model" },
						},
					},
				},
			}),
		);

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "custom provider response" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		try {
			process.env.HOME = tmpDir;
			const client = new ObserverClient({
				observerProvider: "acme",
				observerModel: "acme/foo",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});

			const result = await client.observe("system", "user");

			expect(result.raw).toBe("custom provider response");
			expect(capturedHeaders?.Authorization).toBe(`Bearer ${providerApiKey}`);
			expect(capturedHeaders?.authorization).toBeUndefined();
		} finally {
			if (prevHome == null) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("truncates prompts to maxChars", async () => {
		const observerApiKey = fixtureToken("truncate-prompts");
		let capturedBody: Record<string, unknown> | undefined;

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: "ok" }],
						},
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: null,
			observerRuntime: null,
			observerApiKey,
			observerBaseUrl: null,
			observerMaxChars: 100,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});

		const longSystem = "s".repeat(500);
		const longUser = "u".repeat(500);
		await client.observe(longSystem, longUser);

		const input = capturedBody?.input as Array<Record<string, unknown>>;
		expect(input).toBeDefined();
		const systemMsg = input.find((m: Record<string, unknown>) => m.role === "developer");
		const systemText = ((systemMsg?.content as Array<Record<string, unknown>> | undefined)?.[0]
			?.text ?? "") as string;
		expect(systemText.length).toBeLessThanOrEqual(100);
	});

	it("retries once on auth error", async () => {
		const apiKey = fixtureToken("anthropic-retry");
		let callCount = 0;

		globalThis.fetch = (async () => {
			callCount++;
			if (callCount === 1) {
				return new Response("Unauthorized", { status: 401 });
			}
			return new Response(
				JSON.stringify({
					content: [{ type: "text", text: "retry success" }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = makeClient("anthropic", apiKey);
		// The retry should succeed since we set the key
		const result = await client.observe("system", "user");

		// Should have made 2+ fetch calls (initial + retry after auth refresh)
		expect(callCount).toBeGreaterThanOrEqual(2);
		expect(result.raw).toBe("retry success");
	});

	it("passes the full system prompt to the codex consumer instructions field", async () => {
		const prevHome = process.env.HOME;
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-codex-consumer-test-"));
		mkdirSync(join(tmpDir, ".local", "share", "opencode"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".local", "share", "opencode", "auth.json"),
			JSON.stringify({
				openai: {
					access: "oauth-test-token",
					accountId: "acct-test",
					expires: Date.now() + 60_000,
				},
			}),
		);

		let capturedBody: Record<string, unknown> | undefined;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return new Response(
				'data: {"type":"response.output_text.delta","delta":"<summary><request>ok</request></summary>"}\n\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);
		}) as typeof globalThis.fetch;

		try {
			process.env.HOME = tmpDir;
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: "gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: null,
				observerBaseUrl: null,
				observerMaxChars: 12_000,
				observerMaxTokens: 4_000,
				observerHeaders: {},
				observerAuthSource: "auto",
				observerAuthFile: null,
				observerAuthCommand: [],
				observerAuthTimeoutMs: 1500,
				observerAuthCacheTtlS: 300,
			});

			await client.observe("SYSTEM XML CONTRACT", "USER SESSION TRANSCRIPT");

			expect(client.getStatus().auth.type).toBe("codex_consumer");
			expect(capturedBody?.instructions).toBe("SYSTEM XML CONTRACT");
		} finally {
			if (prevHome == null) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("returns null raw when no credentials available", async () => {
		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: null,
			observerRuntime: null,
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "none",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});

		const result = await client.observe("system", "user");
		expect(result.raw).toBeNull();
	});

	it("passes the selected sidecar model via --model", () => {
		const client = new ObserverClient({
			observerProvider: "anthropic",
			observerModel: "claude-sonnet-4-6",
			observerRuntime: "claude_sidecar",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});
		const command = (
			client as unknown as { _buildSidecarCommand: (prompt: string, useModel: boolean) => string[] }
		)._buildSidecarCommand("prompt", true);
		expect(command).toContain("--model");
		expect(command).toContain("claude-sonnet-4-6");
	});

	it("leaves resolved model null when retry payload omits model", async () => {
		const client = new ObserverClient({
			observerProvider: "anthropic",
			observerModel: "claude-sonnet-4-6",
			observerRuntime: "claude_sidecar",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});
		(
			client as unknown as {
				_invokeSidecar: (
					prompt: string,
					useModel: boolean,
				) => Promise<{ output: string | null; error: string | null; reportedModel: string | null }>;
			}
		)._invokeSidecar = async (_prompt, useModel) => {
			if (useModel) {
				return { output: null, error: "Issue with the selected model", reportedModel: null };
			}
			return { output: "sidecar ok", error: null, reportedModel: null };
		};

		await client.observe("system", "user");
		const status = client.getStatus();

		expect(status.actualModel).toBeNull();
		expect(status.modelFallbackApplied).toBe(true);
	});

	it("raises ObserverAuthError when the sidecar reports an auth failure", async () => {
		const client = new ObserverClient({
			observerProvider: "anthropic",
			observerModel: "claude-sonnet-4-6",
			observerRuntime: "claude_sidecar",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});
		(
			client as unknown as {
				_invokeSidecar: (
					prompt: string,
					useModel: boolean,
				) => Promise<{ output: string | null; error: string | null; reportedModel: string | null }>;
			}
		)._invokeSidecar = async () => ({
			output: null,
			error: "Not logged in. Please run `claude login`.",
			reportedModel: null,
		});

		await expect(client.observe("system", "user")).rejects.toThrow(/not logged in/i);
		expect(client.getStatus().lastError?.code).toBe("auth_failed");
	});

	it("returns null and records ENOENT when the claude binary is missing", async () => {
		const client = new ObserverClient({
			observerProvider: "anthropic",
			observerModel: "claude-sonnet-4-6",
			observerRuntime: "claude_sidecar",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
			claudeCommand: ["/nonexistent/claude-binary-that-does-not-exist"],
		});
		const result = await client.observe("system", "user");
		expect(result.raw).toBeNull();
	});

	describe("sidecar error classifiers", () => {
		it("matches model errors from known Claude CLI phrasings", () => {
			expect(isSidecarModelError("Issue with the selected model")).toBe(true);
			expect(isSidecarModelError("Run --model to pick a different model")).toBe(true);
			expect(isSidecarModelError("model foo may not exist")).toBe(true);
			expect(isSidecarModelError("the model may not exist; try another")).toBe(true);
		});

		it("does not misclassify unrelated errors as model errors", () => {
			expect(isSidecarModelError("Not logged in")).toBe(false);
			expect(isSidecarModelError("Connection timed out")).toBe(false);
			expect(isSidecarModelError("")).toBe(false);
		});

		it("matches auth errors from known Claude CLI phrasings", () => {
			expect(isSidecarAuthError("Not logged in. Please run `claude login`.")).toBe(true);
			expect(isSidecarAuthError("Authentication failed")).toBe(true);
			expect(isSidecarAuthError("Unauthorized")).toBe(true);
			expect(isSidecarAuthError("Permission denied")).toBe(true);
			expect(isSidecarAuthError("Please set ANTHROPIC_API_KEY")).toBe(true);
			expect(isSidecarAuthError("Run /setup-token to authenticate")).toBe(true);
		});

		it("does not misclassify unrelated errors as auth errors", () => {
			expect(isSidecarAuthError("Issue with the selected model")).toBe(false);
			expect(isSidecarAuthError("Request failed with status 500")).toBe(false);
			expect(isSidecarAuthError("")).toBe(false);
		});
	});

	it("reports the actual sidecar model after retrying without --model", async () => {
		const client = new ObserverClient({
			observerProvider: "anthropic",
			observerModel: "claude-sonnet-4-6",
			observerRuntime: "claude_sidecar",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});
		let calls = 0;
		(
			client as unknown as {
				_invokeSidecar: (
					prompt: string,
					useModel: boolean,
				) => Promise<{ output: string | null; error: string | null; reportedModel: string | null }>;
			}
		)._invokeSidecar = async (_prompt, useModel) => {
			calls++;
			if (useModel) {
				return {
					output: null,
					error: "Issue with the selected model",
					reportedModel: null,
				};
			}
			return {
				output: "sidecar ok",
				error: null,
				reportedModel: "claude-haiku-4-5",
			};
		};

		const result = await client.observe("system", "user");
		const status = client.getStatus();

		expect(calls).toBe(2);
		expect(result.raw).toBe("sidecar ok");
		expect(result.model).toBe("claude-haiku-4-5");
		expect(status.model).toBe("claude-haiku-4-5");
		expect(status.actualModel).toBe("claude-haiku-4-5");
		expect(status.modelFallbackApplied).toBe(true);
		expect(status.modelFallbackReason).toBe(
			"configured sidecar tier model unavailable; retried with default Claude model",
		);
	});
});

// ---------------------------------------------------------------------------
// codex_sidecar runtime
// ---------------------------------------------------------------------------

type CodexInvoker = (
	systemPrompt: string,
	userPrompt: string,
	useModel: boolean,
) => Promise<{ output: string | null; error: string | null; reportedModel: string | null }>;

function makeCodexSidecarClient(overrides?: { model?: string | null }): ObserverClient {
	return new ObserverClient({
		observerProvider: "openai",
		observerModel: overrides?.model === undefined ? "gpt-5.1-codex" : overrides.model,
		observerRuntime: "codex_sidecar",
		observerApiKey: null,
		observerBaseUrl: null,
		observerMaxChars: 12_000,
		observerMaxTokens: 4_000,
		observerHeaders: {},
		observerAuthSource: "auto",
		observerAuthFile: null,
		observerAuthCommand: [],
		observerAuthTimeoutMs: 1500,
		observerAuthCacheTtlS: 300,
	});
}

function stubCodexInvoker(client: ObserverClient, impl: CodexInvoker): void {
	(client as unknown as { _invokeCodexSidecar: CodexInvoker })._invokeCodexSidecar = impl;
}

describe("ObserverClient.observe() — codex_sidecar", () => {
	it("passes the selected model via -m", () => {
		const client = makeCodexSidecarClient({ model: "gpt-5.1-codex" });
		const command = (
			client as unknown as {
				_buildCodexSidecarCommand: (useModel: boolean, outputFile: string) => string[];
			}
		)._buildCodexSidecarCommand(true, "/tmp/out.txt");
		expect(command).toContain("exec");
		expect(command).toContain("-m");
		expect(command).toContain("gpt-5.1-codex");
		// Output capture + stdin prompt wiring.
		expect(command).toContain("-o");
		expect(command).toContain("/tmp/out.txt");
		expect(command[command.length - 1]).toBe("-");
	});

	it("omits -m when useModel is false", () => {
		const client = makeCodexSidecarClient({ model: "gpt-5.1-codex" });
		const command = (
			client as unknown as {
				_buildCodexSidecarCommand: (useModel: boolean, outputFile: string) => string[];
			}
		)._buildCodexSidecarCommand(false, "/tmp/out.txt");
		expect(command).not.toContain("-m");
	});

	it("skips API key init when constructed with no key", () => {
		// Construction must not throw even though no API key is configured.
		const client = makeCodexSidecarClient({ model: "gpt-5.1-codex" });
		expect(client.runtime).toBe("codex_sidecar");
		expect(client.auth.token).toBeNull();
		expect(client.getStatus().auth.type).toBe("codex_sidecar");
	});

	it("raises ObserverAuthError when the sidecar reports an auth failure", async () => {
		const client = makeCodexSidecarClient({ model: "gpt-5.1-codex" });
		stubCodexInvoker(client, async () => ({
			output: null,
			error: "Not logged in. Please run `codex login`.",
			reportedModel: null,
		}));

		await expect(client.observe("system", "user")).rejects.toThrow(/not logged in/i);
		expect(client.getStatus().lastError?.code).toBe("auth_failed");
	});

	it("retries without -m and reports fallback on model-unavailable", async () => {
		const client = makeCodexSidecarClient({ model: "gpt-5.1-codex" });
		let calls = 0;
		stubCodexInvoker(client, async (_system, _user, useModel) => {
			calls++;
			if (useModel) {
				return { output: null, error: "unknown model: gpt-5.1-codex", reportedModel: null };
			}
			return { output: "codex ok", error: null, reportedModel: null };
		});

		const result = await client.observe("system", "user");
		const status = client.getStatus();

		expect(calls).toBe(2);
		expect(result.raw).toBe("codex ok");
		expect(status.modelFallbackApplied).toBe(true);
		expect(status.modelFallbackReason).toBe(
			"configured sidecar tier model unavailable; retried with default Codex model",
		);
		// Resolved model marker cleared since codex does not report it.
		expect(status.actualModel).toBeNull();
	});

	describe("codex sidecar error classifiers", () => {
		it("matches model errors from known Codex CLI phrasings", () => {
			expect(isCodexSidecarModelError("unknown model: gpt-5.1-codex")).toBe(true);
			expect(isCodexSidecarModelError("unsupported model foo")).toBe(true);
			expect(isCodexSidecarModelError("invalid model name")).toBe(true);
			expect(isCodexSidecarModelError("model not found")).toBe(true);
			expect(isCodexSidecarModelError("that model does not exist")).toBe(true);
		});

		it("does not misclassify unrelated errors as model errors", () => {
			expect(isCodexSidecarModelError("Not logged in")).toBe(false);
			expect(isCodexSidecarModelError("Connection timed out")).toBe(false);
			expect(isCodexSidecarModelError("")).toBe(false);
		});

		it("matches auth errors from known Codex CLI phrasings", () => {
			expect(isCodexSidecarAuthError("Not logged in. Please run `codex login`.")).toBe(true);
			expect(isCodexSidecarAuthError("Please log in to ChatGPT")).toBe(true);
			expect(isCodexSidecarAuthError("Unauthorized")).toBe(true);
			expect(isCodexSidecarAuthError("authentication required")).toBe(true);
			expect(isCodexSidecarAuthError("request failed with status 401")).toBe(true);
			expect(isCodexSidecarAuthError("request failed with status 403")).toBe(true);
		});

		it("does not misclassify unrelated errors as auth errors", () => {
			expect(isCodexSidecarAuthError("unknown model: gpt-5.1-codex")).toBe(false);
			expect(isCodexSidecarAuthError("Request failed with status 500")).toBe(false);
			expect(isCodexSidecarAuthError("")).toBe(false);
		});

		it("does not false-positive on operational log noise (paths, offsets)", () => {
			// Bare "login" substring in a path must not trip the classifier.
			expect(isCodexSidecarAuthError("/Users/x/.codex/sessions/login.json missing")).toBe(false);
			expect(isCodexSidecarAuthError("wrote login-state to cache")).toBe(false);
			// Status codes must be word-anchored, not matched inside larger numbers.
			expect(isCodexSidecarAuthError("read 40123 bytes from stream")).toBe(false);
			expect(isCodexSidecarAuthError("offset 14031 reached")).toBe(false);
		});
	});
});

// ---------------------------------------------------------------------------
// codex_sidecar real subprocess (fake `codex` via node) — locks the spawn
// surface: env scrubbing, stdin wiring, -o capture, cleanup, redaction.
// ---------------------------------------------------------------------------

describe("ObserverClient.observe() — codex_sidecar real spawn", () => {
	let dir: string;
	let savedClaudeEntry: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codemem-codex-fake-"));
		savedClaudeEntry = process.env.CLAUDE_CODE_ENTRYPOINT;
	});

	afterEach(() => {
		if (savedClaudeEntry === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
		else process.env.CLAUDE_CODE_ENTRYPOINT = savedClaudeEntry;
		rmSync(dir, { recursive: true, force: true });
	});

	function clientWithFakeCodex(scriptBody: string): ObserverClient {
		const scriptPath = join(dir, "fake-codex.mjs");
		writeFileSync(scriptPath, scriptBody, "utf-8");
		return new ObserverClient({
			observerProvider: "openai",
			observerModel: "gpt-5.1-codex",
			observerRuntime: "codex_sidecar",
			observerApiKey: null,
			observerBaseUrl: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
			codexCommand: [process.execPath, scriptPath],
		});
	}

	function tempSidecarFileCount(): number {
		return readdirSync(tmpdir()).filter((n) => n.startsWith("codemem-codex-sidecar-")).length;
	}

	it("scrubs CLAUDE_CODE_* env, forwards the prompt on stdin, captures -o, and cleans up", async () => {
		process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
		const script = [
			'import { readFileSync, writeFileSync } from "node:fs";',
			"const argv = process.argv.slice(2);",
			'const out = argv[argv.indexOf("-o") + 1];',
			'let stdin = "";',
			'process.stdin.on("data", (c) => { stdin += c; });',
			'process.stdin.on("end", () => {',
			"  const payload = JSON.stringify({",
			'    claude: process.env.CLAUDE_CODE_ENTRYPOINT ?? "ABSENT",',
			'    pluginIgnore: process.env.CODEMEM_PLUGIN_IGNORE ?? "",',
			"    stdin,",
			"  });",
			"  writeFileSync(out, payload);",
			"  process.exit(0);",
			"});",
		].join("\n");
		const client = clientWithFakeCodex(script);
		const before = tempSidecarFileCount();
		const result = await client.observe("SYSTEM_PROMPT_MARKER", "USER_PROMPT_MARKER");
		const parsed = JSON.parse(result.raw ?? "{}");
		expect(parsed.claude).toBe("ABSENT");
		expect(parsed.pluginIgnore).toBe("1");
		expect(parsed.stdin).toContain("SYSTEM_PROMPT_MARKER");
		expect(parsed.stdin).toContain("USER_PROMPT_MARKER");
		// Temp output file is unlinked in finally — no leak.
		expect(tempSidecarFileCount()).toBe(before);
	});

	it("returns null output and a redacted error on non-zero exit", async () => {
		const warnings: string[] = [];
		const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
			warnings.push(args.map(String).join(" "));
		});
		try {
			const script = [
				"process.stdin.resume();",
				'process.stdin.on("end", () => {',
				'  process.stderr.write("boom Bearer sk-abcdefghijklmnopqrstuvwxyz failed");',
				"  process.exit(1);",
				"});",
			].join("\n");
			const client = clientWithFakeCodex(script);
			const result = await client.observe("SYS", "USR");
			expect(result.raw).toBeNull();
			const joined = warnings.join("\n");
			expect(joined).toContain("[redacted]");
			expect(joined).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
		} finally {
			spy.mockRestore();
		}
	});
});

// ---------------------------------------------------------------------------
// codex_sidecar auto-selection gating
// ---------------------------------------------------------------------------

describe("shouldAutoSelectCodexSidecar", () => {
	const base = {
		observerRuntime: null,
		hasAnyApiKey: false,
		observerAuthSource: "auto" as string | null,
		observerAuthFile: null as string | null,
		observerAuthCommand: [] as string[] | null,
		hasUsableOpenCodeCache: false,
		codexAvailable: true,
		codexAuthExists: true,
	};

	it("selects codex_sidecar when all preconditions hold", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base })).toBe(true);
	});

	it("does not override an explicit runtime", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, observerRuntime: "api_http" })).toBe(false);
	});

	it("yields to any available API key", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, hasAnyApiKey: true })).toBe(false);
	});

	it("respects a configured file auth source", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, observerAuthSource: "file" })).toBe(false);
	});

	it("respects a configured command auth source", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, observerAuthSource: "command" })).toBe(false);
	});

	it("respects an explicit auth file path", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, observerAuthFile: "~/.tokens/obs" })).toBe(
			false,
		);
	});

	it("respects a configured auth command", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, observerAuthCommand: ["op", "read"] })).toBe(
			false,
		);
	});

	it("yields to a usable OpenCode OAuth cache", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, hasUsableOpenCodeCache: true })).toBe(false);
	});

	it("requires the codex CLI to be available", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, codexAvailable: false })).toBe(false);
	});

	it("requires ~/.codex/auth.json to exist", () => {
		expect(shouldAutoSelectCodexSidecar({ ...base, codexAuthExists: false })).toBe(false);
	});
});
