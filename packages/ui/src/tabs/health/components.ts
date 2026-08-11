/* Preact component primitives + render helpers for the Health tab.
 * HealthCard, HealthActionRow, and StatBlock are the three card-shaped
 * pieces the tab repeats; the render helpers wrap them in a
 * TooltipProvider and render into a container. buildHealthCard is an
 * identity pass-through so card arrays get type-checked as
 * HealthCardInput[] at the call site. */

import { Fragment, h, render } from "preact";
import { Tooltip, TooltipProvider } from "../../components/primitives/tooltip";
import type { UpdateStatus } from "../../lib/api";
import { copyToClipboard } from "../../lib/dom";
import type {
	HealthAction,
	HealthActionRowProps,
	HealthCardInput,
	LucideRuntime,
	StatItem,
} from "./types";

const STABLE_RELEASE_VERSION =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function isStableReleaseVersion(value: string): boolean {
	const match = STABLE_RELEASE_VERSION.exec(value);
	return Boolean(match?.slice(1, 4).map(Number).every(Number.isSafeInteger));
}

export function buildHealthCard(input: HealthCardInput): HealthCardInput {
	return input;
}

function updateBannerCopy(status: UpdateStatus) {
	if (!status.latest_version) {
		return {
			title: "Update check unavailable",
			detail: status.error
				? `Could not check for updates: ${status.error}`
				: "Could not check for updates.",
			tone: "unavailable",
		};
	}

	if (status.stale) {
		return {
			title: status.update_available
				? `Cached update status: Codemem ${status.latest_version} is available`
				: `Cached update status for Codemem ${status.current_version}`,
			detail: status.error
				? `This result is stale because a fresh check failed: ${status.error}`
				: "This result is cached and may be stale.",
			tone: "stale",
		};
	}

	if (status.update_available) {
		return {
			title: `Codemem ${status.latest_version} is available`,
			detail: `Installed version: ${status.current_version}.`,
			tone: "available",
		};
	}

	if (!isStableReleaseVersion(status.current_version)) {
		return {
			title: `Unable to compare Codemem ${status.current_version} with ${status.latest_version}`,
			detail: "The installed version is not a stable semantic version.",
			tone: "unavailable",
		};
	}

	return {
		title: `Codemem ${status.current_version} is up to date`,
		detail: "You are running the latest stable release.",
		tone: "current",
	};
}

function UpdateBanner({ status }: { status: UpdateStatus }) {
	const copy = updateBannerCopy(status);
	const showGuidance =
		status.update_available ||
		status.stale ||
		!status.latest_version ||
		!isStableReleaseVersion(status.current_version);
	return h(
		"section",
		{
			class: `health-update-banner health-update-banner--${copy.tone}`,
			role: "status",
			"aria-atomic": "true",
			"aria-label": "Codemem update status",
		},
		h("i", {
			"aria-hidden": "true",
			"data-lucide": "circle-arrow-up",
			class: "health-update-icon",
		}),
		h(
			"div",
			{ class: "health-update-copy" },
			h("h2", null, copy.title),
			h("p", null, copy.detail),
			showGuidance && status.recommended_action
				? h(
						"p",
						{ class: "health-update-guidance" },
						h("span", { class: "health-update-guidance-label" }, "Recommended action"),
						h("code", null, status.recommended_action),
					)
				: null,
		),
	);
}

export function renderUpdateBanner(container: HTMLElement | null, status: UpdateStatus | null) {
	if (!container) return;
	container.hidden = !status;
	render(status ? h(UpdateBanner, { status }) : null, container);
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
