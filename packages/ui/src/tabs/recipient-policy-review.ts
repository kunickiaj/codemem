import { pruneStaleRecipientPolicySources, repairRecipientPolicyProjectIdentity } from "../lib/api";
import type { RecipientPolicyBlockedItemV1, RecipientPolicyReviewListV1 } from "../lib/api/sync";
import { showGlobalNotice } from "../lib/notice";
import { stableProjectPresentationLabels } from "../lib/project-identity-presentation";

const renderedReviewSignatures = new WeakMap<HTMLElement, string>();

function paragraph(text: string, className = ""): HTMLParagraphElement {
	const node = document.createElement("p");
	if (className) node.className = className;
	node.textContent = text;
	return node;
}

export interface RecipientPolicyReviewRenderOptions {
	onRepairApplied?: () => Promise<void> | void;
	onOpenProjectAdministration?: (projectIdentity: string, projectDisplayName: string) => void;
}

function renderBlockedItem(
	item: RecipientPolicyBlockedItemV1,
	options: RecipientPolicyReviewRenderOptions,
): HTMLElement {
	const card = document.createElement("article");
	card.className = "project-inventory-row recipient-policy-blocked-item";
	const heading = document.createElement("div");
	heading.className = "project-inventory-row-header";
	const finding = document.createElement("h3");
	finding.className = "project-inventory-title";
	finding.textContent = item.finding;
	const badge = document.createElement("span");
	badge.className = "project-status-badge needs_attention";
	badge.textContent = "Blocked";
	heading.append(finding, badge);
	card.append(
		heading,
		paragraph(item.reason, "project-inventory-meta"),
		paragraph(`Owner: ${item.ownerLabel}`, "settings-note"),
	);
	const repair = item.repair;
	if (repair?.kind === "map_legacy_project_identity") {
		if (repair.choices.length === 0) {
			card.append(
				paragraph(
					repair.reason === "no_eligible_projects"
						? "No canonical Projects are currently available for this source."
						: item.repairAction,
					"settings-note",
				),
			);
			return card;
		}
		const choose = document.createElement("button");
		choose.className = "settings-button";
		choose.textContent = "Choose Project";
		choose.type = "button";
		const controls = document.createElement("div");
		controls.className = "recipient-policy-repair";
		controls.hidden = true;
		const projectField = document.createElement("div");
		projectField.className = "recipient-policy-repair-field";
		const label = document.createElement("label");
		const selectId = `recipient-policy-project-${item.blockedItemId}`;
		label.htmlFor = selectId;
		label.textContent = "Canonical Project";
		const select = document.createElement("select");
		select.className = "feed-search legacy-team-project-select";
		select.id = selectId;
		const placeholder = document.createElement("option");
		placeholder.value = "";
		placeholder.textContent = "Choose a Project";
		const labels = stableProjectPresentationLabels(
			repair.choices.map((choice) => ({
				canonicalId: choice.projectRef,
				displayName: choice.displayName,
			})),
		);
		const choiceRefs = [...new Set(repair.choices.map((choice) => choice.projectRef))].sort();
		const choiceTokens = new Map(
			choiceRefs.map((projectRef, index) => [projectRef, `project-choice-${index + 1}`]),
		);
		const choices = repair.choices.map((choice) => ({
			...choice,
			label: labels.get(choice.projectRef) ?? choice.displayName,
			token: choiceTokens.get(choice.projectRef) ?? "",
		}));
		const spaces = repair.spaces ?? [];
		const requiresSpace = repair.reason === "ambiguous_scope_evidence" || spaces.length > 1;
		let selectedSpaceRef: string | undefined;
		const renderProjectOptions = () => {
			select.replaceChildren(placeholder.cloneNode(true));
			const eligible = selectedSpaceRef
				? choices.filter((choice) => choice.spaceRefs?.includes(selectedSpaceRef as string))
				: choices;
			for (const choice of eligible) {
				const option = document.createElement("option");
				option.value = choice.token;
				option.textContent = choice.label;
				select.appendChild(option);
			}
		};
		renderProjectOptions();
		projectField.append(label, select);
		let spaceSelect: HTMLSelectElement | null = null;
		let spaceField: HTMLElement | null = null;
		if (requiresSpace) {
			spaceField = document.createElement("div");
			spaceField.className = "recipient-policy-repair-field";
			const spaceLabel = document.createElement("label");
			const spaceSelectId = `recipient-policy-space-${item.blockedItemId}`;
			spaceLabel.htmlFor = spaceSelectId;
			spaceLabel.textContent = "Space";
			spaceSelect = document.createElement("select");
			spaceSelect.className =
				"feed-search legacy-team-project-select recipient-policy-space-select";
			spaceSelect.id = spaceSelectId;
			const spacePlaceholder = document.createElement("option");
			spacePlaceholder.value = "";
			spacePlaceholder.textContent = "Choose a Space";
			spaceSelect.appendChild(spacePlaceholder);
			for (const [index, space] of spaces.entries()) {
				const option = document.createElement("option");
				option.value = `space-choice-${index + 1}`;
				option.dataset.spaceRef = space.spaceRef;
				option.textContent = space.displayName;
				spaceSelect.appendChild(option);
			}
			spaceField.append(spaceLabel, spaceSelect);
			projectField.hidden = true;
		}
		const save = document.createElement("button");
		save.className = "settings-button";
		save.disabled = true;
		save.textContent = "Save mapping";
		save.type = "button";
		const status = paragraph(
			requiresSpace
				? "Choose the Space to repair, then choose a canonical Project."
				: "Choose and save one of the available canonical Projects.",
			"settings-note recipient-policy-repair-status",
		);
		status.setAttribute("role", "status");
		choose.addEventListener("click", () => {
			controls.hidden = false;
			choose.hidden = true;
			(spaceSelect ?? select).focus();
		});
		spaceSelect?.addEventListener("change", () => {
			selectedSpaceRef = spaceSelect?.selectedOptions[0]?.dataset.spaceRef;
			select.value = "";
			projectField.hidden = !selectedSpaceRef;
			renderProjectOptions();
			save.disabled = true;
			if (selectedSpaceRef) select.focus();
		});
		select.addEventListener("change", () => {
			save.disabled = !select.value || (requiresSpace && !selectedSpaceRef);
		});
		save.addEventListener("click", async () => {
			const selectedProjectRef = choices.find(
				(choice) => choice.token === select.value,
			)?.projectRef;
			if (!selectedProjectRef || save.disabled) return;
			save.disabled = true;
			select.disabled = true;
			status.textContent = "Saving Project mapping…";
			try {
				await repairRecipientPolicyProjectIdentity({
					blockedItemId: item.blockedItemId,
					sourceIdentityRef: repair.sourceIdentityRef,
					sourceFingerprint: repair.sourceFingerprint,
					projectRef: selectedProjectRef,
					...(selectedSpaceRef ? { spaceRef: selectedSpaceRef } : {}),
				});
			} catch (error) {
				status.textContent =
					error instanceof Error
						? `Project mapping was not saved: ${error.message}`
						: "Project mapping was not saved.";
				select.disabled = false;
				save.disabled = !select.value;
				return;
			}
			status.textContent = options.onRepairApplied
				? "Project mapping saved. Refreshing review…"
				: "Project mapping saved.";
			try {
				await options.onRepairApplied?.();
			} catch {
				status.textContent = "Project mapping saved, but the review could not be refreshed.";
			}
		});
		const actions = document.createElement("div");
		actions.className = "recipient-policy-repair-actions";
		actions.append(save);
		if (spaceField) controls.append(spaceField);
		controls.append(projectField, actions, status);
		card.append(choose, controls);
	} else if (repair?.kind === "review_project_scope_mappings") {
		card.append(
			paragraph(
				`Conflicting Spaces: ${repair.conflictingSpaces.map((space) => space.displayName).join(", ")}. Choose the correct mapping in Advanced Project administration.`,
				"settings-note project-attention-note",
			),
		);
		const open = document.createElement("button");
		open.className = "settings-button";
		open.type = "button";
		open.textContent = "Review Space mappings";
		open.addEventListener("click", () => {
			options.onOpenProjectAdministration?.(repair.projectIdentity, repair.projectDisplayName);
		});
		card.appendChild(open);
	} else {
		card.append(paragraph(item.repairAction, "settings-note"));
	}
	return card;
}

export function renderRecipientPolicyReview(
	mount: HTMLElement,
	review: RecipientPolicyReviewListV1,
	options: RecipientPolicyReviewRenderOptions = {},
): void {
	const signature = `review:${JSON.stringify(review)}`;
	if (renderedReviewSignatures.get(mount) === signature) return;
	if (!review.continuity && review.blockedItems.length === 0 && !review.staleNoContent?.count) {
		mount.replaceChildren();
		mount.hidden = true;
		renderedReviewSignatures.set(mount, signature);
		return;
	}

	mount.hidden = false;
	const surface = document.createElement("section");
	surface.className = "card recipient-policy-review";
	surface.setAttribute("aria-labelledby", "recipientPolicyReviewTitle");
	const title = document.createElement("h2");
	title.id = "recipientPolicyReviewTitle";
	title.textContent =
		review.blockedItems.length > 0
			? "Sharing needs repair"
			: review.continuity
				? "Existing sharing kept as-is"
				: "Sharing review";
	surface.appendChild(title);

	if (review.continuity) {
		const findingCount = review.continuity.findingCount;
		const detail = paragraph(
			`${findingCount.toLocaleString()} older sharing finding${findingCount === 1 ? " was" : "s were"} not changed because Codemem could not translate ${findingCount === 1 ? "it" : "them"} automatically.`,
			"settings-note",
		);
		detail.setAttribute("role", "status");
		detail.setAttribute("aria-live", "polite");
		if (review.blockedItems.length === 0) {
			surface.appendChild(
				paragraph(
					"No action is required for this update. Codemem did not change your existing Team or local sharing configuration.",
					"section-meta",
				),
			);
		}
		surface.appendChild(detail);
	}

	if (review.blockedItems.length > 0) {
		const intro = paragraph(
			"Codemem did not change access for these items, but their current availability cannot be confirmed until these source-state problems are repaired.",
			"section-meta project-attention-note",
		);
		const heading = document.createElement("h3");
		heading.className = "recipient-policy-blocked-heading";
		heading.textContent = "Needs repair";
		const list = document.createElement("div");
		list.className = "project-inventory-list recipient-policy-review-list";
		for (const item of review.blockedItems) list.appendChild(renderBlockedItem(item, options));
		surface.append(intro, heading, list);
	}
	if (review.staleNoContent?.count) {
		const stale = document.createElement("details");
		stale.className = "recipient-policy-stale-no-content";
		const summary = document.createElement("summary");
		const count = review.staleNoContent.count;
		summary.textContent = `${count.toLocaleString()} old Project source${count === 1 ? " has" : "s have"} no current memories`;
		const note = paragraph(
			review.staleNoContent.removableCount === 0
				? "These old sources own no memories and no stored sharing records, so they grant no access and there is nothing to remove. They are listed for visibility only."
				: "These legacy sharing records point at identities that own no memories, so they grant no access.",
			"settings-note",
		);
		const labels = document.createElement("ul");
		for (const label of review.staleNoContent.labels) {
			const item = document.createElement("li");
			item.textContent = label;
			labels.appendChild(item);
		}
		// Label from what cleanup can actually delete, not from how many findings
		// are listed. Most `unmapped:` sources own no stored sharing row, so a
		// count-labelled action would promise a removal that reports zero.
		const removable = review.staleNoContent.removableCount;
		const remove = document.createElement("button");
		remove.className = "settings-button";
		remove.type = "button";
		remove.textContent = `Remove ${removable.toLocaleString()} record${removable === 1 ? "" : "s"}`;
		const confirmation = document.createElement("div");
		confirmation.className = "recipient-policy-repair";
		confirmation.hidden = true;
		const warning = paragraph(
			"This removes only these inert legacy sharing records. It does not delete memories, sessions, or Spaces. This cannot be undone.",
			"settings-note project-attention-note",
		);
		const confirm = document.createElement("button");
		confirm.className = "settings-button";
		confirm.type = "button";
		confirm.textContent = `Remove ${removable.toLocaleString()} record${removable === 1 ? "" : "s"}`;
		const cancel = document.createElement("button");
		cancel.className = "settings-button secondary";
		cancel.type = "button";
		cancel.textContent = "Cancel";
		const status = paragraph("", "settings-note recipient-policy-prune-status");
		status.setAttribute("role", "status");
		remove.addEventListener("click", () => {
			remove.hidden = true;
			confirmation.hidden = false;
			confirm.focus();
		});
		cancel.addEventListener("click", () => {
			confirmation.hidden = true;
			remove.hidden = false;
			remove.focus();
		});
		confirm.addEventListener("click", async () => {
			confirm.disabled = true;
			cancel.disabled = true;
			status.textContent = "Removing old sharing records…";
			try {
				const result = await pruneStaleRecipientPolicySources({
					sourceFingerprint: review.staleNoContent?.sourceFingerprint ?? "",
				});
				const removed = `${result.removedCount.toLocaleString()} record${result.removedCount === 1 ? "" : "s"} removed`;
				const skipped = `${result.skippedCount.toLocaleString()} skipped`;
				const message = `${removed}; ${skipped}.`;
				status.textContent = message;
				showGlobalNotice(message, result.skippedCount > 0 ? "warning" : "success");
				await options.onRepairApplied?.();
			} catch (error) {
				status.textContent =
					error instanceof Error && error.message.startsWith("Old sharing records changed")
						? error.message
						: "Old sharing records were not removed. Refresh the review and try again.";
				confirm.disabled = false;
				cancel.disabled = false;
			}
		});
		const actions = document.createElement("div");
		actions.className = "recipient-policy-repair-actions";
		actions.append(confirm, cancel);
		confirmation.append(warning, actions, status);
		stale.append(summary, note, labels);
		// Omit the cleanup controls entirely rather than hiding them: a hidden
		// "Remove 0 records" still reaches assistive technology and text search.
		if (removable > 0) stale.append(remove, confirmation);
		surface.appendChild(stale);
	}

	mount.replaceChildren(surface);
	renderedReviewSignatures.set(mount, signature);
}

export function renderRecipientPolicyReviewLoadError(mount: HTMLElement, error: unknown): void {
	const errorMessage =
		error instanceof Error ? error.message : "Unable to load recipient migration review.";
	const signature = `error:${errorMessage}`;
	if (renderedReviewSignatures.get(mount) === signature) return;
	mount.hidden = false;
	const surface = document.createElement("section");
	surface.className = "card recipient-policy-review";
	const title = document.createElement("h2");
	title.textContent = "Recipient migration review";
	const message = paragraph(errorMessage, "settings-note project-attention-note");
	message.setAttribute("role", "status");
	surface.append(title, message);
	mount.replaceChildren(surface);
	renderedReviewSignatures.set(mount, signature);
}
