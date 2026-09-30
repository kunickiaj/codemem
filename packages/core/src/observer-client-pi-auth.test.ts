/**
 * ObserverClient pi-derived auth (D8). Kept in its own file so the measured
 * describe bodies stay under the test-file line ratchet.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";

const PI_FIXTURE_KEY = "sk-fixture-pi-client-auth-key-do-not-leak";

type PiAuthHarness = {
	tmpHome: string;
	piDir: string;
	before: () => void;
	after: () => void;
};

function piAuthHarness(): PiAuthHarness {
	const envKeys = [
		"CODEMEM_CONFIG",
		"CODEMEM_OBSERVER_PROVIDER",
		"CODEMEM_OBSERVER_MODEL",
		"CODEMEM_OBSERVER_RUNTIME",
		"CODEMEM_OBSERVER_API_KEY",
		"CODEMEM_OBSERVER_BASE_URL",
		"CODEMEM_OBSERVER_OPENAI_USE_RESPONSES",
		"CODEMEM_CODEX_COMMAND",
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OPENCODE_API_KEY",
		"CODEX_API_KEY",
		"HOME",
		"PI_CODING_AGENT_DIR",
		"CLAUDE_CODE_ENTRYPOINT",
		"CLAUDE_CODE_SESSION",
	];
	const saved: Record<string, string | undefined> = {};
	const state: PiAuthHarness = {
		tmpHome: "",
		piDir: "",
		before() {
			for (const k of envKeys) {
				saved[k] = process.env[k];
				delete process.env[k];
			}
			state.tmpHome = mkdtempSync(join(tmpdir(), "codemem-pi-auth-home-"));
			process.env.HOME = state.tmpHome;
			process.env.CODEMEM_CONFIG = join(state.tmpHome, "no-such-codemem-config.json");
			state.piDir = join(state.tmpHome, ".pi", "agent");
			mkdirSync(state.piDir, { recursive: true });
		},
		after() {
			for (const k of envKeys) {
				if (saved[k] === undefined) delete process.env[k];
				else process.env[k] = saved[k];
			}
			if (state.tmpHome) rmSync(state.tmpHome, { recursive: true, force: true });
			state.tmpHome = "";
			state.piDir = "";
		},
	};
	return state;
}

function writePiApiKeyFixture(
	h: PiAuthHarness,
	opts?: { provider?: string; model?: string; baseUrl?: string; api?: string },
): void {
	const provider = opts?.provider ?? "acme";
	const model = opts?.model ?? "gpt-mini";
	const baseUrl = opts?.baseUrl ?? "https://api.acme.test/v1";
	const api = opts?.api ?? "openai-completions";
	writeFileSync(
		join(h.piDir, "settings.json"),
		JSON.stringify({ defaultProvider: provider, defaultModel: `${provider}/${model}` }),
	);
	writeFileSync(
		join(h.piDir, "models.json"),
		JSON.stringify({
			providers: {
				[provider]: {
					baseUrl,
					api,
					models: [{ id: model }, { id: "gpt-premium-ultra" }],
				},
			},
		}),
	);
	writeFileSync(
		join(h.piDir, "auth.json"),
		JSON.stringify({ [provider]: { type: "api_key", key: PI_FIXTURE_KEY } }),
	);
}

function writeOpenCodeAcmeFixture(h: PiAuthHarness): void {
	const configDir = join(h.tmpHome, ".config", "opencode");
	mkdirSync(configDir, { recursive: true });
	writeFileSync(
		join(configDir, "opencode.jsonc"),
		JSON.stringify({
			provider: {
				acme: {
					options: { baseURL: "https://opencode-acme.test/v1", apiKey: "sk-opencode-acme" },
					models: { "gpt-mini": { id: "gpt-mini" } },
				},
			},
		}),
	);
}

function apiHttpClient(provider: string): ObserverClient {
	return new ObserverClient({
		observerProvider: provider,
		observerModel: provider === "anthropic" ? "claude-haiku-4-5" : "gpt-mini",
		observerRuntime: "api_http",
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

describe("OpenCode account defaults remain independent of Pi", () => {
	const h = piAuthHarness();
	beforeEach(() => h.before());
	afterEach(() => h.after());
	it.each(["opencode_v2", " OpenCode_V2 "])("excludes Pi projection for %s", (runtime) => {
		writePiApiKeyFixture(h, { provider: "anthropic", model: "pi-only-model" });
		const cfg = loadObserverConfig({ observer_runtime: runtime });
		expect(cfg.observerProvider).not.toBe("anthropic");
		expect(cfg.observerModel).not.toBe("pi-only-model");
		expect(cfg.observerBaseUrl).toBeNull();
		const client = new ObserverClient(cfg);
		expect(client.provider).toBe("openai");
		expect(client.model).toBe("gpt-6-luna");
	});
});

describe("ObserverClient — pi-derived auth basics", () => {
	const h = piAuthHarness();
	beforeEach(() => h.before());
	afterEach(() => h.after());

	it("uses pi auth.json api key when no explicit observer key/env is set", () => {
		writePiApiKeyFixture(h);
		// Simulate setup having written provider/model/baseUrl but NEVER the key.
		const client = new ObserverClient({
			observerProvider: "acme",
			observerModel: "gpt-mini",
			observerBaseUrl: "https://api.acme.test/v1",
			observerRuntime: "api_http",
			observerApiKey: null,
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
		expect(status.auth.source).toBe("pi");
		// Status must never echo the secret.
		expect(JSON.stringify(status)).not.toContain(PI_FIXTURE_KEY);
		// toConfig must not promote the pi key into observerApiKey (persist risk).
		expect(client.toConfig().observerApiKey).toBeNull();
	});

	it("loadObserverConfig fills unset provider/model/baseUrl from pi without copying the key", () => {
		writePiApiKeyFixture(h, {
			provider: "fw",
			model: "flash-lite",
			baseUrl: "https://api.fw.test/v1",
		});
		const cfg = loadObserverConfig();
		expect(cfg.observerProvider).toBe("fw");
		expect(cfg.observerModel).toBe("flash-lite");
		expect(cfg.observerBaseUrl).toBe("https://api.fw.test/v1");
		// Key stays off the config object — resolved only inside ObserverClient.
		expect(cfg.observerApiKey).toBeNull();

		const client = new ObserverClient(cfg);
		expect(client.getStatus().auth.hasToken).toBe(true);
		expect(client.getStatus().auth.source).toBe("pi");
		expect(client.toConfig().observerApiKey).toBeNull();
	});

	it("does not adopt pi provider when only observer model is set", () => {
		writePiApiKeyFixture(h, {
			provider: "acme",
			model: "gpt-mini",
			baseUrl: "https://api.acme.test/v1",
		});
		process.env.CODEMEM_OBSERVER_MODEL = "gpt-4o-mini";
		const cfg = loadObserverConfig();
		expect(cfg.observerModel).toBe("gpt-4o-mini");
		expect(cfg.observerProvider).toBeNull();
		expect(cfg.observerBaseUrl).toBeNull();

		const client = new ObserverClient();
		expect(client.provider).toBe("openai");
		expect(client.model).toBe("gpt-4o-mini");
		expect(client.getStatus().auth.source).not.toBe("pi");
		expect(client.auth.token).not.toBe(PI_FIXTURE_KEY);
	});

	it("honors pi openai-responses on the no-arg ObserverClient path", () => {
		writePiApiKeyFixture(h, {
			provider: "acme",
			model: "gpt-mini",
			baseUrl: "https://api.acme.test/v1",
			api: "openai-responses",
		});
		const client = new ObserverClient();
		expect(client.provider).toBe("acme");
		expect(client.openaiUseResponses).toBe(true);
	});

	it("honors pi openai-completions on the no-arg ObserverClient path", () => {
		writePiApiKeyFixture(h, {
			provider: "openai",
			model: "gpt-mini",
			baseUrl: "https://api.acme.test/v1",
			api: "openai-completions",
		});
		const client = new ObserverClient();
		expect(client.provider).toBe("openai");
		expect(client.openaiUseResponses).toBe(false);
	});
});

describe("ObserverClient — pi-derived auth explicit keys", () => {
	const h = piAuthHarness();
	beforeEach(() => h.before());
	afterEach(() => h.after());

	it("explicit CODEMEM_OBSERVER_API_KEY wins over pi", () => {
		writePiApiKeyFixture(h);
		process.env.CODEMEM_OBSERVER_API_KEY = "tok-explicit-env";
		const client = new ObserverClient({
			observerProvider: "acme",
			observerModel: "gpt-mini",
			observerBaseUrl: "https://api.acme.test/v1",
			observerRuntime: "api_http",
			observerApiKey: null,
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});
		expect(client.getStatus().auth.source).toBe("env");
		expect(client.auth.token).toBe("tok-explicit-env");
	});

	it("explicit observerApiKey on config wins over pi", () => {
		writePiApiKeyFixture(h);
		const client = new ObserverClient({
			observerProvider: "acme",
			observerModel: "gpt-mini",
			observerBaseUrl: "https://api.acme.test/v1",
			observerRuntime: "api_http",
			observerApiKey: "tok-config-explicit",
			observerMaxChars: 12_000,
			observerMaxTokens: 4_000,
			observerHeaders: {},
			observerAuthSource: "auto",
			observerAuthFile: null,
			observerAuthCommand: [],
			observerAuthTimeoutMs: 1500,
			observerAuthCacheTtlS: 300,
		});
		expect(client.getStatus().auth.source).toBe("explicit");
		expect(client.auth.token).toBe("tok-config-explicit");
	});

	function apiHttpClient(provider: string) {
		return new ObserverClient({
			observerProvider: provider,
			observerModel: provider === "anthropic" ? "claude-haiku-4-5" : "gpt-mini",
			observerRuntime: "api_http",
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

	it("does not send an unrelated pi key to an explicit Anthropic observer", () => {
		writePiApiKeyFixture(h, { provider: "acme" });
		const client = apiHttpClient("anthropic");
		const status = client.getStatus();
		expect(status.auth.source).not.toBe("pi");
		expect(status.auth.hasToken).toBe(false);
		expect(client.auth.token).not.toBe(PI_FIXTURE_KEY);
		expect(JSON.stringify(status)).not.toContain(PI_FIXTURE_KEY);
		expect(client.toConfig().observerApiKey).toBeNull();
	});

	it("does not send an unrelated pi key to an explicit OpenAI observer", () => {
		writePiApiKeyFixture(h, { provider: "acme" });
		const client = apiHttpClient("openai");
		const status = client.getStatus();
		expect(status.auth.source).not.toBe("pi");
		expect(status.auth.hasToken).toBe(false);
		expect(client.auth.token).not.toBe(PI_FIXTURE_KEY);
		expect(JSON.stringify(status)).not.toContain(PI_FIXTURE_KEY);
		expect(client.toConfig().observerApiKey).toBeNull();
	});
});

describe("ObserverClient — pi-derived auth provider match", () => {
	const h = piAuthHarness();
	beforeEach(() => h.before());
	afterEach(() => h.after());

	it("matching anthropic pi provider may supply the key", () => {
		writePiApiKeyFixture(h, {
			provider: "anthropic",
			model: "claude-haiku-4-5",
			baseUrl: "https://api.anthropic.com",
		});
		const client = apiHttpClient("anthropic");
		expect(client.getStatus().auth.source).toBe("pi");
		expect(client.getStatus().auth.hasToken).toBe(true);
		expect(client.toConfig().observerApiKey).toBeNull();
		expect(JSON.stringify(client.getStatus())).not.toContain(PI_FIXTURE_KEY);
	});

	it("matching openai pi provider may supply the key (case-insensitive)", () => {
		writePiApiKeyFixture(h, {
			provider: "OpenAI",
			model: "gpt-mini",
			baseUrl: "https://api.openai.com/v1",
		});
		const client = apiHttpClient("openai");
		expect(client.getStatus().auth.source).toBe("pi");
		expect(client.getStatus().auth.hasToken).toBe(true);
		expect(client.toConfig().observerApiKey).toBeNull();
	});

	it("oauth-only pi install does not invent a token (status stays clean)", () => {
		if (!h.piDir) throw new Error("h.piDir unset");
		writeFileSync(join(h.piDir, "settings.json"), JSON.stringify({ defaultModel: "openai/gpt-x" }));
		writeFileSync(
			join(h.piDir, "models-store.json"),
			JSON.stringify({
				openai: {
					models: [
						{
							id: "gpt-x",
							api: "openai-responses",
							baseUrl: "https://api.openai.com/v1",
						},
					],
				},
			}),
		);
		writeFileSync(
			join(h.piDir, "auth.json"),
			JSON.stringify({ openai: { type: "oauth", access: "oauth-access-not-usable" } }),
		);

		const client = new ObserverClient({
			observerProvider: "openai",
			observerModel: "gpt-x",
			observerRuntime: "api_http",
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
		// No API-key path from pi; no env keys → no token (not a silent 401 with a bogus key).
		expect(client.getStatus().auth.hasToken).toBe(false);
		expect(client.getStatus().auth.source).toBe("none");
		expect(JSON.stringify(client.getStatus())).not.toContain("oauth-access-not-usable");
	});

	it("does not suppress claude_sidecar auto-select when only a pi api key is present", () => {
		// Dual-install: user runs Claude Code AND has pi auth.json with a key.
		// The pi key feeds api_http credential resolution only — it must NOT gate
		// sidecar auto-select (sidecar auth goes through the claude/codex CLI).
		writePiApiKeyFixture(h);
		process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
		// No explicit observer key / provider env keys (cleared in beforeEach).
		const cfg = loadObserverConfig();
		expect(cfg.observerRuntime).toBe("claude_sidecar");
		// Key stays off the config object (api_http-only, resolved in-memory).
		expect(cfg.observerApiKey).toBeNull();
		expect(cfg.observerModel).toBeNull();
		expect(cfg.observerProvider).toBeNull();
		const client = new ObserverClient(cfg);
		expect(client.model).toBe("claude-haiku-4-5");
	});
});

describe("ObserverClient — pi-derived auth sidecar", () => {
	const h = piAuthHarness();
	beforeEach(() => h.before());
	afterEach(() => h.after());

	it("still suppresses claude_sidecar auto-select when an explicit env API key is set", () => {
		writePiApiKeyFixture(h);
		process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
		process.env.ANTHROPIC_API_KEY = "sk-explicit-anthropic";
		const cfg = loadObserverConfig();
		expect(cfg.observerRuntime).not.toBe("claude_sidecar");
	});

	it("does not suppress codex_sidecar auto-select when only a pi api key is present", () => {
		// Dual-install twin of the claude I4 case: pi auth.json key must not
		// steal runtime toward api_http when codex sidecar preconditions hold.
		writePiApiKeyFixture(h);
		if (!h.tmpHome) throw new Error("h.tmpHome unset");
		const codexDir = join(h.tmpHome, ".codex");
		mkdirSync(codexDir, { recursive: true });
		writeFileSync(join(codexDir, "auth.json"), JSON.stringify({ tokens: { access: "x" } }));
		const fakeCodex = join(h.tmpHome, "fake-codex");
		writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		process.env.CODEMEM_CODEX_COMMAND = fakeCodex;
		// No CLAUDE_CODE_* markers, no explicit observer/provider env keys.
		const cfg = loadObserverConfig();
		expect(cfg.observerRuntime).toBe("codex_sidecar");
		expect(cfg.observerApiKey).toBeNull();
		expect(cfg.observerModel).toBeNull();
		expect(cfg.observerProvider).toBeNull();
		const client = new ObserverClient(cfg);
		expect(client.model).toBe("gpt-6-luna");
	});

	it("does not send a gateway-scoped pi openai key to api.openai.com", () => {
		writePiApiKeyFixture(h, {
			provider: "openai",
			model: "gpt-mini",
			baseUrl: "https://gateway.example.test/v1",
			api: "openai-completions",
		});
		const client = apiHttpClient("openai");
		expect(client.getStatus().auth.source).not.toBe("pi");
		expect(client.auth.token).not.toBe(PI_FIXTURE_KEY);
	});

	it("sends zero-config anthropic requests to the pi endpoint", async () => {
		writePiApiKeyFixture(h, {
			provider: "anthropic",
			model: "claude-haiku-4-5",
			baseUrl: "https://proxy.anthropic.test/v1",
			api: "anthropic-messages",
		});
		const previousFetch = globalThis.fetch;
		let capturedUrl: string | undefined;
		globalThis.fetch = (async (input: string | URL | Request) => {
			capturedUrl = String(input);
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		try {
			const client = new ObserverClient();
			await client.observe("system", "user");
			expect(capturedUrl).toContain("proxy.anthropic.test");
			expect(capturedUrl).not.toContain("api.anthropic.com");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("does not send unauthenticated prompts on a pi-derived base URL", async () => {
		writePiApiKeyFixture(h);
		const previousFetch = globalThis.fetch;
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;
		try {
			const cfg = loadObserverConfig();
			cfg.observerAuthSource = "none";
			const client = new ObserverClient(cfg);
			await client.observe("system", "user");
			expect(fetched).toBe(false);
			expect(client.getStatus().lastError?.code).toBe("auth_missing");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});
});

describe("ObserverClient — pi-derived auth unauthenticated", () => {
	const h = piAuthHarness();
	beforeEach(() => h.before());
	afterEach(() => h.after());

	it("does not send unauthenticated prompts when a pi-derived URL outlives the pi credential", async () => {
		writePiApiKeyFixture(h);
		const cfg = loadObserverConfig();
		expect(cfg.observerBaseUrl).toBeTruthy();
		if (!h.piDir) throw new Error("h.piDir unset");
		rmSync(h.piDir, { recursive: true, force: true });
		const previousFetch = globalThis.fetch;
		let fetched = false;
		globalThis.fetch = (async () => {
			fetched = true;
			return new Response("{}", { status: 200 });
		}) as typeof globalThis.fetch;
		try {
			const client = new ObserverClient(cfg);
			await client.observe("system", "user");
			expect(fetched).toBe(false);
			expect(client.getStatus().lastError?.code).toBe("auth_missing");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("withholds vendor env keys from a pi-derived openai endpoint", () => {
		// Reverse direction of the gateway-key test: a zero-config pi provider
		// literally named "openai" must not attract the official OPENAI_API_KEY.
		writePiApiKeyFixture(h, {
			provider: "openai",
			model: "gpt-mini",
			baseUrl: "https://gateway.example.test/v1",
			api: "openai-completions",
		});
		process.env.OPENAI_API_KEY = "sk-official-openai";
		const cfg = loadObserverConfig();
		expect(cfg.observerProvider).toBe("openai");
		expect(cfg.observerBaseUrl).toBe("https://gateway.example.test/v1");
		const client = new ObserverClient(cfg);
		expect(client.getStatus().auth.source).toBe("pi");
		expect(client.auth.token).toBe(PI_FIXTURE_KEY);
		expect(client.auth.token).not.toBe("sk-official-openai");
	});

	it("withholds codex OAuth from a pi-derived openai endpoint", () => {
		writePiApiKeyFixture(h, {
			provider: "openai",
			model: "gpt-mini",
			baseUrl: "https://gateway.example.test/v1",
			api: "openai-completions",
		});
		if (!h.tmpHome) throw new Error("h.tmpHome unset");
		const oauthDir = join(h.tmpHome, ".local", "share", "opencode");
		mkdirSync(oauthDir, { recursive: true });
		writeFileSync(
			join(oauthDir, "auth.json"),
			JSON.stringify({
				openai: {
					type: "oauth",
					access: "codex-oauth-access-token",
					refresh: "codex-oauth-refresh",
					expires: Date.now() + 3_600_000,
				},
			}),
		);

		const client = new ObserverClient(loadObserverConfig());
		expect(client.getStatus().auth.source).toBe("pi");
		expect(client.auth.token).toBe(PI_FIXTURE_KEY);
		expect(JSON.stringify(client.getStatus())).not.toContain("codex-oauth-access-token");
	});

	it("withholds vendor env keys from a pi-derived anthropic endpoint", () => {
		writePiApiKeyFixture(h, {
			provider: "anthropic",
			model: "claude-haiku-4-5",
			baseUrl: "https://proxy.anthropic.test/v1",
			api: "anthropic-messages",
		});
		process.env.ANTHROPIC_API_KEY = "sk-official-anthropic";
		const cfg = loadObserverConfig();
		expect(cfg.observerProvider).toBe("anthropic");
		expect(cfg.observerBaseUrl).toBe("https://proxy.anthropic.test/v1");
		const client = new ObserverClient(cfg);
		expect(client.getStatus().auth.source).toBe("pi");
		expect(client.auth.token).toBe(PI_FIXTURE_KEY);
		expect(client.auth.token).not.toBe("sk-official-anthropic");
	});
});

describe("ObserverClient — pi-derived auth vendor credentials", () => {
	const h = piAuthHarness();
	beforeEach(() => h.before());
	afterEach(() => h.after());

	it("still uses vendor env keys on the official provider endpoint", () => {
		writePiApiKeyFixture(h, {
			provider: "openai",
			model: "gpt-mini",
			baseUrl: "https://api.openai.com/v1",
			api: "openai-completions",
		});
		process.env.OPENAI_API_KEY = "sk-official-openai";
		const client = new ObserverClient(loadObserverConfig());
		expect(client.getStatus().auth.source).toBe("env");
		expect(client.auth.token).toBe("sk-official-openai");
	});

	it("prefers the OpenCode provider block over a pi URL for the same provider", async () => {
		// pi and OpenCode both configure provider "acme" with different URLs and
		// keys. Endpoint and credential must come from the same source: the
		// OpenCode block wins outright, so its key is never sent to the pi host.
		writePiApiKeyFixture(h, {
			provider: "acme",
			model: "gpt-mini",
			baseUrl: "https://pi-acme.test/v1",
		});
		writeOpenCodeAcmeFixture(h);

		const previousFetch = globalThis.fetch;
		let capturedUrl: string | undefined;
		let capturedAuth: string | undefined;
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			capturedUrl = String(input);
			capturedAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
			return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof globalThis.fetch;
		try {
			const client = new ObserverClient({
				observerProvider: "acme",
				observerModel: "acme/gpt-mini",
				observerRuntime: "api_http",
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
			expect(client.auth.token).toBe("sk-opencode-acme");
			await client.observe("system", "user");
			expect(capturedUrl).toContain("opencode-acme.test");
			expect(capturedUrl).not.toContain("pi-acme.test");
			expect(capturedAuth).toBe("Bearer sk-opencode-acme");
		} finally {
			globalThis.fetch = previousFetch;
		}
	});

	it("does not fill the pi base URL in loadObserverConfig when an OpenCode provider block exists", () => {
		// The production zero-config path: applyPiDerivedObserverFields must not
		// stamp the pi URL onto cfg when OpenCode owns the provider — otherwise the
		// constructor guard never engages and the OpenCode key leaks to the pi host.
		writePiApiKeyFixture(h, {
			provider: "acme",
			model: "gpt-mini",
			baseUrl: "https://pi-acme.test/v1",
		});
		writeOpenCodeAcmeFixture(h);

		const cfg = loadObserverConfig();
		expect(cfg.observerProvider).toBe("acme");
		expect(cfg.observerBaseUrl).toBeNull();
		const client = new ObserverClient(cfg);
		expect(client.auth.token).toBe("sk-opencode-acme");
	});

	it("keeps vendor env keys when the official endpoint is written with a full API path", () => {
		process.env.CODEMEM_OBSERVER_BASE_URL = "https://api.openai.com/v1/chat/completions";
		process.env.OPENAI_API_KEY = "sk-official-openai";
		const client = new ObserverClient(loadObserverConfig());
		expect(client.provider).toBe("openai");
		expect(client.getStatus().auth.source).toBe("env");
		expect(client.auth.token).toBe("sk-official-openai");
	});
});
