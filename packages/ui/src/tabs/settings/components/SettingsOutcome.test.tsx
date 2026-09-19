import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import { settingsState } from "../data/state";
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

function panelProps(): SettingsPanelProps {
	return {
		values: {
			...EMPTY_FORM_STATE,
			observerRuntime: "api_http",
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

function renderPanels() {
	const mount = document.createElement("div");
	document.body.appendChild(mount);
	const props = panelProps();
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
		).toContain("For new packs after process restart");
		expect(root.querySelector('[data-settings-outcome-for="syncEnabled"]')?.textContent).toContain(
			"After viewer restart",
		);
		expect(root.querySelector('[data-settings-outcome-for="observerAuthFile"]')).toBeNull();
		expect(root.querySelector('[data-settings-outcome-for="syncCoordinatorUrl"]')).toBeNull();
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
});
