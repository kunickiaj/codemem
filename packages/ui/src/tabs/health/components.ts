/* Preact component primitives + render helpers for the Health tab.
 * HealthCard, HealthActionRow, and StatBlock are the three card-shaped
 * pieces the tab repeats; the render helpers wrap them in a
 * TooltipProvider and render into a container. buildHealthCard is an
 * identity pass-through so card arrays get type-checked as
 * HealthCardInput[] at the call site. */

import { Fragment, h, render } from "preact";
import { Tooltip, TooltipProvider } from "../../components/primitives/tooltip";
import { copyToClipboard } from "../../lib/dom";
import type {
	HealthAction,
	HealthActionRowProps,
	HealthCardInput,
	LucideRuntime,
	StatItem,
} from "./types";

export function buildHealthCard(input: HealthCardInput): HealthCardInput {
	return input;
}

export function HealthCard({ label, value, detail, icon, className, title }: HealthCardInput) {
	const card = h(
		"div",
		{
			class: `stat${className ? ` ${className}` : ""}`,
			style: title ? "cursor: help;" : undefined,
		},
		icon
			? h("i", {
					"data-lucide": icon,
					class: "stat-icon",
				})
			: null,
		h(
			"div",
			{ class: "stat-content" },
			h("div", { class: "value" }, value),
			h("div", { class: "label" }, label),
			detail ? h("div", { class: "small" }, detail) : null,
		),
	);
	return title ? h(Tooltip, { label: title }, card) : card;
}

export function HealthActionRow({ item }: HealthActionRowProps) {
	let actionButton: HTMLButtonElement | null = null;
	let copyButton: HTMLButtonElement | null = null;
	const actionLabel = item.actionLabel || "Run";

	async function handleAction() {
		if (!item.action || !actionButton) return;
		actionButton.disabled = true;
		actionButton.textContent = "Running…";
		try {
			await item.action();
		} catch {}
		actionButton.disabled = false;
		actionButton.textContent = actionLabel;
	}

	function handleCopy() {
		if (!item.command || !copyButton) return;
		copyToClipboard(item.command, copyButton);
	}

	return h(
		"div",
		{ class: "health-action" },
		h(
			"div",
			{ class: "health-action-text" },
			item.label,
			item.command ? h("span", { class: "health-action-command" }, item.command) : null,
		),
		h(
			"div",
			{ class: "health-action-buttons" },
			item.action
				? h(
						"button",
						{
							class: "settings-button",
							onClick: handleAction,
							ref: (node: HTMLButtonElement | null) => {
								actionButton = node;
							},
						},
						actionLabel,
					)
				: null,
			item.command
				? h(
						"button",
						{
							class: "settings-button health-action-copy",
							onClick: handleCopy,
							ref: (node: HTMLButtonElement | null) => {
								copyButton = node;
							},
						},
						"Copy",
					)
				: null,
		),
	);
}

function formatStatValue(value: StatItem["value"]): string {
	if (typeof value === "number") return value.toLocaleString();
	if (value == null) return "n/a";
	return String(value);
}

export function StatBlock({ label, value, icon, tooltip }: StatItem) {
	const card = h(
		"div",
		{
			class: "stat",
			style: tooltip ? "cursor: help;" : undefined,
		},
		h("i", {
			"data-lucide": icon,
			class: "stat-icon",
		}),
		h(
			"div",
			{ class: "stat-content" },
			h("div", { class: "value" }, formatStatValue(value)),
			h("div", { class: "label" }, label),
		),
	);
	return tooltip ? h(Tooltip, { label: tooltip }, card) : card;
}

export function renderStatBlocks(container: HTMLElement | null, items: StatItem[]) {
	if (!container) return;
	render(
		h(
			TooltipProvider,
			null,
			items.map((item) => h(StatBlock, { ...item, key: `${item.label}-${item.icon}` })),
		),
		container,
	);
}

export function renderText(container: HTMLElement | null, value: string) {
	if (!container) return;
	render(h(Fragment, null, value), container);
}

export function renderIcons() {
	const lucide = (globalThis as typeof globalThis & { lucide?: LucideRuntime }).lucide;
	if (lucide && typeof lucide.createIcons === "function") lucide.createIcons();
}

export function renderHealthCards(container: HTMLElement | null, cards: HealthCardInput[]) {
	if (!container) return;
	render(
		h(
			TooltipProvider,
			null,
			cards.map((card) => h(HealthCard, { ...card, key: card.key ?? card.label })),
		),
		container,
	);
}

export function renderActionList(container: HTMLElement | null, actions: HealthAction[]) {
	if (!container) return;
	if (!actions.length) {
		container.hidden = true;
		render(null, container);
		return;
	}

	container.hidden = false;
	render(
		h(
			Fragment,
			null,
			actions
				.slice(0, 3)
				.map((item, index) => h(HealthActionRow, { item, key: `${item.label}-${index}` })),
		),
		container,
	);
}
