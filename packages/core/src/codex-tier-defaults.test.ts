import { expect, it, vi } from "vitest";
import { buildTieredObserverSelection } from "./extraction-tier-routing.js";
import { loadObserverConfig, type ObserverConfig } from "./observer-client.js";

function baseConfig(overrides: Partial<ObserverConfig> = {}): ObserverConfig {
	return {
		...loadObserverConfig({ observer_runtime: "codex_sidecar" }),
		observerModel: "gpt-6-luna",
		observerExplicitConfigKeys: [],
		...overrides,
	};
}

it.each(["", "  "])("uses tier defaults when environment overrides are blank (%j)", (blank) => {
	vi.stubEnv("CODEMEM_OBSERVER_SIMPLE_MODEL", blank);
	vi.stubEnv("CODEMEM_OBSERVER_RICH_MODEL", blank);
	try {
		const config = loadObserverConfig({ observer_runtime: "codex_sidecar" });
		for (const [tier, model] of [
			["simple", "gpt-6-luna"],
			["rich", "gpt-5.6-terra"],
		] as const) {
			expect(
				buildTieredObserverSelection(config, { tier, reasons: [], observer: {} }).observer
					.observerModel,
			).toBe(model);
		}
	} finally {
		vi.unstubAllEnvs();
	}
});

it.each([
	{ tier: "simple", expectedModel: "gpt-6-luna" },
	{ tier: "rich", expectedModel: "gpt-5.6-terra" },
] as const)(
	"uses the Codex $tier default without an explicit base model",
	({ tier, expectedModel }) => {
		for (const config of [
			baseConfig(),
			baseConfig({ observerModel: null, observerExplicitConfigKeys: ["observerModel"] }),
			baseConfig({ observerSimpleModel: "", observerRichModel: "" }),
			baseConfig({
				observerSimpleModel: "  ",
				observerRichModel: "  ",
				observerModel: "  ",
				observerExplicitConfigKeys: ["observerModel"],
			}),
		]) {
			const selection = buildTieredObserverSelection(config, { tier, reasons: [], observer: {} });
			expect(selection.observer.observerModel).toBe(expectedModel);
			expect(selection.metadata.requestedModel).toBe(expectedModel);
		}
	},
);

it.each(["simple", "rich"] as const)(
	"preserves the legacy Codex base model for %s routing",
	(tier) => {
		for (const keys of [undefined, ["observerModel"]]) {
			const selection = buildTieredObserverSelection(
				baseConfig({ observerModel: "gpt-5.1-codex-mini", observerExplicitConfigKeys: keys }),
				{ tier, reasons: [], observer: {} },
			);
			expect(selection.observer.observerModel).toBe("gpt-5.1-codex-mini");
		}
	},
);

it.each(["simple", "rich"] as const)("preserves the explicit Codex %s tier model", (tier) => {
	const selection = buildTieredObserverSelection(
		baseConfig({
			observerModel: "gpt-5.1-codex-mini",
			observerExplicitConfigKeys: ["observerModel"],
			observerSimpleModel: "saved-simple",
			observerRichModel: "saved-rich",
		}),
		{ tier, reasons: [], observer: {} },
	);
	expect(selection.observer.observerModel).toBe(`saved-${tier}`);
});

it("uses an explicit base model when a tier override is blank", () => {
	const selection = buildTieredObserverSelection(
		baseConfig({
			observerModel: " saved-base ",
			observerExplicitConfigKeys: ["observerModel"],
			observerRichModel: " ",
		}),
		{ tier: "rich", reasons: [], observer: {} },
	);
	expect(selection.observer.observerModel).toBe("saved-base");
});
