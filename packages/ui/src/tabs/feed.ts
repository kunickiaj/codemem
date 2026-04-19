/* Feed tab — memory feed rendering, filtering, search. */

import { type ComponentChildren, Fragment, h, render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Chip } from "../components/primitives/chip";
import { Tooltip, TooltipProvider } from "../components/primitives/tooltip";
import * as api from "../lib/api";
import { highlightText } from "../lib/dom";
import {
	formatDate,
	formatFileList,
	formatRelativeTime,
	formatTagLabel,
	parseJsonArray,
} from "../lib/format";
import { showGlobalNotice } from "../lib/notice";
import { setFeedScopeFilter, setFeedTypeFilter, state } from "../lib/state";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

/* ── Types ───────────────────────────────────────────────── */

export type { FeedItem, FeedItemMetadata } from "./feed/types";

import {
	authorLabel,
	feedScopeLabel,
	isLowSignalObservation,
	itemKey,
	mergeFeedItems,
	mergeMetadata,
	mergeRefreshFeedItems,
	trustStateLabel,
} from "./feed/helpers";
import {
	countNewItems,
	isNearFeedBottom,
	OBSERVATION_PAGE_SIZE,
	pageHasMore,
	pageNextOffset,
	SUMMARY_PAGE_SIZE,
} from "./feed/pagination";
import { FeedSkeletonItem } from "./feed/skeleton";
import type { FeedItem, ItemViewMode } from "./feed/types";

/* ── Module state ─────────────────────────────────────────── */

let lastFeedProject = "";
let observationOffset = 0;
let summaryOffset = 0;
let observationHasMore = true;
let summaryHasMore = true;
let loadMoreInFlight = false;
let feedScrollHandlerBound = false;
let feedProjectGeneration = 0;
let lastFeedScope = "all";

function markFeedMount(mount: HTMLElement) {
	mount.dataset.feedRenderRoot = "preact";
}

function ensureFeedRenderBoundary() {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return;
	feedTab.dataset.feedRenderBoundary = "preact-hybrid";
}

function renderIntoFeedMount(mount: HTMLElement, content: ComponentChildren) {
	markFeedMount(mount);
	// Wrap every feed render in a TooltipProvider so adjacent feed-item
	// tooltips share skipDelayDuration and don't each pay the full open
	// delay when the user hovers from one card to the next.
	render(h(TooltipProvider, null, content), mount);
}

function ProvenanceChip({ label, variant = "" }: { label: string; variant?: string }) {
	return h(Chip, { variant: "provenance", tone: variant || undefined }, label);
}

function resetPagination(project: string) {
	lastFeedProject = project;
	lastFeedScope = state.feedScopeFilter;
	feedProjectGeneration += 1;
	observationOffset = 0;
	summaryOffset = 0;
	observationHasMore = true;
	summaryHasMore = true;
	state.lastFeedItems = [];
	state.pendingFeedItems = null;
	state.lastFeedFilteredCount = 0;
	state.lastFeedSignature = "";
	state.newItemKeys.clear();
	state.itemViewState.clear();
	state.itemExpandState.clear();
}

function hasMorePages(): boolean {
	return observationHasMore || summaryHasMore;
}

export function syncInspectorQueryDraft(options: {
	feedQuery: string;
	inspectorQuery: string;
	hasInspectorOverride: boolean;
}): string {
	return options.hasInspectorOverride ? options.inspectorQuery : options.feedQuery;
}

export function parseInspectorWorkingSet(value: string): string[] {
	return value
		.split(/\n|,/)
		.map((item) => item.trim())
		.filter(Boolean);
}

export function packTraceContextKey(options: {
	project: string | null;
	query: string;
	workingSetFiles: string[];
}): string {
	return JSON.stringify([options.project, options.query.trim(), options.workingSetFiles]);
}

function replaceFeedItem(updatedItem: FeedItem) {
	const key = itemKey(updatedItem);
	state.lastFeedItems = (state.lastFeedItems as FeedItem[]).map((item) =>
		itemKey(item) === key ? updatedItem : item,
	);
}

function removeFeedItem(memoryId: number) {
	const removedKeys = new Set<string>();
	const keepItem = (item: FeedItem) => {
		const itemMemoryId = Number(item.id || item.memory_id || 0);
		const keep = itemMemoryId !== memoryId;
		if (!keep) removedKeys.add(itemKey(item));
		return keep;
	};
	state.lastFeedItems = (state.lastFeedItems as FeedItem[]).filter(keepItem);
	if (Array.isArray(state.pendingFeedItems)) {
		state.pendingFeedItems = (state.pendingFeedItems as FeedItem[]).filter(keepItem);
	}
	for (const key of removedKeys) {
		state.newItemKeys.delete(key);
		state.itemViewState.delete(key);
		for (const expandKey of Array.from(state.itemExpandState.keys())) {
			if (expandKey.startsWith(`${key}:`)) state.itemExpandState.delete(expandKey);
		}
	}
}

import { FeedItemMenu } from "./feed/menu";

/* ── Summary object extraction ───────────────────────────── */

import { canonicalKind, getSummaryObject, isSummaryLikeItem } from "./feed/summary-extract";

export { observationViewData } from "./feed/observation-view";

import {
	clampClass,
	defaultObservationView,
	observationViewData,
	observationViewModes,
	shouldClampBody,
} from "./feed/observation-view";

/* ── Rendering functions ─────────────────────────────────── */

import {
	renderFactsContent,
	renderNarrativeContent,
	renderSummarySections,
} from "./feed/body-renderers";

import { FeedToggle, FeedViewToggle, TagChip } from "./feed/toggles";

/* ── Feed item card renderer ─────────────────────────────── */

function FeedItemCard({ item }: { item: FeedItem }) {
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
				replaceFeedItem(payload.item as FeedItem);
				updateFeedView(true);
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
			removeFeedItem(memoryId);
			updateFeedView(true);
			await loadFeedData();
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

function FeedList({ items, loadingText }: { items: FeedItem[]; loadingText?: string }) {
	if (loadingText) {
		return h(
			"div",
			{
				className: "feed-skeleton",
				role: "status",
				"aria-label": loadingText,
			},
			[0, 1, 2, 3].map((i) => h(FeedSkeletonItem, { index: i, key: `skeleton-${i}` })),
		);
	}
	if (!items.length) {
		const hasFilters =
			Boolean(state.feedQuery.trim()) ||
			state.feedTypeFilter !== "all" ||
			state.feedScopeFilter !== "all";
		return h(
			"div",
			{ className: "small feed-empty-state" },
			h("strong", null, hasFilters ? "No memories match the current filters." : "No memories yet."),
			h(
				"div",
				null,
				hasFilters
					? "Try clearing filters, changing the scope, or using a broader search."
					: "Memories and session summaries will appear here once codemem has something worth keeping.",
			),
		);
	}
	return h(
		Fragment,
		null,
		items.map((item) => h(FeedItemCard, { item, key: itemKey(item) })),
	);
}

/* ── Filtering ───────────────────────────────────────────── */

import { computeSignature, filterByQuery, filterByType } from "./feed/filter";

async function loadMoreFeedPage() {
	if (loadMoreInFlight || !hasMorePages()) return;
	const requestProject = state.currentProject || "";
	const requestGeneration = feedProjectGeneration;
	const startObservationOffset = observationOffset;
	const startSummaryOffset = summaryOffset;
	loadMoreInFlight = true;
	try {
		const [observations, summaries] = await Promise.all([
			observationHasMore
				? api.loadMemoriesPage(requestProject, {
						limit: OBSERVATION_PAGE_SIZE,
						offset: startObservationOffset,
						scope: state.feedScopeFilter,
					})
				: Promise.resolve({
						items: [],
						pagination: { has_more: false, next_offset: startObservationOffset },
					}),
			summaryHasMore
				? api.loadSummariesPage(requestProject, {
						limit: SUMMARY_PAGE_SIZE,
						offset: startSummaryOffset,
						scope: state.feedScopeFilter,
					})
				: Promise.resolve({
						items: [],
						pagination: { has_more: false, next_offset: startSummaryOffset },
					}),
		]);

		if (
			requestGeneration !== feedProjectGeneration ||
			requestProject !== (state.currentProject || "")
		) {
			return;
		}

		const summaryItems = (summaries.items || []) as FeedItem[];
		const observationItems = (observations.items || []) as FeedItem[];
		const filtered = observationItems.filter((i) => !isLowSignalObservation(i));
		state.lastFeedFilteredCount += observationItems.length - filtered.length;

		summaryHasMore = pageHasMore(summaries, summaryItems.length, SUMMARY_PAGE_SIZE);
		observationHasMore = pageHasMore(observations, observationItems.length, OBSERVATION_PAGE_SIZE);
		summaryOffset = pageNextOffset(summaries, startSummaryOffset + summaryItems.length);
		observationOffset = pageNextOffset(
			observations,
			startObservationOffset + observationItems.length,
		);

		const incoming = [...summaryItems, ...filtered];
		const feedItems = mergeFeedItems(state.lastFeedItems as FeedItem[], incoming);
		// Pagination loads OLDER items, not fresh arrivals — skip the newPulse
		// bookkeeping so scrolling doesn't flash historical cards.

		state.lastFeedItems = feedItems;
		updateFeedView();
	} finally {
		loadMoreInFlight = false;
	}
}

function maybeLoadMoreFeedPage() {
	if (state.activeTab !== "feed") return;
	if (!hasMorePages()) return;
	if (!isNearFeedBottom()) return;
	void loadMoreFeedPage();
}

function feedMetaText(visibleCount: number): string {
	const filterLabel =
		state.feedTypeFilter === "observations"
			? " · observations"
			: state.feedTypeFilter === "summaries"
				? " · session summaries"
				: "";
	const scopeLabel = feedScopeLabel(state.feedScopeFilter);
	const filteredLabel =
		!state.feedQuery.trim() && state.lastFeedFilteredCount
			? ` · ${state.lastFeedFilteredCount} observations filtered`
			: "";
	const queryLabel = state.feedQuery.trim() ? ` · matching "${state.feedQuery.trim()}"` : "";
	const moreLabel = hasMorePages() ? " · scroll for more" : "";
	return `${visibleCount} items${filterLabel}${scopeLabel}${queryLabel}${filteredLabel}${moreLabel}`;
}

function TraceCandidateGroup({
	label,
	candidates,
}: {
	label: string;
	candidates: api.PackTraceCandidate[];
}) {
	if (candidates.length === 0) return null;
	return h(
		"div",
		{ className: "trace-group" },
		h("div", { className: "section-meta" }, label),
		h(
			"div",
			{ className: "feed-list" },
			candidates.map((candidate) =>
				h(
					"div",
					{ className: "feed-card", key: `${label}:${candidate.id}` },
					h("div", { className: "feed-card-header" }, [
						h("div", { className: "feed-card-title" }, `${candidate.rank}. ${candidate.title}`),
						h(
							"div",
							{ className: "feed-card-meta" },
							`#${candidate.id} · ${candidate.kind}${candidate.section ? ` · ${candidate.section}` : ""}`,
						),
					]),
					h("div", { className: "feed-card-body" }, [
						h("div", null, candidate.preview || "No preview available."),
						candidate.reasons.length
							? h("div", { className: "section-meta" }, `Reasons: ${candidate.reasons.join(", ")}`)
							: null,
					]),
				),
			),
		),
	);
}

function ContextInspectorPanel({ open }: { open: boolean }) {
	const [inspectorQuery, setInspectorQuery] = useState(() => String(state.feedQuery || ""));
	const [hasSeededInspectorQuery, setHasSeededInspectorQuery] = useState(false);
	const [hasInspectorOverride, setHasInspectorOverride] = useState(false);
	const [workingSetText, setWorkingSetText] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	const [errorContextKey, setErrorContextKey] = useState("");
	const [trace, setTrace] = useState<api.PackTrace | null>(null);
	const latestTraceRequestId = useRef(0);
	const feedQuery = String(state.feedQuery || "");
	const currentQuery = String(inspectorQuery || "").trim();
	const currentProject = state.currentProject || null;
	const currentWorkingSetFiles = parseInspectorWorkingSet(workingSetText);
	const currentContextKey = packTraceContextKey({
		project: currentProject,
		query: currentQuery,
		workingSetFiles: currentWorkingSetFiles,
	});
	const visibleTrace =
		trace &&
		packTraceContextKey({
			project: trace.inputs.project,
			query: trace.inputs.query,
			workingSetFiles: trace.inputs.working_set_files,
		}) === currentContextKey
			? trace
			: null;
	const visibleError = error && errorContextKey === currentContextKey ? error : "";

	useEffect(() => {
		latestTraceRequestId.current += 1;
		setLoading(false);
		setError("");
		setErrorContextKey("");
		setTrace((currentTrace) => {
			if (!currentTrace) return null;
			if (
				currentTrace.inputs.query !== currentQuery ||
				currentTrace.inputs.project !== currentProject
			) {
				return null;
			}
			return currentTrace;
		});
	}, [currentContextKey]);

	useEffect(() => {
		if (open && !hasSeededInspectorQuery) {
			setInspectorQuery(
				syncInspectorQueryDraft({
					feedQuery,
					hasInspectorOverride,
					inspectorQuery,
				}),
			);
			setHasSeededInspectorQuery(true);
		}
	}, [feedQuery, hasInspectorOverride, hasSeededInspectorQuery, inspectorQuery, open]);

	const runTrace = async () => {
		const context = currentQuery;
		const project = currentProject;
		const workingSetFiles = currentWorkingSetFiles;
		const contextKey = packTraceContextKey({ project, query: context, workingSetFiles });
		const requestId = latestTraceRequestId.current + 1;
		latestTraceRequestId.current = requestId;
		if (!context) {
			setError("Enter a query to inspect.");
			setErrorContextKey(contextKey);
			setTrace(null);
			return;
		}
		setLoading(true);
		setError("");
		setErrorContextKey("");
		try {
			const nextTrace = await api.tracePack({
				context,
				project,
				working_set_files: workingSetFiles,
			});
			if (requestId !== latestTraceRequestId.current) {
				return;
			}
			setTrace(nextTrace);
		} catch (err) {
			if (requestId !== latestTraceRequestId.current) {
				return;
			}
			setError(err instanceof Error ? err.message : String(err));
			setErrorContextKey(contextKey);
			setTrace(null);
		} finally {
			if (requestId === latestTraceRequestId.current) {
				setLoading(false);
			}
		}
	};

	const selected =
		visibleTrace?.retrieval.candidates.filter(
			(candidate) => candidate.disposition === "selected",
		) || [];
	const dropped =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "dropped") ||
		[];
	const deduped =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "deduped") ||
		[];
	const trimmed =
		visibleTrace?.retrieval.candidates.filter((candidate) => candidate.disposition === "trimmed") ||
		[];

	return open
		? h(
				"div",
				{ className: "feed-inspector" },
				h(
					"div",
					{ className: "feed-card", id: "contextInspectorPanel", style: "margin-top:12px;" },
					[
						h("div", { className: "feed-card-header" }, [
							h("div", { className: "feed-card-title" }, "Context Inspector"),
							h(
								"div",
								{ className: "feed-card-meta" },
								hasInspectorOverride
									? "Tracing an inspector-specific query"
									: "Seeded from the feed search on first open",
							),
						]),
						h("div", { className: "feed-card-body" }, [
							h("input", {
								className: "feed-search",
								onInput: (event) => {
									setInspectorQuery(String((event.currentTarget as HTMLInputElement).value || ""));
									setHasInspectorOverride(true);
									setTrace(null);
									setError("");
									setErrorContextKey("");
								},
								placeholder: "Trace a pack query…",
								value: inspectorQuery,
							}),
							h(
								"div",
								{ className: "section-meta", style: "margin-top:8px;" },
								hasInspectorOverride
									? "Inspector query is independent from the live feed search."
									: "Inspector query was seeded from the feed search and will stay independent until you change it.",
							),
							h("textarea", {
								className: "feed-inspector-files",
								onInput: (event) =>
									setWorkingSetText(
										String((event.currentTarget as HTMLTextAreaElement).value || ""),
									),
								placeholder: "Optional working-set files, one per line",
								rows: 3,
								value: workingSetText,
							}),
							h(
								"div",
								{ style: "display:flex; gap:8px; margin-top:8px; align-items:center;" },
								h(
									"button",
									{
										className: "toggle-button active",
										disabled: loading,
										onClick: () => void runTrace(),
										type: "button",
									},
									loading ? "Tracing…" : "Run trace",
								),
								visibleTrace
									? h(
											"span",
											{ className: "section-meta" },
											`mode=${visibleTrace.mode.selected} · candidates=${visibleTrace.retrieval.candidate_count} · tokens=${visibleTrace.output.estimated_tokens}`,
										)
									: null,
							),
							trace && !visibleTrace
								? h(
										"div",
										{ className: "section-meta", style: "margin-top:8px;" },
										"Trace inputs changed. Run trace again for the current query, project, and working set.",
									)
								: null,
							visibleError
								? h(
										"div",
										{ className: "section-meta", style: "margin-top:8px; color:#d96c6c;" },
										visibleError,
									)
								: null,
						]),
						visibleTrace
							? h(Fragment, null, [
									h(TraceCandidateGroup, { label: "Selected", candidates: selected }),
									h(TraceCandidateGroup, { label: "Dropped", candidates: dropped }),
									h(TraceCandidateGroup, { label: "Deduped", candidates: deduped }),
									h(TraceCandidateGroup, { label: "Trimmed", candidates: trimmed }),
									h("div", { className: "feed-card-body" }, [
										visibleTrace.assembly.collapsed_groups.length
											? h(
													"div",
													{ className: "section-meta" },
													`Collapsed duplicates: ${visibleTrace.assembly.collapsed_groups
														.map(
															(group) => `kept #${group.kept} from [${group.dropped.join(", ")}]`,
														)
														.join(" · ")}`,
												)
											: null,
										visibleTrace.assembly.trim_reasons.length
											? h(
													"div",
													{ className: "section-meta" },
													`Trim reasons: ${visibleTrace.assembly.trim_reasons.join(", ")}`,
												)
											: null,
										h("div", { className: "section-meta" }, "Final pack"),
										h(
											"pre",
											{ style: "white-space:pre-wrap; overflow:auto;" },
											visibleTrace.output.pack_text,
										),
									]),
								])
							: null,
					],
				),
			)
		: null;
}

function FeedTabView({ items, loadingText }: { items: FeedItem[]; loadingText?: string }) {
	const [inspectorOpen, setInspectorOpen] = useState(false);
	return h(
		Fragment,
		null,
		h(
			"div",
			{ className: "feed-controls" },
			h(
				"div",
				{ className: "section-meta", id: "feedMeta" },
				loadingText || feedMetaText(items.length),
			),
			h(
				"div",
				{ className: "feed-controls-right" },
				h("input", {
					className: "feed-search",
					id: "feedSearch",
					onInput: (event) => {
						state.feedQuery = String((event.currentTarget as HTMLInputElement).value || "");
						updateFeedView();
					},
					placeholder: "Search title, body, tags…",
					value: state.feedQuery,
				}),
				h(FeedToggle, {
					active: state.feedScopeFilter,
					id: "feedScopeToggle",
					onSelect: (value) => {
						if (value === state.feedScopeFilter) return;
						setFeedScopeFilter(value);
						void loadFeedData();
					},
					options: [
						{ value: "all", label: "All" },
						{ value: "mine", label: "My memories" },
						{ value: "theirs", label: "Other people" },
					],
				}),
				h(FeedToggle, {
					active: state.feedTypeFilter,
					id: "feedTypeToggle",
					onSelect: (value) => {
						if (value === state.feedTypeFilter) return;
						setFeedTypeFilter(value);
						updateFeedView();
					},
					options: [
						{ value: "all", label: "All" },
						{ value: "observations", label: "Observations" },
						{ value: "summaries", label: "Summaries" },
					],
				}),
				h(
					"button",
					{
						"aria-controls": "contextInspectorPanel",
						"aria-expanded": inspectorOpen,
						className: "settings-button feed-inspector-button",
						onClick: () => setInspectorOpen((current) => !current),
						type: "button",
					},
					inspectorOpen ? "Hide Context Inspector" : "Context Inspector",
				),
			),
		),
		h(ContextInspectorPanel, { open: inspectorOpen }),
		h("div", { className: "feed-list", id: "feedList" }, h(FeedList, { items, loadingText })),
	);
}

function renderFeedTab(items: FeedItem[], options?: { loadingText?: string }) {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return false;
	renderIntoFeedMount(feedTab, h(FeedTabView, { items, loadingText: options?.loadingText }));
	const globalLucide = (globalThis as { lucide?: { createIcons: () => void } }).lucide;
	if (globalLucide && !options?.loadingText) {
		globalLucide.createIcons();
	}
	return true;
}

function renderProjectSwitchLoadingState() {
	renderFeedTab([], { loadingText: "Loading selected project..." });
}

/* ── Public API ──────────────────────────────────────────── */

export function initFeedTab() {
	ensureFeedRenderBoundary();
	renderFeedTab(
		state.lastFeedItems,
		state.lastFeedItems.length || state.lastFeedSignature
			? undefined
			: { loadingText: "Loading memories…" },
	);

	if (!feedScrollHandlerBound) {
		window.addEventListener(
			"scroll",
			() => {
				maybeLoadMoreFeedPage();
			},
			{ passive: true },
		);
		feedScrollHandlerBound = true;
	}
}

export function updateFeedTypeToggle() {
	updateFeedView(true);
}

export function updateFeedScopeToggle() {
	updateFeedView(true);
}

export function updateFeedView(force = false) {
	const feedTab = document.getElementById("tab-feed");
	if (!feedTab) return;

	const scrollY = window.scrollY;
	const byType = filterByType(state.lastFeedItems as FeedItem[]);
	const visible = filterByQuery(byType);

	const sig = computeSignature(visible);
	const changed = force || sig !== state.lastFeedSignature;
	state.lastFeedSignature = sig;

	if (changed) {
		renderFeedTab(visible);
	}

	window.scrollTo({ top: scrollY });
	maybeLoadMoreFeedPage();
}

export async function loadFeedData() {
	const project = state.currentProject || "";
	const scopeChanged = state.feedScopeFilter !== lastFeedScope;
	if (project !== lastFeedProject || scopeChanged) {
		resetPagination(project);
		renderProjectSwitchLoadingState();
	}
	const requestGeneration = feedProjectGeneration;

	const observationsLimit = OBSERVATION_PAGE_SIZE;
	const summariesLimit = SUMMARY_PAGE_SIZE;

	const [observations, summaries] = await Promise.all([
		api.loadMemoriesPage(project, {
			limit: observationsLimit,
			offset: 0,
			scope: state.feedScopeFilter,
		}),
		api.loadSummariesPage(project, {
			limit: summariesLimit,
			offset: 0,
			scope: state.feedScopeFilter,
		}),
	]);

	if (requestGeneration !== feedProjectGeneration || project !== (state.currentProject || "")) {
		return;
	}

	const summaryItems = (summaries.items || []) as FeedItem[];
	const observationItems = (observations.items || []) as FeedItem[];
	const filtered = observationItems.filter((i) => !isLowSignalObservation(i));
	const filteredCount = observationItems.length - filtered.length;
	const firstPageFeedItems = [...summaryItems, ...filtered].sort((a, b) => {
		return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
	});
	const feedItems = mergeRefreshFeedItems(state.lastFeedItems as FeedItem[], firstPageFeedItems);

	// Only flag newPulse on genuine incremental arrivals. First-time load has
	// an empty lastFeedItems and every row "looks new" — skip that case so we
	// don't bulk-pulse the whole feed on open/tab-switch/project-switch.
	const previousItems = state.lastFeedItems as FeedItem[];
	const newCount = countNewItems(feedItems, previousItems);
	if (newCount && previousItems.length > 0) {
		const seen = new Set(previousItems.map(itemKey));
		feedItems.forEach((item) => {
			if (!seen.has(itemKey(item))) state.newItemKeys.add(itemKey(item));
		});
	}

	state.pendingFeedItems = null;
	state.lastFeedItems = feedItems;
	state.lastFeedFilteredCount = Math.max(state.lastFeedFilteredCount, filteredCount);
	summaryHasMore = pageHasMore(summaries, summaryItems.length, summariesLimit);
	observationHasMore = pageHasMore(observations, observationItems.length, observationsLimit);
	summaryOffset = Math.max(summaryOffset, pageNextOffset(summaries, summaryItems.length));
	observationOffset = Math.max(
		observationOffset,
		pageNextOffset(observations, observationItems.length),
	);
	lastFeedScope = state.feedScopeFilter;
	updateFeedView();
}
