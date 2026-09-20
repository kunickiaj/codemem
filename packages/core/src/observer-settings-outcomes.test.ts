import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { buildTieredObserverConfig } from "./extraction-tier-routing.js";
import { ObserverAuthAdapter } from "./observer-auth.js";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	env = process.env;
	home = mkdtempSync(join(tmpdir(), "codemem-settings-outcomes-"));
	process.env = { PATH: env.PATH, HOME: home, CODEMEM_CONFIG: join(home, "config.json") };
});
afterEach(() => {
	process.env = env;
	rmSync(home, { recursive: true, force: true });
});

it.each([
	["disabled", false],
	[" YES ", true],
	["On", true],
] as const)("backs Settings sync outcome for environment value %s", (value, enabled) => {
	process.env.CODEMEM_SYNC_ENABLED = value;
	expect(readCoordinatorSyncConfig({ sync_enabled: true }).syncEnabled).toBe(enabled);
});

it.each([
	["COMMAND", "command"],
	["  FiLe  ", "file"],
	[" EnV ", "env"],
	[" NONE ", "none"],
	["", "explicit"],
	["   ", "explicit"],
	["invalid", "explicit"],
] as const)("backs Settings auth outcome normalization for %j", (source, resolvedSource) => {
	const filePath = join(home, "auth.txt");
	writeFileSync(filePath, "fixture-file-token");
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			observer_runtime: "api_http",
			observer_auth_source: source,
		}),
	);
	for (const useEnv of [false, true]) {
		if (useEnv) process.env.CODEMEM_OBSERVER_AUTH_SOURCE = source;
		const config = loadObserverConfig();
		const adapter = new ObserverAuthAdapter({
			source: config.observerAuthSource,
			filePath,
			command: [process.execPath, "-e", "process.stdout.write('fixture-command-token')"],
		});
		expect(
			adapter.resolve({ explicitToken: "fixture-explicit-token", envTokens: ["fixture-env-token"] })
				.source,
		).toBe(resolvedSource);
	}
});

it("resolves omitted provider, model, and routing before applying built-in tier defaults", () => {
	writeFileSync(join(home, "config.json"), JSON.stringify({ observer_runtime: "api_http" }));
	const loaded = loadObserverConfig();
	expect(loaded.observerProvider).toBeNull();
	expect(loaded.observerModel).toBeNull();
	expect(loaded.observerTierRoutingEnabled).toBe(false);
	expect(loaded.observerExplicitConfigKeys).not.toContain("observerTierRoutingEnabled");
	const client = new ObserverClient(loaded);
	expect(client.provider).toBe("openai");
	expect(client.tierRoutingEnabled).toBe(true);
	for (const tier of ["simple", "rich"] as const) {
		const selected = buildTieredObserverConfig(client.toConfig(), {
			tier,
			reasons: [],
			observer: {},
		});
		expect(selected.observerModel).not.toBe(client.model);
	}
});

it.each([
	{
		runtime: "api_http",
		routing: undefined,
		env: undefined,
		endpoint: undefined,
		enabled: true,
		fallback: false,
	},
	{
		runtime: "api_http",
		routing: false,
		env: undefined,
		endpoint: undefined,
		enabled: false,
		fallback: true,
	},
	{
		runtime: "api_http",
		routing: undefined,
		env: "true",
		endpoint: undefined,
		enabled: true,
		fallback: false,
	},
	{
		runtime: "api_http",
		routing: undefined,
		env: "1",
		endpoint: undefined,
		enabled: true,
		fallback: false,
	},
	{
		runtime: "api_http",
		routing: true,
		env: "false",
		endpoint: undefined,
		enabled: false,
		fallback: true,
	},
	{
		runtime: "api_http",
		routing: true,
		env: "0",
		endpoint: undefined,
		enabled: false,
		fallback: true,
	},
	{
		runtime: "api_http",
		routing: undefined,
		env: undefined,
		endpoint: "https://gateway.example/v1",
		enabled: false,
		fallback: true,
	},
	{
		runtime: "claude_sidecar",
		routing: undefined,
		env: undefined,
		endpoint: undefined,
		enabled: true,
		fallback: false,
	},
	{
		runtime: "codex_sidecar",
		routing: undefined,
		env: undefined,
		endpoint: undefined,
		enabled: false,
		fallback: true,
	},
	{
		runtime: "codex_sidecar",
		routing: true,
		env: undefined,
		endpoint: undefined,
		enabled: true,
		fallback: true,
	},
])("backs Settings base-model fallback wording with runtime resolution: %j", (scenario) => {
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			observer_runtime: scenario.runtime,
			observer_model: "gpt-5.4-mini",
			observer_tier_routing_enabled: scenario.routing,
			observer_base_url: scenario.endpoint,
			observer_auth_source: "none",
		}),
	);
	if (scenario.env !== undefined) process.env.CODEMEM_OBSERVER_TIER_ROUTING_ENABLED = scenario.env;
	const config = loadObserverConfig();
	const client = new ObserverClient(config);
	expect(client.tierRoutingEnabled).toBe(scenario.enabled);
	for (const tier of ["simple", "rich"] as const) {
		const selected = client.tierRoutingEnabled
			? buildTieredObserverConfig(client.toConfig(), { tier, reasons: [], observer: {} })
			: config;
		expect(selected.observerModel === config.observerModel).toBe(scenario.fallback);
	}
});
