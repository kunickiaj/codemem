import { afterEach, describe, expect, it, vi } from "vitest";

import { handlePrimaryActionKeyboard } from "./keyboard";

function keydown(
	target: HTMLElement,
	key: string,
	modifiers: { metaKey?: boolean; ctrlKey?: boolean; isComposing?: boolean } = {},
): KeyboardEvent {
	const event = new KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key,
		metaKey: modifiers.metaKey ?? false,
		ctrlKey: modifiers.ctrlKey ?? false,
		isComposing: modifiers.isComposing ?? false,
	});
	Object.defineProperty(event, "target", { value: target, configurable: true });
	return event;
}

function appendInput(): HTMLInputElement {
	const input = document.createElement("input");
	input.type = "text";
	document.body.appendChild(input);
	return input;
}

function appendInputWithType(type: string): HTMLInputElement {
	const input = document.createElement("input");
	input.type = type;
	document.body.appendChild(input);
	return input;
}

function appendTextarea(): HTMLTextAreaElement {
	const textarea = document.createElement("textarea");
	document.body.appendChild(textarea);
	return textarea;
}

function appendButton(): HTMLButtonElement {
	const button = document.createElement("button");
	button.type = "button";
	document.body.appendChild(button);
	return button;
}

function appendSelect(): HTMLSelectElement {
	const select = document.createElement("select");
	document.body.appendChild(select);
	return select;
}

function appendAnchor(): HTMLAnchorElement {
	const anchor = document.createElement("a");
	anchor.href = "#test";
	document.body.appendChild(anchor);
	return anchor;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("handlePrimaryActionKeyboard", () => {
	it("fires onSubmit and preventDefaults Enter on a single-line input", () => {
		const input = appendInput();
		const onSubmit = vi.fn();

		const event = keydown(input, "Enter");
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("does not fire onSubmit on bare Enter inside a textarea", () => {
		const textarea = appendTextarea();
		const onSubmit = vi.fn();

		const event = keydown(textarea, "Enter");
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("fires onSubmit on Cmd+Enter inside a textarea", () => {
		const textarea = appendTextarea();
		const onSubmit = vi.fn();

		const event = keydown(textarea, "Enter", { metaKey: true });
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("fires onSubmit on Ctrl+Enter inside a textarea", () => {
		const textarea = appendTextarea();
		const onSubmit = vi.fn();

		const event = keydown(textarea, "Enter", { ctrlKey: true });
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("fires onSubmit on Cmd+Enter inside a contentEditable region", () => {
		const region = document.createElement("div");
		region.contentEditable = "true";
		document.body.appendChild(region);
		const onSubmit = vi.fn();

		const event = keydown(region, "Enter", { metaKey: true });
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("does not intercept Enter on a button", () => {
		const button = appendButton();
		const onSubmit = vi.fn();

		const event = keydown(button, "Enter");
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("does not intercept Enter on input types with native Enter behavior", () => {
		for (const type of ["button", "file", "image", "reset", "submit"]) {
			const input = appendInputWithType(type);
			const onSubmit = vi.fn();

			const event = keydown(input, "Enter");
			handlePrimaryActionKeyboard(event, { onSubmit });

			expect(onSubmit, type).not.toHaveBeenCalled();
			expect(event.defaultPrevented, type).toBe(false);
		}
	});

	it("does not intercept Enter on a select", () => {
		const select = appendSelect();
		const onSubmit = vi.fn();

		const event = keydown(select, "Enter");
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("does not intercept Enter on an anchor", () => {
		const anchor = appendAnchor();
		const onSubmit = vi.fn();

		const event = keydown(anchor, "Enter");
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("ignores Enter when the focused element opts out via data-primary-action-ignore", () => {
		const wrapper = document.createElement("div");
		wrapper.dataset.primaryActionIgnore = "true";
		const input = document.createElement("input");
		wrapper.appendChild(input);
		document.body.appendChild(wrapper);

		const onSubmit = vi.fn();
		const event = keydown(input, "Enter");
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("does not fire onSubmit when isComposing is true", () => {
		const input = appendInput();
		const onSubmit = vi.fn();

		const event = keydown(input, "Enter", { isComposing: true });
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not fire onSubmit when the event was already preventDefaulted", () => {
		const input = appendInput();
		const onSubmit = vi.fn();

		const event = keydown(input, "Enter");
		event.preventDefault();
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("does not fire onSubmit when disabled is true", () => {
		const input = appendInput();
		const onSubmit = vi.fn();

		const event = keydown(input, "Enter");
		handlePrimaryActionKeyboard(event, { onSubmit, disabled: true });

		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("fires onCancel and preventDefaults Escape when onCancel is provided", () => {
		const input = appendInput();
		const onSubmit = vi.fn();
		const onCancel = vi.fn();

		const event = keydown(input, "Escape");
		handlePrimaryActionKeyboard(event, { onSubmit, onCancel });

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(true);
	});

	it("ignores Escape when no onCancel handler is provided", () => {
		const input = appendInput();
		const onSubmit = vi.fn();

		const event = keydown(input, "Escape");
		handlePrimaryActionKeyboard(event, { onSubmit });

		expect(onSubmit).not.toHaveBeenCalled();
		expect(event.defaultPrevented).toBe(false);
	});

	it("ignores keys other than Enter and Escape", () => {
		const input = appendInput();
		const onSubmit = vi.fn();
		const onCancel = vi.fn();

		for (const key of ["a", "Tab", "ArrowDown", " "]) {
			const event = keydown(input, key);
			handlePrimaryActionKeyboard(event, { onSubmit, onCancel });
		}

		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});
});
