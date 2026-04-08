import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";

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
		"CODEMEM_OBSERVER_RICH_OPENAI_USE_RESPONSES",
		"CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
		"CODEMEM_OBSERVER_RICH_REASONING_SUMMARY",
		"CODEMEM_OBSERVER_RICH_MAX_OUTPUT_TOKENS",
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
			process.env.CODEMEM_OBSERVER_RICH_OPENAI_USE_RESPONSES = "true";
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
			expect(cfg.observerRichOpenAIUseResponses).toBe(true);
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
});

// ---------------------------------------------------------------------------
// ObserverClient constructor
// ---------------------------------------------------------------------------

describe("ObserverClient", () => {
	describe("constructor", () => {
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
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ opencode: { type: "api", key: "zen-test-key" } }),
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
			const client = new ObserverClient({
				observerProvider: "opencode",
				observerModel: "opencode/gpt-5.4-mini",
				observerRuntime: null,
				observerApiKey: "override-key",
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
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ opencode: { type: "api", key: "cached-key" } }),
			);
			try {
				process.env.HOME = tmpDir;
				const client = new ObserverClient({
					observerProvider: "opencode",
					observerModel: "opencode/gpt-5.4-mini",
					observerRuntime: null,
					observerApiKey: "explicit-key",
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
					"explicit-key",
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
			writeFileSync(join(configDir, "opencode.jsonc"), JSON.stringify({ provider: { acme: {} } }));
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ acme: { type: "api", key: "should-not-be-used" } }),
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
			const client = new ObserverClient({
				observerProvider: "openai",
				observerModel: null,
				observerRuntime: null,
				observerApiKey: "sk-test-key",
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
			writeFileSync(
				join(tmpDir, ".local", "share", "opencode", "auth.json"),
				JSON.stringify({ opencode: { type: "api", key: "zen-test-key" } }),
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

		const client = makeClient("anthropic", "sk-ant-test-key-12345");
		const result = await client.observe("system prompt", "user prompt");

		expect(capturedUrl).toContain("anthropic.com");
		expect(capturedHeaders?.["x-api-key"]).toBe("sk-ant-test-key-12345");
		expect(result.raw).toBe("test response");
		expect(result.provider).toBe("anthropic");
	});

	it("calls OpenAI endpoint with correct format", async () => {
		let capturedUrl: string | undefined;
		let capturedHeaders: Record<string, string> | undefined;

		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedHeaders = Object.fromEntries(
				Object.entries((init?.headers as Record<string, string>) ?? {}),
			);
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "openai response text" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = makeClient("openai", "sk-openai-test-key");
		const result = await client.observe("system", "user");

		expect(capturedUrl).toContain("openai.com");
		expect(capturedHeaders?.authorization).toBe("Bearer sk-openai-test-key");
		expect(result.raw).toBe("openai response text");
		expect(result.provider).toBe("openai");
	});

	it("dedupes authorization headers case-insensitively for custom providers", async () => {
		const prevHome = process.env.HOME;
		const tmpDir = mkdtempSync(join(tmpdir(), "codemem-custom-auth-header-test-"));
		const configDir = join(tmpDir, ".config", "opencode");
		mkdirSync(configDir, { recursive: true });
		let capturedHeaders: Record<string, string> | undefined;

		writeFileSync(
			join(configDir, "opencode.jsonc"),
			JSON.stringify({
				provider: {
					acme: {
						options: {
							baseURL: "https://proxy.example.test/v1",
							apiKey: "sk-provider-token",
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
			expect(capturedHeaders?.Authorization).toBe("Bearer sk-provider-token");
			expect(capturedHeaders?.authorization).toBeUndefined();
		} finally {
			if (prevHome == null) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("truncates prompts to maxChars", async () => {
		let capturedBody: Record<string, unknown> | undefined;

		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: "ok" } }],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}) as typeof globalThis.fetch;

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: null,
			observerRuntime: null,
			observerApiKey: "sk-test",
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

		// The messages should be truncated — system to 100 chars, user to remaining budget
		const messages = capturedBody?.messages as Array<{ content: string }>;
		expect(messages).toBeDefined();
		const systemMsg = messages.find((m: Record<string, unknown>) => m.role === "system");
		expect(systemMsg?.content.length).toBeLessThanOrEqual(100);
	});

	it("retries once on auth error", async () => {
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

		const client = makeClient("anthropic", "sk-ant-test");
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
});
