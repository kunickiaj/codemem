import { useState } from "preact/hooks";
import type { LegacyTeamSetupDetailResponseV1 } from "../lib/api";

type FinishableDetail = LegacyTeamSetupDetailResponseV1 & { canFinish: true };

export interface LegacyTeamSetupReviewProps {
	blocked: boolean;
	blockedDescriptionId?: string;
	detail: FinishableDetail;
	onFinish: (detail: FinishableDetail) => void;
}

const CHANGE_VERBS = { add: "Add", update: "Update", remove: "Remove" } as const;
const EXACT_DISCLOSURE_THRESHOLD = 10;

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

interface ProjectIdentityGroup {
	displayName: string;
	projectRefs: Set<string>;
	changeCount: number;
}

function groupProjectIdentities<T>(
	items: T[],
	displayName: (item: T) => string,
	projectRef: (item: T) => string,
): ProjectIdentityGroup[] {
	const groups = new Map<string, ProjectIdentityGroup>();
	for (const item of items) {
		const name = displayName(item);
		const key = name.trim().toLowerCase();
		const ref = projectRef(item);
		const group = groups.get(key) ?? {
			displayName: name,
			projectRefs: new Set<string>(),
			changeCount: 0,
		};
		group.projectRefs.add(ref);
		group.changeCount += 1;
		groups.set(key, group);
	}
	return [...groups.values()];
}

function projectGroupSummary(group: ProjectIdentityGroup): string {
	return `${group.displayName} — ${countLabel(
		group.projectRefs.size,
		"Project with this name",
		"Projects with this name",
	)}`;
}

function DeltaSection({
	empty,
	exactItemName,
	exactItems,
	summaryItems,
	title,
}: {
	empty: string;
	exactItemName: string;
	exactItems: string[];
	summaryItems?: string[];
	title: string;
}) {
	const hasUsefulSummary = Boolean(summaryItems && summaryItems.length < exactItems.length);
	const collapsed = hasUsefulSummary && exactItems.length > EXACT_DISCLOSURE_THRESHOLD;
	return (
		<section>
			<h4>{title}</h4>
			{exactItems.length > 0 ? (
				<>
					{hasUsefulSummary && summaryItems ? (
						<ul className="legacy-team-setup-delta-summary">
							{summaryItems.map((item, index) => (
								<li key={`${title}-summary-${index}`}>{item}</li>
							))}
						</ul>
					) : null}
					{collapsed ? (
						<details>
							<summary>Show all {countLabel(exactItems.length, `exact ${exactItemName}`)}</summary>
							<ExactDeltaList items={exactItems} title={title} />
						</details>
					) : (
						<ExactDeltaList items={exactItems} title={title} />
					)}
				</>
			) : (
				<p className="small">{empty}</p>
			)}
		</section>
	);
}

function ExactDeltaList({ items, title }: { items: string[]; title: string }) {
	return (
		<ul className="legacy-team-setup-exact-list">
			{items.map((item, index) => (
				<li key={`${title}-${index}`}>{item}</li>
			))}
		</ul>
	);
}

export function LegacyTeamSetupReview({
	blocked,
	blockedDescriptionId,
	detail,
	onFinish,
}: LegacyTeamSetupReviewProps) {
	const delta = detail.accessDelta;
	const evidenceKey = JSON.stringify([
		detail.attemptId,
		detail.finishDigest,
		detail.accessDeltaDigest,
		detail.viewerAccessDeltaDigest,
	]);
	const [confirmedEvidenceKey, setConfirmedEvidenceKey] = useState<string | null>(null);
	const confirmed = confirmedEvidenceKey === evidenceKey;
	const finishBlocked = blocked || !confirmed;
	const finishBlockedDescription = [
		!confirmed ? "legacy-team-setup-confirmation-label" : null,
		blocked ? blockedDescriptionId : null,
	]
		.filter(Boolean)
		.join(" ");
	const teamItems = delta.teamChanges.map((change) => {
		const fromMode =
			change.fromDeviceEligibilityMode === "person_all_devices"
				? "all devices assigned to each person"
				: change.fromDeviceEligibilityMode === "reviewed_allowlist"
					? "the reviewed device list"
					: "no existing device policy";
		return `${CHANGE_VERBS[change.change]} ${change.teamDisplayName}: change device access from ${fromMode} to the reviewed device list.`;
	});
	const membershipItems = delta.membershipChanges.map(
		(change) =>
			`${CHANGE_VERBS[change.change]} ${change.identityDisplayName} ${
				change.change === "remove" ? "from" : "to"
			} ${change.teamDisplayName}.`,
	);
	const projectItems = delta.projectChanges.map(
		(change) =>
			`${CHANGE_VERBS[change.change]} ${change.projectDisplayName}: ${
				change.fromResolvedProjectDisplayName ?? "no Project"
			} to ${change.toResolvedProjectDisplayName ?? "no Project"}.`,
	);
	const recipientItems = delta.recipientChanges.map(
		(change) =>
			`${CHANGE_VERBS[change.change]} ${change.recipientDisplayName} ${
				change.change === "remove" ? "from" : "as"
			} a recipient for ${change.canonicalProjectDisplayName}.`,
	);
	const deviceItems = delta.deviceAccessChanges.map(
		(change) =>
			`${CHANGE_VERBS[change.change]} ${change.deviceDisplayName} access ${
				change.change === "remove" ? "from" : "to"
			} ${change.canonicalProjectDisplayName}.`,
	);
	const accessChangeCount =
		delta.teamChanges.length +
		delta.membershipChanges.length +
		delta.projectChanges.length +
		delta.recipientChanges.length +
		delta.deviceAccessChanges.length;
	const projectGroups = groupProjectIdentities(
		delta.projectChanges,
		(change) => change.projectDisplayName,
		(change) => change.projectRef,
	);
	const recipientGroups = groupProjectIdentities(
		delta.recipientChanges,
		(change) => change.canonicalProjectDisplayName,
		(change) => change.canonicalProjectRef,
	);
	const deviceAccessGroups = groupProjectIdentities(
		delta.deviceAccessChanges,
		(change) => change.canonicalProjectDisplayName,
		(change) => change.canonicalProjectRef,
	);
	const includedDeviceCount = detail.devices.filter(
		(device) => device.decision === "included",
	).length;
	const changeSummary = [
		countLabel(delta.teamChanges.length, "Team policy change"),
		countLabel(delta.membershipChanges.length, "membership change"),
		countLabel(delta.projectChanges.length, "Project change"),
		countLabel(delta.recipientChanges.length, "recipient change"),
		countLabel(delta.deviceAccessChanges.length, "device-access change"),
	];
	const scopeSummary = `${countLabel(detail.projects.length, "Project")} included; ${countLabel(
		includedDeviceCount,
		"included device",
	)}.`;

	return (
		<section aria-labelledby="legacy-team-setup-step-review">
			<h3 id="legacy-team-setup-step-review" tabIndex={-1}>
				Review and finish
			</h3>
			<p>Review every server-confirmed access change before activating this Team.</p>
			<section aria-label="Access review summary" className="legacy-team-setup-review-summary">
				<p>
					<strong>{countLabel(accessChangeCount, "exact access change")}</strong> to review.
				</p>
				<ul>
					{changeSummary.map((item) => (
						<li key={item}>{item}</li>
					))}
				</ul>
				<p className="small">Scope: {scopeSummary}</p>
			</section>
			<div className="legacy-team-setup-delta">
				<DeltaSection
					empty="No Team policy changes."
					exactItemName="Team policy change"
					exactItems={teamItems}
					title="Team policy"
				/>
				<DeltaSection
					empty="No membership changes."
					exactItemName="membership change"
					exactItems={membershipItems}
					title="Memberships"
				/>
				<DeltaSection
					empty="No Project mapping changes."
					exactItemName="Project change"
					exactItems={projectItems}
					summaryItems={projectGroups.map(
						(group) =>
							`${projectGroupSummary(group)}, ${countLabel(group.changeCount, "Project change")}`,
					)}
					title="Projects"
				/>
				<DeltaSection
					empty="No recipient changes."
					exactItemName="recipient change"
					exactItems={recipientItems}
					summaryItems={recipientGroups.map(
						(group) =>
							`${projectGroupSummary(group)}, ${countLabel(group.changeCount, "recipient change")}`,
					)}
					title="Recipients"
				/>
				<DeltaSection
					empty="No device access changes."
					exactItemName="device-access change"
					exactItems={deviceItems}
					summaryItems={deviceAccessGroups.map(
						(group) =>
							`${projectGroupSummary(group)}, ${countLabel(group.changeCount, "device-access change")}`,
					)}
					title="Device access"
				/>
			</div>
			<label className="legacy-team-setup-confirmation" id="legacy-team-setup-confirmation-label">
				<input
					aria-disabled={blocked ? "true" : undefined}
					aria-describedby={blocked ? blockedDescriptionId : undefined}
					checked={confirmed}
					onClick={(event) => {
						if (blocked) event.preventDefault();
					}}
					onChange={(event) => {
						if (blocked) {
							event.currentTarget.checked = confirmed;
							return;
						}
						setConfirmedEvidenceKey(event.currentTarget.checked ? evidenceKey : null);
					}}
					type="checkbox"
				/>
				<span>I reviewed every access change above and approve activating this Team.</span>
			</label>
			<button
				aria-describedby={finishBlockedDescription || undefined}
				aria-disabled={finishBlocked ? "true" : undefined}
				className="settings-button legacy-team-setup-target"
				onClick={() => {
					if (!finishBlocked) onFinish(detail);
				}}
				type="button"
			>
				Finish Team setup
			</button>
		</section>
	);
}
