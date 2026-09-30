import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildTieredObserverConfig } from "./extraction-tier-routing.js";
import { probeAvailableCredentials } from "./observer-auth.js";
import { loadObserverConfig, ObserverAuthError, ObserverClient } from "./observer-client.js";
import { observerForRawEvents } from "./raw-event-flush.js";

const generate = vi.hoisted(() => vi.fn());
vi.mock("./opencode-v2-generation.js", async (importActual) => ({
	...(await importActual<typeof import("./opencode-v2-generation.js")>()),
	generateWithOpenCodeV2: generate,
}));

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-connection-modes-"));
	vi.stubEnv("HOME", home);
	for (const key of [
		"CODEMEM_OBSERVER_RUNTIME",
		"CODEMEM_OBSERVER_API_KEY",
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"CODEX_API_KEY",
		"OPENCODE_API_KEY",
		"PI_CODING_AGENT_DIR",
		"CODEMEM_ANTHROPIC_ENDPOINT",
	])
		vi.stubEnv(key, undefined);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	const authDir = join(home, ".local/share/opencode");
	mkdirSync(authDir, { recursive: true });
	writeFileSync(
		join(authDir, "auth.json"),
		JSON.stringify({
			openai: { type: "oauth", access: "fixture-openai-subscription" },
			anthropic: { type: "oauth", access: "fixture-anthropic-subscription" },
			opencode: { type: "api", key: "fixture-zen-key" },
		}),
	);
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	generate.mockReset();
	rmSync(home, { recursive: true, force: true });
});

it.each(["openai", "anthropic", "opencode"])(
	"API key mode ignores cached %s sign-ins and fails without a key",
	async (provider) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const observer = new ObserverClient(
			loadObserverConfig({ observer_runtime: "api_key", observer_provider: provider }),
		);
		expect(observer.runtime).toBe("api_key");
		expect(observer.auth.token).toBeNull();
		const result = await observer.observe("system", "user");
		expect(result.outcome.status).toBe("failure");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(generate).not.toHaveBeenCalled();
		expect(
			observerForRawEvents([{ codemem_host_generation: "v2" }], { observer }, "opencode").observer,
		).toBe(observer);
	},
);

it("API key mode preserves the connection across tier routing and uses the supplied key", async () => {
	const fetchMock = vi.fn().mockResolvedValue(
		new Response(
			JSON.stringify({
				output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
			}),
			{ status: 200 },
		),
	);
	vi.stubGlobal("fetch", fetchMock);
	const config = loadObserverConfig({
		observer_runtime: "api_key",
		observer_provider: "openai",
		observer_api_key: "fixture-explicit-key",
	});
	const tier = buildTieredObserverConfig(config, { tier: "rich", reasons: [], observer: {} });
	const observer = new ObserverClient(tier);
	expect(observer.runtime).toBe("api_key");
	expect(observer.getStatus().auth.type).toBe("api_direct");
	await observer.observeStructuredJson("system", "user", "test", { type: "object" });
	expect(fetchMock).toHaveBeenCalledOnce();
	expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
	expect(fetchMock.mock.calls[0]?.[1].headers.authorization).toBe("Bearer fixture-explicit-key");
});

it("uses OPENCODE_API_KEY only for the OpenCode API-key provider", () => {
	vi.stubEnv("OPENCODE_API_KEY", "fixture-provider-env-key");
	const opencode = new ObserverClient(
		loadObserverConfig({ observer_runtime: "api_key", observer_provider: "opencode" }),
	);
	expect(opencode.auth.token).toBe("fixture-provider-env-key");
	expect(probeAvailableCredentials().opencode?.env_var).toBe(true);
	for (const provider of ["openai", "anthropic", "gateway"]) {
		const observer = new ObserverClient(
			loadObserverConfig({
				observer_runtime: "api_key",
				observer_provider: provider,
				observer_base_url: "https://gateway.example/v1",
			}),
		);
		expect(observer.auth.token).toBeNull();
	}
});

it.each(["openai", "anthropic"])(
	"OpenCode %s structured requests never use direct API credentials",
	async (provider) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		generate.mockResolvedValue({ text: "{}", error: null });
		const observer = new ObserverClient(
			loadObserverConfig({
				observer_runtime: "opencode_v2",
				observer_provider: provider,
				observer_api_key: "fixture-unused-key",
				observer_openai_use_responses: true,
			}),
		);
		await observer.observeStructuredJson("system", "user", "test", { type: "object" });
		expect(generate).toHaveBeenCalledOnce();
		expect(fetchMock).not.toHaveBeenCalled();
		generate.mockResolvedValue({ text: null, error: "service_unavailable" });
		await expect(observer.observe("system", "user")).rejects.toBeInstanceOf(ObserverAuthError);
		expect(fetchMock).not.toHaveBeenCalled();
	},
);

it("legacy api_http still uses its existing subscription route", () => {
	const observer = new ObserverClient(
		loadObserverConfig({ observer_runtime: "api_http", observer_provider: "openai" }),
	);
	expect(observer.getStatus().auth.type).toBe("codex_consumer");
});

it.each([
	{ provider: "opencode", selected: undefined, expected: "gpt-6-luna" },
	{ provider: "custom", selected: "custom/org/model", expected: "org/model" },
	{ provider: "custom", selected: "org/model", expected: "org/model" },
	{ provider: "openai", selected: "OpenAI/gpt-6-luna", expected: "gpt-6-luna" },
	{ provider: "anthropic", selected: "ANTHROPIC/claude-sonnet-4-6", expected: "claude-sonnet-4-6" },
	{ provider: "custom", selected: "Custom/Org/Model", expected: "Org/Model" },
])(
	"sends provider-local model IDs to OpenCode for $provider/$selected",
	async ({ provider, selected, expected }) => {
		generate.mockResolvedValue({ text: "{}", error: null });
		const observer = new ObserverClient(
			loadObserverConfig({
				observer_runtime: "opencode_v2",
				observer_provider: provider,
				observer_model: selected,
			}),
		);
		await observer.observe("system", "user");
		expect(generate).toHaveBeenCalledWith({ provider, model: expected, prompt: "system\n\nuser" });
	},
);

it("API key mode requires a key even for a custom endpoint", async () => {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	const observer = new ObserverClient(
		loadObserverConfig({
			observer_runtime: "api_key",
			observer_provider: "openai",
			observer_base_url: "http://localhost:1234/v1",
		}),
	);
	const result = await observer.observeStructuredJson("system", "user", "test", { type: "object" });
	expect(result.outcome.status).toBe("failure");
	expect(fetchMock).not.toHaveBeenCalled();
});

it("API key mode accepts a provider environment key without using subscription credentials", () => {
	vi.stubEnv("ANTHROPIC_API_KEY", "fixture-provider-key");
	const observer = new ObserverClient(
		loadObserverConfig({ observer_runtime: "api_key", observer_provider: "anthropic" }),
	);
	expect(observer.auth.token).toBe("fixture-provider-key");
	expect(observer.getStatus().auth.type).toBe("api_direct");
});

it.each(["api_key", "opencode_v2"])(
	"retains %s even when explicit runtime metadata is missing",
	(runtime) => {
		const observer = new ObserverClient({
			...loadObserverConfig({}),
			observerRuntime: runtime,
			observerExplicitConfigKeys: [],
		});
		const options = { observer };
		expect(observerForRawEvents([{ codemem_host_generation: "v2" }], options, "opencode")).toBe(
			options,
		);
	},
);
