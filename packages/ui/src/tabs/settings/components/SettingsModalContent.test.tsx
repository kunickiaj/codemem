import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FORM_STATE } from "../data/constants";
import { settingsView } from "../data/state";
import type { SettingsPanelProps } from "../data/types";
import { SettingsModalContent } from "./SettingsModalContent";

vi.mock("../../../components/primitives/radix-select", () => ({
	RadixSelect: ({ id }: { id?: string }) => <select id={id} />,
}));
vi.mock("../../../components/primitives/radix-switch", () => ({
	RadixSwitch: ({ id }: { id?: string }) => <input id={id} type="checkbox" />,
}));
vi.mock("../../../components/primitives/radix-tabs", () => ({
	RadixTabs: ({ children }: { children: ComponentChildren }) => <div>{children}</div>,
	RadixTabsContent: ({ children }: { children: ComponentChildren }) => <div>{children}</div>,
}));

const panelProps: SettingsPanelProps = {
	values: EMPTY_FORM_STATE,
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
	protectedConfigHelp: () => "Managed outside Settings",
};

let mount: HTMLDivElement;

function requiredElement<T extends HTMLElement>(selector: string, root: HTMLElement = mount): T {
	const element = root.querySelector<T>(selector);
	if (!element) throw new Error(`Missing test element: ${selector}`);
	return element;
}

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

function renderDirtySettings() {
	mount = document.createElement("div");
	document.body.append(mount);
	const onSave = vi.fn();
	act(() => {
		render(
			<SettingsModalContent
				activeTab="observer"
				observerStatusBannerSlot={null}
				onActiveTabChange={vi.fn()}
				onAdvancedToggle={vi.fn()}
				onClose={vi.fn()}
				onSave={onSave}
				onShowGettingStarted={vi.fn()}
				panelProps={panelProps}
				renderState={settingsView.value.renderState}
				settingsDirty
				showAdvanced
			/>,
			mount,
		);
	});
	return onSave;
}

function pressEnter(target: HTMLElement, modifiers: KeyboardEventInit = {}) {
	target.focus();
	const event = new KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
		...modifiers,
	});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

describe("Settings form keyboard actions", () => {
	it.each([".settings-outcome", ".settings-config-details"])(
		"preserves native disclosure activation in dirty Settings: %s",
		(selector) => {
			const onSave = renderDirtySettings();
			const details = requiredElement<HTMLDetailsElement>(selector);
			const summary = requiredElement("summary", details);
			expect(summary.closest("form")).not.toBeNull();
			expect(mount.querySelector<HTMLButtonElement>("#settingsSave")?.disabled).toBe(false);
			expect(pressEnter(summary).defaultPrevented).toBe(false);
			expect(onSave).not.toHaveBeenCalled();
			// JSDOM does not generate the native click from Enter. Exercise that
			// default activation separately after verifying the form permits it.
			act(() => summary.click());
			expect(details.open).toBe(true);
			expect(onSave).not.toHaveBeenCalled();
		},
	);

	it("retains input Enter, textarea modifier-Enter, and Save button actions", () => {
		const onSave = renderDirtySettings();
		const input = requiredElement("#observerModel");
		expect(pressEnter(input).defaultPrevented).toBe(true);
		expect(onSave).toHaveBeenCalledTimes(1);
		const textarea = requiredElement("textarea");
		expect(pressEnter(textarea).defaultPrevented).toBe(false);
		expect(onSave).toHaveBeenCalledTimes(1);
		expect(pressEnter(textarea, { ctrlKey: true }).defaultPrevented).toBe(true);
		expect(onSave).toHaveBeenCalledTimes(2);
		const save = requiredElement("#settingsSave");
		expect(pressEnter(save).defaultPrevented).toBe(false);
		act(() => save.click());
		expect(onSave).toHaveBeenCalledTimes(3);
	});
});
