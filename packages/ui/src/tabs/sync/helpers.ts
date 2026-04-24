/* Shared helpers for the Sync tab sub-modules. */

import type { RadixSelectOption } from "../../components/primitives/radix-select";
import { copyToClipboard, el } from "../../lib/dom";
import { type SyncActor, state } from "../../lib/state";
import { deriveVisiblePeopleActors } from "./view-model";

/* ── Skeleton helpers ────────────────────────────────────── */

export function hideSkeleton(id: string): void {
	const skeleton = document.getElementById(id);
	if (skeleton) skeleton.remove();
}

/* ── Module-level UI state ───────────────────────────────── */

export let adminSetupExpanded = false;
export function setAdminSetupExpanded(v: boolean) {
	adminSetupExpanded = v;
}

export let teamInvitePanelOpen = false;
export function setTeamInvitePanelOpen(v: boolean) {
	teamInvitePanelOpen = v;
}

export let teamJoinPanelOpen = false;
export function setTeamJoinPanelOpen(v: boolean) {
	teamJoinPanelOpen = v;
}

export const openPeerScopeEditors = new Set<string>();
const pendingPeerScopeReviewIds = new Set<string>();
const freshPeerScopeReviewIds = new Set<string>();
const DUPLICATE_PERSON_DECISIONS_KEY = "codemem-sync-duplicate-person-decisions";

export type DuplicatePersonDecision = "different-people";

export function requestPeerScopeReview(peerDeviceId: string) {
	const value = String(peerDeviceId || "").trim();
	if (!value) return;
	pendingPeerScopeReviewIds.add(value);
	freshPeerScopeReviewIds.add(value);
	openPeerScopeEditors.add(value);
}

export function isPeerScopeReviewPending(peerDeviceId: string): boolean {
	const value = String(peerDeviceId || "").trim();
	return Boolean(value) && pendingPeerScopeReviewIds.has(value);
}

export function clearPeerScopeReview(peerDeviceId: string) {
	const value = String(peerDeviceId || "").trim();
	if (!value) return;
	pendingPeerScopeReviewIds.delete(value);
}

export function consumePeerScopeReviewRequest(peerDeviceId: string): boolean {
	const value = String(peerDeviceId || "").trim();
	if (!value || !freshPeerScopeReviewIds.has(value)) return false;
	freshPeerScopeReviewIds.delete(value);
	return true;
}

function readDuplicatePersonDecisionStore(): Record<string, DuplicatePersonDecision> {
	try {
		const raw = localStorage.getItem(DUPLICATE_PERSON_DECISIONS_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function writeDuplicatePersonDecisionStore(value: Record<string, DuplicatePersonDecision>) {
	try {
		localStorage.setItem(DUPLICATE_PERSON_DECISIONS_KEY, JSON.stringify(value));
	} catch {}
}

export function duplicatePersonDecisionKey(actorIds: string[]): string {
	return [...actorIds]
		.map((value) => String(value || "").trim())
		.filter(Boolean)
		.sort()
		.join("::");
}

export function readDuplicatePersonDecisions(): Record<string, DuplicatePersonDecision> {
	return readDuplicatePersonDecisionStore();
}

export function saveDuplicatePersonDecision(actorIds: string[], decision: DuplicatePersonDecision) {
	const key = duplicatePersonDecisionKey(actorIds);
	if (!key) return;
	const next = readDuplicatePersonDecisionStore();
	next[key] = decision;
	writeDuplicatePersonDecisionStore(next);
}

export function clearDuplicatePersonDecision(actorIds: string[]) {
	const key = duplicatePersonDecisionKey(actorIds);
	if (!key) return;
	const next = readDuplicatePersonDecisionStore();
	delete next[key];
	writeDuplicatePersonDecisionStore(next);
}

/* ── Text helpers ────────────────────────────────────────── */

/** Redact the last two octets of IPv4 addresses. */
export function redactIpOctets(text: string): string {
	return text.replace(/\b(\d{1,3}\.\d{1,3})\.\d{1,3}\.\d{1,3}\b/g, "$1.#.#");
}

export function redactAddress(address: unknown): string {
	const raw = String(address || "");
	if (!raw) return "";
	return redactIpOctets(raw);
}

export function pickPrimaryAddress(addresses: unknown): string {
	if (!Array.isArray(addresses)) return "";
	const unique = Array.from(new Set(addresses.filter(Boolean)));
	return typeof unique[0] === "string" ? unique[0] : "";
}

export function parseScopeList(value: string): string[] {
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

/* ── Actor helpers ───────────────────────────────────────── */

export function actorLabel(actor: SyncActor | null | undefined): string {
	if (!actor || typeof actor !== "object") return "Unknown person";
	const displayName = String(actor.display_name || "").trim();
	if (!displayName) return String(actor.actor_id || "Unknown person");
	return displayName;
}

export function actorDisplayLabel(actor: SyncActor | null | undefined): string {
	if (!actor || typeof actor !== "object") return "Unknown person";
	return actor.is_local ? "You" : actorLabel(actor);
}

export function assignedActorCount(actorId: string): number {
	const peers = Array.isArray(state.lastSyncPeers) ? state.lastSyncPeers : [];
	return peers.filter((peer) => String(peer?.actor_id || "") === actorId).length;
}

export function assignmentNote(actorId: string): string {
	if (!actorId)
		return "Unassigned devices keep legacy fallback attribution until you choose a person.";
	const actors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
	const actor = actors.find((item) => String(item?.actor_id || "") === actorId);
	if (actor?.is_local) {
		return "Assigning this device to you keeps it in your identity across your devices, including private sync.";
	}
	return "This person receives memories from allowed projects by default. Use Only me on a memory when it should stay local.";
}

export function visibleSyncActors() {
	return deriveVisiblePeopleActors({
		actors: state.lastSyncActors,
		peers: state.lastSyncPeers,
		duplicatePeople: state.lastSyncViewModel?.duplicatePeople,
	}).visibleActors;
}

export function buildActorSelectOptions(selectedActorId = ""): RadixSelectOption[] {
	const options: RadixSelectOption[] = [{ value: "", label: "No person assigned" }];
	const visibleActors = visibleSyncActors();
	const allActors = Array.isArray(state.lastSyncActors) ? state.lastSyncActors : [];
	const selectedActor = allActors.find(
		(actor) => String(actor?.actor_id || "") === selectedActorId,
	);
	const actors =
		selectedActor &&
		!visibleActors.some((actor) => String(actor?.actor_id || "") === selectedActorId)
			? [...visibleActors, selectedActor]
			: visibleActors;

	actors.forEach((actor) => {
		const actorId = String(actor?.actor_id || "").trim();
		if (!actorId) return;
		options.push({ value: actorId, label: actorDisplayLabel(actor) });
	});

	return options.filter(
		(option, index, all) =>
			index === all.findIndex((candidate) => candidate.value === option.value),
	);
}

export function buildActorOptions(selectedActorId: string): HTMLOptionElement[] {
	const options: HTMLOptionElement[] = [];
	const unassigned = document.createElement("option");
	unassigned.value = "";
	unassigned.textContent = "No person assigned";
	options.push(unassigned);

	buildActorSelectOptions(selectedActorId)
		.filter((option) => option.value)
		.forEach((selectOption) => {
			const option = document.createElement("option");
			option.value = selectOption.value;
			option.textContent = selectOption.label;
			option.selected = option.value === selectedActorId;
			options.push(option);
		});
	if (!selectedActorId) options[0].selected = true;
	return options;
}

export function mergeTargetActors(actorId: string): SyncActor[] {
	const actors = visibleSyncActors();
	return actors.filter((actor) => String(actor?.actor_id || "") !== actorId);
}

export function actorMergeNote(targetActorId: string, secondaryActorId: string): string {
	const target = mergeTargetActors(secondaryActorId).find(
		(actor) => String(actor?.actor_id || "") === targetActorId,
	);
	if (!targetActorId || !target) {
		return "Choose which person should keep these devices.";
	}
	return `Merge into ${actorDisplayLabel(target)}. Assigned devices move now; existing memories keep their current provenance.`;
}

/* ── Chip editor component ───────────────────────────────── */

export function createChipEditor(
	initialValues: string[],
	placeholder: string,
	emptyLabel: string,
	availableProjects: string[] = [],
) {
	let values = [...initialValues];
	let query = "";
	let activeIndex = 0;
	let popoverOpen = false;

	const container = el("div", "project-scope-picker");
	const selectedList = el("ul", "project-scope-picker-selected");
	const trigger = el("button", "project-scope-picker-trigger settings-button") as HTMLButtonElement;
	trigger.type = "button";
	const triggerLabel = el("span", null, placeholder || "Add project");
	const triggerPlus = el("span", null, "+");
	triggerPlus.setAttribute("aria-hidden", "true");
	trigger.append(triggerPlus, triggerLabel);
	trigger.setAttribute("aria-haspopup", "listbox");
	trigger.setAttribute("aria-expanded", "false");

	const popover = el("div", "project-scope-picker-popover project-scope-picker-popover--inline");
	popover.hidden = true;
	const search = el("input", "project-scope-picker-search") as HTMLInputElement;
	search.type = "text";
	search.placeholder = "Search or create…";
	search.setAttribute("aria-label", "Search projects");
	const results = el("div", "project-scope-picker-results");
	results.setAttribute("role", "listbox");
	popover.append(search, results);

	const knownPool = () => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const item of [...availableProjects, ...values]) {
			const trimmed = item.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			out.push(trimmed);
		}
		return out.sort((a, b) => a.localeCompare(b));
	};

	const filteredRows = () => {
		const all = knownPool();
		const q = query.trim().toLowerCase();
		if (!q) return all;
		return all.filter((project) => project.toLowerCase().includes(q));
	};

	const shouldShowCreateRow = () => {
		const q = query.trim();
		if (!q) return false;
		return !knownPool().some((project) => project.toLowerCase() === q.toLowerCase());
	};

	const toggleValue = (project: string) => {
		if (values.includes(project)) {
			values = values.filter((value) => value !== project);
		} else {
			values = Array.from(new Set([...values, project]));
		}
		renderSelected();
		renderResults();
	};

	const createFromQuery = () => {
		const trimmed = query.trim();
		if (!trimmed) return;
		values = Array.from(new Set([...values, trimmed]));
		query = "";
		search.value = "";
		activeIndex = 0;
		renderSelected();
		renderResults();
	};

	const activateRow = (index: number) => {
		const rows = filteredRows();
		if (index < rows.length) {
			const project = rows[index];
			if (project) toggleValue(project);
			return;
		}
		if (shouldShowCreateRow()) createFromQuery();
	};

	const renderSelected = () => {
		selectedList.textContent = "";
		if (!values.length) {
			const note = el("li", "project-scope-picker-selected-empty", emptyLabel);
			selectedList.appendChild(note);
			return;
		}
		values.forEach((value) => {
			const chip = el("li", "project-scope-picker-selected-chip");
			const label = el("span", null, value);
			const remove = el("button", "project-scope-picker-selected-remove", "×") as HTMLButtonElement;
			remove.type = "button";
			remove.setAttribute("aria-label", `Remove ${value}`);
			remove.addEventListener("click", () => {
				values = values.filter((existing) => existing !== value);
				renderSelected();
				renderResults();
			});
			chip.append(label, remove);
			selectedList.appendChild(chip);
		});
	};

	const renderResults = () => {
		results.textContent = "";
		const rows = filteredRows();
		const withCreate = shouldShowCreateRow();
		const rowCount = rows.length + (withCreate ? 1 : 0);
		if (activeIndex >= rowCount) activeIndex = Math.max(0, rowCount - 1);
		if (!rows.length && !withCreate) {
			const empty = el(
				"div",
				"project-scope-picker-empty-row",
				"No projects yet. Type a name to create one.",
			);
			results.appendChild(empty);
			return;
		}
		rows.forEach((project, index) => {
			const selected = values.includes(project);
			const active = index === activeIndex;
			const row = el(
				"button",
				active
					? "project-scope-picker-row project-scope-picker-row--active"
					: "project-scope-picker-row",
			) as HTMLButtonElement;
			row.type = "button";
			row.setAttribute("role", "option");
			row.setAttribute("aria-selected", selected ? "true" : "false");
			const check = el("span", "project-scope-picker-row-check", selected ? "✓" : "");
			check.setAttribute("aria-hidden", "true");
			const labelEl = el("span", "project-scope-picker-row-label", project);
			row.append(check, labelEl);
			row.addEventListener("click", () => {
				activeIndex = index;
				toggleValue(project);
			});
			row.addEventListener("mouseenter", () => {
				activeIndex = index;
				renderResults();
			});
			results.appendChild(row);
		});
		if (withCreate) {
			const index = rows.length;
			const active = index === activeIndex;
			const row = el(
				"button",
				active
					? "project-scope-picker-row project-scope-picker-row--create project-scope-picker-row--active"
					: "project-scope-picker-row project-scope-picker-row--create",
			) as HTMLButtonElement;
			row.type = "button";
			row.setAttribute("role", "option");
			const check = el("span", "project-scope-picker-row-check", "+");
			check.setAttribute("aria-hidden", "true");
			const labelEl = el("span", "project-scope-picker-row-label", `Create "${query.trim()}"`);
			row.append(check, labelEl);
			row.addEventListener("click", () => createFromQuery());
			row.addEventListener("mouseenter", () => {
				activeIndex = index;
				renderResults();
			});
			results.appendChild(row);
		}
	};

	const setOpen = (next: boolean) => {
		popoverOpen = next;
		popover.hidden = !next;
		trigger.setAttribute("aria-expanded", next ? "true" : "false");
		if (next) {
			query = "";
			search.value = "";
			activeIndex = 0;
			renderResults();
			// Defer focus so the element is laid out before we focus it.
			requestAnimationFrame(() => search.focus());
		}
	};

	trigger.addEventListener("click", (event) => {
		event.stopPropagation();
		setOpen(!popoverOpen);
	});

	search.addEventListener("input", () => {
		query = search.value;
		activeIndex = 0;
		renderResults();
	});
	search.addEventListener("keydown", (event) => {
		const rowCount = filteredRows().length + (shouldShowCreateRow() ? 1 : 0);
		if (event.key === "ArrowDown") {
			event.preventDefault();
			activeIndex = Math.min(rowCount - 1, activeIndex + 1);
			renderResults();
			return;
		}
		if (event.key === "ArrowUp") {
			event.preventDefault();
			activeIndex = Math.max(0, activeIndex - 1);
			renderResults();
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			activateRow(activeIndex);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
		}
	});

	const onDocumentClick = (event: MouseEvent) => {
		if (!popoverOpen) return;
		const target = event.target as Node | null;
		if (!target) return;
		if (container.contains(target)) return;
		setOpen(false);
	};
	document.addEventListener("click", onDocumentClick);

	container.append(selectedList, trigger, popover);
	renderSelected();
	renderResults();

	return {
		element: container,
		values: () => [...values],
	};
}

/* ── Action list renderer ────────────────────────────────── */

export function renderActionList(
	container: HTMLElement | null,
	actions: Array<{ label: string; command: string }>,
) {
	if (!container) return;
	container.textContent = "";
	if (!actions.length) {
		container.hidden = true;
		return;
	}
	container.hidden = false;
	actions.slice(0, 2).forEach((item) => {
		const row = el("div", "sync-action");
		const textWrap = el("div", "sync-action-text");
		textWrap.textContent = item.label;
		textWrap.appendChild(el("span", "sync-action-command", item.command));
		const btn = el("button", "settings-button sync-action-copy", "Copy") as HTMLButtonElement;
		btn.addEventListener("click", () => copyToClipboard(item.command, btn));
		row.append(textWrap, btn);
		container.appendChild(row);
	});
}
