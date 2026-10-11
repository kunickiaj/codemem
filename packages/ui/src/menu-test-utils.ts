import { act } from "preact/test-utils";

/** Open a row's real Radix menu and query only the portal owned by its trigger. */
export function openActionMenu(scope: ParentNode = document): HTMLElement {
	// Legacy controller renderers mount outside act; flush their listener effects first.
	act(() => {});
	const trigger = scope.querySelector<HTMLButtonElement>(".feed-menu-trigger");
	if (!trigger) throw new Error("Menu trigger missing");
	if (trigger.getAttribute("aria-expanded") !== "true") {
		act(() => {
			trigger.focus();
			trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
	}
	const menu = document.getElementById(trigger.getAttribute("aria-controls") || "");
	if (menu?.getAttribute("role") !== "menu") throw new Error("Menu portal missing");
	return menu;
}

export function closeActionMenu(menu: HTMLElement): void {
	act(() => {
		menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	});
}
