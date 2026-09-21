import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CODEMEM_CONFIG_ENV_OVERRIDES,
	getCodememEnvOverrides,
	getCodememEnvOverrideValues,
	loadObserverConfig,
	type ObserverConfig,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configRoutes } from "./config.js";

let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	env = process.env;
	home = mkdtempSync(join(tmpdir(), "codemem-env-outcomes-"));
	process.env = { HOME: home, CODEMEM_CONFIG: join(home, "config.json") };
});
afterEach(() => {
	process.env = env;
	rmSync(home, { recursive: true, force: true });
});

const strings = [
	["observer_provider", "observerProvider"],
	["observer_model", "observerModel"],
	["observer_runtime", "observerRuntime"],
	["observer_base_url", "observerBaseUrl"],
	["observer_simple_provider", "observerSimpleProvider"],
	["observer_simple_model", "observerSimpleModel"],
	["observer_rich_provider", "observerRichProvider"],
	["observer_rich_model", "observerRichModel"],
	["observer_reasoning_effort", "observerReasoningEffort"],
	["observer_reasoning_summary", "observerReasoningSummary"],
	["observer_rich_reasoning_effort", "observerRichReasoningEffort"],
	["observer_rich_reasoning_summary", "observerRichReasoningSummary"],
	["observer_auth_source", "observerAuthSource"],
	["observer_auth_file", "observerAuthFile"],
] as const;

async function configWithOverride(key: string, saved: unknown, raw: string) {
	const envKey = CODEMEM_CONFIG_ENV_OVERRIDES[key];
	if (!envKey) throw new Error(`Missing env mapping: ${key}`);
	process.env[envKey] = raw;
	writeFileSync(
		join(home, "config.json"),
		JSON.stringify({
			observer_runtime: "api_http",
			observer_api_key: "fixture-api-key",
			[key]: saved,
		}),
	);
	const response = await configRoutes().request("/api/config");
	expect(response.status).toBe(200);
	return { body: await response.json(), envKey, loaded: loadObserverConfig() };
}

it.each(strings)(
	"empty %s clears saved value and is environment controlled",
	async (key, normalized) => {
		const { body, envKey, loaded } = await configWithOverride(key, "saved-value", "");
		expect(loaded[normalized]).toBe("");
		expect(body.effective[key]).toBe(loaded[normalized]);
		expect(body.env_overrides[key]).toBe(envKey);
		expect(getCodememEnvOverrides()[key]).toBe(envKey);
	},
);

const parsed: Array<{
	key: string;
	normalized: keyof ObserverConfig;
	saved: unknown;
	raw: string;
	expected: unknown;
	controlled: boolean;
}> = [
	{
		key: "observer_max_output_tokens",
		normalized: "observerMaxOutputTokens",
		saved: 4000,
		raw: "",
		expected: 0,
		controlled: true,
	},
	{
		key: "observer_max_tokens",
		normalized: "observerMaxTokens",
		saved: 4000,
		raw: "",
		expected: 4000,
		controlled: false,
	},
	{
		key: "observer_openai_use_responses",
		normalized: "observerOpenAIUseResponses",
		saved: true,
		raw: "",
		expected: false,
		controlled: true,
	},
	{
		key: "observer_temperature",
		normalized: "observerTemperature",
		saved: 0.5,
		raw: "",
		expected: 0,
		controlled: true,
	},
	{
		key: "observer_simple_temperature",
		normalized: "observerSimpleTemperature",
		saved: 0.5,
		raw: "",
		expected: 0,
		controlled: true,
	},
	{
		key: "observer_rich_temperature",
		normalized: "observerRichTemperature",
		saved: 0.5,
		raw: "",
		expected: 0,
		controlled: true,
	},
	{
		key: "observer_rich_max_output_tokens",
		normalized: "observerRichMaxOutputTokens",
		saved: 4000,
		raw: "",
		expected: 0,
		controlled: true,
	},
	{
		key: "observer_tier_routing_enabled",
		normalized: "observerTierRoutingEnabled",
		saved: true,
		raw: "",
		expected: false,
		controlled: true,
	},
	{
		key: "observer_max_chars",
		normalized: "observerMaxChars",
		saved: 9000,
		raw: "",
		expected: 9000,
		controlled: false,
	},
	{
		key: "observer_auth_timeout_ms",
		normalized: "observerAuthTimeoutMs",
		saved: 2500,
		raw: "",
		expected: 2500,
		controlled: false,
	},
	{
		key: "observer_auth_cache_ttl_s",
		normalized: "observerAuthCacheTtlS",
		saved: 600,
		raw: "",
		expected: 600,
		controlled: false,
	},
	{
		key: "observer_output_mode",
		normalized: "observerOutputMode",
		saved: "json_schema",
		raw: "",
		expected: "json_schema",
		controlled: false,
	},
	{
		key: "observer_auth_command",
		normalized: "observerAuthCommand",
		saved: ["fixture-command"],
		raw: "",
		expected: [],
		controlled: true,
	},
	{
		key: "observer_headers",
		normalized: "observerHeaders",
		saved: { "x-fixture": "value" },
		raw: "",
		expected: {},
		controlled: true,
	},
	{
		key: "claude_command",
		normalized: "claudeCommand",
		saved: ["fixture-claude"],
		raw: "",
		expected: ["fixture-claude"],
		controlled: false,
	},
	{
		key: "codex_command",
		normalized: "codexCommand",
		saved: ["fixture-codex"],
		raw: "",
		expected: ["fixture-codex"],
		controlled: false,
	},
	{
		key: "observer_simple_temperature",
		normalized: "observerSimpleTemperature",
		saved: 0.5,
		raw: "invalid",
		expected: 0.5,
		controlled: false,
	},
	{
		key: "observer_auth_timeout_ms",
		normalized: "observerAuthTimeoutMs",
		saved: 2500,
		raw: "invalid",
		expected: 2500,
		controlled: false,
	},
	{
		key: "observer_auth_timeout_ms",
		normalized: "observerAuthTimeoutMs",
		saved: 2500,
		raw: "123ms",
		expected: 123,
		controlled: true,
	},
	{
		key: "observer_output_mode",
		normalized: "observerOutputMode",
		saved: "json_schema",
		raw: "invalid",
		expected: "json_schema",
		controlled: false,
	},
];

it.each(parsed)(
	"matches parsed override and fallback: $key=$raw",
	async ({ key, normalized, saved, raw, expected, controlled }) => {
		const { body, envKey, loaded } = await configWithOverride(key, saved, raw);
		expect(loaded[normalized]).toEqual(expected);
		expect(body.effective[key]).toEqual(expected);
		expect(body.env_overrides[key]).toBe(controlled ? envKey : undefined);
		expect(getCodememEnvOverrides()[key]).toBe(controlled ? envKey : undefined);
	},
);

it.each([
	["observer_auth_command", "observerAuthCommand", ["saved"], "   ", [], true],
	[
		"observer_auth_command",
		"observerAuthCommand",
		["saved"],
		'["env-command"]',
		["env-command"],
		true,
	],
	["observer_auth_command", "observerAuthCommand", ["saved"], "[42]", ["saved"], false],
	["observer_headers", "observerHeaders", { saved: "value" }, "   ", {}, true],
	["observer_headers", "observerHeaders", { saved: "value" }, "[]", { saved: "value" }, false],
	["observer_headers", "observerHeaders", { saved: "value" }, "invalid", { saved: "value" }, false],
	["claude_command", "claudeCommand", ["saved"], "   ", ["saved"], false],
	[
		"codex_command",
		"codexCommand",
		["saved"],
		"env-command --flag",
		["env-command", "--flag"],
		true,
	],
	["observer_temperature", "observerTemperature", 0.5, "   ", 0, true],
	["observer_tier_routing_enabled", "observerTierRoutingEnabled", true, "TRUE", false, true],
	["observer_tier_routing_enabled", "observerTierRoutingEnabled", false, "true", true, true],
] as const)(
	"matches runtime structured/whitespace override %s=%s",
	async (key, normalized, saved, raw, expected, controlled) => {
		const { body, envKey, loaded } = await configWithOverride(key, saved, raw);
		expect(loaded[normalized]).toEqual(expected);
		if (controlled) expect(getCodememEnvOverrideValues()[key]).toEqual(expected);
		const redacted =
			["observer_auth_command", "observer_headers"].includes(key) &&
			typeof expected === "object" &&
			Object.keys(expected).length > 0;
		expect(body.effective[key]).toEqual(redacted ? "[redacted]" : expected);
		expect(body.env_overrides[key]).toBe(controlled ? envKey : undefined);
	},
);

it.each([
	["observer_provider", "openai", "anthropic"],
	["observer_model", "old-model", "new-model"],
	["observer_simple_model", "old-model", "new-model"],
	["observer_rich_model", "old-model", "new-model"],
	["observer_auth_source", "file", "command"],
] as const)(
	"reports saves to %s as ignored under an empty env override",
	async (key, saved, next) => {
		await configWithOverride(key, saved, "");
		const response = await configRoutes().request("/api/config", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config: { [key]: next } }),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.config[key]).toBe(next);
		expect(body.effective[key]).toBe("");
		expect(body.effects.ignored_by_env_keys).toContain(key);
		expect(body.effects.effective_keys).not.toContain(key);
		expect(body.effects.restart_required_keys).not.toContain(key);
	},
);

it("does not mark an integer setting ignored when an empty env falls back to the saved value", async () => {
	await configWithOverride("observer_auth_timeout_ms", 1500, "");
	const response = await configRoutes().request("/api/config", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ config: { observer_auth_timeout_ms: 2500 } }),
	});
	const body = await response.json();
	expect(body.effective.observer_auth_timeout_ms).toBe(2500);
	expect(body.effects.ignored_by_env_keys).not.toContain("observer_auth_timeout_ms");
	expect(body.effects.restart_required_keys).toContain("observer_auth_timeout_ms");
});
