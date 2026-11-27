import type { LegacyTeamSetupSummaryResponseV1 } from "../lib/api/sync";
import { teamSetupRecoveryReason } from "./team-setup-recovery";

type SetupCandidate = LegacyTeamSetupSummaryResponseV1["candidates"][number];
type Reconciliation = LegacyTeamSetupSummaryResponseV1["reconciliation"];

const NOT_CHECKED = "Not checked with the coordinator yet";

/** "Last checked with the coordinator 12 min ago", for a result that is out of date. */
function staleNote(reconciliation: Reconciliation): string | null {
	if (reconciliation?.state !== "stale") return null;
	const minutes = Math.max(1, Math.round((reconciliation.age_ms ?? 0) / 60_000));
	const checking = reconciliation.refreshing ? "; checking again" : "";
	return `Last checked with the coordinator ${minutes} min ago${checking}`;
}

export interface ProjectTeamSetupViewOptions {
	onOpenTeamSetup?: (candidateRef: string) => void;
	onFocusFallback(): void;
}

function focusedCandidateRef(existingEntry: HTMLElement | null): string | undefined {
	if (!existingEntry?.contains(document.activeElement)) return undefined;
	if (!(document.activeElement instanceof HTMLButtonElement)) return undefined;
	return document.activeElement.dataset.teamSetupCandidateRef;
}

function restoreCandidateFocus(
	surface: HTMLElement,
	candidateRef: string | undefined,
	onFocusFallback: () => void,
): void {
	if (!candidateRef) return;
	for (const button of surface.querySelectorAll<HTMLButtonElement>("button")) {
		if (button.dataset.teamSetupCandidateRef !== candidateRef) continue;
		button.focus();
		return;
	}
	onFocusFallback();
}

function candidateRow(
	candidate: SetupCandidate,
	onOpenTeamSetup: ProjectTeamSetupViewOptions["onOpenTeamSetup"],
	reconciliation: Reconciliation,
): HTMLElement {
	const row = document.createElement("div");
	row.className = "project-inventory-actions";
	const label = document.createElement("strong");
	label.textContent = candidate.displayName;
	row.appendChild(label);
	if (!onOpenTeamSetup) return row;
	const button = document.createElement("button");
	const needsRecovery = Boolean(candidate.blockingError);
	button.setAttribute(
		"aria-label",
		needsRecovery
			? `View recovery details for ${candidate.displayName}`
			: `Finish setting up ${candidate.displayName}`,
	);
	button.className = "settings-button";
	button.type = "button";
	button.textContent = needsRecovery ? "View recovery details" : "Finish setting up this Team";
	button.dataset.teamSetupCandidateRef = candidate.candidateRef;
	button.addEventListener("click", () => onOpenTeamSetup(candidate.candidateRef));
	row.appendChild(button);
	// Finish still checks with the coordinator itself, so it stays available.
	if (reconciliation?.state === "never") {
		const note = document.createElement("span");
		note.className = "section-meta project-team-setup-unchecked";
		note.textContent = NOT_CHECKED;
		row.appendChild(note);
	}
	return row;
}

function recoveryReason(candidate: SetupCandidate): HTMLElement | null {
	if (!candidate.blockingError) return null;
	const reason = document.createElement("p");
	reason.className = "section-meta project-team-setup-recovery-reason";
	reason.textContent = teamSetupRecoveryReason(candidate);
	return reason;
}

function setupSignature(summary: LegacyTeamSetupSummaryResponseV1): string {
	return JSON.stringify([
		summary.reconciliation?.state ?? null,
		staleNote(summary.reconciliation),
		summary.candidates.map((candidate) => [
			candidate.candidateRef,
			candidate.displayName,
			candidate.blockingError ?? null,
		]),
	]);
}

function setupSurface(
	summary: LegacyTeamSetupSummaryResponseV1,
	options: ProjectTeamSetupViewOptions,
): HTMLElement {
	const surface = document.createElement("section");
	surface.className = "card project-team-setup-entry";
	surface.dataset.teamSetupSignature = setupSignature(summary);
	const needsRecovery = summary.candidates.every((candidate) => candidate.blockingError);
	const heading = document.createElement("h2");
	heading.textContent = needsRecovery ? "Team needs recovery" : "Finish setting up this Team";
	surface.appendChild(heading);
	const stale = staleNote(summary.reconciliation);
	if (stale) {
		const note = document.createElement("p");
		note.className = "section-meta project-team-setup-checked";
		note.textContent = stale;
		surface.appendChild(note);
	}
	if (!needsRecovery) {
		const detail = document.createElement("p");
		detail.className = "section-meta";
		detail.textContent =
			"Tell Codemem who uses each device before using this Team for Project sharing.";
		surface.appendChild(detail);
	}
	for (const candidate of summary.candidates) {
		surface.appendChild(candidateRow(candidate, options.onOpenTeamSetup, summary.reconciliation));
		const reason = recoveryReason(candidate);
		if (reason) surface.appendChild(reason);
	}
	return surface;
}

export function renderProjectTeamSetupEntry(
	mount: HTMLElement,
	summary: LegacyTeamSetupSummaryResponseV1 | undefined,
	options: ProjectTeamSetupViewOptions,
): void {
	const candidates = summary?.candidates ?? [];
	const existing = mount.querySelector<HTMLElement>(":scope > .project-team-setup-entry");
	existing?.querySelector(".project-team-setup-status")?.remove();
	const candidateRef = focusedCandidateRef(existing);
	if (candidates.length === 0) {
		existing?.remove();
		const review = mount.querySelector<HTMLElement>(
			":scope > .project-recipient-policy-review-content",
		);
		mount.hidden = review?.hidden !== false;
		if (candidateRef) options.onFocusFallback();
		return;
	}
	if (!summary) return;
	const signature = setupSignature(summary);
	if (existing?.dataset.teamSetupSignature === signature) {
		mount.hidden = false;
		return;
	}
	existing?.remove();
	mount.hidden = false;
	const surface = setupSurface(summary, options);
	mount.appendChild(surface);
	restoreCandidateFocus(surface, candidateRef, options.onFocusFallback);
}

export function markProjectTeamSetupEntryUnavailable(mount: HTMLElement): void {
	const entry = mount.querySelector<HTMLElement>(":scope > .project-team-setup-entry");
	if (!entry) return;
	let status = entry.querySelector<HTMLElement>(".project-team-setup-status");
	if (!status) {
		status = document.createElement("p");
		status.className = "section-meta project-team-setup-status";
		status.setAttribute("role", "status");
		entry.appendChild(status);
	}
	status.textContent =
		"Team setup status is temporarily unavailable. The previous Team setup status is being shown.";
	mount.hidden = false;
}
