import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTabVisibilityTracker, ensureTabIsVisible } from "./tab-visibility";

function bounds(left: number, right: number): DOMRect {
	return {
		bottom: 40,
		height: 40,
		left,
		right,
		toJSON: () => ({}),
		top: 0,
		width: right - left,
		x: left,
		y: 0,
	};
}

describe("ensureTabIsVisible", () => {
	let button: HTMLButtonElement;
	let navigation: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = '<nav class="tab-bar"><button>Advanced</button></nav>';
		navigation = document.querySelector("nav") as HTMLElement;
		button = document.querySelector("button") as HTMLButtonElement;
		button.scrollIntoView = vi.fn();
		navigation.getBoundingClientRect = vi.fn(() => bounds(20, 500));
	});

	it("leaves a fully visible active tab in place", () => {
		button.getBoundingClientRect = vi.fn(() => bounds(360, 460));

		ensureTabIsVisible(button);

		expect(button.scrollIntoView).not.toHaveBeenCalled();
	});

	it.each([
		["left", 0, 100],
		["right", 460, 540],
	])("brings a tab clipped on the %s edge into view", (_edge, left, right) => {
		button.getBoundingClientRect = vi.fn(() => bounds(left, right));

		ensureTabIsVisible(button);

		expect(button.scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
	});

	it("ignores buttons outside the navigation or hidden from it", () => {
		const detached = document.createElement("button");
		detached.scrollIntoView = vi.fn();
		ensureTabIsVisible(detached);
		button.hidden = true;
		ensureTabIsVisible(button);

		expect(detached.scrollIntoView).not.toHaveBeenCalled();
		expect(button.scrollIntoView).not.toHaveBeenCalled();
	});

	it("does not pull the tab bar back during unchanged refreshes", () => {
		button.getBoundingClientRect = vi.fn(() => bounds(460, 540));
		const revealChangedTab = createTabVisibilityTracker();

		revealChangedTab(button);
		revealChangedTab(button);

		expect(button.scrollIntoView).toHaveBeenCalledTimes(1);
	});

	it("rechecks the active tab after the navigation bounds change", () => {
		let navigationRight = 500;
		navigation.getBoundingClientRect = vi.fn(() => bounds(20, navigationRight));
		button.getBoundingClientRect = vi.fn(() => bounds(430, 490));
		const revealChangedTab = createTabVisibilityTracker();

		revealChangedTab(button);
		navigationRight = 450;
		revealChangedTab(button);

		expect(button.scrollIntoView).toHaveBeenCalledOnce();
	});

	it("rechecks the active tab after its bounds change", () => {
		let buttonLeft = 430;
		button.getBoundingClientRect = vi.fn(() => bounds(buttonLeft, buttonLeft + 60));
		const revealChangedTab = createTabVisibilityTracker();

		revealChangedTab(button);
		buttonLeft = 460;
		revealChangedTab(button);

		expect(button.scrollIntoView).toHaveBeenCalledOnce();
	});

	it("preserves manual tab-bar scrolling during refreshes", () => {
		let buttonLeft = 430;
		button.getBoundingClientRect = vi.fn(() => bounds(buttonLeft, buttonLeft + 60));
		const revealChangedTab = createTabVisibilityTracker();

		revealChangedTab(button);
		navigation.scrollLeft = 430;
		buttonLeft = 0;
		revealChangedTab(button);

		expect(button.scrollIntoView).not.toHaveBeenCalled();
	});
});
