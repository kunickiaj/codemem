import type { RecipientPolicyBlockedItemV1, RecipientPolicyReviewListV1 } from "../lib/api/sync";

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
	if (!review.continuity && review.blockedItems.length === 0) {
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
		review.blockedItems.length > 0 ? "Sharing needs repair" : "Existing sharing kept as-is";
	surface.appendChild(title);

	if (review.continuity) {
		const findingCount = review.continuity.findingCount;
		const detail = paragraph(
			`${findingCount.toLocaleString()} older sharing finding${findingCount === 1 ? " was" : "s were"} not changed because Codemem could not safely translate ${findingCount === 1 ? "it" : "them"} automatically.`,
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
