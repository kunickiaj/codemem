import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import { settingsState, settingsView } from "../data/state";
import { settingsOutcomeFor } from "./SettingsOutcome";

function values(update: Partial<typeof EMPTY_FORM_STATE>) {
	settingsView.value = {
		...settingsView.value,
		renderState: { ...settingsView.value.renderState, values: { ...EMPTY_FORM_STATE, ...update } },
	};
}
afterEach(() => {
	settingsState.envOverrides = {};
	settingsState.effectiveConfig = {};
	values({});
});

describe("effective Settings outcomes", () => {
	it.each(["true", "1"])("honors raw routing environment value %s", (routing) => {
		values({ observerProvider: "openai", observerTierRoutingEnabled: false });
		settingsState.envOverrides = {
			observer_tier_routing_enabled: "CODEMEM_OBSERVER_TIER_ROUTING_ENABLED",
		};
		settingsState.effectiveConfig = { observer_tier_routing_enabled: routing };
		expect(settingsOutcomeFor("observerModel")?.scope).toBe("No current effect");
	});
	it.each(["false", "0", "TRUE", "yes"])(
		"does not enable routing for runtime-disabled environment value %s",
		(routing) => {
			values({ observerProvider: "openai", observerTierRoutingEnabled: true });
			settingsState.envOverrides = {
				observer_tier_routing_enabled: "CODEMEM_OBSERVER_TIER_ROUTING_ENABLED",
			};
			settingsState.effectiveConfig = { observer_tier_routing_enabled: routing };
			expect(settingsOutcomeFor("observerModel")?.scope).toContain(
				"Requests that use the base model",
			);
		},
	);
	it.each(["false", "0"])("honors raw disabled sync environment value %s", (sync) => {
		values({ syncEnabled: true });
		settingsState.envOverrides = { sync_enabled: "CODEMEM_SYNC_ENABLED" };
		settingsState.effectiveConfig = { sync_enabled: sync };
		expect(settingsOutcomeFor("syncEnabled")?.scope).toContain("Stop future peer transfers");
		expect(settingsOutcomeFor("syncEnabled")?.existingData).toContain("does not retract");
	});
	it.each(["true", "1"])("honors raw enabled sync environment value %s", (sync) => {
		values({ syncEnabled: false });
		settingsState.envOverrides = { sync_enabled: "CODEMEM_SYNC_ENABLED" };
		settingsState.effectiveConfig = { sync_enabled: sync };
		expect(settingsOutcomeFor("syncEnabled")?.scope).toBe("Future sync cycles on this device");
	});
	it.each([
		{ observerRuntime: "api_http", observerProvider: "" },
		{ observerRuntime: "api_http", observerProvider: "openai" },
		{ observerRuntime: "api_http", observerProvider: "anthropic" },
		{ observerRuntime: "api_http", observerProvider: "custom" },
		{ observerRuntime: "claude_sidecar", observerProvider: "" },
		{ observerRuntime: "codex_sidecar", observerProvider: "" },
	])("qualifies base-model use when routing is omitted or false: %j", (config) => {
		// /api/config supplies false for omitted routing even when ObserverClient auto-enables it.
		values({ ...config, observerTierRoutingEnabled: false });
		const outcome = settingsOutcomeFor("observerModel");
		expect(outcome?.scope).toBe(
			"Requests that use the base model, including tiers that fall back to it",
		);
		expect(outcome?.timing).toContain(
			"only where no tier model or built-in tier default takes precedence",
		);
	});
	it("does not guess a provider when explicit routing uses automatic provider resolution", () => {
		values({ observerProvider: "", observerTierRoutingEnabled: true });
		expect(settingsOutcomeFor("observerModel")?.scope).toContain("tiers that fall back to it");
		expect(settingsOutcomeFor("observerModel")?.timing).toContain("built-in tier default");
	});
});

describe("transport-specific Settings outcomes", () => {
	it.each(["claude_sidecar", "codex_sidecar"])(
		"marks the base model inactive when %s uses tier models",
		(runtime) => {
			values({
				observerRuntime: runtime,
				observerProvider: "anthropic",
				observerTierRoutingEnabled: true,
				observerSimpleModel: "simple-model",
				observerRichModel: "rich-model",
			});
			expect(settingsOutcomeFor("observerModel")?.scope).toBe("No current effect");
		},
	);
	it("uses built-in Claude tier models when both overrides are empty", () => {
		values({
			observerRuntime: "claude_sidecar",
			observerProvider: "anthropic",
			observerTierRoutingEnabled: true,
			observerSimpleModel: "",
			observerRichModel: "",
		});
		expect(settingsOutcomeFor("observerModel")?.scope).toBe("No current effect");
	});
	it("keeps the Codex base model active when tier models fall back to it", () => {
		values({
			observerRuntime: "codex_sidecar",
			observerProvider: "openai",
			observerTierRoutingEnabled: true,
			observerSimpleModel: "",
			observerRichModel: "",
		});
		expect(settingsOutcomeFor("observerModel")?.scope).not.toBe("No current effect");
	});
	it("uses the temperature control's tier provider instead of the base provider", () => {
		values({
			observerRuntime: "api_http",
			observerProvider: "anthropic",
			observerTierRoutingEnabled: true,
		});
		settingsState.effectiveConfig = { observer_simple_provider: "openai" };
		expect(settingsOutcomeFor("observerSimpleTemperature")?.scope).not.toBe("No current effect");
		expect(settingsOutcomeFor("observerRichTemperature")?.scope).toBe("No current effect");
	});
	it.each(["claude_sidecar", "codex_sidecar"])(
		"uses effective %s despite a draft API runtime",
		(runtime) => {
			values({ observerRuntime: "api_http" });
			settingsState.envOverrides = { observer_runtime: "CODEMEM_OBSERVER_RUNTIME" };
			settingsState.effectiveConfig = { observer_runtime: runtime };
			expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("No effect");
			expect(settingsOutcomeFor("observerProvider")?.scope).toBe("No current effect");
			expect(settingsOutcomeFor("observerRichReasoningEffort")?.scope).toBe("No current effect");
		},
	);
	it("does not use a draft sidecar when API runtime is overridden", () => {
		values({ observerRuntime: "claude_sidecar" });
		settingsState.envOverrides = { observer_runtime: "CODEMEM_OBSERVER_RUNTIME" };
		settingsState.effectiveConfig = { observer_runtime: "api_http" };
		expect(settingsOutcomeFor("observerAuthSource")?.scope).toContain("model requests");
	});
	it("marks base model inactive behind tier defaults", () => {
		values({ observerProvider: "openai", observerTierRoutingEnabled: true });
		expect(settingsOutcomeFor("observerModel")?.scope).toBe("No current effect");
	});
	it("qualifies transport-dependent tuning", () => {
		values({ observerProvider: "anthropic" });
		expect(settingsOutcomeFor("observerSimpleTemperature")?.scope).toBe("No current effect");
		expect(settingsOutcomeFor("observerRichReasoningSummary")?.scope).toContain("Responses");
	});
	it("qualifies authentication controls by source", () => {
		values({ observerAuthSource: "env" });
		expect(settingsOutcomeFor("observerAuthTimeoutMs")?.scope).toBe("No current effect");
		values({ observerAuthSource: "auto" });
		expect(settingsOutcomeFor("observerAuthCacheTtlS")?.scope).toBe("No current effect");
	});
	it("describes disabled sync, advertisement, and immediate pairing address changes", () => {
		values({ syncEnabled: false });
		expect(settingsOutcomeFor("syncEnabled")?.existingData).toContain("does not retract");
		expect(settingsOutcomeFor("syncMdns")?.scope).toContain("Advertise");
		expect(settingsOutcomeFor("syncPort")?.timing).toContain("restart the viewer before sharing");
	});
});
