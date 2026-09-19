/* Preact component primitives + render helpers for the Health tab.
 * HealthCard, HealthActionRow, and StatBlock are the three card-shaped
 * pieces the tab repeats; the render helpers wrap them in a
 * TooltipProvider and render into a container. buildHealthCard is an
 * identity pass-through so card arrays get type-checked as
 * HealthCardInput[] at the call site. */

import { Fragment, h, render } from "preact";
import { Chip } from "../../components/primitives/chip";
import { PresencePip, type PresenceState } from "../../components/primitives/presence-pip";
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

type UpdateBannerCopy = {
	label: string;
	title: string;
	tone?: string;
	showCopy?: boolean;
};

function withUpdateError(title: string, status: UpdateStatus): string {
	if (!status.error) return title;
	return `${title} ${status.error}`;
}

function withUpdateGuidance(title: string, status: UpdateStatus): string {
	if (!status.recommended_action) return title;
	return `${title} ${status.recommended_action}`;
}

function updateBannerCopy(status: UpdateStatus): UpdateBannerCopy {
	if (status.install_kind === "repo-dev") {
		return {
			label: `Source build · ${status.current_version}`,
			title: withUpdateGuidance(
				`Running from repository source. Package metadata version: ${status.current_version}. Registry releases do not describe the checked-out source revision.`,
				status,
			),
			tone: "health-update-source",
		};
	}

	if (!status.channel) {
		return {
			label: "Unsupported channel",
			title: withUpdateGuidance(
				withUpdateError("The installed version is not on a supported release channel.", status),
				status,
			),
			tone: "badge-offline",
		};
	}

	if (!status.latest_version) {
		return {
			label: "Update check unavailable",
			title: withUpdateGuidance(withUpdateError("Could not check for updates.", status), status),
			tone: "badge-offline",
		};
	}

	if (status.update_available) {
		return {
			label: `Update available · ${status.latest_version}`,
			title: withUpdateError(
				`Codemem ${status.latest_version} is available. Installed version: ${status.current_version}.`,
				status,
			),
			tone: "badge-online",
			showCopy: Boolean(status.recommended_action),
		};
	}

	return {
		label: `Up to date · ${status.current_version}`,
		title: withUpdateError(
			`Codemem ${status.current_version} is up to date. You are running the latest ${status.channel === "latest" ? "stable" : status.channel} release.`,
			status,
		),
		tone: "badge-online",
	};
}

function UpdateBanner({ status }: { status: UpdateStatus }) {
	const copy = updateBannerCopy(status);
	const showDetail = copy.tone !== "badge-online" || status.stale;
	const detail = status.stale
		? `${copy.title} ${status.error ? `This result is stale because a fresh check failed: ${status.error}` : "This result is cached and may be stale."}`
		: copy.title;
	let copyButton: HTMLButtonElement | null = null;
	function handleCopy() {
		if (!status.recommended_action || !copyButton) return;
		copyToClipboard(status.recommended_action, copyButton);
	}
	return h(
		"section",
		{
			class: "health-update-banner",
			role: "status",
			"aria-atomic": "true",
			"aria-label": "Codemem update status",
		},
		h("i", {
			"aria-hidden": "true",
			"data-lucide": "circle-arrow-up",
			class: "health-update-icon",
		}),
		h(Chip, { variant: "badge", tone: copy.tone, title: copy.title }, copy.label),
		showDetail ? h("span", { class: "health-update-detail" }, detail) : null,
		status.stale
			? h(
					Chip,
					{
						variant: "badge",
						title: status.error
							? `This result is stale because a fresh check failed: ${status.error}`
							: "This result is cached and may be stale.",
					},
					"Cached",
				)
			: null,
		copy.showCopy && status.recommended_action
			? h(
					"button",
					{
						class: "settings-button health-update-copy-button",
						onClick: handleCopy,
						ref: (node: HTMLButtonElement | null) => {
							copyButton = node;
						},
						title: status.recommended_action,
						type: "button",
					},
					"Copy command",
				)
			: null,
	);
}

export function renderUpdateBanner(container: HTMLElement | null, status: UpdateStatus | null) {
	if (!container) return;
	container.hidden = !status;
	render(status ? h(UpdateBanner, { status }) : null, container);
}

export function HealthCard({
	label,
	value,
	detail,
	icon,
	className,
	title,
	loading,
}: HealthCardInput) {
	const card = h(
		"div",
		{
			class: `stat${className ? ` ${className}` : ""}${title ? " has-tooltip" : ""}`,
		},
		icon
			? h(
					"span",
					{ class: "health-icon-slot", key: `${icon}-${loading ? "loading" : "static"}` },
					h("i", {
						"aria-hidden": "true",
						"data-lucide": icon,
						class: `stat-icon${loading ? " health-loading-icon" : ""}`,
					}),
				)
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
			class: `stat${tooltip ? " has-tooltip" : ""}`,
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

export type HealthTileInput = {
	key: string;
	label: string;
	value: string;
	state: PresenceState;
	title: string;
};

function HealthTile({ label, value, state: presenceState, title }: HealthTileInput) {
	return h(
		"div",
		{ class: "health-tile", title },
		h("span", { class: "health-tile-label" }, label),
		h(
			"span",
			{ class: "health-tile-value" },
			h(PresencePip, { state: presenceState, size: 6 }),
			value,
		),
	);
}

export function renderHealthOverviewGrid(
	container: HTMLElement | null,
	tiles: HealthTileInput[],
	maintenanceCards: HealthCardInput[],
) {
	if (!container) return;
	render(
		h(
			TooltipProvider,
			null,
			h(
				"div",
				{ class: "health-tile-grid" },
				tiles.map((tile) => h(HealthTile, { ...tile, key: tile.key })),
			),
			maintenanceCards.length
				? h(
						"div",
						{ class: "grid-2 health-maintenance-grid" },
						maintenanceCards.map((card) => h(HealthCard, { ...card, key: card.key ?? card.label })),
					)
				: null,
		),
		container,
	);
}

type HealthStatusInput = {
	label: string;
	message: string;
	stale: boolean;
	state: PresenceState;
	statusClass: string;
};

function HealthStatus({
	label,
	message,
	stale,
	state: presenceState,
	statusClass,
}: HealthStatusInput) {
	return h(
		"div",
		{ class: "health-status-summary" },
		h(PresencePip, { state: presenceState, size: 8 }),
		h(
			"div",
			{ class: "health-status-copy" },
			h("strong", { class: `health-status-word ${statusClass}` }, label),
			h(
				"div",
				{ class: "health-status-meta" },
				h(
					"div",
					{
						class: "section-meta",
						id: "healthMeta",
						role: "status",
						"aria-live": "polite",
						"aria-atomic": "true",
					},
					h("span", { class: "sr-only" }, `${label} · `),
					message,
					stale ? h("span", { class: "sr-only" }, " · Stale data") : null,
				),
				stale ? h(Chip, { variant: "badge" }, "Stale data") : null,
			),
		),
	);
}

export function renderHealthStatus(container: HTMLElement | null, input: HealthStatusInput) {
	if (!container) return;
	render(h(HealthStatus, input), container);
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
