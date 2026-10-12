import { act } from "preact/test-utils";
import { describe, expect, it, vi } from "vitest";
import { Gallery } from "./gallery";
import { click, key, node, setupGalleryTests, type } from "./gallery-test-helpers";
import { LONG_LABEL, SELECT_OPTIONS } from "./inputs";

const { getMount } = setupGalleryTests(() => <Gallery />);

describe("gallery selects", () => {
	it("retains all native options, long labels and disabled states while selections stay independent", () => {
		// Arrange
		const select = node<HTMLSelectElement>('[data-testid="gallery-native-select-default"]');
		const long = node<HTMLSelectElement>('[data-testid="gallery-native-select-long"]');
		const disabled = node<HTMLSelectElement>('[data-testid="gallery-native-select-disabled"]');
		// Act
		act(() => {
			select.value = "long";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		click(disabled);
		// Assert
		expect(
			[...select.options].map((option) => ({
				value: option.value,
				label: option.textContent,
				disabled: option.disabled,
			})),
		).toEqual(SELECT_OPTIONS.map((option) => ({ ...option, disabled: option.disabled ?? false })));
		expect(select.value).toBe("long");
		expect(long.selectedOptions[0].textContent).toBe(LONG_LABEL);
		expect(disabled.disabled).toBe(true);
		expect(disabled.value).toBe("alpha");
		expect(node("#gallery-radix-select-default").getAttribute("data-value")).toBe("alpha");
	});

	it("chooses a real Radix option, keeps its full label and cannot choose an unavailable option", async () => {
		// Arrange
		const trigger = node("#gallery-radix-select-default");
		// Act
		key(trigger, "ArrowDown");
		const list = node('[role="listbox"]');
		const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
		click(options[2]);
		// Assert
		expect(options.map((option) => option.title)).toEqual(
			SELECT_OPTIONS.map((option) => option.label),
		);
		expect(options[2].getAttribute("aria-disabled")).toBe("true");
		expect(trigger.getAttribute("data-value")).toBe("alpha");
		// Act
		key(options[1], "Enter");
		// Assert
		await vi.waitFor(() => expect(trigger.getAttribute("data-value")).toBe("long"));
		expect(trigger.textContent).toContain(LONG_LABEL);
		await vi.waitFor(() => expect(document.querySelector('[role="listbox"]')).toBeNull());
	});

	it("does not open a disabled Radix select and keeps the long fixture selected", () => {
		// Arrange
		const disabled = node<HTMLButtonElement>("#gallery-radix-select-disabled");
		// Act
		click(disabled);
		// Assert
		expect(disabled.disabled).toBe(true);
		expect(disabled.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector('[role="listbox"]')).toBeNull();
		expect(node("#gallery-radix-select-long").getAttribute("data-value")).toBe("long");
		expect(node("#gallery-radix-select-long").textContent).toContain(LONG_LABEL);
	});
});

describe("gallery fields and choices", () => {
	it("edits text and multiline notes, including clearing them, without changing disabled fields", () => {
		// Arrange
		const input = node<HTMLInputElement>("#gallery-text-input");
		const area = node<HTMLTextAreaElement>("#gallery-text-area");
		// Act
		type(input, LONG_LABEL);
		type(area, "Changed\nnotes");
		// Assert
		expect(input.value).toBe(LONG_LABEL);
		expect(area.value).toBe("Changed\nnotes");
		// Act
		type(input, "");
		type(area, "");
		// Assert
		expect(input.value).toBe("");
		expect(area.value).toBe("");
		expect(node<HTMLInputElement>("#gallery-text-disabled").disabled).toBe(true);
		expect(node<HTMLTextAreaElement>("#gallery-area-disabled").disabled).toBe(true);
		expect(node<HTMLInputElement>("#gallery-text-long").value).toBe(LONG_LABEL);
		expect(node<HTMLInputElement>("#gallery-text-empty").placeholder).not.toBe("");
	});

	it("toggles switch and checkbox state in both directions while disabled choices stay checked", () => {
		// Arrange
		const toggle = node("#gallery-switch");
		const checkbox = node<HTMLInputElement>("#gallery-checkbox");
		// Act
		click(toggle);
		click(checkbox);
		click(node("#gallery-switch-disabled"));
		click(node("#gallery-checkbox-disabled"));
		// Assert
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		expect(checkbox.checked).toBe(false);
		expect(node("#gallery-switch-disabled").getAttribute("aria-checked")).toBe("true");
		expect(node<HTMLInputElement>("#gallery-checkbox-disabled").checked).toBe(true);
		// Act
		click(toggle);
		click(checkbox);
		// Assert
		expect(toggle.getAttribute("aria-checked")).toBe("false");
		expect(checkbox.checked).toBe(true);
	});

	it("selects the long radio choice exclusively and ignores the disabled choice", () => {
		// Arrange
		const radios = [...node('[role="radiogroup"]').querySelectorAll<HTMLElement>('[role="radio"]')];
		// Act
		click(radios[1]);
		click(radios[2]);
		// Assert
		expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
			"false",
			"true",
			"false",
		]);
		expect(radios[2].hasAttribute("disabled")).toBe(true);
		expect(node('[role="radiogroup"]').textContent).toContain(LONG_LABEL);
	});

	it("changes real tab panels but cannot activate the unavailable view", () => {
		// Arrange
		const tabs = [
			...node('[role="tablist"][aria-label="Example views"]').querySelectorAll<HTMLElement>(
				'[role="tab"]',
			),
		];
		const details = tabs.find((tab) => tab.textContent === "Details and a longer label");
		const overview = tabs.find((tab) => tab.textContent === "Overview");
		if (!details || !overview) throw new Error("Gallery tabs missing");
		const disabled = node<HTMLButtonElement>('[role="tab"][disabled]');
		// Act
		key(details, "Enter");
		click(disabled);
		// Assert
		expect(details.getAttribute("aria-selected")).toBe("true");
		expect(overview.getAttribute("aria-selected")).toBe("false");
		expect(disabled.getAttribute("aria-selected")).toBe("false");
		expect(node('[role="tabpanel"][data-state="active"]').id).toBe(
			details.getAttribute("aria-controls"),
		);
		expect(node('[role="tabpanel"][data-state="active"]').getAttribute("aria-labelledby")).toBe(
			details.id,
		);
		expect(
			document.getElementById(
				node('[role="tabpanel"][data-state="active"]').getAttribute("aria-labelledby") || "",
			),
		).toBe(details);
		expect(node('[role="tabpanel"][data-state="active"]').textContent).toContain(
			"Synthetic details content",
		);
	});
});

describe("gallery indicators and loading", () => {
	it("renders distinct presence states and chip variants, including unknown and offline cases", () => {
		// Arrange
		const states = ["online", "offline", "degraded", "attention", "syncing", "unknown"];
		// Act
		const pips = [...node("#indicators").querySelectorAll('[role="img"]')];
		const chips = [...node('[data-testid="gallery-chips"]').children];
		// Assert
		expect(pips).toHaveLength(states.length);
		for (const [index, state] of states.entries()) {
			expect(pips[index].classList.contains(`presence-pip--${state}`)).toBe(true);
			expect(pips[index].getAttribute("aria-label")).not.toBe("");
		}
		expect(new Set(chips.map((chip) => chip.className)).size).toBe(5);
		expect(pips[1].classList.contains("presence-pip--online")).toBe(false);
		expect(pips[5].getAttribute("aria-label")).toBe("Status unknown");
	});

	it("announces loading once while hiding decorative skeleton cards from assistive technology", () => {
		// Arrange
		const loading = node("#loading");
		// Act
		const status = loading.querySelectorAll('[role="status"]');
		const cards = [...loading.querySelectorAll(".loading-card")];
		// Assert
		expect(status).toHaveLength(1);
		expect(status[0].textContent).not.toBe("");
		expect(loading.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(cards).toHaveLength(2);
		expect(cards.every((card) => card.getAttribute("aria-hidden") === "true")).toBe(true);
		expect(cards.some((card) => card.contains(status[0]))).toBe(false);
	});
});

describe("gallery dialog", () => {
	it.each(["close", "finish", "Escape"])(
		"opens a labelled dialog and restores trigger focus after %s",
		async (method) => {
			// Arrange
			const trigger = node('[data-testid="gallery-dialog-trigger"]');
			act(() => trigger.focus());
			// Act
			click(trigger);
			// Assert
			const dialog = node('[role="dialog"]');
			expect(getMount().contains(dialog)).toBe(false);
			expect(document.getElementById(dialog.getAttribute("aria-labelledby") || "")).not.toBeNull();
			expect(document.getElementById(dialog.getAttribute("aria-describedby") || "")).not.toBeNull();
			await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
			// Act
			if (method === "Escape") key(dialog, "Escape");
			else if (method === "close") click(node('[aria-label="Close fixture dialog"]'));
			else click(node("#gallery-dialog .modal-footer button"));
			// Assert
			await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
			await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		},
	);

	it("keeps the dialog closed when its disabled close example is clicked", () => {
		// Arrange
		const disabled = node<HTMLButtonElement>('[aria-label="Disabled close example"]');
		// Act
		click(disabled);
		// Assert
		expect(disabled.disabled).toBe(true);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});
});

describe("gallery action menu", () => {
	it.each([
		["Select fixture", "Fixture selected"],
		[LONG_LABEL, "Long action selected"],
		["Remove fixture", "Fixture removed locally"],
	])("runs %s locally and returns focus after closing", async (label, result) => {
		// Arrange
		const trigger = node("#gallery-action-menu");
		// Act
		key(trigger, "ArrowDown");
		const menu = node('[role="menu"]');
		const item = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
			(item) => item.textContent === label,
		);
		if (!item) throw new Error("Gallery menu fixture missing");
		click(item);
		// Assert
		expect(node('[data-testid="gallery-menu-result"]').textContent).toBe(result);
		await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(fetch).not.toHaveBeenCalled();
	});

	it("ignores an unavailable action and dismisses with Escape without changing the result", async () => {
		// Arrange
		const trigger = node("#gallery-action-menu");
		key(trigger, "ArrowDown");
		const menu = node('[role="menu"]');
		const disabled = node<HTMLButtonElement>('[role="menuitem"][disabled]');
		// Act
		click(disabled);
		// Assert
		expect(menu.isConnected).toBe(true);
		expect(node('[data-testid="gallery-menu-result"]').textContent).toBe("No action selected");
		// Act
		key(menu, "Escape");
		// Assert
		await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		expect(node('[data-testid="gallery-menu-result"]').textContent).toBe("No action selected");
	});
});

describe("gallery autocomplete and tooltip", () => {
	it("opens real suggestions without moving focus, commits a long label and then dismisses", () => {
		// Arrange
		const input = node<HTMLInputElement>("#gallery-autocomplete");
		act(() => input.focus());
		// Act
		key(input, "ArrowDown");
		key(input, "ArrowDown");
		key(input, "ArrowDown");
		// Assert
		expect(document.activeElement).toBe(input);
		expect(
			node('[role="listbox"]').contains(node(`#${input.getAttribute("aria-activedescendant")}`)),
		).toBe(true);
		// Act
		key(input, "Enter");
		// Assert
		expect(input.value).toBe(LONG_LABEL);
		expect(input.getAttribute("aria-expanded")).toBe("false");
		expect(input.hasAttribute("aria-activedescendant")).toBe(false);
		// Act
		key(input, "ArrowDown");
		key(input, "Escape");
		// Assert
		expect(input.value).toBe(LONG_LABEL);
		expect(document.querySelector('[role="listbox"]')).toBeNull();
		expect(document.activeElement).toBe(input);
	});

	it("allows unmatched free text without a popup and cannot focus disabled autocomplete", () => {
		// Arrange
		const input = node<HTMLInputElement>("#gallery-autocomplete");
		const disabled = node<HTMLInputElement>("#gallery-autocomplete-disabled");
		act(() => input.focus());
		// Act
		type(input, "No fixture matches this");
		key(input, "ArrowDown");
		act(() => disabled.focus());
		// Assert
		expect(input.value).toBe("No fixture matches this");
		expect(input.getAttribute("aria-expanded")).toBe("false");
		expect(document.querySelector('[role="listbox"]')).toBeNull();
		expect(disabled.disabled).toBe(true);
		expect(document.activeElement).toBe(input);
	});

	it("opens a linked tooltip on focus and removes it on Escape and blur", async () => {
		// Arrange
		const trigger = node('[data-testid="gallery-tooltip-trigger"]');
		// Act
		act(() => trigger.focus());
		// Assert
		await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).not.toBeNull());
		expect(node('[role="tooltip"]').id).toBe(trigger.getAttribute("aria-describedby"));
		// Act
		key(trigger, "Escape");
		act(() => trigger.blur());
		// Assert
		await vi.waitFor(() => expect(document.querySelector('[role="tooltip"]')).toBeNull());
		expect(trigger.hasAttribute("aria-describedby")).toBe(false);
	});

	it("does not show a tooltip for the disabled fixture", () => {
		// Arrange
		const disabled = [...node("#overlays").querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Disabled tooltip trigger",
		);
		if (!disabled) throw new Error("Disabled tooltip fixture missing");
		// Act
		act(() => disabled.focus());
		click(disabled);
		// Assert
		expect(disabled.disabled).toBe(true);
		expect(document.activeElement).not.toBe(disabled);
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(disabled.hasAttribute("aria-describedby")).toBe(false);
	});
});
