import { expect, it } from "vitest";
import { buildTieredObserverSelection } from "./extraction-tier-routing.js";
import { loadObserverConfig } from "./observer-client.js";

it.each(["openai", "anthropic"])(
	"uses %s tier defaults for blank API-key overrides",
	(provider) => {
		for (const blank of ["", "  "]) {
			const config = loadObserverConfig({
				observer_runtime: "api_key",
				observer_provider: provider,
			});
			config.observerSimpleModel = blank;
			config.observerRichModel = blank;
			const simple = buildTieredObserverSelection(config, {
				tier: "simple",
				reasons: [],
				observer: {},
			});
			const rich = buildTieredObserverSelection(config, {
				tier: "rich",
				reasons: [],
				observer: {},
			});
			expect(simple.observer.observerModel).toBe(
				provider === "openai" ? "gpt-6-luna" : "claude-haiku-4-5",
			);
			expect(rich.observer.observerModel).toBe(
				provider === "openai" ? "gpt-5.6-terra" : "claude-sonnet-4-6",
			);
		}
	},
);

it("keeps a custom-provider base model when its tier overrides are blank", () => {
	const config = loadObserverConfig({
		observer_runtime: "api_key",
		observer_provider: "gateway",
		observer_model: "saved-model",
	});
	config.observerSimpleModel = " ";
	config.observerRichModel = "";
	for (const tier of ["simple", "rich"] as const) {
		expect(
			buildTieredObserverSelection(config, { tier, reasons: [], observer: {} }).observer
				.observerModel,
		).toBe("saved-model");
	}
});
