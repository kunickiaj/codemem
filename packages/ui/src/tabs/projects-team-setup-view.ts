import type { LegacyTeamSetupSummaryResponseV1 } from "../lib/api/sync";

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
	candidate: LegacyTeamSetupSummaryResponseV1["candidates"][number],
	onOpenTeamSetup: ProjectTeamSetupViewOptions["onOpenTeamSetup"],
): HTMLElement {
	const row = document.createElement("div");
	row.className = "project-inventory-actions";
	const label = document.createElement("strong");
	label.textContent = candidate.displayName;
	row.appendChild(label);
	if (!onOpenTeamSetup) return row;
	const button = document.createElement("button");
	button.setAttribute("aria-label", `Finish setting up ${candidate.displayName}`);
	button.className = "settings-button";
	button.type = "button";
	button.textContent = "Finish setting up this Team";
	button.dataset.teamSetupCandidateRef = candidate.candidateRef;
	button.addEventListener("click", () => onOpenTeamSetup(candidate.candidateRef));
	row.appendChild(button);
	return row;
}

function setupSurface(
	summary: LegacyTeamSetupSummaryResponseV1,
	options: ProjectTeamSetupViewOptions,
): HTMLElement {
	const surface = document.createElement("section");
	surface.className = "card project-team-setup-entry";
	surface.dataset.teamSetupSignature = JSON.stringify(
		summary.candidates.map((candidate) => [candidate.candidateRef, candidate.displayName]),
	);
	const heading = document.createElement("h2");
	heading.textContent = "Finish setting up this Team";
	const detail = document.createElement("p");
	detail.className = "section-meta";
	detail.textContent =
		"Tell Codemem who uses each device before using this Team for Project sharing.";
	surface.append(heading, detail);
	for (const candidate of summary.candidates) {
		surface.appendChild(candidateRow(candidate, options.onOpenTeamSetup));
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
	const signature = JSON.stringify(
		candidates.map((candidate) => [candidate.candidateRef, candidate.displayName]),
	);
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
