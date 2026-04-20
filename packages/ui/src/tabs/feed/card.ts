/* Feed item card — renders a single memory item with its header, body,
 * provenance chips, visibility controls, and expand/collapse toggle. */

import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Chip } from "../../components/primitives/chip";
import { Tooltip } from "../../components/primitives/tooltip";
import * as api from "../../lib/api";
import { highlightText } from "../../lib/dom";
import {
	formatDate,
	formatFileList,
	formatRelativeTime,
	formatTagLabel,
	parseJsonArray,
} from "../../lib/format";
import { showGlobalNotice } from "../../lib/notice";
import { state } from "../../lib/state";
import { openSyncConfirmDialog } from "../sync/sync-dialogs";
import {
	renderFactsContent,
	renderNarrativeContent,
	renderSummarySections,
} from "./body-renderers";
import { authorLabel, itemKey, mergeMetadata, trustStateLabel } from "./helpers";
import { FeedItemMenu } from "./menu";
import { ProvenanceChip } from "./mount";
import {
	clampClass,
	defaultObservationView,
	observationViewData,
	observationViewModes,
	shouldClampBody,
} from "./observation-view";
import { canonicalKind, getSummaryObject, isSummaryLikeItem } from "./summary-extract";
import { FeedViewToggle, TagChip } from "./toggles";
import type { FeedItem, ItemViewMode } from "./types";

export interface FeedItemCardProps {
	item: FeedItem;
	onReplace: (item: FeedItem) => void;
	onRemove: (memoryId: number) => void;
	onViewRefresh: () => void;
	onReload: () => Promise<void>;
}

export function FeedItemCard({
	item,
	onReplace,
	onRemove,
	onViewRefresh,
	onReload,
}: FeedItemCardProps) {
	const metadata = mergeMetadata(item?.metadata_json);
	const isSessionSummary = isSummaryLikeItem(item, metadata);
	const displayKindValue = canonicalKind(item, metadata);
	const rowKey = itemKey(item);
	const defaultTitle = item.title || "(untitled)";
	const displayTitle = isSessionSummary && metadata?.request ? metadata.request : defaultTitle;
	const createdAtRaw = item.created_at || item.created_at_utc;
	const relative = formatRelativeTime(createdAtRaw);
	const tags = parseJsonArray(item.tags || []);
	const files = parseJsonArray(item.files || []);
	const project = item.project || "";
	const actor = authorLabel(item);
	const visibility = String(item.visibility || metadata?.visibility || "private").trim();
	const workspaceKind = String(item.workspace_kind || metadata?.workspace_kind || "").trim();
	const originSource = String(item.origin_source || metadata?.origin_source || "").trim();
	const originDeviceId = String(item.origin_device_id || metadata?.origin_device_id || "").trim();
	const trustState = String(item.trust_state || metadata?.trust_state || "").trim();
	const tagContent = tags.length ? ` · ${tags.map((t) => formatTagLabel(t)).join(", ")}` : "";
	const fileContent = files.length ? ` · ${formatFileList(files)}` : "";
	const memoryId = Number(item.id || 0);
	const [isNew, setIsNew] = useState(state.newItemKeys.has(rowKey));
	const summaryObj = isSessionSummary
		? getSummaryObject({ ...item, metadata_json: metadata })
		: null;
	const observationData = !isSessionSummary
		? observationViewData({ ...item, metadata_json: metadata })
		: null;
	const modes = observationData ? observationViewModes(observationData) : [];
	const fallbackMode = observationData ? defaultObservationView(observationData) : "summary";
	const storedMode = state.itemViewState.get(rowKey) as ItemViewMode | undefined;
	const initialMode =
		observationData && storedMode && modes.some((mode) => mode.id === storedMode)
			? storedMode
			: (fallbackMode as ItemViewMode);
	const [activeMode, setActiveMode] = useState<ItemViewMode>(initialMode);
	const activeExpandKey = `${rowKey}:${activeMode}`;
	const [expanded, setExpanded] = useState(state.itemExpandState.get(activeExpandKey) === true);
	const [selectedVisibility, setSelectedVisibility] = useState<"private" | "shared">(
		visibility === "shared" ? "shared" : "private",
	);
	const [savingVisibility, setSavingVisibility] = useState(false);
	const [deletingMemory, setDeletingMemory] = useState(false);
	const summarySections = summaryObj ? renderSummarySections(summaryObj) : [];

	useEffect(() => {
		if (!observationData) return;
		if (modes.some((mode) => mode.id === activeMode)) return;
		setActiveMode(fallbackMode as ItemViewMode);
	}, [activeMode, fallbackMode, modes, observationData]);

	useEffect(() => {
		state.itemViewState.set(rowKey, activeMode);
	}, [activeMode, rowKey]);

	useEffect(() => {
		const nextExpandKey = `${rowKey}:${activeMode}`;
		setExpanded(state.itemExpandState.get(nextExpandKey) === true);
	}, [activeMode, rowKey]);

	useEffect(() => {
		setSelectedVisibility(visibility === "shared" ? "shared" : "private");
	}, [visibility]);

	useEffect(() => {
		if (!isNew) return;
		const timer = window.setTimeout(() => {
			state.newItemKeys.delete(rowKey);
			setIsNew(false);
		}, 700);
		return () => window.clearTimeout(timer);
	}, [isNew, rowKey]);

	const currentVisibility = selectedVisibility;
	const visibilityNote =
		currentVisibility === "shared"
			? "This memory can sync to peers allowed by your project filters."
			: "This memory stays on this device unless a matching local assignment allows it to sync.";
	const secondaryMeta = [project ? `Project ${project}` : "No project", relative]
		.filter(Boolean)
		.join(" · ");
	const provenanceDetails = [
		workspaceKind && workspaceKind !== visibility ? `Workspace ${workspaceKind}` : "",
		originSource ? `From ${originSource}` : "",
		originDeviceId && actor !== "You" ? `Device ${originDeviceId}` : "",
		trustState && trustState !== "trusted" ? trustStateLabel(trustState) : "",
	]
		.filter(Boolean)
		.join(" · ");
	const metaText = [`${tagContent}${fileContent}`.trim(), provenanceDetails]
		.filter(Boolean)
		.join(" · ");

	const canClamp = Boolean(observationData) && shouldClampBody(activeMode, observationData);
	const bodyClassName = [
		activeMode === "facts" ? "feed-body facts" : "feed-body",
		canClamp && !expanded ? clampClass(activeMode).join(" ") : "",
	]
		.filter(Boolean)
		.join(" ");

	const bodyContent = isSessionSummary
		? summarySections.length
			? h("div", { className: "feed-body facts" }, summarySections)
			: renderNarrativeContent(String(item.body_text || "")) || h("div", { className: "feed-body" })
		: observationData
			? activeMode === "facts"
				? renderFactsContent(observationData.facts) || h("div", { className: bodyClassName })
				: renderNarrativeContent(
						activeMode === "narrative" ? observationData.narrative : observationData.summary,
						bodyClassName,
					) || h("div", { className: bodyClassName })
			: h("div", { className: "feed-body" });

	async function saveVisibility(nextVisibility: "private" | "shared") {
		const previousVisibility = currentVisibility;
		setSelectedVisibility(nextVisibility);
		setSavingVisibility(true);
		try {
			const payload = await api.updateMemoryVisibility(memoryId, nextVisibility);
			if (payload?.item) {
				onReplace(payload.item as FeedItem);
				onViewRefresh();
			}
			showGlobalNotice(
				nextVisibility === "shared"
					? "Memory will now sync as shared context."
					: "Memory is private again.",
			);
		} catch (error) {
			setSelectedVisibility(previousVisibility);
			showGlobalNotice(
				error instanceof Error ? error.message : "Failed to save visibility.",
				"warning",
			);
		} finally {
			setSavingVisibility(false);
		}
	}

	async function forgetMemory() {
		const titleText = String(displayTitle || "this memory").trim();
		const truncatedTitle =
			titleText.length > 80 ? `${titleText.slice(0, 79).trimEnd()}…` : titleText;
		const confirmed = await openSyncConfirmDialog({
			autoFocusAction: "cancel",
			title: "Forget this memory?",
			description: `Forgetting "${truncatedTitle}". This removes the memory from active results. The underlying record remains soft-deleted for audit and sync safety.`,
			confirmLabel: "Forget memory",
			cancelLabel: "Keep memory",
			tone: "danger",
		});
		if (!confirmed) return;

		setDeletingMemory(true);
		try {
			await api.forgetMemory(memoryId);
			onRemove(memoryId);
			onViewRefresh();
			await onReload();
			showGlobalNotice("Memory forgotten and removed from the active feed.");
		} catch (error) {
			showGlobalNotice(
				error instanceof Error ? error.message : "Failed to forget memory.",
				"warning",
			);
		} finally {
			setDeletingMemory(false);
		}
	}

	const kindChipLabel = displayKindValue.replace(/_/g, " ");
	const filesRow = files.length
		? h(
				"div",
				{ className: "feed-files" },
				files.map((file, index) =>
					h("span", { className: "feed-file", key: `${String(file)}-${index}` }, String(file)),
				),
			)
		: null;
	return h(
		"article",
		{
			className: `feed-item ${displayKindValue}${isNew ? " new-item" : ""}`.trim(),
			"data-key": rowKey,
		},
		h(
			"div",
			{ className: "feed-kind-banner" },
			h(Chip, { variant: "kind", tone: displayKindValue }, kindChipLabel),
		),
		h(
			"div",
			{ className: "feed-card-body" },
			h(
				"div",
				{ className: "feed-card-header" },
				h(
					"div",
					{ className: "feed-header" },
					h("div", {
						className: "feed-title title",
						dangerouslySetInnerHTML: { __html: highlightText(displayTitle, state.feedQuery) },
					}),
					h("div", { className: "feed-card-subtitle small" }, secondaryMeta),
				),
				h(
					"div",
					{ className: "feed-actions" },
					observationData
						? h(FeedViewToggle, {
								active: activeMode,
								modes,
								onSelect: (mode) => setActiveMode(mode),
							})
						: null,
					h(
						Tooltip,
						{ label: formatDate(createdAtRaw), side: "left" },
						h("div", { className: "small feed-age" }, relative),
					),
					Boolean(item.owned_by_self) && memoryId > 0
						? h(FeedItemMenu, {
								disabled: deletingMemory,
								onForget: () => void forgetMemory(),
								title: String(displayTitle || "memory"),
							})
						: null,
				),
			),
			h(
				"div",
				{ className: "feed-provenance" },
				h(ProvenanceChip, { label: actor, variant: actor === "You" ? "mine" : "author" }),
				h(ProvenanceChip, { label: visibility || "private", variant: visibility || "private" }),
			),
			h(
				"div",
				{ className: "feed-meta" },
				metaText || "No tags, files, or provenance details attached.",
			),
			bodyContent,
			h(
				"div",
				{ className: "feed-footer" },
				h(
					"div",
					{ className: "feed-footer-left" },
					tags.length
						? h(
								"div",
								{ className: "feed-tags" },
								tags.map((tag, index) => h(TagChip, { key: `${String(tag)}-${index}`, tag })),
							)
						: null,
					Boolean(item.owned_by_self) && memoryId > 0
						? h(
								"div",
								{ className: "feed-visibility-controls" },
								h(
									"select",
									{
										"aria-label": `Visibility for ${String(item.title || "memory")}`,
										className: "feed-visibility-select",
										disabled: savingVisibility,
										onChange: (event) => {
											const nextValue =
												String((event.currentTarget as HTMLSelectElement).value) === "shared"
													? "shared"
													: "private";
											void saveVisibility(nextValue);
										},
										value: currentVisibility,
									},
									h("option", { value: "private" }, "Only me"),
									h("option", { value: "shared" }, "Share with peers"),
								),
								h("div", { className: "feed-visibility-note" }, visibilityNote),
							)
						: null,
				),
				h(
					"div",
					{ className: "feed-footer-right" },
					canClamp
						? h(
								"button",
								{
									className: "feed-expand",
									onClick: () => {
										const nextValue = !expanded;
										state.itemExpandState.set(activeExpandKey, nextValue);
										setExpanded(nextValue);
									},
									type: "button",
								},
								expanded ? "Collapse" : "Expand",
							)
						: null,
				),
			),
			filesRow,
		),
	);
}
