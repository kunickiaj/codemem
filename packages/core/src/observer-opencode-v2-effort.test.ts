import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractionReplayObserverIdentity } from "./extraction-replay.js";
import { buildTieredObserverConfig } from "./extraction-tier-routing.js";
import { loadObserverConfig, ObserverClient } from "./observer-client.js";

/*
 * The OpenCode service selects reasoning effort through a model variant. The
 * observer sends the configured effort as that variant when the model lists it,
 * and otherwise uses the service default and reports what it requested.
 */

const generate = vi.hoisted(() => vi.fn());
const listVariants = vi.hoisted(() => vi.fn());
vi.mock("./opencode-v2-generation.js", async (importActual) => ({
	...(await importActual<typeof import("./opencode-v2-generation.js")>()),
	generateWithOpenCodeV2: generate,
	listOpenCodeV2ModelVariants: listVariants,
}));

const VARIANTS = ["none", "low", "medium", "high", "xhigh"];

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-opencode-effort-"));
	vi.stubEnv("HOME", home);
	vi.stubEnv("CODEMEM_CONFIG", join(home, "config.json"));
	for (const key of [
		"CODEMEM_OBSERVER_RUNTIME",
		"CODEMEM_OBSERVER_REASONING_EFFORT",
		"CODEMEM_OBSERVER_RICH_REASONING_EFFORT",
	])
		vi.stubEnv(key, undefined);
	generate.mockResolvedValue({ text: "{}", error: null });
	listVariants.mockResolvedValue(VARIANTS);
});
afterEach(() => {
	vi.unstubAllEnvs();
	generate.mockReset();
	listVariants.mockReset();
	rmSync(home, { recursive: true, force: true });
});

function serviceObserver(settings: Record<string, unknown>) {
	return new ObserverClient(
		loadObserverConfig({
			observer_runtime: "opencode_v2",
			observer_provider: "openai",
			observer_model: "gpt-5.6",
			...settings,
		}),
	);
}

function tierObserver(settings: Record<string, unknown>, tier: "simple" | "rich") {
	const base = serviceObserver({ observer_tier_routing_enabled: true, ...settings }).toConfig();
	return new ObserverClient(buildTieredObserverConfig(base, { tier, observer: {}, reasons: [] }));
}

function sentVariant() {
	return generate.mock.calls[0]?.[0]?.variant;
}

describe("reasoning effort on the OpenCode service", () => {
	it("sends the shared effort as the request variant", async () => {
		const observer = serviceObserver({ observer_reasoning_effort: "high" });

		await observer.observe("system", "user");

		expect(generate).toHaveBeenCalledWith({
			provider: "openai",
			model: "gpt-5.6",
			prompt: "system\n\nuser",
			variant: "high",
		});
		expect(listVariants).toHaveBeenCalledWith("openai", "gpt-5.6");
		expect(observer.getStatus()).toMatchObject({
			requestedReasoningEffort: "high",
			actualReasoningEffort: "high",
			reasoningEffortFallbackApplied: false,
			reasoningEffortFallbackReason: null,
		});
	});

	it("sends nothing and looks up nothing when no effort is configured", async () => {
		const observer = serviceObserver({});

		await observer.observe("system", "user");

		expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("variant");
		expect(listVariants).not.toHaveBeenCalled();
		expect(observer.getStatus()).toMatchObject({
			requestedReasoningEffort: null,
			actualReasoningEffort: null,
			reasoningEffortFallbackApplied: false,
		});
	});

	it.each([
		["simple", { observer_reasoning_effort: "low" }, "low"],
		[
			"simple",
			{ observer_reasoning_effort: "low", observer_rich_reasoning_effort: "xhigh" },
			"low",
		],
		[
			"rich",
			{ observer_reasoning_effort: "low", observer_rich_reasoning_effort: "xhigh" },
			"xhigh",
		],
		["rich", { observer_reasoning_effort: "low" }, "low"],
	] as const)("sends the %s tier's effort from %j", async (tier, settings, expected) => {
		await tierObserver(settings, tier).observe("system", "user");

		expect(sentVariant()).toBe(expected);
	});

	it("sends the configured effort on an Anthropic tier too", async () => {
		const observer = tierObserver(
			{ observer_provider: "anthropic", observer_rich_reasoning_effort: "high" },
			"rich",
		);

		await observer.observe("system", "user");

		expect(sentVariant()).toBe("high");
	});

	it.each(["simple", "rich"] as const)(
		"sends no tier default effort on the %s tier when none is configured",
		async (tier) => {
			await tierObserver({}, tier).observe("system", "user");

			expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("variant");
			expect(listVariants).not.toHaveBeenCalled();
		},
	);

	it("sends a replay or benchmark effort override ahead of the saved setting", async () => {
		// The replay and benchmark commands put --reasoning-effort into the shared setting.
		const saved = serviceObserver({ observer_reasoning_effort: "low" }).toConfig();
		const overridden = { ...saved, observerReasoningEffort: "medium" };

		await new ObserverClient(overridden).observe("system", "user");
		await new ObserverClient(
			buildTieredObserverConfig(
				{ ...overridden, observerTierRoutingEnabled: true },
				{ tier: "simple", observer: {}, reasons: [] },
			),
		).observe("system", "user");

		expect(generate.mock.calls.map(([input]) => input.variant)).toEqual(["medium", "medium"]);
	});

	it("sends the variant ID the model lists when only the case differs", async () => {
		listVariants.mockResolvedValue(["High"]);

		await serviceObserver({ observer_reasoning_effort: "high" }).observe("system", "user");

		expect(sentVariant()).toBe("High");
	});

	it.each([
		["the model does not list the variant", ["none", "low"], "variant not listed for model"],
		["the model catalog is unavailable", null, "model variants unavailable"],
	])("falls back to the service default when %s", async (_case, variants, reason) => {
		listVariants.mockResolvedValue(variants);
		const observer = serviceObserver({ observer_reasoning_effort: "max" });

		const response = await observer.observe("system", "user");

		expect(response.raw).toBe("{}");
		expect(generate.mock.calls[0]?.[0]).not.toHaveProperty("variant");
		expect(observer.getStatus()).toMatchObject({
			requestedReasoningEffort: "max",
			actualReasoningEffort: null,
			reasoningEffortFallbackApplied: true,
			reasoningEffortFallbackReason: reason,
		});
	});
});

describe("replay metadata for the OpenCode service", () => {
	it("reports the sent effort and marks other request settings as not transmitted", async () => {
		const observer = serviceObserver({
			observer_reasoning_effort: "high",
			observer_temperature: 0.2,
			observer_max_tokens: 4000,
		});
		await observer.observe("system", "user");

		expect(extractionReplayObserverIdentity(observer, null)).toMatchObject({
			transport: "opencode_v2",
			reasoningEffort: "high",
			requestedReasoningEffort: "high",
			reasoningEffortFallbackApplied: false,
			reasoningSummary: null,
			maxOutputTokens: null,
			temperature: null,
		});
	});

	it("reports an effort that fell back as requested, not applied", async () => {
		listVariants.mockResolvedValue(["low"]);
		const observer = serviceObserver({ observer_reasoning_effort: "xhigh" });
		await observer.observe("system", "user");

		expect(extractionReplayObserverIdentity(observer, "rich")).toMatchObject({
			reasoningEffort: null,
			requestedReasoningEffort: "xhigh",
			reasoningEffortFallbackApplied: true,
			reasoningEffortFallbackReason: "variant not listed for model",
		});
	});
});
