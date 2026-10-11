import { type ComponentChild, createContext, render } from "preact";
import { useContext, useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

// Keep our autocomplete real; replace only the external popup runtime.
vi.mock("@radix-ui/react-popover", () => {
	const OpenContext = createContext(false);
	return {
		Root: ({ open, children }: { open: boolean; children: ComponentChild }) => (
			<OpenContext.Provider value={open}>{children}</OpenContext.Provider>
		),
		Anchor: ({ children }: { children: ComponentChild }) => <>{children}</>,
		Portal: ({ children }: { children: ComponentChild }) => <>{children}</>,
		Content: ({ children }: { children: ComponentChild }) =>
			useContext(OpenContext) ? <div>{children}</div> : null,
	};
});

import { AutocompleteInput } from "./autocomplete-input";

let mount: HTMLDivElement;

function Harness() {
	const [first, setFirst] = useState("");
	const [second, setSecond] = useState("");
	return (
		<>
			<AutocompleteInput
				aria-label="First model"
				value={first}
				onValueChange={setFirst}
				suggestions={["Alpha", "Beta"]}
			/>
			<AutocompleteInput
				aria-label="Second model"
				value={second}
				onValueChange={setSecond}
				suggestions={["Gamma", "Delta"]}
			/>
		</>
	);
}

function arrangeInputs() {
	mount = document.createElement("div");
	document.body.append(mount);
	act(() => render(<Harness />, mount));
	return Array.from(mount.querySelectorAll<HTMLInputElement>("input"));
}

function key(input: HTMLInputElement, value: string) {
	act(() => {
		input.dispatchEvent(
			new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
		);
	});
}

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.useRealTimers();
});

describe("AutocompleteInput accessibility", () => {
	it("removes the active descendant after blur closes the popup", () => {
		// Arrange: use a fake clock for the option-click grace period.
		vi.useFakeTimers();
		const [input] = arrangeInputs();
		key(input, "ArrowDown");
		expect(input.hasAttribute("aria-activedescendant")).toBe(true);
		// Act
		act(() => {
			input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
			vi.advanceTimersByTime(120);
		});
		// Assert: blur preserves the internal selection but must not reference a hidden option.
		expect(input.getAttribute("aria-expanded")).toBe("false");
		expect(input.hasAttribute("aria-activedescendant")).toBe(false);
		expect(mount.querySelector('[role="option"]')).toBeNull();
	});

	it("keeps both mounted instances' listboxes and options uniquely linked", () => {
		// Arrange: each field owns its suggestions, even when both are open.
		const inputs = arrangeInputs();
		// Act
		for (const input of inputs) key(input, "ArrowDown");
		// Assert
		const ids = Array.from(mount.querySelectorAll<HTMLElement>("[id]"), (node) => node.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(mount.querySelectorAll('[role="listbox"]')).toHaveLength(2);
		for (const [index, input] of inputs.entries()) {
			const listbox = document.getElementById(input.getAttribute("aria-controls") || "");
			expect(listbox?.getAttribute("role")).toBe("listbox");
			expect(listbox?.textContent).toBe(index === 0 ? "AlphaBeta" : "GammaDelta");
			const option = document.getElementById(input.getAttribute("aria-activedescendant") || "");
			expect(option?.getAttribute("role")).toBe("option");
			expect(listbox?.contains(option)).toBe(true);
		}
	});

	it.each(["Escape", "Enter", "Tab"])(
		"removes the active descendant when %s closes the popup",
		(closingKey) => {
			// Arrange
			const [input] = arrangeInputs();
			key(input, "ArrowDown");
			expect(input.hasAttribute("aria-activedescendant")).toBe(true);
			// Act
			key(input, closingKey);
			// Assert: a closed popup must not leave a dangling option reference.
			expect(input.getAttribute("aria-expanded")).toBe("false");
			expect(input.hasAttribute("aria-activedescendant")).toBe(false);
			expect(mount.querySelector('[role="listbox"]')).toBeNull();
		},
	);

	it("omits active descendants before navigation and when filtering leaves no options", () => {
		// Arrange
		const [input, other] = arrangeInputs();
		expect(input.hasAttribute("aria-activedescendant")).toBe(false);
		key(input, "ArrowDown");
		key(input, "ArrowDown");
		// Act
		act(() => {
			input.value = "no matching model";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		key(input, "ArrowDown");
		// Assert
		expect(input.getAttribute("aria-expanded")).toBe("false");
		expect(input.hasAttribute("aria-activedescendant")).toBe(false);
		expect(other.hasAttribute("aria-activedescendant")).toBe(false);
		expect(mount.querySelector('[role="option"]')).toBeNull();
	});
});
