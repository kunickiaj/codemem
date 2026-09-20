import { h, type TargetedEvent } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Chip } from "../../../components/primitives/chip";
import { Tooltip } from "../../../components/primitives/tooltip";
import * as api from "../../../lib/api";
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
	highlightFeedText,
	normalizeFeedQuery,
	preferredAvailableMode,
	visibleSkimPrefixLength,
} from "../data/card-view-model";
import {
	authorLabel,
	deviceLabel,
	isOwnedBySelf,
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

function useSingleModeFocus(input: {
	modeIds: ItemViewMode[];
	focusedModeRef: { current: ItemViewMode | null };
	cardRef: { current: HTMLElement | null };
}) {
	const previousModeCount = useRef(input.modeIds.length);
	useEffect(() => {
		const toggleDisappeared = previousModeCount.current > 1 && input.modeIds.length === 1;
		previousModeCount.current = input.modeIds.length;
		if (!toggleDisappeared) return;
		const hadModeFocus = input.focusedModeRef.current !== null;
		input.focusedModeRef.current = null;
		if (hadModeFocus && document.activeElement === document.body) input.cardRef.current?.focus();
	}, [input]);
}

function usePollingModeState(input: {
	activeMode: ItemViewMode;
	cardRef: { current: HTMLElement | null };
	expanded: boolean;
	focusedModeRef: { current: ItemViewMode | null };
	hasSupplementalDetail: boolean;
	modeIds: ItemViewMode[];
	modes: FeedCardMode[];
	restoreModeFocusRef: { current: boolean };
	rowKey: string;
	setActiveMode: (mode: ItemViewMode) => void;
	setExpanded: (expanded: boolean) => void;
}) {
	useSingleModeFocus(input);
	useEffect(() => {
		if (input.modeIds.length === 0) {
			const shouldRestoreCardFocus =
				input.focusedModeRef.current === input.activeMode &&
				document.activeElement === document.body;
			input.restoreModeFocusRef.current = false;
			input.focusedModeRef.current = null;
			state.itemViewState.delete(input.rowKey);
			if (!input.hasSupplementalDetail && input.expanded) {
				state.itemExpandState.delete(input.rowKey);
				input.setExpanded(false);
			}
			if (shouldRestoreCardFocus) queueMicrotask(() => input.cardRef.current?.focus());
			return;
		}
		if (input.modeIds.includes(input.activeMode)) return;
		input.restoreModeFocusRef.current =
			input.focusedModeRef.current === input.activeMode && document.activeElement === document.body;
		input.setActiveMode(preferredAvailableMode(input.modes, "summary"));
	}, [input]);

	useEffect(() => {
		if (!input.restoreModeFocusRef.current) return;
		const activeRadio = input.cardRef.current?.querySelector<HTMLButtonElement>(
			'[role="radio"][aria-checked="true"]',
		);
		if (!activeRadio && input.modeIds.length > 1) return;
		input.restoreModeFocusRef.current = false;
		input.focusedModeRef.current = input.activeMode;
		if (activeRadio) activeRadio.focus();
		else input.cardRef.current?.focus();
	}, [input]);

	useEffect(() => {
		if (input.modeIds.includes(input.activeMode)) {
			state.itemViewState.set(input.rowKey, input.activeMode);
		} else state.itemViewState.delete(input.rowKey);
	}, [input]);
}

function renderedSearchText(node: Node): string {
	if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
	if (!(node instanceof Element)) return "";
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
		const body = cardRef.current?.querySelector(".feed-detail .feed-body");
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
	const originSource = originSourceLabel(item.origin_source || metadata.origin_source);
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

function useTitleFocusRecovery(cardRef: { current: HTMLElement | null }) {
	const titleWasFocused =
		cardRef.current?.querySelector("button.feed-title") === document.activeElement;
	useLayoutEffect(() => {
		if (
			titleWasFocused &&
			document.activeElement === document.body &&
			!cardRef.current?.querySelector("button.feed-title")
		) {
			cardRef.current?.focus();
		}
	});
}

type FeedCardDisclosureState = {
	activeMode: ItemViewMode;
	cardRef: { current: HTMLElement | null };
	expanded: boolean;
	focusedModeRef: { current: ItemViewMode | null };
	isNew: boolean;
	restoreModeFocusRef: { current: boolean };
	setActiveMode: (mode: ItemViewMode) => void;
	setExpanded: (expanded: boolean) => void;
};

function useFeedCardDisclosureState(
	model: ReturnType<typeof buildFeedCardViewModel>,
	hasSupplementalDetail: boolean,
): FeedCardDisclosureState {
	const modeIds = model.modes.map((mode) => mode.id);
	const storedMode = state.itemViewState.get(model.rowKey) as ItemViewMode | undefined;
	const initialMode = preferredAvailableMode(
		model.modes,
		storedMode || state.preferredFeedViewMode,
	);
	const [activeMode, setActiveMode] = useState<ItemViewMode>(initialMode);
	const [expanded, setExpanded] = useState(state.itemExpandState.get(model.rowKey) === true);
	const cardRef = useRef<HTMLElement | null>(null);
	useTitleFocusRecovery(cardRef);
	const focusedModeRef = useRef<ItemViewMode | null>(null);
	const restoreModeFocusRef = useRef(false);
	usePollingModeState({
		activeMode,
		cardRef,
		expanded,
		focusedModeRef,
		hasSupplementalDetail,
		modeIds,
		modes: model.modes,
		restoreModeFocusRef,
		rowKey: model.rowKey,
		setActiveMode,
		setExpanded,
	});
	return {
		activeMode,
		cardRef,
		expanded,
		focusedModeRef,
		isNew: useNewItemState(model.rowKey),
		restoreModeFocusRef,
		setActiveMode,
		setExpanded,
	};
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
	activeMode: ItemViewMode;
	activeModeData: FeedCardMode | undefined;
	cardRef: { current: HTMLElement | null };
	deletingMemory: boolean;
	details: FeedCardDetails;
	expanded: boolean;
	focusedModeRef: { current: ItemViewMode | null };
	hasDisclosure: boolean;
	isNew: boolean;
	model: ReturnType<typeof buildFeedCardViewModel>;
	movingProject: boolean;
	onForget: () => Promise<void>;
	onMoveProject: () => Promise<void>;
	onSaveVisibility: (visibility: "private" | "shared") => Promise<void>;
	onSelectMode: (mode: ItemViewMode) => void;
	onToggleDetail: () => void;
	savingVisibility: boolean;
	searchMatch: ReturnType<typeof hiddenSearchMatch>;
	renderedSearchMatch: boolean;
	selectedVisibility: VisibilitySelection;
	visibilityKnown: boolean;
};

function renderFeedCardTitle(input: FeedCardRenderInput) {
	const titleProps = {
		className: "feed-title title",
		dangerouslySetInnerHTML: {
			__html: highlightFeedText(input.model.displayTitle, state.feedQuery),
		},
	};
	if (!input.hasDisclosure) return h("div", titleProps);
	return h("button", {
		...titleProps,
		"aria-controls": input.details.detailId,
		"aria-expanded": input.expanded,
		onClick: input.onToggleDetail,
		type: "button",
	});
}

function renderFeedSearchMatch(input: FeedCardRenderInput) {
	if (!input.searchMatch || (input.searchMatch.mode !== null && input.renderedSearchMatch)) {
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
	const { details, model } = input;
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
		model.tags.map((tag, index) => h(TagChip, { key: `${String(tag)}-${index}`, tag })),
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
			? h(ProvenanceChip, { label: `From ${details.originSource}`, variant: "source" })
			: null,
		details.device ? h(ProvenanceChip, { label: details.device, variant: "device" }) : null,
	].filter(Boolean);
	if (!provenance.length) return null;
	return h("div", { className: "feed-expanded-provenance" }, provenance);
}

function renderFeedCardDetail(input: FeedCardRenderInput) {
	if (!input.expanded || !input.hasDisclosure) return null;
	const label = input.activeModeData
		? `${input.model.displayTitle} ${input.activeModeData.label}`
		: `${input.model.displayTitle} details`;
	return h(
		"section",
		{
			"aria-label": label,
			className: "feed-detail",
			id: input.details.detailId,
		},
		input.activeModeData ? renderModeContent(input.activeModeData) : null,
		renderFeedFiles(input.model.files),
		renderExpandedProvenance(input.details),
	);
}

function renderFeedCardBody(input: FeedCardRenderInput) {
	return h(
		"div",
		{ className: "feed-card-body" },
		renderFeedCardTitle(input),
		input.model.skimSummary
			? h("div", {
					className: "feed-summary",
					dangerouslySetInnerHTML: {
						__html: highlightFeedText(input.model.skimSummary, state.feedQuery),
					},
				})
			: null,
		renderFeedSearchMatch(input),
		renderFeedCardMeta(input),
		renderFeedCardDetail(input),
	);
}

function renderFeedVisibilityControl(input: FeedCardRenderInput) {
	if (!input.details.ownedBySelf || input.details.memoryId <= 0) return null;
	return h(
		"label",
		{ className: "feed-visibility-label" },
		h("span", null, "Visible to"),
		h(
			"select",
			{
				"aria-label": `Who can see ${input.model.displayTitle}`,
				className: "feed-visibility-select",
				disabled: input.savingVisibility || !input.visibilityKnown,
				onChange: (event: TargetedEvent<HTMLSelectElement>) => {
					const visibility = String(event.currentTarget.value) === "shared" ? "shared" : "private";
					void input.onSaveVisibility(visibility);
				},
				value: input.visibilityKnown ? input.selectedVisibility : "unknown",
			},
			!input.visibilityKnown ? h("option", { value: "unknown" }, "Unknown") : null,
			h("option", { value: "private" }, "Only me"),
			h("option", { value: "shared" }, "Synced peers"),
		),
	);
}

function renderFeedCardSide(input: FeedCardRenderInput) {
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
			h(
				Tooltip,
				{ label: formatDate(input.details.createdAtRaw), side: "left" },
				h("span", { className: "feed-age mono" }, input.details.relative),
			),
			menu,
		),
		h(
			"div",
			{ className: "feed-card-side-bottom" },
			h(FeedViewToggle, {
				active: input.activeMode,
				ariaLabel: `View for ${input.model.displayTitle}`,
				modes: input.model.modes,
				onModeFocus: (mode) => {
					input.focusedModeRef.current = mode;
				},
				onSelect: input.onSelectMode,
			}),
			renderFeedVisibilityControl(input),
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
	const [prefixLength, setPrefixLength] = useState(() =>
		visibleSkimPrefixLength(globalThis.innerWidth),
	);
	useEffect(() => {
		const update = () => setPrefixLength(visibleSkimPrefixLength(globalThis.innerWidth));
		window.addEventListener("resize", update);
		return () => window.removeEventListener("resize", update);
	}, []);
	return hiddenSearchMatch(model, state.feedQuery, prefixLength);
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
	const searchMatch = useFeedSearchMatch(model);
	const metadata = mergeMetadata(item.metadata_json);
	const details = buildFeedCardDetails(item, model, metadata);
	const disclosure = useFeedCardDisclosureState(model, details.hasSupplementalDetail);
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
	const activeModeData = model.modes.find((mode) => mode.id === disclosure.activeMode);
	const hasDisclosure = Boolean(activeModeData || details.hasSupplementalDetail);
	const selectMode = (mode: ItemViewMode) => {
		state.itemViewState.set(model.rowKey, mode);
		setPreferredFeedViewMode(mode);
		disclosure.setActiveMode(mode);
	};
	const toggleDetail = () => {
		if (!hasDisclosure) return;
		const nextValue = !disclosure.expanded;
		state.itemExpandState.set(model.rowKey, nextValue);
		disclosure.setExpanded(nextValue);
	};
	return renderFeedCard({
		activeMode: disclosure.activeMode,
		activeModeData,
		cardRef: disclosure.cardRef,
		deletingMemory: actions.deletingMemory,
		details,
		expanded: disclosure.expanded,
		focusedModeRef: disclosure.focusedModeRef,
		hasDisclosure,
		isNew: disclosure.isNew,
		model,
		movingProject: actions.movingProject,
		onForget: actions.forget,
		onMoveProject: actions.moveProject,
		onSaveVisibility: actions.saveVisibility,
		onSelectMode: selectMode,
		onToggleDetail: toggleDetail,
		savingVisibility: actions.savingVisibility,
		searchMatch,
		renderedSearchMatch,
		selectedVisibility: visibility.selectedVisibility,
		visibilityKnown: visibility.visibilityKnown,
	});
}
