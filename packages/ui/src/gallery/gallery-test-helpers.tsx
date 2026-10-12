import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, vi } from "vitest";

// Each test file calls this once and owns a separate closure and mount.
export function setupGalleryTests(content: () => ComponentChild) {
	let mount: HTMLDivElement;
	beforeEach(() => {
		// jsdom has no layout observer; do not replace the actual Radix controls.
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Gallery must not fetch");
			}),
		);
		document.documentElement.dataset.theme = "dark";
		document.documentElement.dataset.colorMode = "dark";
		mount = document.createElement("div");
		document.body.append(mount);
		act(() => render(content(), mount));
	});
	afterEach(() => {
		act(() => render(null, mount));
		mount.remove();
		delete document.documentElement.dataset.theme;
		delete document.documentElement.dataset.colorMode;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	return { getMount: () => mount };
}

export function node<T extends HTMLElement = HTMLElement>(selector: string): T {
	const result = document.querySelector<T>(selector);
	if (!result) throw new Error(`Missing gallery fixture: ${selector}`);
	return result;
}

export function key(target: HTMLElement, value: string) {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
		);
	});
}

export function click(target: HTMLElement) {
	act(() => target.click());
}

export function type(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
	act(() => {
		target.value = value;
		target.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
