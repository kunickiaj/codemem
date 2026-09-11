/* Preact component primitives + render helpers for the Health tab.
 * HealthCard, HealthActionRow, and StatBlock are the three card-shaped
 * pieces the tab repeats; the render helpers wrap them in a
 * TooltipProvider and render into a container. buildHealthCard is an
 * identity pass-through so card arrays get type-checked as
 * HealthCardInput[] at the call site. */

import { Fragment, h, render } from "preact";
import { Tooltip, TooltipProvider } from "../../components/primitives/tooltip";
import type { UpdateStatus } from "../../lib/api";
import { type AutomaticRecallStats, parseAutomaticRecallStats } from "../../lib/api/stats";
import { copyToClipboard } from "../../lib/dom";
import { formatTokenCount } from "../../lib/format";
import type {
	HealthAction,
	HealthActionRowProps,
	HealthCardInput,
	LucideRuntime,
	StatItem,
} from "./types";

function releaseChannelLabel(status: UpdateStatus): string | null {
	if (status.channel === "latest") return "stable";
	return status.channel;
}

export function buildHealthCard(input: HealthCardInput): HealthCardInput {
	return input;
}

function formatAutomaticRecallPeriod(stats: AutomaticRecallStats): [string, string] {
	const start = new Date(stats.periodStart);
	const end = new Date(stats.periodEnd);
	const shortDate = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
	});
	const datedYear = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
	if (start.getFullYear() === end.getFullYear()) {
		return [shortDate.format(start), datedYear.format(end)];
	}
	return [datedYear.format(start), datedYear.format(end)];
}

function formatRecallShare(part: number, total: number): string {
	const rawPercent = (100 * part) / total;
	const roundedPercent = Math.round(rawPercent);
	if (rawPercent > 0 && roundedPercent === 0) return "<1%";
	if (rawPercent < 100 && roundedPercent === 100) return ">99%";
	return `${roundedPercent}%`;
}

function automaticRecallItems(stats: AutomaticRecallStats): StatItem[] {
	if (stats.freshEvaluations === 0) {
		return [
			{
				label: "Recalls checked",
				value: 0,
				tooltip: "No automatic recalls were checked for repeated memories in this period.",
				icon: "activity",
			},
			{
				label: "Not checked",
				value: stats.unmeasuredAttempts,
				tooltip: `Codemem could not check ${stats.unmeasuredAttempts.toLocaleString()} automatic recalls for repeated memories, so savings are unknown.`,
				icon: "circle-help",
			},
		];
	}

	const deduplicatedValue = formatRecallShare(
		stats.evaluationsWithDuplicates,
		stats.freshEvaluations,
	);
	const hasIncompleteResults =
		stats.missingRetainedMetadata > 0 ||
		stats.invalidRetainedMetadata > 0 ||
		stats.packMetadataGaps > 0;
	return [
		{
			label: "Recalls with repeats",
			value: deduplicatedValue,
			tooltip: `Codemem removed repeated memories from ${stats.evaluationsWithDuplicates.toLocaleString()} of ${stats.freshEvaluations.toLocaleString()} automatic recalls.`,
			icon: "filter",
		},
		{
			label: "Memories skipped",
			value: stats.duplicatesOmitted,
			tooltip: `Codemem left out ${stats.duplicatesOmitted.toLocaleString()} memories that were already in your conversation, out of ${stats.candidateItems.toLocaleString()} considered.`,
			icon: "minus-circle",
		},
		{
			label: "Repeated tokens removed",
			value: `~${formatTokenCount(stats.estimatedTokensAvoided)}`,
			tooltip: `About ${stats.estimatedTokensAvoided.toLocaleString()} tokens were left out because they repeated information already in your conversation.`,
			icon: "trending-down",
		},
		{
			label: "Recalls checked",
			value: stats.freshEvaluations,
			tooltip: `Codemem checked ${stats.freshEvaluations.toLocaleString()} automatic recalls for repeated memories. ${stats.unmeasuredAttempts.toLocaleString()} more could not be checked.${hasIncompleteResults ? " Some results may be incomplete." : ""}`,
			icon: "activity",
		},
	];
}

function automaticRecallDetail(stats: AutomaticRecallStats | null) {
	if (!stats || stats.availability === "unavailable")
		return h(
			"p",
			{ class: "section-meta" },
			"Automatic recall details aren’t available. Update Codemem and refresh this page.",
		);
	const [periodStart, periodEnd] = formatAutomaticRecallPeriod(stats);
	return h(
		Fragment,
		null,
		h(
			"div",
			{ class: "grid-2 automatic-recall-grid" },
			automaticRecallItems(stats).map((item) =>
				h(StatBlock, { ...item, key: `${item.label}-${item.icon}` }),
			),
		),
		h(
			"p",
			{ class: "automatic-recall-meta" },
			h("time", { dateTime: stats.periodStart }, periodStart),
			"–",
			h("time", { dateTime: stats.periodEnd }, periodEnd),
			` · Based on up to ${stats.windowLimit.toLocaleString()} recent automatic recalls across all projects.${stats.freshEvaluations === 0 ? " No recalls were checked, so savings are unknown." : ""}`,
		),
	);
}

export function renderAutomaticRecall(container: HTMLElement | null, payload: unknown) {
	if (!container) return;
	render(
		h(
			TooltipProvider,
			null,
			h(
				"details",
				{ class: "automatic-recall" },
				h("summary", null, "Automatic recall"),
				h(
					"section",
					{ "aria-label": "Automatic recall measurements" },
					automaticRecallDetail(parseAutomaticRecallStats(payload)),
				),
			),
		),
		container,
	);
	renderIcons();
}

function updateBannerCopy(status: UpdateStatus) {
	if (status.install_kind === "repo-dev") {
		return {
			title: "Running from repository source",
			detail: `Package metadata version: ${status.current_version}. Registry releases do not describe the checked-out source revision.`,
			tone: "current",
		};
	}

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

	const channelLabel = releaseChannelLabel(status);
	if (!channelLabel) {
		return {
			title: `Unable to compare Codemem ${status.current_version} with ${status.latest_version}`,
			detail: "The installed version is not on a supported release channel.",
			tone: "unavailable",
		};
	}

	return {
		title: `Codemem ${status.current_version} is up to date`,
		detail: `You are running the latest ${channelLabel} release.`,
		tone: "current",
	};
}

function UpdateBanner({ status }: { status: UpdateStatus }) {
	const copy = updateBannerCopy(status);
	const showGuidance =
		status.install_kind === "repo-dev" ||
		status.update_available ||
		status.stale ||
		!status.latest_version ||
		!status.channel;
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
			await item.action(actionButton);
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
			tabIndex: tooltip ? 0 : undefined,
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
