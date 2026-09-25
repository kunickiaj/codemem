import { Fragment, h } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Chip } from "../../../components/primitives/chip";
import { RadixSelect } from "../../../components/primitives/radix-select";
import { Tooltip } from "../../../components/primitives/tooltip";
import * as api from "../../../lib/api";
import { formatDate, formatRelativeTime } from "../../../lib/format";
import { showGlobalNotice } from "../../../lib/notice";
import { state } from "../../../lib/state";
import { openSyncConfirmDialog, openSyncInputDialog } from "../../sync/sync-dialogs";
import { renderFactsContent, renderNarrativeContent } from "../data/body-renderers";
import {
	buildFeedCardViewModel,
	hiddenSearchMatch,
	highlightFeedText,
	normalizeFeedQuery,
} from "../data/card-view-model";
import {
	authorLabel,
	deviceLabel,
	isOwnedBySelf,
	mergeMetadata,
	originSourceLabel,
	trustStateLabel,
} from "../data/helpers";
import type { FeedItem } from "../types";
import { FeedItemMenu } from "./FeedItemMenu";
import { ProvenanceChip } from "./ProvenanceChip";
import { TagChip } from "./TagChip";

export interface FeedItemCardProps {
	item: FeedItem;
	onReplace: (item: FeedItem) => void;
	onRemove: (memoryId: number) => void;
	onViewRefresh: () => void;
	onReload: () => Promise<void>;
}

function renderedSearchText(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
	if (!(node instanceof Element)) return "";
	if (node.matches("details:not([open])")) return node.querySelector("summary")?.textContent ?? "";
	const text = Array.from(node.childNodes, renderedSearchText).join("");
	// Keep inline words intact, but never join text across rendered blocks or breaks.
	if (
		node.matches(
			"p, div, li, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, table, tr, th, td, hr, br",
		)
	) {
		return `\n${text}\n`;
	}
	return text;
}

function useRenderedSearchMatch(cardRef: { current: HTMLElement | null }) {
	const [visible, setVisible] = useState(false);
	useLayoutEffect(() => {
		const query = normalizeFeedQuery(state.feedQuery);
		const body = cardRef.current?.querySelector(".feed-detail");
		const text = body ? renderedSearchText(body) : "";
		setVisible(Boolean(query && text.toLowerCase().includes(query)));
	});
	return visible;
}

type VisibilitySelection = "private" | "shared" | "unknown";

function visibilitySelection(value: string): VisibilitySelection {
	if (value === "shared") return "shared";
	if (value === "private") return "private";
	return "unknown";
}

type FeedCardDetails = {
	actor: string;
	createdAtRaw: unknown;
	device: string;
	detailId: string;
	hasSupplementalDetail: boolean;
	memoryId: number;
	originSource: string;
	ownedBySelf: boolean;
	project: string;
	relative: string;
	trustLabel: string;
	visibility: string;
	workspaceKind: string;
};

function buildFeedCardDetails(
	item: FeedItem,
	model: ReturnType<typeof buildFeedCardViewModel>,
	metadata: ReturnType<typeof mergeMetadata>,
): FeedCardDetails {
	const visibility = String(item.visibility || metadata.visibility || "").trim();
	const ownedBySelf = isOwnedBySelf(item);
	const trustState = String(item.trust_state || metadata.trust_state || "").trim();
	const workspaceKind = String(item.workspace_kind || metadata.workspace_kind || "").trim();
	const sourceLabel = originSourceLabel(item.origin_source || metadata.origin_source);
	const originSource = ["Observer", "Session summary"].includes(sourceLabel) ? "" : sourceLabel;
	const device = deviceLabel(item, metadata);
	let trustLabel = "";
	if (!ownedBySelf && trustState !== "trusted") {
		trustLabel = trustState ? trustStateLabel(trustState) : "Trust unknown";
	}
	return {
		actor: authorLabel(item),
		createdAtRaw: item.created_at || item.created_at_utc,
		device,
		detailId: `feed-detail-${model.rowKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
		hasSupplementalDetail: Boolean(model.files.length || workspaceKind || originSource || device),
		memoryId: Number(item.id || item.memory_id || 0),
		originSource,
		ownedBySelf,
		project: String(item.project || "").trim(),
		relative: formatRelativeTime(item.created_at || item.created_at_utc),
		trustLabel,
		visibility,
		workspaceKind,
	};
}

function useNewItemState(rowKey: string): boolean {
	const [isNew, setIsNew] = useState(state.newItemKeys.has(rowKey));
	useEffect(() => {
		if (!isNew) return;
		const timer = window.setTimeout(() => {
			state.newItemKeys.delete(rowKey);
			setIsNew(false);
		}, 700);
		return () => window.clearTimeout(timer);
	}, [isNew, rowKey]);
	return isNew;
}

type FeedCardDisclosureState = {
	cardRef: { current: HTMLElement | null };
	expanded: boolean;
	isNew: boolean;
	setExpanded: (expanded: boolean) => void;
};

function useFeedCardDisclosureState(rowKey: string): FeedCardDisclosureState {
	const [expanded, setExpanded] = useState(state.itemExpandState.get(rowKey) !== false);
	const cardRef = useRef<HTMLElement | null>(null);
	return {
		cardRef,
		expanded,
		isNew: useNewItemState(rowKey),
		setExpanded,
	};
}

function useDisclosureFocusRecovery(
	cardRef: { current: HTMLElement | null },
	hasDisclosure: boolean,
) {
	const disclosureWasFocused =
		cardRef.current?.querySelector(".feed-disclosure") === document.activeElement;
	useLayoutEffect(() => {
		if (disclosureWasFocused && !hasDisclosure && document.activeElement === document.body) {
			cardRef.current?.focus();
		}
	}, [cardRef, disclosureWasFocused, hasDisclosure]);
}

type SaveVisibilityInput = {
	memoryId: number;
	nextVisibility: "private" | "shared";
	onReplace: (item: FeedItem) => void;
	onViewRefresh: () => void;
	previousVisibility: VisibilitySelection;
	setSavingVisibility: (saving: boolean) => void;
	setSelectedVisibility: (visibility: VisibilitySelection) => void;
};

async function saveMemoryVisibility(input: SaveVisibilityInput): Promise<void> {
	input.setSelectedVisibility(input.nextVisibility);
	input.setSavingVisibility(true);
	try {
		const payload = await api.updateMemoryVisibility(input.memoryId, input.nextVisibility);
		if (payload?.item) {
			input.onReplace(payload.item as FeedItem);
			input.onViewRefresh();
		}
		showGlobalNotice(
			input.nextVisibility === "shared" ? "Shared with synced peers" : "Only you can see this",
		);
	} catch (error) {
		input.setSelectedVisibility(input.previousVisibility);
		showGlobalNotice(
			error instanceof Error ? error.message : "Failed to save visibility.",
			"warning",
		);
	} finally {
		input.setSavingVisibility(false);
	}
}

type FeedCardActionsInput = {
	item: FeedItem;
	memoryId: number;
	model: ReturnType<typeof buildFeedCardViewModel>;
	onReload: () => Promise<void>;
	onRemove: (memoryId: number) => void;
	onReplace: (item: FeedItem) => void;
	onViewRefresh: () => void;
	selectedVisibility: VisibilitySelection;
	setSelectedVisibility: (visibility: VisibilitySelection) => void;
};

async function loadProjectSuggestions(currentProject: string): Promise<string[]> {
	try {
		const projects = await api.loadProjects();
		return projects.filter((project) => project && project !== currentProject);
	} catch {
		return [];
	}
}

function projectDialogDescription(currentProject: string, title: string): string {
	const truncatedTitle = title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
	if (currentProject) {
		return `Move "${truncatedTitle}" from "${currentProject}" to another project. Pick an existing project or type a new name. Every memory in the same session will be reassigned together.`;
	}
	return `Assign a project to "${truncatedTitle}". Pick an existing project or type a new name. Every memory in the same session will be reassigned together.`;
}

type MoveProjectInput = {
	currentProject: string;
	memoryId: number;
	onReload: () => Promise<void>;
	onViewRefresh: () => void;
	setMovingProject: (moving: boolean) => void;
	suggestions: string[];
	title: string;
};

async function moveMemoryProject(input: MoveProjectInput): Promise<void> {
	const nextProject = await openSyncInputDialog({
		title: "Assign to project",
		description: projectDialogDescription(input.currentProject, input.title),
		initialValue: input.currentProject,
		placeholder: "Pick one or type a new project name",
		suggestions: input.suggestions,
		confirmLabel: "Move",
		cancelLabel: "Cancel",
		validate: (value) => {
			const trimmed = value.trim();
			if (!trimmed) return "Enter a project name.";
			if (trimmed === input.currentProject) return "Already assigned to this project.";
			return null;
		},
	});
	if (nextProject == null) return;
	const target = nextProject.trim();
	if (!target || target === input.currentProject) return;
	input.setMovingProject(true);
	try {
		const result = await api.moveMemoryProject(input.memoryId, target);
		const count = Number(result.moved_memory_count || 1);
		showGlobalNotice(
			count > 1
				? `Moved ${count} memories from this session to "${result.project}".`
				: `Moved to "${result.project}".`,
		);
		await input.onReload();
		input.onViewRefresh();
	} catch (error) {
		showGlobalNotice(error instanceof Error ? error.message : "Failed to move memory.", "warning");
	} finally {
		input.setMovingProject(false);
	}
}

type ForgetMemoryInput = {
	memoryId: number;
	onReload: () => Promise<void>;
	onRemove: (memoryId: number) => void;
	onViewRefresh: () => void;
	setDeletingMemory: (deleting: boolean) => void;
	title: string;
};

async function forgetMemory(input: ForgetMemoryInput): Promise<void> {
	const title = input.title.length > 80 ? `${input.title.slice(0, 79).trimEnd()}…` : input.title;
	const confirmed = await openSyncConfirmDialog({
		autoFocusAction: "cancel",
		title: "Forget this memory?",
		description: `Forgetting "${title}". This removes the memory from active results. The underlying record remains soft-deleted for audit and sync safety.`,
		confirmLabel: "Forget memory",
		cancelLabel: "Keep memory",
		tone: "danger",
	});
	if (!confirmed) return;
	input.setDeletingMemory(true);
	try {
		await api.forgetMemory(input.memoryId);
		input.onRemove(input.memoryId);
		input.onViewRefresh();
		await input.onReload();
		showGlobalNotice("Memory forgotten and removed from the active feed.");
	} catch (error) {
		showGlobalNotice(
			error instanceof Error ? error.message : "Failed to forget memory.",
			"warning",
		);
	} finally {
		input.setDeletingMemory(false);
	}
}

type FeedCardActions = {
	deletingMemory: boolean;
	movingProject: boolean;
	savingVisibility: boolean;
	forget: () => Promise<void>;
	moveProject: () => Promise<void>;
	saveVisibility: (visibility: "private" | "shared") => Promise<void>;
};

function useFeedCardActions(input: FeedCardActionsInput): FeedCardActions {
	const [savingVisibility, setSavingVisibility] = useState(false);
	const [deletingMemory, setDeletingMemory] = useState(false);
	const [movingProject, setMovingProject] = useState(false);
	const currentProject = String(input.item.project || "").trim();
	const title = String(input.model.displayTitle || "this memory").trim();
	return {
		deletingMemory,
		movingProject,
		savingVisibility,
		forget: () =>
			forgetMemory({
				memoryId: input.memoryId,
				onReload: input.onReload,
				onRemove: input.onRemove,
				onViewRefresh: input.onViewRefresh,
				setDeletingMemory,
				title,
			}),
		moveProject: async () =>
			moveMemoryProject({
				currentProject,
				memoryId: input.memoryId,
				onReload: input.onReload,
				onViewRefresh: input.onViewRefresh,
				setMovingProject,
				suggestions: await loadProjectSuggestions(currentProject),
				title,
			}),
		saveVisibility: (visibility) =>
			saveMemoryVisibility({
				memoryId: input.memoryId,
				nextVisibility: visibility,
				onReplace: input.onReplace,
				onViewRefresh: input.onViewRefresh,
				previousVisibility: input.selectedVisibility,
				setSavingVisibility,
				setSelectedVisibility: input.setSelectedVisibility,
			}),
	};
}

type FeedCardRenderInput = {
	cardRef: { current: HTMLElement | null };
	deletingMemory: boolean;
	details: FeedCardDetails;
	expanded: boolean;
	hasDisclosure: boolean;
	isNew: boolean;
	model: ReturnType<typeof buildFeedCardViewModel>;
	movingProject: boolean;
	onForget: () => Promise<void>;
	onMoveProject: () => Promise<void>;
	onSaveVisibility: (visibility: "private" | "shared") => Promise<void>;
	onToggleDetail: () => void;
	savingVisibility: boolean;
	searchMatch: ReturnType<typeof hiddenSearchMatch>;
	renderedSearchMatch: boolean;
	selectedVisibility: VisibilitySelection;
	visibilityKnown: boolean;
};

function renderFeedCardTitle(input: FeedCardRenderInput) {
	return h("div", {
		className: "feed-title title",
		dangerouslySetInnerHTML: {
			__html: highlightFeedText(input.model.displayTitle, state.feedQuery),
		},
	});
}

function renderFeedSearchMatch(input: FeedCardRenderInput) {
	if (!input.searchMatch || input.renderedSearchMatch) {
		return null;
	}
	return h(
		"div",
		{ className: "feed-search-match" },
		h("span", { className: "feed-search-match-label" }, `${input.searchMatch.label} match`),
		h("span", {
			dangerouslySetInnerHTML: {
				__html: highlightFeedText(input.searchMatch.excerpt, state.feedQuery),
			},
		}),
	);
}

function renderFeedCardMeta(input: FeedCardRenderInput) {
	const { details } = input;
	const memoryId =
		details.memoryId > 0
			? h(
					Tooltip,
					{ label: `Memory database id ${details.memoryId}`, side: "top" },
					h(ProvenanceChip, { label: `#${details.memoryId}`, variant: "memory-id" }),
				)
			: null;
	return h(
		"div",
		{ className: "feed-meta-line" },
		details.project
			? h("span", { className: "feed-project" }, details.project)
			: h("span", null, "No project"),
		h(
			Tooltip,
			{ label: formatDate(details.createdAtRaw), side: "top" },
			h("span", { className: "feed-age mono" }, details.relative),
		),
		h(ProvenanceChip, {
			label: details.actor,
			variant: details.ownedBySelf ? "mine" : "author",
		}),
		h(ProvenanceChip, {
			label: input.visibilityKnown ? input.selectedVisibility : "Visibility unknown",
			variant: input.visibilityKnown ? input.selectedVisibility : "unknown",
		}),
		memoryId,
		details.trustLabel ? h(ProvenanceChip, { label: details.trustLabel, variant: "trust" }) : null,
	);
}

function renderFeedFiles(files: unknown[]) {
	if (!files.length) return null;
	return h(
		"div",
		{ className: "feed-files" },
		files.map((file, index) =>
			h("span", { className: "feed-file", key: `${String(file)}-${index}` }, String(file)),
		),
	);
}

function renderExpandedProvenance(details: FeedCardDetails) {
	const provenance = [
		details.workspaceKind
			? h(ProvenanceChip, {
					label: `Workspace ${details.workspaceKind}`,
					variant: "workspace",
				})
			: null,
		details.originSource
			? h(ProvenanceChip, { label: details.originSource, variant: "source" })
			: null,
		details.device ? h(ProvenanceChip, { label: details.device, variant: "device" }) : null,
	].filter(Boolean);
	if (!provenance.length) return null;
	return h("div", { className: "feed-expanded-provenance" }, provenance);
}

function renderFeedFacts(facts: string[], label: string, className = "feed-pack-facts") {
	if (!facts.length) return null;
	return h(
		"div",
		{ className },
		h("div", { className: "feed-pack-facts-label" }, label),
		renderFactsContent(facts),
	);
}

function renderFeedCardContent(input: FeedCardRenderInput) {
	const { body, facts, narrative } = input.model.content;
	if (!input.model.isSessionSummary && facts.length) {
		const context = narrative || body;
		return h(
			Fragment,
			null,
			renderFeedFacts(facts, "Key points", "feed-pack-facts feed-observation-points"),
			context
				? h(
						"details",
						{ className: "feed-observation-context" },
						h(
							"summary",
							{ "aria-label": `Full context for ${input.model.displayTitle}` },
							"Full context",
						),
						renderNarrativeContent(context, "feed-body narrative"),
					)
				: null,
		);
	}
	return h(
		Fragment,
		null,
		narrative ? renderNarrativeContent(narrative, "feed-body narrative") : null,
		body ? renderNarrativeContent(body, "feed-body narrative") : null,
		renderFeedFacts(facts, "Facts included in pack"),
	);
}

function renderFeedCardDetail(input: FeedCardRenderInput) {
	if (!input.expanded || !input.hasDisclosure) return null;
	return h(
		"section",
		{
			"aria-label": `${input.model.displayTitle} content`,
			className: "feed-detail",
			id: input.details.detailId,
		},
		renderFeedCardContent(input),
		renderFeedFiles(input.model.files),
		renderExpandedProvenance(input.details),
	);
}

function renderFeedCardBody(input: FeedCardRenderInput) {
	return h(
		"div",
		{ className: "feed-card-body" },
		renderFeedCardTitle(input),
		!input.expanded && input.hasDisclosure
			? h("div", { className: "feed-collapsed-note" }, "Memory content collapsed")
			: null,
		renderFeedSearchMatch(input),
		renderFeedCardMeta(input),
		renderFeedCardDetail(input),
		renderFeedCardFooter(input),
	);
}

function renderFeedVisibilityControl(input: FeedCardRenderInput) {
	if (!input.details.ownedBySelf || input.details.memoryId <= 0) return null;
	const selectId = `feed-visibility-${input.details.memoryId}`;
	const options = [
		...(input.visibilityKnown ? [] : [{ disabled: true, label: "Unknown", value: "unknown" }]),
		{ label: "Only me", value: "private" },
		{ label: "Synced peers", value: "shared" },
	];
	return h(
		"label",
		{ className: "feed-visibility-label", htmlFor: selectId },
		h("span", { className: "sr-only" }, "Visible to"),
		h(RadixSelect, {
			ariaLabel: `Who can see ${input.model.displayTitle}`,
			contentClassName: "sync-radix-select-content feed-visibility-content",
			disabled: input.savingVisibility || !input.visibilityKnown,
			id: selectId,
			itemClassName: "sync-radix-select-item",
			onValueChange: (value) => {
				const visibility = value === "shared" ? "shared" : "private";
				void input.onSaveVisibility(visibility);
			},
			options,
			triggerClassName: "sync-radix-select-trigger feed-visibility-select",
			value: input.visibilityKnown ? input.selectedVisibility : "unknown",
			viewportClassName: "sync-radix-select-viewport",
		}),
	);
}

function renderFeedCardFooter(input: FeedCardRenderInput) {
	if (!input.model.tags.length) return null;
	return h(
		"footer",
		{ className: "feed-card-footer" },
		h(
			"div",
			{ "aria-label": "Tags", className: "feed-tags" },
			input.model.tags.map((tag, index) => h(TagChip, { key: `${String(tag)}-${index}`, tag })),
		),
	);
}

function renderFeedCardSide(input: FeedCardRenderInput) {
	const visibility = renderFeedVisibilityControl(input);
	const menu =
		input.details.ownedBySelf && input.details.memoryId > 0
			? h(FeedItemMenu, {
					assignProjectDisabled: input.movingProject,
					disabled: input.deletingMemory,
					onAssignProject: () => void input.onMoveProject(),
					onForget: () => void input.onForget(),
					title: input.model.displayTitle,
				})
			: null;
	return h(
		"div",
		{ className: "feed-card-side" },
		h(
			"div",
			{ className: "feed-card-side-top" },
			visibility,
			input.hasDisclosure
				? h(
						Tooltip,
						{
							label: input.expanded ? "Collapse memory" : "Expand memory",
							side: "top",
						},
						h(
							"button",
							{
								"aria-controls": input.details.detailId,
								"aria-expanded": input.expanded,
								"aria-label": input.expanded ? "Collapse memory" : "Expand memory",
								className: "feed-disclosure",
								onClick: input.onToggleDetail,
								type: "button",
							},
							h(
								"svg",
								{
									"aria-hidden": "true",
									className: "feed-disclosure-icon",
									viewBox: "0 0 16 16",
								},
								h("path", {
									d: "m3.5 6 4.5 4 4.5-4",
									fill: "none",
									stroke: "currentColor",
									"stroke-linecap": "round",
									"stroke-linejoin": "round",
									"stroke-width": "1.7",
								}),
							),
						),
					)
				: null,
			menu,
		),
	);
}

function renderFeedCard(input: FeedCardRenderInput) {
	return h(
		"article",
		{
			className: `feed-item ${input.model.displayKind}${input.isNew ? " new-item" : ""}`.trim(),
			"data-key": input.model.rowKey,
			ref: input.cardRef,
			tabIndex: -1,
		},
		h(
			"div",
			{ className: "feed-kind-rail" },
			h(
				Chip,
				{ variant: "kind", tone: input.model.displayKind },
				input.model.displayKind.replace(/_/g, " "),
			),
		),
		renderFeedCardBody(input),
		renderFeedCardSide(input),
	);
}

function useFeedSearchMatch(model: ReturnType<typeof buildFeedCardViewModel>) {
	if (
		normalizeFeedQuery(state.feedQuery) &&
		model.displayTitle.toLowerCase().includes(normalizeFeedQuery(state.feedQuery))
	)
		return null;
	return hiddenSearchMatch(model, state.feedQuery);
}

function useFeedCardVisibilityState(visibility: string) {
	const [selectedVisibility, setSelectedVisibility] = useState<VisibilitySelection>(
		visibilitySelection(visibility),
	);
	useEffect(() => {
		setSelectedVisibility(visibilitySelection(visibility));
	}, [visibility]);
	return {
		selectedVisibility,
		setSelectedVisibility,
		visibilityKnown: visibility === "private" || visibility === "shared",
	};
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
	const details = buildFeedCardDetails(item, model, metadata);
	const disclosure = useFeedCardDisclosureState(model.rowKey);
	const searchMatch = useFeedSearchMatch(model);
	const renderedSearchMatch = useRenderedSearchMatch(disclosure.cardRef);
	const visibility = useFeedCardVisibilityState(details.visibility);
	const actions = useFeedCardActions({
		item,
		memoryId: details.memoryId,
		model,
		onReload,
		onRemove,
		onReplace,
		onViewRefresh,
		selectedVisibility: visibility.selectedVisibility,
		setSelectedVisibility: visibility.setSelectedVisibility,
	});
	const hasDisclosure = Boolean(model.content.searchText || details.hasSupplementalDetail);
	useDisclosureFocusRecovery(disclosure.cardRef, hasDisclosure);
	const toggleDetail = () => {
		if (!hasDisclosure) return;
		const nextValue = !disclosure.expanded;
		state.itemExpandState.set(model.rowKey, nextValue);
		disclosure.setExpanded(nextValue);
	};
	return renderFeedCard({
		cardRef: disclosure.cardRef,
		deletingMemory: actions.deletingMemory,
		details,
		expanded: disclosure.expanded,
		hasDisclosure,
		isNew: disclosure.isNew,
		model,
		movingProject: actions.movingProject,
		onForget: actions.forget,
		onMoveProject: actions.moveProject,
		onSaveVisibility: actions.saveVisibility,
		onToggleDetail: toggleDetail,
		savingVisibility: actions.savingVisibility,
		searchMatch,
		renderedSearchMatch,
		selectedVisibility: visibility.selectedVisibility,
		visibilityKnown: visibility.visibilityKnown,
	});
}
