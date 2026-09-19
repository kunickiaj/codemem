import { h, type TargetedEvent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Chip } from "../../../components/primitives/chip";
import { Tooltip } from "../../../components/primitives/tooltip";
import * as api from "../../../lib/api";
import { highlightText } from "../../../lib/dom";
import { formatDate, formatRelativeTime } from "../../../lib/format";
import { showGlobalNotice } from "../../../lib/notice";
import { setPreferredFeedViewMode, state } from "../../../lib/state";
import { openSyncConfirmDialog, openSyncInputDialog } from "../../sync/sync-dialogs";
import {
	renderFactsContent,
	renderNarrativeContent,
	renderSummarySections,
} from "../data/body-renderers";
import {
	buildFeedCardViewModel,
	type FeedCardMode,
	hiddenSearchMatch,
	preferredAvailableMode,
} from "../data/card-view-model";
import {
	authorLabel,
	deviceLabel,
	mergeMetadata,
	originSourceLabel,
	trustStateLabel,
} from "../data/helpers";
import type { FeedItem, ItemViewMode } from "../types";
import { FeedItemMenu } from "./FeedItemMenu";
import { FeedViewToggle } from "./FeedViewToggle";
import { ProvenanceChip } from "./ProvenanceChip";
import { TagChip } from "./TagChip";

export interface FeedItemCardProps {
	item: FeedItem;
	onReplace: (item: FeedItem) => void;
	onRemove: (memoryId: number) => void;
	onViewRefresh: () => void;
	onReload: () => Promise<void>;
}

function renderModeContent(mode: FeedCardMode) {
	if (mode.content.type === "facts") return renderFactsContent(mode.content.facts);
	if (mode.content.type === "sections") {
		return h("div", { className: "feed-body facts" }, renderSummarySections(mode.content.sections));
	}
	const className = mode.id === "narrative" ? "feed-body narrative" : "feed-body";
	return renderNarrativeContent(mode.content.text, className);
}

function shouldShowSearchMatch(
	searchMatch: ReturnType<typeof hiddenSearchMatch>,
	expanded: boolean,
	activeMode: ItemViewMode,
) {
	if (!searchMatch) return false;
	return !expanded || searchMatch.mode !== activeMode;
}

export function FeedItemCard({
	item,
	onReplace,
	onRemove,
	onViewRefresh,
	onReload,
}: FeedItemCardProps) {
	const model = buildFeedCardViewModel(item);
	const metadata = mergeMetadata(item.metadata_json);
	const modeIds = model.modes.map((mode) => mode.id);
	const storedMode = state.itemViewState.get(model.rowKey) as ItemViewMode | undefined;
	const preferredMode = storedMode || state.preferredFeedViewMode;
	const initialMode = preferredAvailableMode(model.modes, preferredMode);
	const [activeMode, setActiveMode] = useState<ItemViewMode>(initialMode);
	const activeExpandKey = `${model.rowKey}:${activeMode}`;
	const [expanded, setExpanded] = useState(state.itemExpandState.get(activeExpandKey) === true);
	const [isNew, setIsNew] = useState(state.newItemKeys.has(model.rowKey));
	const visibility = String(item.visibility || metadata.visibility || "private").trim();
	const [selectedVisibility, setSelectedVisibility] = useState<"private" | "shared">(
		visibility === "shared" ? "shared" : "private",
	);
	const [savingVisibility, setSavingVisibility] = useState(false);
	const [deletingMemory, setDeletingMemory] = useState(false);
	const [movingProject, setMovingProject] = useState(false);
	const createdAtRaw = item.created_at || item.created_at_utc;
	const relative = formatRelativeTime(createdAtRaw);
	const project = String(item.project || "").trim();
	const actor = authorLabel(item);
	const device = deviceLabel(item, metadata);
	const workspaceKind = String(item.workspace_kind || metadata.workspace_kind || "").trim();
	const originSource = originSourceLabel(item.origin_source || metadata.origin_source);
	const trustState = String(item.trust_state || metadata.trust_state || "").trim();
	const memoryId = Number(item.id || item.memory_id || 0);
	const detailId = `feed-detail-${model.rowKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
	const activeModeData = model.modes.find((mode) => mode.id === activeMode);
	const searchMatch = hiddenSearchMatch(model, state.feedQuery);
	const ownedBySelf = item.owned_by_self === true || actor === "You";
	let trustLabel = "";
	if (!ownedBySelf && trustState !== "trusted") {
		trustLabel = trustState ? trustStateLabel(trustState) : "Unknown trust";
	}

	useEffect(() => {
		if (modeIds.includes(activeMode)) return;
		setActiveMode(preferredAvailableMode(model.modes, state.preferredFeedViewMode));
	}, [activeMode, modeIds, model.modes]);

	useEffect(() => {
		state.itemViewState.set(model.rowKey, activeMode);
	}, [activeMode, model.rowKey]);

	useEffect(() => {
		setExpanded(state.itemExpandState.get(`${model.rowKey}:${activeMode}`) === true);
	}, [activeMode, model.rowKey]);

	useEffect(() => {
		setSelectedVisibility(visibility === "shared" ? "shared" : "private");
	}, [visibility]);

	useEffect(() => {
		if (!isNew) return;
		const timer = window.setTimeout(() => {
			state.newItemKeys.delete(model.rowKey);
			setIsNew(false);
		}, 700);
		return () => window.clearTimeout(timer);
	}, [isNew, model.rowKey]);

	function selectMode(mode: ItemViewMode) {
		state.itemExpandState.set(`${model.rowKey}:${mode}`, expanded);
		state.itemViewState.set(model.rowKey, mode);
		setPreferredFeedViewMode(mode);
		setActiveMode(mode);
	}

	function toggleDetail() {
		if (!activeModeData) return;
		const nextValue = !expanded;
		state.itemExpandState.set(activeExpandKey, nextValue);
		setExpanded(nextValue);
	}

	async function saveVisibility(nextVisibility: "private" | "shared") {
		const previousVisibility = selectedVisibility;
		setSelectedVisibility(nextVisibility);
		setSavingVisibility(true);
		try {
			const payload = await api.updateMemoryVisibility(memoryId, nextVisibility);
			if (payload?.item) {
				onReplace(payload.item as FeedItem);
				onViewRefresh();
			}
			showGlobalNotice(
				nextVisibility === "shared" ? "Shared with synced peers" : "Only you can see this",
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

	async function moveProject() {
		const currentProject = String(item.project || "").trim();
		const titleText = String(model.displayTitle || "this memory").trim();
		const truncatedTitle =
			titleText.length > 80 ? `${titleText.slice(0, 79).trimEnd()}…` : titleText;
		const description = currentProject
			? `Move "${truncatedTitle}" from "${currentProject}" to another project. Pick an existing project or type a new name. Every memory in the same session will be reassigned together.`
			: `Assign a project to "${truncatedTitle}". Pick an existing project or type a new name. Every memory in the same session will be reassigned together.`;
		let suggestions: string[] = [];
		try {
			const all = await api.loadProjects();
			suggestions = all.filter((candidate) => candidate && candidate !== currentProject);
		} catch {
			// Free-text project entry remains available when suggestions fail.
		}
		const nextProject = await openSyncInputDialog({
			title: "Assign to project",
			description,
			initialValue: currentProject,
			placeholder: "Pick one or type a new project name",
			suggestions,
			confirmLabel: "Move",
			cancelLabel: "Cancel",
			validate: (value) => {
				const trimmed = value.trim();
				if (!trimmed) return "Enter a project name.";
				if (trimmed === currentProject) return "Already assigned to this project.";
				return null;
			},
		});
		if (nextProject == null) return;
		const target = nextProject.trim();
		if (!target || target === currentProject) return;

		setMovingProject(true);
		try {
			const result = await api.moveMemoryProject(memoryId, target);
			const count = Number(result.moved_memory_count || 1);
			showGlobalNotice(
				count > 1
					? `Moved ${count} memories from this session to "${result.project}".`
					: `Moved to "${result.project}".`,
			);
			await onReload();
			onViewRefresh();
		} catch (error) {
			showGlobalNotice(
				error instanceof Error ? error.message : "Failed to move memory.",
				"warning",
			);
		} finally {
			setMovingProject(false);
		}
	}

	async function forgetMemory() {
		const titleText = String(model.displayTitle || "this memory").trim();
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

	const filesRow = model.files.length
		? h(
				"div",
				{ className: "feed-files" },
				model.files.map((file, index) =>
					h("span", { className: "feed-file", key: `${String(file)}-${index}` }, String(file)),
				),
			)
		: null;
	const expandedProvenance = [
		workspaceKind
			? h(ProvenanceChip, { label: `Workspace ${workspaceKind}`, variant: "workspace" })
			: null,
		originSource ? h(ProvenanceChip, { label: `From ${originSource}`, variant: "source" }) : null,
		device ? h(ProvenanceChip, { label: device, variant: "device" }) : null,
	].filter(Boolean);

	return h(
		"article",
		{
			className: `feed-item ${model.displayKind}${isNew ? " new-item" : ""}`.trim(),
			"data-key": model.rowKey,
		},
		h(
			"div",
			{ className: "feed-kind-rail" },
			h(Chip, { variant: "kind", tone: model.displayKind }, model.displayKind.replace(/_/g, " ")),
		),
		h(
			"div",
			{ className: "feed-card-body" },
			activeModeData
				? h("button", {
						"aria-controls": detailId,
						"aria-expanded": expanded,
						className: "feed-title title",
						dangerouslySetInnerHTML: {
							__html: highlightText(model.displayTitle, state.feedQuery),
						},
						onClick: toggleDetail,
						type: "button",
					})
				: h("div", {
						className: "feed-title title",
						dangerouslySetInnerHTML: {
							__html: highlightText(model.displayTitle, state.feedQuery),
						},
					}),
			model.skimSummary
				? h("div", {
						className: "feed-summary",
						dangerouslySetInnerHTML: {
							__html: highlightText(model.skimSummary, state.feedQuery),
						},
					})
				: null,
			searchMatch && shouldShowSearchMatch(searchMatch, expanded, activeMode)
				? h(
						"div",
						{ className: "feed-search-match" },
						h("span", { className: "feed-search-match-label" }, `${searchMatch.mode} match`),
						h("span", {
							dangerouslySetInnerHTML: {
								__html: highlightText(searchMatch.excerpt, state.feedQuery),
							},
						}),
					)
				: null,
			h(
				"div",
				{ className: "feed-meta-line" },
				project ? h("span", { className: "feed-project" }, project) : h("span", null, "No project"),
				h(ProvenanceChip, { label: actor, variant: actor === "You" ? "mine" : "author" }),
				h(ProvenanceChip, {
					label: selectedVisibility,
					variant: selectedVisibility,
				}),
				memoryId > 0
					? h(
							Tooltip,
							{ label: `Memory database id ${memoryId}`, side: "top" },
							h(ProvenanceChip, { label: `#${memoryId}`, variant: "memory-id" }),
						)
					: null,
				trustLabel ? h(ProvenanceChip, { label: trustLabel, variant: "trust" }) : null,
				model.tags.map((tag, index) => h(TagChip, { key: `${String(tag)}-${index}`, tag })),
			),
			expanded && activeModeData
				? h(
						"section",
						{
							"aria-label": `${model.displayTitle} ${activeModeData.label}`,
							className: "feed-detail",
							id: detailId,
						},
						renderModeContent(activeModeData),
						filesRow,
						expandedProvenance
							? h("div", { className: "feed-expanded-provenance" }, expandedProvenance)
							: null,
					)
				: null,
		),
		h(
			"div",
			{ className: "feed-card-side" },
			h(
				"div",
				{ className: "feed-card-side-top" },
				h(
					Tooltip,
					{ label: formatDate(createdAtRaw), side: "left" },
					h("span", { className: "feed-age mono" }, relative),
				),
				ownedBySelf && memoryId > 0
					? h(FeedItemMenu, {
							assignProjectDisabled: movingProject,
							disabled: deletingMemory,
							onAssignProject: () => void moveProject(),
							onForget: () => void forgetMemory(),
							title: model.displayTitle,
						})
					: null,
			),
			h(
				"div",
				{ className: "feed-card-side-bottom" },
				h(FeedViewToggle, {
					active: activeMode,
					ariaLabel: `View for ${model.displayTitle}`,
					modes: model.modes,
					onSelect: selectMode,
				}),
				ownedBySelf && memoryId > 0
					? h(
							"label",
							{ className: "feed-visibility-label" },
							h("span", null, "Visible to"),
							h(
								"select",
								{
									"aria-label": `Who can see ${model.displayTitle}`,
									className: "feed-visibility-select",
									disabled: savingVisibility,
									onChange: (event: TargetedEvent<HTMLSelectElement>) => {
										const nextValue =
											String(event.currentTarget.value) === "shared" ? "shared" : "private";
										void saveVisibility(nextValue);
									},
									value: selectedVisibility,
								},
								h("option", { value: "private" }, "Only me"),
								h("option", { value: "shared" }, "Synced peers"),
							),
						)
					: null,
			),
		),
	);
}
