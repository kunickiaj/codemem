import type {
	RecipientPolicyBlockedItemV1,
	RecipientPolicyReviewItemV1,
	RecipientPolicyReviewListV1,
} from "../lib/api/sync";

const renderedReviewSignatures = new WeakMap<HTMLElement, string>();

function paragraph(text: string, className = ""): HTMLParagraphElement {
	const node = document.createElement("p");
	if (className) node.className = className;
	node.textContent = text;
	return node;
}

export interface RecipientPolicyReviewRenderOptions {
	isRepairAvailable?: (repair: RecipientPolicyBlockedItemV1["repair"]) => boolean;
	onRepair?: (repair: RecipientPolicyBlockedItemV1["repair"]) => Promise<void> | void;
}

function sectionHeading(label: string, count: number): HTMLHeadingElement {
	const heading = document.createElement("h3");
	heading.className = "recipient-policy-review-heading";
	heading.textContent = `${label} (${count.toLocaleString()})`;
	return heading;
}

function renderReviewItem(item: RecipientPolicyReviewItemV1): HTMLElement {
	const card = document.createElement("article");
	card.className = "project-inventory-row recipient-policy-review-item";
	const finding = document.createElement("h4");
	finding.className = "project-inventory-title";
	finding.textContent = item.finding;
	card.append(finding, paragraph(item.reason, "project-inventory-meta"));
	return card;
}

function renderReviewDecisionSection(review: RecipientPolicyReviewListV1): HTMLElement {
	const section = document.createElement("section");
	section.className = "recipient-policy-review-section recipient-policy-review-decisions";
	section.append(
		sectionHeading("Review decisions", review.reviewItems.length),
		paragraph(
			"Access has not changed. Action is required. Next step: review these findings, then use the existing sharing controls below if you choose to change access.",
			"section-meta",
		),
	);
	const list = document.createElement("div");
	list.className = "project-inventory-list recipient-policy-review-list";
	for (const item of review.reviewItems) list.appendChild(renderReviewItem(item));
	section.appendChild(list);
	return section;
}

function renderContinuitySection(review: RecipientPolicyReviewListV1): HTMLElement {
	const count = review.categoryCounts.preservedContinuity;
	const section = document.createElement("section");
	section.className = "recipient-policy-review-section recipient-policy-review-continuity";
	const detail = paragraph(
		`${count.toLocaleString()} preserved legacy finding${count === 1 ? "" : "s"}. Access has not changed. These preserved findings require no action. Next step: none for this category; Codemem will keep this legacy sharing state as-is.`,
		"settings-note",
	);
	detail.setAttribute("role", "status");
	detail.setAttribute("aria-live", "polite");
	section.append(sectionHeading("Preserved legacy continuity", count), detail);
	return section;
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
			"Access has not changed. Action is required before Codemem can safely interpret these records. Next step: repair each source record below.",
			"section-meta project-attention-note",
		),
	);
	const list = document.createElement("div");
	list.className = "project-inventory-list recipient-policy-review-list";
	for (const item of review.blockedItems) list.appendChild(renderBlockedItem(item, options));
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

export function renderRecipientPolicyReview(
	mount: HTMLElement,
	review: RecipientPolicyReviewListV1,
	options: RecipientPolicyReviewRenderOptions = {},
): void {
	const repairAvailability = review.blockedItems.map((item) =>
		options.onRepair && (options.isRepairAvailable?.(item.repair) ?? true) ? "1" : "0",
	);
	const signature = `review:${repairAvailability.join("")}:${JSON.stringify(review)}`;
	if (renderedReviewSignatures.get(mount) === signature) return;
	const { preservedContinuity } = review.categoryCounts;
	if (
		review.reviewItems.length === 0 &&
		preservedContinuity === 0 &&
		review.blockedItems.length === 0
	) {
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
	title.textContent = "Sharing review";
	surface.appendChild(title);

	if (review.reviewItems.length > 0) surface.appendChild(renderReviewDecisionSection(review));
	if (preservedContinuity > 0) surface.appendChild(renderContinuitySection(review));
	if (review.blockedItems.length > 0) surface.appendChild(renderBlockedSection(review, options));

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
