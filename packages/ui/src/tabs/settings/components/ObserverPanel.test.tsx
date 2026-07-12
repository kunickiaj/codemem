import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import type { SettingsPanelProps } from "../data/types";
import { ObserverPanel } from "./ObserverPanel";

vi.mock("../../../components/primitives/radix-select", () => ({
	RadixSelect: ({
		id,
		onValueChange,
		options,
		value,
	}: {
		id?: string;
		onValueChange: (value: string) => void;
		options: Array<{ label: string; value: string }>;
		value: string;
	}) => (
		<select id={id} onChange={(event) => onValueChange(event.currentTarget.value)} value={value}>
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	),
}));

let mount: HTMLDivElement | null = null;

function props(): SettingsPanelProps & { observerStatusBannerSlot: null } {
	return {
		values: { ...EMPTY_FORM_STATE, observerRuntime: "api_http" },
		observerMaxCharsDefault: "12000",
		providerOptions: [],
		showAuthFile: false,
		showAuthCommand: false,
		showTieredRouting: false,
		hiddenUnlessAdvanced: () => false,
		onTextInput: () => vi.fn(),
		onSelectValueChange: () => vi.fn(),
		onSwitchInput: () => vi.fn(),
		getObserverModelLabel: () => "Model",
		getObserverModelTooltip: () => "",
		getObserverModelDescription: () => "",
		getObserverModelHint: () => "",
		getTieredRoutingHelperText: () => "",
		protectedConfigHelp: (key) => `${key} is protected`,
		observerStatusBannerSlot: null,
	};
}

afterEach(() => {
	if (mount) {
		act(() => render(null, mount as HTMLDivElement));
		mount.remove();
		mount = null;
	}
	document.body.innerHTML = "";
});

describe("ObserverPanel", () => {
	it("offers a local Codex runtime and shows its protected command", () => {
		mount = document.createElement("div");
		document.body.appendChild(mount);
		act(() => render(<ObserverPanel {...props()} />, mount as HTMLDivElement));

		const runtime = mount.querySelector<HTMLSelectElement>("#observerRuntime");
		expect(runtime?.textContent).toContain("Local Codex session");
		expect(mount.querySelector<HTMLTextAreaElement>("#codexCommand")).not.toBeNull();
		expect(mount.textContent).toContain("codex_command is protected");
	});
});
