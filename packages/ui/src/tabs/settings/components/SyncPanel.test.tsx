import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsPanelProps } from "../data/types";
import { SyncPanel } from "./SyncPanel";

vi.mock("../../../components/primitives/radix-switch", () => ({
	RadixSwitch: ({
		checked,
		disabled,
		id,
		onCheckedChange,
	}: {
		checked: boolean;
		disabled?: boolean;
		id?: string;
		onCheckedChange: (checked: boolean) => void;
	}) => (
		<input
			checked={checked}
			disabled={disabled}
			id={id}
			onChange={(event) => onCheckedChange((event.currentTarget as HTMLInputElement).checked)}
			type="checkbox"
		/>
	),
}));

let mount: HTMLDivElement | null = null;

function baseProps(): SettingsPanelProps {
	return {
		values: {
			claudeCommand: "",
			observerProvider: "openai",
			observerModel: "",
			observerTierRoutingEnabled: false,
			observerSimpleModel: "",
			observerSimpleTemperature: "",
			observerRichModel: "",
			observerRichTemperature: "",
			observerRichReasoningEffort: "",
			observerRichReasoningSummary: "",
			observerRichMaxOutputTokens: "",
			observerRuntime: "api_http",
			observerAuthSource: "auto",
			observerAuthFile: "",
			observerAuthCommand: "",
			observerAuthTimeoutMs: "1500",
			observerAuthCacheTtlS: "300",
			observerHeaders: "{}",
			observerMaxChars: "12000",
			packObservationLimit: "8",
			packSessionLimit: "4",
			rawEventsSweeperIntervalS: "2",
			syncEnabled: true,
			syncHost: "127.0.0.1",
			syncPort: "8765",
			syncInterval: "60",
			syncMdns: false,
			syncCoordinatorUrl: "https://coord.example.test",
			syncCoordinatorGroup: "team-alpha",
			syncCoordinatorTimeout: "5",
			syncCoordinatorPresenceTtl: "120",
		},
		observerMaxCharsDefault: "12000",
		providerOptions: [],
		showAuthFile: false,
		showAuthCommand: false,
		showTieredRouting: false,
		hiddenUnlessAdvanced: () => true,
		onTextInput: () => vi.fn(),
		onSelectValueChange: () => vi.fn(),
		onSwitchInput: () => vi.fn(),
		getObserverModelLabel: () => "Observer model",
		getObserverModelTooltip: () => "",
		getObserverModelDescription: () => "",
		getObserverModelHint: () => "",
		getTieredRoutingHelperText: () => "",
		protectedConfigHelp: (key) => `${key} is managed outside Settings`,
	};
}

function renderSyncPanel() {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(<SyncPanel {...baseProps()} />, mount as HTMLDivElement);
	});
	return mount;
}

afterEach(() => {
	if (mount) {
		act(() => {
			render(null, mount as HTMLDivElement);
		});
		mount.remove();
		mount = null;
	}
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("SyncPanel", () => {
	it("keeps Settings focused on device sync configuration", () => {
		const root = renderSyncPanel();

		expect(root.textContent).toContain("Device Sync");
		expect(root.textContent).toContain("Enable sync");
		expect(root.textContent).toContain("Coordinator URL");
		expect(root.textContent).toContain("Coordinator group");
		expect(root.textContent).not.toContain("Always-on peers");
		expect(root.textContent).not.toContain("Advanced Space assignments");
		expect(root.textContent).not.toContain("Open Projects review");
	});
});
