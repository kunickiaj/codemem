import * as api from "../lib/api";
import type {
	RecipientPolicyBlockedItemV1,
	RecipientPolicyReviewItemV1,
	RecipientPolicyReviewListV1,
	RecipientPolicyReviewOptionV1,
} from "../lib/api/sync";

type RefreshReview = () => Promise<void>;

const pendingReviewItems = new Set<string>();
const staleReviewItems = new Set<string>();
let surfaceMessage = "";

function paragraph(text: string, className = ""): HTMLParagraphElement {
	const node = document.createElement("p");
	if (className) node.className = className;
	node.textContent = text;
	return node;
}

function optionLabel(item: RecipientPolicyReviewItemV1): string {
	return (
		item.options.find((option) => option.decision === item.recommendedDecision)?.label ??
		item.recommendedDecision.replaceAll("_", " ")
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

function renderPreview(option: RecipientPolicyReviewOptionV1): HTMLElement {
	const preview = document.createElement("div");
	preview.className = "recipient-policy-preview settings-note";
	const counts = document.createElement("strong");
	counts.textContent = `Exact preview: ${option.preview.affectedProjectCount.toLocaleString()} project${option.preview.affectedProjectCount === 1 ? "" : "s"} · ${option.preview.affectedMemoryCount.toLocaleString()} memor${option.preview.affectedMemoryCount === 1 ? "y" : "ies"} · ${option.preview.affectedDeviceCount.toLocaleString()} device${option.preview.affectedDeviceCount === 1 ? "" : "s"}`;
	preview.appendChild(counts);
	preview.appendChild(
		renderNamedList(
			"Projects",
			option.preview.projects.map((project) => project.displayName),
		),
	);
	preview.appendChild(
		renderNamedList(
			"Devices",
			option.preview.effectiveDevices.map(
				(device) => `${device.displayName} (${device.assignment})`,
			),
		),
	);
	return preview;
}

function renderActionableItem(
	item: RecipientPolicyReviewItemV1,
	index: number,
	status: HTMLElement,
	onRefresh: RefreshReview,
): HTMLElement {
	const card = document.createElement("article");
	card.className = "project-inventory-row recipient-policy-review-item";

	const finding = document.createElement("h3");
	finding.className = "project-inventory-title";
	finding.textContent = item.finding;
	const reason = paragraph(item.reason, "project-inventory-meta");
	const recommended = paragraph(`Recommended: ${optionLabel(item)}`, "settings-note");

	const controls = document.createElement("div");
	controls.className = "project-inventory-actions";
	const selectId = `recipient-policy-decision-${index}`;
	const label = document.createElement("label");
	label.htmlFor = selectId;
	label.textContent = "Decision";
	const select = document.createElement("select");
	select.id = selectId;
	select.className = "project-filter recipient-policy-review-select";
	for (const reviewOption of item.options) {
		const option = document.createElement("option");
		option.value = reviewOption.decision;
		option.textContent = reviewOption.label;
		select.appendChild(option);
	}
	if (item.options.some((option) => option.decision === item.recommendedDecision)) {
		select.value = item.recommendedDecision;
	}

	const submit = document.createElement("button");
	submit.className = "settings-button";
	submit.type = "button";
	submit.textContent = "Apply decision";
	const deferred = paragraph("", "settings-note recipient-policy-deferred");
	const previewMount = document.createElement("div");
	previewMount.className = "recipient-policy-preview-mount";
	previewMount.setAttribute("aria-live", "polite");

	const selectedOption = () =>
		item.options.find((option) => option.decision === select.value) ?? item.options[0];
	const updateSelection = () => {
		const current = selectedOption();
		if (!current) return;
		previewMount.replaceChildren(renderPreview(current));
		deferred.textContent = current.preview.requiresDecisionInput
			? "Recipient or device details are required for this decision. Complete it in a later review flow; no incomplete decision will be submitted."
			: "";
		deferred.hidden = !current.preview.requiresDecisionInput;
		submit.disabled =
			current.preview.requiresDecisionInput || pendingReviewItems.has(item.reviewItemId);
	};
	select.addEventListener("change", updateSelection);
	updateSelection();

	if (staleReviewItems.has(item.reviewItemId)) {
		card.appendChild(
			paragraph(
				"Source state changed while this decision was being reviewed. Review the refreshed choices before trying again.",
				"settings-note project-attention-note",
			),
		);
	}

	submit.addEventListener("click", async () => {
		const current = selectedOption();
		if (
			!current ||
			current.preview.requiresDecisionInput ||
			pendingReviewItems.has(item.reviewItemId)
		) {
			return;
		}
		pendingReviewItems.add(item.reviewItemId);
		select.disabled = true;
		submit.disabled = true;
		submit.textContent = "Applying…";
		status.textContent = `Applying “${current.label}”…`;
		try {
			await api.resolveRecipientPolicyReview({
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: current.decision,
			});
			staleReviewItems.delete(item.reviewItemId);
			surfaceMessage = "Decision applied. Review items refreshed.";
			pendingReviewItems.delete(item.reviewItemId);
			await onRefresh();
		} catch (error) {
			if (error instanceof api.RecipientPolicyReviewStaleError) {
				staleReviewItems.add(item.reviewItemId);
				surfaceMessage =
					"Source state changed. The review item is still open and its choices were refreshed.";
				status.textContent = surfaceMessage;
				pendingReviewItems.delete(item.reviewItemId);
				await onRefresh();
				return;
			}
			surfaceMessage = error instanceof Error ? error.message : "Unable to apply decision.";
			status.textContent = surfaceMessage;
			pendingReviewItems.delete(item.reviewItemId);
			select.disabled = false;
			submit.textContent = "Apply decision";
			updateSelection();
		} finally {
			pendingReviewItems.delete(item.reviewItemId);
		}
	});

	controls.append(label, select, submit);
	card.prepend(finding, reason, recommended);
	card.append(controls, deferred, previewMount);
	return card;
}

function renderBlockedItem(item: RecipientPolicyBlockedItemV1): HTMLElement {
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
		paragraph(`Repair: ${item.repairAction}`, "settings-note"),
	);
	return card;
}

export function renderRecipientPolicyReview(
	mount: HTMLElement,
	review: RecipientPolicyReviewListV1,
	onRefresh: RefreshReview,
): void {
	const actionable = review.reviewItems.filter((item) => item.options.length > 0);
	if (actionable.length === 0 && review.blockedItems.length === 0) {
		mount.replaceChildren();
		mount.hidden = true;
		return;
	}

	mount.hidden = false;
	const surface = document.createElement("section");
	surface.className = "card recipient-policy-review";
	surface.setAttribute("aria-labelledby", "recipientPolicyReviewTitle");
	const title = document.createElement("h2");
	title.id = "recipientPolicyReviewTitle";
	title.textContent = "Recipient migration review";
	const intro = paragraph(
		"Review how older project sharing should be represented. These decisions do not expose internal scope or transport details.",
		"section-meta",
	);
	const status = document.createElement("div");
	status.className = "section-meta recipient-policy-review-status";
	status.setAttribute("role", "status");
	status.setAttribute("aria-live", "polite");
	status.textContent = surfaceMessage;
	surface.append(title, intro, status);

	if (actionable.length > 0) {
		const heading = document.createElement("h3");
		heading.textContent = "Needs review";
		const list = document.createElement("div");
		list.className = "project-inventory-list recipient-policy-review-list";
		actionable.forEach((item, index) => {
			list.appendChild(renderActionableItem(item, index, status, onRefresh));
		});
		surface.append(heading, list);
	}
	if (review.blockedItems.length > 0) {
		const heading = document.createElement("h3");
		heading.className = "recipient-policy-blocked-heading";
		heading.textContent = "Blocked";
		const list = document.createElement("div");
		list.className = "project-inventory-list recipient-policy-review-list";
		for (const item of review.blockedItems) list.appendChild(renderBlockedItem(item));
		surface.append(heading, list);
	}
	mount.replaceChildren(surface);
}

export function renderRecipientPolicyReviewLoadError(mount: HTMLElement, error: unknown): void {
	mount.hidden = false;
	const surface = document.createElement("section");
	surface.className = "card recipient-policy-review";
	const title = document.createElement("h2");
	title.textContent = "Recipient migration review";
	const message = paragraph(
		error instanceof Error ? error.message : "Unable to load recipient migration review.",
		"settings-note project-attention-note",
	);
	message.setAttribute("role", "status");
	surface.append(title, message);
	mount.replaceChildren(surface);
}
