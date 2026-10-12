import { type ComponentChild, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tooltip, TooltipProvider } from "./tooltip";

let mount: HTMLDivElement;

function renderTooltips(content: ComponentChild) {
	act(() => render(<TooltipProvider delayDuration={0}>{content}</TooltipProvider>, mount));
}

function button(id: string): HTMLButtonElement {
	const result = mount.querySelector<HTMLButtonElement>(`#${id}`);
	if (!result) throw new Error(`Missing tooltip trigger ${id}`);
	return result;
}

function focus(target: HTMLElement) {
	act(() => target.focus());
}

function advanceEffects() {
	// Includes Radix's provider delay; this never depends on elapsed wall time.
	act(() => {
		vi.advanceTimersByTime(1000);
	});
}

function expectLinkedTooltip(trigger: HTMLElement, label: string) {
	const tooltips = document.querySelectorAll('[role="tooltip"]');
	expect(tooltips).toHaveLength(1);
	expect(tooltips[0].textContent).toBe(label);
	expect(trigger.getAttribute("aria-describedby")).toBe(tooltips[0].id);
	expect(document.activeElement).toBe(trigger);
}

function DisabledHarness() {
	const [disabled, setDisabled] = useState(false);
	return (
		<>
			<button id="toggle-disabled" type="button" onClick={() => setDisabled(!disabled)}>
				Toggle hint
			</button>
			<Tooltip disabled={disabled} label="Toggleable hint">
				<button id="hint" type="button">
					Hint
				</button>
			</Tooltip>
		</>
	);
}

beforeEach(() => {
	vi.useFakeTimers();
	// jsdom does not calculate layout; only its missing browser observer is stubbed.
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	mount = document.createElement("div");
	document.body.append(mount);
});

describe("Tooltip pointer delay", () => {
	it("waits for the hover delay, stays open after effects and skips the delay for a neighboring hint", () => {
		// Arrange
		act(() =>
			render(
				<TooltipProvider delayDuration={200} skipDelayDuration={500}>
					<Tooltip label="First hover hint">
						<button id="first" type="button">
							First
						</button>
					</Tooltip>
					<Tooltip label="Second hover hint">
						<button id="second" type="button">
							Second
						</button>
					</Tooltip>
				</TooltipProvider>,
				mount,
			),
		);
		const hover = (target: HTMLElement) => {
			const event = new MouseEvent("pointermove", { bubbles: true });
			Object.defineProperty(event, "pointerType", { value: "mouse" });
			act(() => {
				target.dispatchEvent(event);
			});
		};
		// Act
		hover(button("first"));
		act(() => {
			vi.advanceTimersByTime(199);
		});
		// Assert: hovering must not bypass the configured initial delay.
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(button("first").hasAttribute("aria-describedby")).toBe(false);
		// Act
		act(() => {
			vi.advanceTimersByTime(1);
		});
		advanceEffects();
		// Assert: delayed opening must survive the same SDK opening event as focus.
		const first = document.querySelector('[role="tooltip"]');
		expect(first?.textContent).toBe("First hover hint");
		expect(button("first").getAttribute("aria-describedby")).toBe(first?.id);
		expect(button("first").getAttribute("data-state")).toBe("delayed-open");
		expect(document.activeElement).not.toBe(button("first"));
		// Act: clicking dismisses the first hint; its neighbor opens within the skip window.
		act(() => button("first").click());
		hover(button("second"));
		// Assert: no clock advance is needed for the shared-provider handoff.
		const second = document.querySelector('[role="tooltip"]');
		expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
		expect(second?.textContent).toBe("Second hover hint");
		expect(button("second").getAttribute("aria-describedby")).toBe(second?.id);
		expect(button("second").getAttribute("data-state")).toBe("instant-open");
		expect(button("first").hasAttribute("aria-describedby")).toBe(false);
	});
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("Tooltip real Radix lifecycle", () => {
	it("stays open after focus and opening effects instead of dismissing itself", () => {
		// Arrange
		renderTooltips(
			<Tooltip label="Persistent hint">
				<button id="hint" type="button">
					Hint
				</button>
			</Tooltip>,
		);
		const trigger = button("hint");
		// Act
		focus(trigger);
		advanceEffects();
		// Assert: uncontrolled Radix previously mounted its listener before its opening event.
		expectLinkedTooltip(trigger, "Persistent hint");
		expect(mount.querySelector('[role="tooltip"]')).toBeNull();
	});

	it.each(["Escape", "blur"])(
		"dismisses with %s and removes the hidden description link",
		(method) => {
			// Arrange
			renderTooltips(
				<Tooltip label="Dismissible hint">
					<button id="hint" type="button">
						Hint
					</button>
				</Tooltip>,
			);
			const trigger = button("hint");
			focus(trigger);
			expectLinkedTooltip(trigger, "Dismissible hint");
			// Act
			act(() => {
				if (method === "blur") trigger.blur();
				else
					trigger.dispatchEvent(
						new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
					);
			});
			advanceEffects();
			// Assert
			expect(document.querySelector('[role="tooltip"]')).toBeNull();
			expect(trigger.hasAttribute("aria-describedby")).toBe(false);
			if (method === "Escape") expect(document.activeElement).toBe(trigger);
		},
	);

	it("hands focus to a neighboring hint without closing the newly opened tooltip", () => {
		// Arrange
		renderTooltips(
			<>
				<Tooltip label="First hint">
					<button id="first" type="button">
						First
					</button>
				</Tooltip>
				<Tooltip label="Second hint">
					<button id="second" type="button">
						Second
					</button>
				</Tooltip>
			</>,
		);
		focus(button("first"));
		expectLinkedTooltip(button("first"), "First hint");
		// Act
		focus(button("second"));
		advanceEffects();
		// Assert
		expectLinkedTooltip(button("second"), "Second hint");
		expect(button("first").hasAttribute("aria-describedby")).toBe(false);
	});

	it("clears an open hint when disabled and reenables it closed until a new focus", () => {
		// Arrange
		renderTooltips(<DisabledHarness />);
		focus(button("hint"));
		expectLinkedTooltip(button("hint"), "Toggleable hint");
		// Act
		act(() => button("toggle-disabled").click());
		advanceEffects();
		// Assert
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(button("hint").hasAttribute("aria-describedby")).toBe(false);
		// Act: a disabled tooltip leaves its child usable but must not show a hint.
		focus(button("hint"));
		// Assert
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		// Act
		act(() => button("toggle-disabled").click());
		advanceEffects();
		// Assert
		expect(document.querySelector('[role="tooltip"]')).toBeNull();
		expect(button("hint").hasAttribute("aria-describedby")).toBe(false);
		// Act
		focus(button("hint"));
		advanceEffects();
		// Assert
		expectLinkedTooltip(button("hint"), "Toggleable hint");
	});
});
