import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-key-endpoint-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(home, "pi"));
	vi.stubEnv("CODEMEM_OBSERVER_API_KEY", undefined);
	vi.stubEnv("CODEMEM_OBSERVER_RUNTIME", undefined);
	vi.stubEnv("OPENCODE_API_KEY", "fixture-zen-key");
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(home, { recursive: true, force: true });
});

it.each(["https://gateway.example/v1", "https://opencode.ai/other/v1"])(
	"never sends the Zen environment key to %s",
	async (endpoint) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const observer = new ObserverClient(
			loadObserverConfig({
				observer_runtime: "api_key",
				observer_provider: "opencode",
				observer_base_url: endpoint,
			}),
		);
		expect(observer.auth.token).toBeNull();
		const result = await observer.observe("system", "user");
		expect(result.outcome?.error?.code).toBe("auth_missing");
		expect(fetch).not.toHaveBeenCalled();
	},
);

it.each([undefined, "https://opencode.ai/zen/v1", "https://opencode.ai/zen/v1/"])(
	"keeps the Zen environment key for the official endpoint %s",
	(endpoint) => {
		const observer = new ObserverClient(
			loadObserverConfig({
				observer_runtime: "api_key",
				observer_provider: "opencode",
				observer_base_url: endpoint,
			}),
		);
		expect(observer.auth.token).toBe("fixture-zen-key");
	},
);

it("uses an explicitly supplied gateway key instead of the Zen environment key", async () => {
	const fetch = vi
		.fn()
		.mockResolvedValue(
			new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }),
		);
	vi.stubGlobal("fetch", fetch);
	const observer = new ObserverClient(
		loadObserverConfig({
			observer_runtime: "api_key",
			observer_provider: "opencode",
			observer_base_url: "https://gateway.example/v1",
			observer_api_key: "fixture-gateway-key",
		}),
	);
	await observer.observe("system", "user");
	expect(fetch.mock.calls[0]?.[0]).toBe("https://gateway.example/v1/chat/completions");
	expect(fetch.mock.calls[0]?.[1].headers.authorization).toBe("Bearer fixture-gateway-key");
});
