import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import { settingsState, settingsView } from "../data/state";
import type { SettingsPanelProps } from "../data/types";
import { ObserverPanel } from "./ObserverPanel";
import { ProcessingPanel } from "./ProcessingPanel";
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
		getTieredRoutingHelperText: () => "",
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
	settingsView.value = {
		...settingsView.value,
		renderState: {
			...settingsView.value.renderState,
			values: { ...settingsView.value.renderState.values, observerRuntime: "api_http" },
		},
	};
});

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

describe("settings outcomes", () => {
	it("identifies the stage, scope, timing, and existing-data effect for every editable setting", () => {
		const root = renderPanels();

		for (const id of EDITABLE_SETTING_IDS) {
			expect(root.querySelector(`#${id}`), `${id} control`).not.toBeNull();
			const outcome = root.querySelector(`[data-settings-outcome-for="${id}"]`);
			expect(outcome, `${id} outcome`).not.toBeNull();
			expect(outcome?.textContent).toContain("Affects:");
			expect(outcome?.textContent).toContain("Scope:");
			expect(outcome?.textContent).toContain("Takes effect:");
			expect(outcome?.textContent).toContain("Existing data:");
		}
	});

	it("distinguishes live, restart, and future-pack timing without annotating protected values", () => {
		const root = renderPanels();

		expect(
			root.querySelector('[data-settings-outcome-for="rawEventsSweeperIntervalS"]')?.textContent,
		).toContain("Immediately after save");
		expect(
			root.querySelector('[data-settings-outcome-for="observerProvider"]')?.textContent,
		).toContain("After viewer restart");
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

		expect(
			root.querySelector('[data-settings-outcome-for="observerModel"]')?.textContent,
		).toContain("After removing CODEMEM_OBSERVER_MODEL and restarting the viewer");
		expect(
			root.querySelector('[data-settings-outcome-for="observerProvider"]')?.textContent,
		).toContain("After viewer restart");
	});

	it.each(["claude_sidecar", "codex_sidecar"])(
		"marks API authentication controls inactive for %s",
		(runtime) => {
			const root = renderPanels(runtime);

			for (const controlId of [
				"observerAuthSource",
				"observerAuthTimeoutMs",
				"observerAuthCacheTtlS",
			]) {
				const outcome = root.querySelector(
					`[data-settings-outcome-for="${controlId}"]`,
				)?.textContent;
				expect(outcome).toContain(
					"No effect while Connection mode uses a local Claude or Codex session",
				);
				expect(outcome).toContain("Not used by local Claude or Codex sessions");
			}
		},
	);
});
