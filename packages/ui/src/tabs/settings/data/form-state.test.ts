import { expect, it } from "vitest";
import { formStateFromPayload } from "./form-state";

it.each(["applying", "failed"] as const)(
	"ignores old observer routing while apply is %s",
	(state) => {
		for (const routing of [true, false]) {
			expect(
				formStateFromPayload({
					config: { observer_runtime: "codex_sidecar" },
					effective: { observer_tier_routing_enabled: routing },
					observer_apply: {
						state,
						active: {
							provider: "openai",
							model: "old-model",
							runtime: "api_http",
							authType: "sdk_client",
							tierRoutingEnabled: !routing,
						},
					},
				}).observerTierRoutingEnabled,
			).toBe(routing);
		}
	},
);

it("shows the running tier default when no explicit routing setting exists", () => {
	const payload = {
		config: {},
		effective: { observer_tier_routing_enabled: false },
		observer_apply: {
			state: "active" as const,
			active: {
				provider: "openai",
				model: "sample-model",
				runtime: "api_http",
				authType: "sdk_client",
				tierRoutingEnabled: true,
			},
		},
	};
	expect(formStateFromPayload(payload).observerTierRoutingEnabled).toBe(true);
	expect(
		formStateFromPayload({
			...payload,
			config: { observer_tier_routing_enabled: false },
		}).observerTierRoutingEnabled,
	).toBe(false);
	expect(
		formStateFromPayload({
			...payload,
			env_overrides: { observer_tier_routing_enabled: "CODEMEM_OBSERVER_TIER_ROUTING_ENABLED" },
		}).observerTierRoutingEnabled,
	).toBe(false);
});
