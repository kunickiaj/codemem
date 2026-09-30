import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderConfigModal } from "../data/config-loader";
import { EMPTY_FORM_STATE } from "../data/constants";
import { settingsState, settingsView } from "../data/state";
import type { SettingsPanelProps } from "../data/types";
import { ObserverPanel } from "./ObserverPanel";
import { ProcessingPanel } from "./ProcessingPanel";
import { SettingsOutcome, settingsOutcomeFor } from "./SettingsOutcome";
import { SyncPanel } from "./SyncPanel";

vi.mock("../../../components/primitives/radix-select", () => ({
	RadixSelect: ({ id }: { id?: string }) => <select id={id} />,
}));

vi.mock("../../../components/primitives/radix-switch", () => ({
	RadixSwitch: ({ id }: { id?: string }) => <input id={id} type="checkbox" />,
}));

const EDITABLE_SETTING_IDS = [
	"observerProvider",
	"observerModel",
	"observerRuntime",
	"observerMaxChars",
	"observerAuthSource",
	"observerAuthTimeoutMs",
	"observerAuthCacheTtlS",
	"rawEventsSweeperIntervalS",
	"observerTierRoutingEnabled",
	"observerSimpleModel",
	"observerSimpleTemperature",
	"observerReasoningEffort",
	"observerReasoningSummary",
	"observerRichModel",
	"observerRichTemperature",
	"observerRichReasoningEffort",
	"observerRichReasoningSummary",
	"observerRichMaxOutputTokens",
	"packObservationLimit",
	"packSessionLimit",
	"syncEnabled",
	"syncInterval",
	"syncHost",
	"syncPort",
	"syncMdns",
	"syncCoordinatorGroup",
	"syncCoordinatorTimeout",
	"syncCoordinatorPresenceTtl",
];

function panelProps(observerRuntime = "api_http"): SettingsPanelProps {
	return {
		values: {
			...EMPTY_FORM_STATE,
			observerRuntime,
			observerTierRoutingEnabled: true,
		},
		observerMaxCharsDefault: "12000",
		providerOptions: [],
		showAuthFile: true,
		showAuthCommand: true,
		showTieredRouting: true,
		hiddenUnlessAdvanced: () => false,
		onTextInput: () => vi.fn(),
		onSelectValueChange: () => vi.fn(),
		onSwitchInput: () => vi.fn(),
		getObserverModelLabel: () => "Model",
		getObserverModelTooltip: () => "",
		getObserverModelDescription: () => "",
		getObserverModelHint: () => "",
		protectedConfigHelp: () => "Managed outside Settings",
	};
}

function renderPanels(observerRuntime = "api_http") {
	const mount = document.createElement("div");
	document.body.appendChild(mount);
	settingsView.value = {
		...settingsView.value,
		renderState: {
			...settingsView.value.renderState,
			values: { ...settingsView.value.renderState.values, observerRuntime },
		},
	};
	const props = panelProps(observerRuntime);
	act(() => {
		render(
			<>
				<ObserverPanel {...props} observerStatusBannerSlot={null} />
				<ProcessingPanel {...props} />
				<SyncPanel {...props} />
			</>,
			mount,
		);
	});
	return mount;
}

afterEach(() => {
	document.body.innerHTML = "";
	settingsState.envOverrides = {};
	settingsState.baseline = {};
	settingsView.value = {
		...settingsView.value,
		renderState: {
			...settingsView.value.renderState,
			values: { ...settingsView.value.renderState.values, observerRuntime: "api_http" },
		},
	};
});

it("retains active observer scope and data impact without guessing timing", () => {
	const root = renderPanels();
	for (const id of ["observerRuntime", "observerMaxChars", "observerTierRoutingEnabled"]) {
		const disclosure = root.querySelector(`[data-settings-outcome-for="${id}"]`);
		expect(disclosure?.textContent).toContain("Affects:");
		expect(disclosure?.textContent).toContain("Scope:");
		expect(disclosure?.textContent).toContain("Stored memories stay unchanged");
		expect(disclosure?.textContent).not.toContain("Takes effect:");
		expect(disclosure?.textContent).not.toContain("restart");
	}
});

it.each(["command", "file"])(
	"explains auth override removal above saved %s authentication",
	(source) => {
		settingsState.baseline = { observer_auth_source: source };
		settingsState.envOverrides = { observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE" };
		const outcome = settingsOutcomeFor("observerAuthSource", { observerRuntime: "codex_sidecar" });
		const root = document.createElement("div");
		document.body.appendChild(root);
		act(() => render(outcome ? <SettingsOutcome {...outcome} /> : null, root));
		expect(root.textContent).toContain("CODEMEM_OBSERVER_AUTH_SOURCE");
		expect(root.textContent).toContain("restart the viewer");
		expect(root.textContent).not.toContain("does not activate");
	},
);

it.each(["claude_sidecar", "codex_sidecar"])(
	"keeps auth removal inactive for pinned %s",
	(runtime) => {
		renderConfigModal({
			config: { observer_runtime: runtime, observer_auth_source: "command" },
			resolved_observer_runtime: runtime,
			env_overrides: { observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE" },
		});
		const outcome = settingsOutcomeFor("observerAuthSource");
		const root = document.createElement("div");
		document.body.appendChild(root);
		act(() => render(outcome ? <SettingsOutcome {...outcome} /> : null, root));
		expect(root.textContent).toContain("does not activate this field");
		expect(root.textContent).not.toContain("connection may change");
		expect(root.textContent).not.toContain("use the saved authentication settings");
	},
);

it.each([
	["observerAuthTimeoutMs", "observer_auth_timeout_ms", "CODEMEM_OBSERVER_AUTH_TIMEOUT_MS"],
	["observerAuthCacheTtlS", "observer_auth_cache_ttl_s", "CODEMEM_OBSERVER_AUTH_CACHE_TTL_S"],
])("names both controlling variables for %s recovery", (id, key, variable) => {
	renderConfigModal({
		config: { observer_auth_source: "command" },
		resolved_observer_runtime: "codex_sidecar",
		env_overrides: { observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE", [key]: variable },
	});
	const outcome = settingsOutcomeFor(id);
	const root = document.createElement("div");
	document.body.appendChild(root);
	act(() => render(outcome ? <SettingsOutcome {...outcome} /> : null, root));
	expect(root.textContent).toContain(`Remove CODEMEM_OBSERVER_AUTH_SOURCE and ${variable}`);
});

it.each(["observerAuthTimeoutMs", "observerAuthCacheTtlS"])(
	"shows auth-source recovery for %s without its own override",
	(id) => {
		renderConfigModal({
			config: { observer_auth_source: "command" },
			resolved_observer_runtime: "codex_sidecar",
			env_overrides: { observer_auth_source: "CODEMEM_OBSERVER_AUTH_SOURCE" },
		});
		const outcome = settingsOutcomeFor(id);
		const root = document.createElement("div");
		document.body.appendChild(root);
		act(() => render(outcome ? <SettingsOutcome {...outcome} /> : null, root));
		expect(root.textContent).toContain(
			"Remove CODEMEM_OBSERVER_AUTH_SOURCE and restart the viewer",
		);
	},
);

describe("inactive pack setting outcomes", () => {
	it("keeps no-effect timing under environment overrides", () => {
		settingsState.envOverrides = {
			pack_observation_limit: "CODEMEM_PACK_OBSERVATION_LIMIT",
			pack_session_limit: "CODEMEM_PACK_SESSION_LIMIT",
		};
		const root = renderPanels();

		for (const controlId of ["packObservationLimit", "packSessionLimit"]) {
			const outcome = root.querySelector(`[data-settings-outcome-for="${controlId}"]`)?.textContent;
			expect(outcome).toContain("Not used when Codemem creates context packs");
			expect(outcome).not.toContain("After removing");
		}
	});
});

it.each(["claude_sidecar", "codex_sidecar"])(
	"keeps unsupported local %s tuning visibly inactive without an override",
	(runtime) => {
		const root = renderPanels(runtime);
		expect(root.textContent).toContain(
			"Inactive · Anthropic and local Claude/Codex sessions do not send sampling temperature",
		);
		expect(root.textContent).toContain(
			"Local Claude and Codex sessions do not use these API tuning fields",
		);
		expect(
			root.querySelector("#observerSimpleTemperature")?.closest(".field")?.textContent,
		).not.toContain("Restart required");
	},
);

it.each(["claude_sidecar", "codex_sidecar"])(
	"keeps overridden temperature inactive for %s",
	(runtime) => {
		settingsState.envOverrides = {
			observer_simple_temperature: "CODEMEM_OBSERVER_SIMPLE_TEMPERATURE",
		};
		const root = renderPanels(runtime);
		const note =
			root
				.querySelector("#observerSimpleTemperature")
				?.closest(".field")
				?.querySelector(".settings-env-note")?.textContent ??
			root.querySelector(".settings-env-note")?.textContent;
		expect(note).toContain("CODEMEM_OBSERVER_SIMPLE_TEMPERATURE");
		expect(note).toContain("Inactive");
		expect(note).toContain("do not send sampling temperature");
		expect(note).not.toContain("to apply changes here");
	},
);

describe("settings outcomes", () => {
	it("keeps observer restart guesses off fields while preserving sync and processing outcomes", () => {
		const root = renderPanels();

		for (const id of EDITABLE_SETTING_IDS) {
			expect(root.querySelector(`#${id}`), `${id} control`).not.toBeNull();
			const outcome = root.querySelector(`[data-settings-outcome-for="${id}"]`);
			if (id.startsWith("observer")) {
				expect(outcome, `${id} has impact details`).not.toBeNull();
				expect(outcome?.textContent).toContain("Existing data:");
				expect(outcome?.textContent).not.toContain("Takes effect:");
				continue;
			}
			expect(outcome, `${id} outcome`).not.toBeNull();
			expect(outcome?.tagName).toBe("DETAILS");
			expect(outcome?.hasAttribute("open")).toBe(false);
			expect(outcome?.firstElementChild?.tagName).toBe("SUMMARY");
			expect(outcome?.textContent).toContain("Affects:");
			expect(outcome?.textContent).toContain("Scope:");
			expect(outcome?.textContent).toContain("Takes effect:");
			expect(outcome?.textContent).toContain("Existing data:");
		}
	});

	it("keeps actionable timing visible while collapsing the full explanation", () => {
		const root = renderPanels();
		const summaryFor = (id: string) =>
			root.querySelector(`[data-settings-outcome-for="${id}"] > summary`)?.textContent;
		expect(summaryFor("observerProvider")).toBe("Change details");
		expect(summaryFor("rawEventsSweeperIntervalS")).toBe("Immediately after save");
		expect(summaryFor("packObservationLimit")).toBe(
			"Inactive · Not used when Codemem creates context packs",
		);
		expect(summaryFor("syncHost")).toContain("restart the viewer before sharing or using them");
	});

	it("distinguishes live, restart, and future-pack timing without annotating protected values", () => {
		const root = renderPanels();

		expect(
			root.querySelector('[data-settings-outcome-for="rawEventsSweeperIntervalS"]')?.textContent,
		).toContain("Immediately after save");
		expect(
			root.querySelector('[data-settings-outcome-for="observerProvider"]')?.textContent,
		).not.toContain("restart");
		expect(
			root.querySelector('[data-settings-outcome-for="packObservationLimit"]')?.textContent,
		).toContain("Not used when Codemem creates context packs");
		expect(root.querySelector('[data-settings-outcome-for="syncEnabled"]')?.textContent).toContain(
			"After viewer restart",
		);
		expect(root.querySelector('[data-settings-outcome-for="observerAuthFile"]')).toBeNull();
		expect(root.querySelector('[data-settings-outcome-for="syncCoordinatorUrl"]')).toBeNull();
	});

	it("discloses the existing-memory effect of sync changes", () => {
		settingsView.value = {
			...settingsView.value,
			renderState: {
				...settingsView.value.renderState,
				values: { ...settingsView.value.renderState.values, syncEnabled: true },
			},
		};
		const root = renderPanels();
		const syncOutcome = root.querySelector(
			'[data-settings-outcome-for="syncEnabled"]',
		)?.textContent;

		expect(syncOutcome).toContain("not reprocessed locally");
		expect(syncOutcome).toContain("sent to or received from trusted peers");
	});

	it("qualifies the singular coordinator group as a fallback", () => {
		const root = renderPanels();
		const outcome = root.querySelector(
			'[data-settings-outcome-for="syncCoordinatorGroup"]',
		)?.textContent;

		expect(outcome).toContain("when no coordinator group list is configured");
	});

	it("names the environment override that must be removed", () => {
		settingsState.envOverrides = { observer_model: "CODEMEM_OBSERVER_MODEL" };
		const root = renderPanels();

		expect(root.querySelector(".settings-env-note")?.textContent).toContain(
			"CODEMEM_OBSERVER_MODEL",
		);
		expect(root.querySelector(".settings-env-note")?.textContent).toContain("restart the viewer");
		expect(
			root.querySelector('[data-settings-outcome-for="observerProvider"]')?.textContent,
		).not.toContain("restart");
	});

	it.each(["claude_sidecar", "codex_sidecar"])("hides API auth controls for %s", (runtime) => {
		const root = renderPanels(runtime);
		const authGroup = root
			.querySelector<HTMLElement>("#observerAuthSource")
			?.closest<HTMLElement>(".settings-group");
		expect(authGroup?.hidden).toBe(true);
	});
});
