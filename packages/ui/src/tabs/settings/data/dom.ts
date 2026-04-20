/* Pure DOM helpers used by the settings modal — tooltip positioning,
 * tooltip anchor lookup, focus-trap enumeration, and the initial focus
 * handler for the opened dialog. */

import { $ } from "../../../lib/dom";

export function positionHelpTooltipElement(el: HTMLElement, anchor: HTMLElement) {
	const rect = anchor.getBoundingClientRect();
	const margin = 8;
	const gap = 8;
	const width = el.offsetWidth;
	const height = el.offsetHeight;

	let left = rect.left + rect.width / 2 - width / 2;
	left = Math.max(margin, Math.min(left, globalThis.innerWidth - width - margin));

	let top = rect.bottom + gap;
	if (top + height > globalThis.innerHeight - margin) {
		top = rect.top - height - gap;
	}
	top = Math.max(margin, top);

	el.style.left = `${Math.round(left)}px`;
	el.style.top = `${Math.round(top)}px`;
}

export function helpButtonFromTarget(target: EventTarget | null): HTMLElement | null {
	if (!(target instanceof Element)) return null;
	return target.closest(".help-icon[data-tooltip]") as HTMLElement | null;
}

export function getFocusableNodes(container: HTMLElement | null): HTMLElement[] {
	if (!container) return [];
	const selector = [
		"button:not([disabled])",
		"input:not([disabled])",
		"select:not([disabled])",
		"textarea:not([disabled])",
		"[href]",
		'[tabindex]:not([tabindex="-1"])',
	].join(",");
	return Array.from(container.querySelectorAll(selector)).filter((node) => {
		const el = node as HTMLElement;
		return !el.hidden && el.offsetParent !== null;
	}) as HTMLElement[];
}

export function focusSettingsDialog() {
	const modal = $("settingsModal");
	const focusable = getFocusableNodes(modal as HTMLElement | null);
	const firstFocusable = focusable[0];
	(firstFocusable || (modal as HTMLElement | null))?.focus();
}
