import * as api from "../lib/api";
import type {
	RecipientPolicyBlockedItemV1,
	RecipientPolicyReviewDecisionV1,
	RecipientPolicyReviewItemV1,
	RecipientPolicyReviewListV1,
	RecipientPolicyReviewOptionV1,
} from "../lib/api/sync";

const renderedReviewSignatures = new WeakMap<HTMLElement, string>();
const pendingReviewGroups = new Set<string>();
const staleReviewItems = new Set<string>();
const MAX_BULK_REVIEW_ITEMS = 100;
let surfaceMessage = "";

interface ReviewGroup {
	key: string;
	displayName: string;
	items: RecipientPolicyReviewItemV1[];
}

export interface RecipientPolicyReviewRenderOptions {
	isRepairAvailable?: (repair: RecipientPolicyBlockedItemV1["repair"]) => boolean;
	onRefresh?: () => Promise<void> | void;
	onRepair?: (repair: RecipientPolicyBlockedItemV1["repair"]) => Promise<void> | void;
}

function paragraph(text: string, className = ""): HTMLParagraphElement {
	const node = document.createElement("p");
	if (className) node.className = className;
	node.textContent = text;
	return node;
}

function sectionHeading(label: string, count: number): HTMLHeadingElement {
	const heading = document.createElement("h3");
	heading.className = "recipient-policy-review-heading";
	heading.textContent = `${label} (${count.toLocaleString()})`;
	return heading;
}

function groupReviewItems(items: RecipientPolicyReviewItemV1[]): ReviewGroup[] {
	const groups = new Map<string, ReviewGroup>();
	for (const item of items) {
		const key = `${item.projectGroup.identity}\u0000${item.conditionCode}`;
		const existing = groups.get(key);
		if (existing) {
			existing.items.push(item);
			continue;
		}
		groups.set(key, { key, displayName: item.projectGroup.displayName, items: [item] });
	}
	return [...groups.values()];
}

function optionFor(
	item: RecipientPolicyReviewItemV1,
	decision: RecipientPolicyReviewDecisionV1,
): RecipientPolicyReviewOptionV1 | undefined {
	return item.options.find((option) => option.decision === decision);
}

function optionLabel(group: ReviewGroup): string {
	const first = group.items[0];
	if (!first) return "";
	return (
		optionFor(first, first.recommendedDecision)?.label ??
		first.recommendedDecision.replaceAll("_", " ")
	);
}

function renderNamedList(label: string, values: string[]): HTMLElement {
	const section = document.createElement("div");
	section.className = "recipient-policy-preview-list";
	const title = document.createElement("strong");
	title.textContent = label;
	const list = document.createElement("ul");
	for (const value of values) {
		const item = document.createElement("li");
		item.textContent = value;
		list.appendChild(item);
	}
	section.append(title, list);
	return section;
}

function uniqueValues(values: Array<{ id: string; label: string }>): string[] {
	return [...new Map(values.map((value) => [value.id, value.label])).values()];
}

function affectedMemoryCount(options: RecipientPolicyReviewOptionV1[]): number {
	const countsByProject = new Map<string, number>();
	for (const option of options) {
		for (const project of option.preview.projects) {
			const existing = countsByProject.get(project.canonicalIdentity) ?? 0;
			countsByProject.set(
				project.canonicalIdentity,
				Math.max(existing, option.preview.affectedMemoryCount),
			);
		}
	}
	return [...countsByProject.values()].reduce((total, count) => total + count, 0);
}

function renderPreview(group: ReviewGroup, decision: RecipientPolicyReviewDecisionV1): HTMLElement {
	const options = group.items.flatMap((item) => {
		const selected = optionFor(item, decision);
		return selected ? [selected] : [];
	});
	const projects = uniqueValues(
		options.flatMap((option) =>
			option.preview.projects.map((project) => ({
				id: project.canonicalIdentity,
				label: `${project.displayName} — ${project.canonicalIdentity}`,
			})),
		),
	);
	const devices = uniqueValues(
		options.flatMap((option) =>
			option.preview.effectiveDevices.map((device) => ({
				id: device.deviceId,
				label: `${device.displayName} (${device.assignment})`,
			})),
		),
	);
	const memoryCount = affectedMemoryCount(options);
	const preview = document.createElement("div");
	preview.className = "recipient-policy-preview settings-note";
	const counts = document.createElement("strong");
	counts.textContent = `Affected: ${projects.length.toLocaleString()} Project${projects.length === 1 ? "" : "s"} · ${memoryCount.toLocaleString()} memor${memoryCount === 1 ? "y" : "ies"} · ${devices.length.toLocaleString()} device${devices.length === 1 ? "" : "s"}`;
	preview.append(counts, renderNamedList("Projects and paths", projects));
	if (devices.length > 0) preview.appendChild(renderNamedList("Devices", devices));
	return preview;
}

function requiredInputGuidance(
	conditionCode: RecipientPolicyReviewItemV1["conditionCode"],
): string {
	if (conditionCode === "unassigned_effective_device") {
		return "This decision needs Identity or device details. Complete that setup first, then return to this review.";
	}
	return "This decision needs recipient details. Use the Project sharing controls below, then return to this review.";
}

async function applyGroupDecision(
	group: ReviewGroup,
	decision: RecipientPolicyReviewDecisionV1,
): Promise<{ stale: boolean; failed: boolean }> {
	const requests = group.items.map((item) => ({
		decision,
		reviewItemId: item.reviewItemId,
		sourceFingerprint: item.sourceFingerprint,
	}));
	if (requests.length === 1) {
		try {
			await api.resolveRecipientPolicyReview(requests[0]);
			return { stale: false, failed: false };
		} catch (error) {
			if (!(error instanceof api.RecipientPolicyReviewStaleError)) throw error;
			staleReviewItems.add(requests[0].reviewItemId);
			return { stale: true, failed: false };
		}
	}
	let stale = false;
	let failed = false;
	for (let offset = 0; offset < requests.length; offset += MAX_BULK_REVIEW_ITEMS) {
		const batch = requests.slice(offset, offset + MAX_BULK_REVIEW_ITEMS);
		const result = await api.resolveRecipientPolicyReviewBulk(batch);
		for (const item of result.results) {
			if (item.status === "stale") {
				staleReviewItems.add(item.reviewItemId);
				stale = true;
			} else if (item.status !== "applied") {
				failed = true;
			}
		}
	}
	return { stale, failed };
}

interface ReviewGroupControls {
	container: HTMLElement;
	deferred: HTMLElement;
	previewMount: HTMLElement;
	select: HTMLSelectElement;
	submit: HTMLButtonElement;
}

function applyButtonLabel(group: ReviewGroup): string {
	return group.items.length > 1 ? "Apply to all worktrees" : "Apply decision";
}

function updateGroupSelection(group: ReviewGroup, controls: ReviewGroupControls): void {
	const first = group.items[0];
	if (!first) return;
	const decision = controls.select.value as RecipientPolicyReviewDecisionV1;
	const selectedOptions = group.items.map((item) => optionFor(item, decision));
	const requiresInput = selectedOptions.some((option) => option?.preview.requiresDecisionInput);
	const unavailable = selectedOptions.some((option) => !option);
	controls.previewMount.replaceChildren(renderPreview(group, decision));
	controls.deferred.textContent = requiresInput ? requiredInputGuidance(first.conditionCode) : "";
	controls.deferred.hidden = !requiresInput;
	controls.submit.disabled = requiresInput || unavailable || pendingReviewGroups.has(group.key);
}

function appliedGroupMessage(
	group: ReviewGroup,
	result: { stale: boolean; failed: boolean },
): string {
	if (result.failed) {
		return "Some review items could not be updated. Review the remaining items and try again.";
	}
	if (result.stale) {
		return "Source state changed. Review the refreshed choices before trying again.";
	}
	for (const item of group.items) staleReviewItems.delete(item.reviewItemId);
	return "Decision applied. Review items refreshed.";
}

function restoreGroupControls(group: ReviewGroup, controls: ReviewGroupControls): void {
	controls.select.disabled = false;
	controls.submit.textContent = applyButtonLabel(group);
	updateGroupSelection(group, controls);
}

async function submitGroupDecision(
	group: ReviewGroup,
	controls: ReviewGroupControls,
	status: HTMLElement,
	options: RecipientPolicyReviewRenderOptions,
): Promise<void> {
	if (controls.submit.disabled || pendingReviewGroups.has(group.key)) return;
	const decision = controls.select.value as RecipientPolicyReviewDecisionV1;
	pendingReviewGroups.add(group.key);
	controls.select.disabled = true;
	controls.submit.disabled = true;
	controls.submit.textContent = "Applying…";
	status.textContent = "Applying review decision…";
	try {
		const result = await applyGroupDecision(group, decision);
		surfaceMessage = appliedGroupMessage(group, result);
		status.textContent = surfaceMessage;
		pendingReviewGroups.delete(group.key);
		if (result.failed || result.stale) restoreGroupControls(group, controls);
		await options.onRefresh?.();
	} catch (error) {
		surfaceMessage = error instanceof Error ? error.message : "Unable to apply decision.";
		status.textContent = surfaceMessage;
		pendingReviewGroups.delete(group.key);
		restoreGroupControls(group, controls);
		try {
			await options.onRefresh?.();
		} catch (refreshError) {
			const refreshMessage =
				refreshError instanceof Error ? refreshError.message : "Unable to refresh review items.";
			surfaceMessage = `${surfaceMessage} Refresh failed: ${refreshMessage}`;
			status.textContent = surfaceMessage;
		}
	}
}

function createGroupControls(
	group: ReviewGroup,
	index: number,
	status: HTMLElement,
	options: RecipientPolicyReviewRenderOptions,
): ReviewGroupControls {
	const first = group.items[0];
	if (!first) throw new Error("Review group must contain at least one item.");
	const container = document.createElement("div");
	container.className = "project-inventory-actions";
	const label = document.createElement("label");
	label.htmlFor = `recipient-policy-decision-${index}`;
	label.textContent = "Decision";
	const select = document.createElement("select");
	select.id = label.htmlFor;
	select.className = "project-filter recipient-policy-review-select";
	select.dataset.reviewControl = "decision";
	for (const reviewOption of first.options) {
		const option = document.createElement("option");
		option.value = reviewOption.decision;
		option.textContent = reviewOption.label;
		select.appendChild(option);
	}
	select.value = first.recommendedDecision;
	const submit = document.createElement("button");
	submit.className = "settings-button";
	submit.type = "button";
	submit.textContent = applyButtonLabel(group);
	submit.dataset.reviewControl = "apply";
	const deferred = paragraph("", "settings-note recipient-policy-deferred");
	const previewMount = document.createElement("div");
	previewMount.className = "recipient-policy-preview-mount";
	previewMount.setAttribute("aria-live", "polite");
	const controls = { container, deferred, previewMount, select, submit };
	select.addEventListener("change", () => updateGroupSelection(group, controls));
	submit.addEventListener("click", () => submitGroupDecision(group, controls, status, options));
	updateGroupSelection(group, controls);
	container.append(label, select, submit);
	return controls;
}

function renderActionableGroup(
	group: ReviewGroup,
	index: number,
	status: HTMLElement,
	options: RecipientPolicyReviewRenderOptions,
): HTMLElement {
	const first = group.items[0];
	if (!first) throw new Error("Review group must contain at least one item.");
	const card = document.createElement("article");
	card.className = "project-inventory-row recipient-policy-review-item";
	card.dataset.reviewGroup = group.key;
	const finding = document.createElement("h4");
	finding.className = "project-inventory-title";
	finding.textContent = `${group.displayName}: ${first.finding}`;
	const reason = paragraph(first.reason, "project-inventory-meta");
	const recommended = paragraph(`Recommended: ${optionLabel(group)}`, "settings-note");
	card.append(finding, reason, recommended);

	if (group.items.some((item) => staleReviewItems.has(item.reviewItemId))) {
		card.appendChild(
			paragraph(
				"Source state changed while this decision was being reviewed. Review the refreshed choices before trying again.",
				"settings-note project-attention-note",
			),
		);
	}

	const controls = createGroupControls(group, index, status, options);
	card.append(controls.container, controls.deferred, controls.previewMount);
	return card;
}

function renderReviewDecisionSection(
	review: RecipientPolicyReviewListV1,
	status: HTMLElement,
	options: RecipientPolicyReviewRenderOptions,
): HTMLElement {
	const groups = groupReviewItems(review.reviewItems);
	const section = document.createElement("section");
	section.className = "recipient-policy-review-section recipient-policy-review-decisions";
	section.append(
		sectionHeading("Review findings", groups.length),
		paragraph(
			"Review each repository before Codemem records how its older sharing state should be represented. Access stays unchanged until you apply a decision.",
			"section-meta",
		),
	);
	const list = document.createElement("div");
	list.className = "project-inventory-list recipient-policy-review-list";
	groups.forEach((group, index) => {
		list.appendChild(renderActionableGroup(group, index, status, options));
	});
	section.appendChild(list);
	return section;
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
	const repairHelp = paragraph(item.repairAction, "settings-note");
	repairHelp.id = `recipient-policy-repair-help-${item.blockedItemId}`;
	card.append(
		heading,
		paragraph(item.reason, "project-inventory-meta"),
		repairHelp,
		paragraph(`Owner: ${item.ownerLabel}`, "settings-note"),
	);
	if (options.onRepair && (options.isRepairAvailable?.(item.repair) ?? true)) {
		const repair = document.createElement("button");
		repair.className = "settings-button";
		repair.type = "button";
		repair.textContent = item.repair.label;
		repair.setAttribute("aria-describedby", repairHelp.id);
		repair.addEventListener("click", async () => {
			repair.disabled = true;
			try {
				await options.onRepair?.(item.repair);
			} finally {
				repair.disabled = false;
			}
		});
		card.appendChild(repair);
	} else {
		card.appendChild(paragraph("Open Projects to repair this item.", "settings-note"));
	}
	return card;
}

function renderBlockedSection(
	review: RecipientPolicyReviewListV1,
	options: RecipientPolicyReviewRenderOptions,
): HTMLElement {
	const section = document.createElement("section");
	section.className = "recipient-policy-review-section recipient-policy-review-blocked";
	section.append(
		sectionHeading("Blocked source repairs", review.blockedItems.length),
		paragraph(
			"Access has not changed. Repair each source record before Codemem can safely interpret it.",
			"section-meta project-attention-note",
		),
	);
	const list = document.createElement("div");
	list.className = "project-inventory-list recipient-policy-review-list";
	for (const item of review.blockedItems) list.appendChild(renderBlockedItem(item, options));
	section.appendChild(list);
	return section;
}

function focusedReviewControl(mount: HTMLElement): { group: string; control: string } | null {
	const active = document.activeElement;
	if (!(active instanceof HTMLElement) || !mount.contains(active)) return null;
	const group = active.closest<HTMLElement>("[data-review-group]")?.dataset.reviewGroup;
	const control = active.dataset.reviewControl;
	return group && control ? { group, control } : null;
}

function restoreReviewFocus(
	mount: HTMLElement,
	focus: { group: string; control: string } | null,
): void {
	if (!focus) return;
	for (const card of mount.querySelectorAll<HTMLElement>("[data-review-group]")) {
		if (card.dataset.reviewGroup !== focus.group) continue;
		card.querySelector<HTMLElement>(`[data-review-control="${focus.control}"]`)?.focus();
		return;
	}
}

export function renderRecipientPolicyReview(
	mount: HTMLElement,
	review: RecipientPolicyReviewListV1,
	options: RecipientPolicyReviewRenderOptions = {},
): void {
	const repairAvailability = review.blockedItems.map((item) =>
		options.onRepair && (options.isRepairAvailable?.(item.repair) ?? true) ? "1" : "0",
	);
	const renderedReview = { blockedItems: review.blockedItems, reviewItems: review.reviewItems };
	const signature = `review:${repairAvailability.join("")}:${JSON.stringify(renderedReview)}`;
	if (renderedReviewSignatures.get(mount) === signature) return;
	if (review.reviewItems.length === 0 && review.blockedItems.length === 0) {
		mount.replaceChildren();
		mount.hidden = true;
		renderedReviewSignatures.set(mount, signature);
		return;
	}

	const focusedControl = focusedReviewControl(mount);
	mount.hidden = false;
	const surface = document.createElement("section");
	surface.className = "card recipient-policy-review";
	surface.setAttribute("aria-labelledby", "recipientPolicyReviewTitle");
	const title = document.createElement("h2");
	title.id = "recipientPolicyReviewTitle";
	title.textContent = "Sharing review";
	const status = document.createElement("div");
	status.className = "section-meta recipient-policy-review-status";
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	status.textContent = surfaceMessage;
	surface.append(title, status);
	if (review.reviewItems.length > 0) {
		surface.appendChild(renderReviewDecisionSection(review, status, options));
	}
	if (review.blockedItems.length > 0) surface.appendChild(renderBlockedSection(review, options));
	mount.replaceChildren(surface);
	restoreReviewFocus(mount, focusedControl);
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
	title.textContent = "Sharing review";
	const message = paragraph(errorMessage, "settings-note project-attention-note");
	message.setAttribute("role", "status");
	surface.append(title, message);
	mount.replaceChildren(surface);
	renderedReviewSignatures.set(mount, signature);
}
