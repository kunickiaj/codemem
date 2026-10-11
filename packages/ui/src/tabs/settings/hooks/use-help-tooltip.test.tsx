import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHelpTooltip } from "./use-help-tooltip";

function Harness() {
	const { tooltipPortal } = useHelpTooltip();
	return <>{tooltipPortal}</>;
}

let mount: HTMLDivElement;
let first: HTMLButtonElement;
let second: HTMLButtonElement;

function dispatch(target: HTMLElement, type: string, relatedTarget: EventTarget | null = null) {
	act(() => {
		target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget }));
	});
}

function tooltip() {
	const element = document.querySelector<HTMLElement>('[role="tooltip"]');
	if (!element) throw new Error("Help tooltip missing");
	return element;
}

beforeEach(() => {
	// Positioning is irrelevant to these relationships; do not schedule real frames.
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	document.body.innerHTML =
		'<span id="existing-description">Existing help</span><button class="help-icon" data-tooltip="First help" aria-describedby="existing-description"><span>Help</span></button><button class="help-icon" data-tooltip="Second help">Help</button>';
	[first, second] = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
	mount = document.createElement("div");
	document.body.append(mount);
	act(() => render(<Harness />, mount));
});

afterEach(() => {
	act(() => render(null, mount));
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("Settings help tooltip accessibility", () => {
	it.each([
		["pointerover", "pointerout"],
		["focusin", "focusout"],
		["click", "click"],
	])("shows on %s and cleans up on %s", (show, hide) => {
		// Arrange
		expect(tooltip().hidden).toBe(true);
		expect(first.getAttribute("aria-describedby")).toBe("existing-description");
		// Act
		dispatch(first, show);
		// Assert: help augments, rather than replaces, the trigger's description.
		expect(tooltip().hidden).toBe(false);
		expect(tooltip().textContent).toBe("First help");
		expect(tooltip().id).not.toBe("");
		expect(first.getAttribute("aria-describedby")?.split(/\s+/)).toEqual([
			"existing-description",
			tooltip().id,
		]);
		expect(second.hasAttribute("aria-describedby")).toBe(false);
		// Act
		dispatch(first, hide);
		// Assert
		expect(tooltip().hidden).toBe(true);
		expect(first.getAttribute("aria-describedby")).toBe("existing-description");
	});

	it("moves the description relationship when switching triggers and removes it on hide", () => {
		// Arrange
		dispatch(first, "pointerover");
		const id = tooltip().id;
		// Act
		dispatch(second, "focusin");
		// Assert
		expect(first.getAttribute("aria-describedby")).toBe("existing-description");
		expect(second.getAttribute("aria-describedby")).toBe(id);
		expect(document.getElementById(id)?.textContent).toBe("Second help");
		// Act
		dispatch(second, "focusout");
		// Assert
		expect(second.hasAttribute("aria-describedby")).toBe(false);
	});

	it("retains help when the pointer moves within the trigger", () => {
		// Arrange
		dispatch(first, "pointerover");
		// Act
		dispatch(first, "pointerout", first.querySelector("span"));
		// Assert
		expect(tooltip().hidden).toBe(false);
		expect(first.getAttribute("aria-describedby")).toContain(tooltip().id);
	});

	it("ignores unrelated targets and empty help messages", () => {
		// Arrange
		second.dataset.tooltip = "   ";
		const unrelated = document.getElementById("existing-description") as HTMLElement;
		// Act
		for (const type of ["pointerover", "focusin", "click"]) {
			dispatch(unrelated, type);
			dispatch(second, type);
		}
		// Assert
		expect(tooltip().hidden).toBe(true);
		expect(second.hasAttribute("aria-describedby")).toBe(false);
	});

	it("uses unique tooltip IDs for two mounted hook instances", () => {
		// Arrange
		// Act
		act(() =>
			render(
				<>
					<Harness />
					<Harness />
				</>,
				mount,
			),
		);
		// Assert
		const ids = Array.from(
			document.querySelectorAll<HTMLElement>('[role="tooltip"]'),
			(node) => node.id,
		);
		expect(ids).toHaveLength(2);
		expect(ids.every(Boolean)).toBe(true);
		expect(new Set(ids).size).toBe(2);
	});

	it("removes its description and listeners on unmount without losing other descriptions", () => {
		// Arrange
		dispatch(first, "click");
		const id = tooltip().id;
		first.setAttribute(
			"aria-describedby",
			`${first.getAttribute("aria-describedby")} later-description`,
		);
		// Act
		act(() => render(null, mount));
		dispatch(second, "click");
		// Assert
		expect(document.getElementById(id)).toBeNull();
		expect(first.getAttribute("aria-describedby")).toBe("existing-description later-description");
		expect(second.hasAttribute("aria-describedby")).toBe(false);
	});
});
