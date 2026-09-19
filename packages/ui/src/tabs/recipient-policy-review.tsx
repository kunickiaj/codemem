import { render } from "preact";
import { useId, useState } from "preact/hooks";
import { Chip } from "../components/primitives/chip";
import * as api from "../lib/api";
import type {
	RecipientPolicyBlockedItemV1,
	RecipientPolicyReviewDecisionV1,
	RecipientPolicyReviewItemV1,
	RecipientPolicyReviewListV1,
	RecipientPolicyReviewOptionV1,
} from "../lib/api/sync";

const pendingReviewGroups = new Set<string>();
const staleReviewItems = new Set<string>();
const MAX_BULK_REVIEW_ITEMS = 100;
let surfaceMessage = "";

interface ReviewGroup {
	key: string;
	displayName: string;
	items: [RecipientPolicyReviewItemV1, ...RecipientPolicyReviewItemV1[]];
}

export interface RecipientPolicyReviewRenderOptions {
	isRepairAvailable?: (repair: RecipientPolicyBlockedItemV1["repair"]) => boolean;
	onRefresh?: () => Promise<void> | void;
	onRepair?: (repair: RecipientPolicyBlockedItemV1["repair"]) => Promise<void> | void;
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
	return (
		optionFor(first, first.recommendedDecision)?.label ??
		first.recommendedDecision.replaceAll("_", " ")
	);
}

function uniqueValues(values: Array<{ id: string; label: string }>): string[] {
	return [...new Map(values.map((value) => [value.id, value.label])).values()];
}

function selectedOptions(
	group: ReviewGroup,
	decision: RecipientPolicyReviewDecisionV1,
): RecipientPolicyReviewOptionV1[] {
	return group.items.flatMap((item) => {
		const selected = optionFor(item, decision);
		return selected ? [selected] : [];
	});
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

function previewValues(options: RecipientPolicyReviewOptionV1[]) {
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
	return { devices, memoryCount: affectedMemoryCount(options), projects };
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

function requiredInputGuidance(
	conditionCode: RecipientPolicyReviewItemV1["conditionCode"],
): string {
	if (conditionCode === "unassigned_effective_device") return "Set up Identity or devices first";
	return "Choose recipients first (Update sharing, below)";
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
		const firstRequest = requests[0];
		if (!firstRequest) throw new Error("Review group has no items.");
		try {
			await api.resolveRecipientPolicyReview(firstRequest);
			return { stale: false, failed: false };
		} catch (error) {
			if (!(error instanceof api.RecipientPolicyReviewStaleError)) throw error;
			staleReviewItems.add(firstRequest.reviewItemId);
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
				continue;
			}
			if (item.status !== "applied") failed = true;
		}
	}
	return { stale, failed };
}

function appliedGroupMessage(
	group: ReviewGroup,
	result: { stale: boolean; failed: boolean },
): string {
	if (result.failed) return "Some items did not update. Try again.";
	if (result.stale) return "Changed since loaded. Check the refreshed choices.";
	for (const item of group.items) staleReviewItems.delete(item.reviewItemId);
	return "Applied";
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function Preview({ options }: { options: RecipientPolicyReviewOptionV1[] }) {
	const { devices, memoryCount, projects } = previewValues(options);
	return (
		<div className="recipient-policy-preview">
			<strong>
				Affected: {countLabel(projects.length, "Project")} ·{" "}
				{countLabel(memoryCount, "memory", "memories")} · {countLabel(devices.length, "device")}
			</strong>
			<div className="recipient-policy-preview-list">
				<strong>Projects and paths</strong>
				<ul>
					{projects.map((project) => (
						<li key={project}>{project}</li>
					))}
				</ul>
			</div>
			{devices.length > 0 ? (
				<div className="recipient-policy-preview-list">
					<strong>Devices</strong>
					<ul>
						{devices.map((device) => (
							<li key={device}>{device}</li>
						))}
					</ul>
				</div>
			) : null}
		</div>
	);
}

function DecisionRow({
	group,
	onStatus,
	options,
}: {
	group: ReviewGroup;
	onStatus: (message: string) => void;
	options: RecipientPolicyReviewRenderOptions;
}) {
	const first = group.items[0];
	const detailsId = `recipient-policy-details-${useId()}`;
	const [decision, setDecision] = useState(first.recommendedDecision);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [pending, setPending] = useState(pendingReviewGroups.has(group.key));
	const selected = selectedOptions(group, decision);
	const selectedUnavailable = selected.length !== group.items.length;
	const requiresInput = selected.some((option) => option.preview.requiresDecisionInput);
	const recommended = previewValues(selectedOptions(group, first.recommendedDecision));
	const stale = group.items.some((item) => staleReviewItems.has(item.reviewItemId));
	const meta = [
		`Suggested: ${optionLabel(group)}`,
		countLabel(recommended.memoryCount, "memory", "memories"),
		countLabel(recommended.devices.length, "device"),
	];
	if (group.items.length > 1) meta.push(countLabel(group.items.length, "worktree"));

	async function refresh(): Promise<void> {
		try {
			await options.onRefresh?.();
		} catch (error) {
			const refreshMessage = errorMessage(error, "Unable to refresh review items.");
			surfaceMessage = `${surfaceMessage} Refresh failed: ${refreshMessage}`;
			onStatus(surfaceMessage);
		}
	}

	async function apply(): Promise<void> {
		if (pending || requiresInput || selectedUnavailable || pendingReviewGroups.has(group.key))
			return;
		pendingReviewGroups.add(group.key);
		setPending(true);
		surfaceMessage = "Applying…";
		onStatus(surfaceMessage);
		try {
			const result = await applyGroupDecision(group, decision);
			surfaceMessage = appliedGroupMessage(group, result);
			onStatus(surfaceMessage);
		} catch (error) {
			surfaceMessage = errorMessage(error, "Unable to apply decision. Try again.");
			onStatus(surfaceMessage);
		} finally {
			pendingReviewGroups.delete(group.key);
			setPending(false);
		}
		await refresh();
	}

	return (
		<article className="recipient-policy-review-item" data-review-group={group.key}>
			<div className="recipient-policy-review-summary">
				<div className="recipient-policy-review-name">
					<strong>{group.displayName}</strong>
					{first.projectGroup.identity !== group.displayName ? (
						<span className="mono small recipient-policy-review-identity">
							{first.projectGroup.identity}
						</span>
					) : null}
				</div>
				<div className="small recipient-policy-review-meta">
					{meta.join(" · ")}
					{stale ? (
						<Chip variant="badge" tone="badge-offline">
							Changed since loaded
						</Chip>
					) : null}
				</div>
			</div>
			<select
				aria-label={`Decision for ${group.displayName}`}
				className="project-domain-select recipient-policy-review-select"
				data-review-control="decision"
				disabled={pending}
				onChange={(event) =>
					setDecision(event.currentTarget.value as RecipientPolicyReviewDecisionV1)
				}
				value={decision}
			>
				{first.options.map((reviewOption) => (
					<option key={reviewOption.decision} value={reviewOption.decision}>
						{reviewOption.label}
					</option>
				))}
			</select>
			<div className="recipient-policy-review-actions">
				<button
					className="settings-save"
					data-review-control="apply"
					disabled={pending || requiresInput || selectedUnavailable}
					onClick={() => void apply()}
					type="button"
				>
					{pending ? "Applying…" : "Apply"}
				</button>
				<button
					aria-controls={detailsId}
					aria-expanded={detailsOpen}
					className="settings-button"
					onClick={() => setDetailsOpen((open) => !open)}
					type="button"
				>
					Details
				</button>
			</div>
			<div
				className="settings-note recipient-policy-review-details"
				hidden={!detailsOpen}
				id={detailsId}
			>
				<div>
					{first.finding} — {first.reason}
				</div>
				{stale ? <div>Changed since loaded. Check the refreshed choices.</div> : null}
				{requiresInput ? (
					<div className="recipient-policy-deferred">
						{requiredInputGuidance(first.conditionCode)}
					</div>
				) : null}
				<Preview options={selected} />
			</div>
		</article>
	);
}

function BlockedRow({
	item,
	options,
}: {
	item: RecipientPolicyBlockedItemV1;
	options: RecipientPolicyReviewRenderOptions;
}) {
	const detailsId = `recipient-policy-blocked-details-${useId()}`;
	const helpId = `recipient-policy-repair-help-${useId()}`;
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [pending, setPending] = useState(false);
	const repairAvailable = Boolean(
		options.onRepair && (options.isRepairAvailable?.(item.repair) ?? true),
	);

	async function repair(): Promise<void> {
		if (!options.onRepair || pending) return;
		setPending(true);
		try {
			await options.onRepair(item.repair);
		} finally {
			setPending(false);
		}
	}

	return (
		<article className="recipient-policy-review-item recipient-policy-blocked-item">
			<div className="recipient-policy-review-summary">
				<div className="recipient-policy-review-name">
					<strong>{item.finding}</strong>
					<Chip variant="badge" tone="badge-offline">
						Blocked
					</Chip>
				</div>
				<div className="small recipient-policy-review-meta">Owner: {item.ownerLabel}</div>
			</div>
			<div aria-hidden="true" />
			<div className="recipient-policy-review-actions">
				{repairAvailable ? (
					<button
						aria-describedby={helpId}
						className="settings-button"
						disabled={pending}
						onClick={() => void repair()}
						type="button"
					>
						{item.repair.label}
					</button>
				) : (
					<span className="small">Repair in Projects</span>
				)}
				<button
					aria-controls={detailsId}
					aria-expanded={detailsOpen}
					className="settings-button"
					onClick={() => setDetailsOpen((open) => !open)}
					type="button"
				>
					Details
				</button>
			</div>
			<div
				className="settings-note recipient-policy-review-details"
				hidden={!detailsOpen}
				id={detailsId}
			>
				<div>{item.reason}</div>
				<div id={helpId}>{item.repairAction}</div>
			</div>
		</article>
	);
}

export function SharingDecisions({
	options,
	review,
}: {
	options: RecipientPolicyReviewRenderOptions;
	review: RecipientPolicyReviewListV1;
}) {
	const groups = groupReviewItems(review.reviewItems);
	const [status, setStatus] = useState(surfaceMessage);
	return (
		<section className="card recipient-policy-review" aria-labelledby="recipientPolicyReviewTitle">
			<div className="recipient-policy-review-header">
				<h2 id="recipientPolicyReviewTitle">
					Sharing decisions <span className="recipient-policy-review-count">{groups.length}</span>
				</h2>
				<Chip variant="badge" tone="badge-offline">
					Unapplied
				</Chip>
			</div>
			<div className="section-meta recipient-policy-review-status" role="status" aria-live="polite">
				{status}
			</div>
			{groups.length > 0 ? (
				<div className="recipient-policy-review-list recipient-policy-review-decisions">
					{groups.map((group) => (
						<DecisionRow group={group} key={group.key} onStatus={setStatus} options={options} />
					))}
				</div>
			) : null}
			{review.blockedItems.length > 0 ? (
				<section className="recipient-policy-review-section recipient-policy-review-blocked">
					<h3>
						Blocked repairs{" "}
						<span className="recipient-policy-review-count">{review.blockedItems.length}</span>
					</h3>
					<div className="recipient-policy-review-list">
						{review.blockedItems.map((item) => (
							<BlockedRow item={item} key={item.blockedItemId} options={options} />
						))}
					</div>
				</section>
			) : null}
		</section>
	);
}

export function renderRecipientPolicyReview(
	mount: HTMLElement,
	review: RecipientPolicyReviewListV1,
	options: RecipientPolicyReviewRenderOptions = {},
): void {
	if (review.reviewItems.length === 0 && review.blockedItems.length === 0) {
		render(null, mount);
		mount.hidden = true;
		return;
	}
	mount.hidden = false;
	render(<SharingDecisions options={options} review={review} />, mount);
}

export function renderRecipientPolicyReviewLoadError(mount: HTMLElement, error: unknown): void {
	mount.hidden = false;
	render(
		<section className="card recipient-policy-review">
			<h2>Sharing decisions</h2>
			<p className="settings-note project-attention-note" role="status">
				{errorMessage(error, "Unable to load sharing decisions. Try again.")}
			</p>
		</section>,
		mount,
	);
}
