import { expect, it } from "vitest";
import { diffSettingsPayload } from "./diff-payload";

it.each([true, false])(
	"preserves the displayed routing choice %s when changing connection",
	(routing) => {
		const baseline = { observer_runtime: "api_http", observer_tier_routing_enabled: routing };
		const current = {
			...baseline,
			observer_runtime: "codex_sidecar",
			observer_simple_model: "saved-simple",
		};
		expect(
			diffSettingsPayload({
				current,
				baseline,
				envOverrides: {},
				touchedKeys: new Set(["observer_runtime"]),
				isProtected: () => false,
			}),
		).toEqual({
			observer_runtime: "codex_sidecar",
			observer_simple_model: "saved-simple",
			observer_tier_routing_enabled: routing,
		});
	},
);

it("does not pin routing for an unrelated or reverted connection edit", () => {
	const baseline = { observer_runtime: "api_http", observer_tier_routing_enabled: true };
	expect(
		diffSettingsPayload({
			current: { ...baseline, observer_simple_model: "new-model" },
			baseline,
			envOverrides: {},
			touchedKeys: new Set(["observer_runtime"]),
			isProtected: () => false,
		}),
	).toEqual({ observer_simple_model: "new-model" });
});

it("does not pin routing when the environment controls the switch", () => {
	const baseline = { observer_runtime: "api_http", observer_tier_routing_enabled: true };
	expect(
		diffSettingsPayload({
			current: { ...baseline, observer_runtime: "codex_sidecar" },
			baseline,
			envOverrides: { observer_tier_routing_enabled: "CODEMEM_OBSERVER_TIER_ROUTING_ENABLED" },
			touchedKeys: new Set(["observer_runtime"]),
			isProtected: () => false,
		}),
	).toEqual({ observer_runtime: "codex_sidecar" });
});
