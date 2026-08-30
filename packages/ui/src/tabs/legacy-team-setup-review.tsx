import { useState } from "preact/hooks";
import type { LegacyTeamSetupDetailResponseV1 } from "../lib/api";
import {
	projectDisplayNameKey,
	stableProjectPresentationLabels,
} from "../lib/project-identity-presentation";

type FinishableDetail = Extract<LegacyTeamSetupDetailResponseV1, { state: "ready_to_finish" }>;

export interface LegacyTeamSetupReviewProps {
	blocked: boolean;
	blockedDescriptionId?: string;
	detail: FinishableDetail;
	finishing: boolean;
	onFinish: (detail: FinishableDetail) => void;
}

const CHANGE_VERBS = { add: "Add", update: "Update", remove: "Remove" } as const;
const EXACT_DISCLOSURE_THRESHOLD = 10;

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
	return `${count.toLocaleString()} ${count === 1 ? singular : plural}`;
}

interface ProjectIdentityGroup {
	displayName: string;
	kind: "project" | "legacy_default_sharing";
	projectRefs: Set<string>;
	changeCount: number;
}

function groupProjectIdentities<T>(
	items: T[],
	displayName: (item: T) => string,
	projectRef: (item: T) => string,
	kind: (item: T) => ProjectIdentityGroup["kind"],
): ProjectIdentityGroup[] {
	const groups = new Map<string, ProjectIdentityGroup>();
	for (const item of items) {
		const name = displayName(item);
		const itemKind = kind(item);
		const key = `${itemKind}:${projectDisplayNameKey(name)}`;
		const ref = projectRef(item);
		const group = groups.get(key) ?? {
			displayName: name,
			kind: itemKind,
			projectRefs: new Set<string>(),
			changeCount: 0,
		};
		group.projectRefs.add(ref);
		group.changeCount += 1;
		groups.set(key, group);
	}
	return [...groups.values()];
}

function projectGroupSummary(group: ProjectIdentityGroup, noun: string): string {
	if (group.kind === "legacy_default_sharing") return `${group.displayName} — default scope`;
	return group.projectRefs.size > 1
		? `${group.displayName} — ${countLabel(group.projectRefs.size, noun)}`
		: group.displayName;
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
	finishing,
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
	const projectLabels = stableProjectPresentationLabels([
		...detail.projects.map((project) => ({
			canonicalId: project.projectRef,
			displayName: project.displayName,
		})),
		...delta.projectChanges.map((change) => ({
			canonicalId: change.projectRef,
			displayName: change.projectDisplayName,
		})),
	]);
	const resolvedProjectItems = delta.projectChanges.flatMap((change) => [
		...(change.fromResolvedProjectRef && change.fromResolvedProjectDisplayName
			? [
					{
						canonicalProjectRef: change.fromCanonicalProjectRef,
						resolvedProjectRef: change.fromResolvedProjectRef,
						displayName: change.fromResolvedProjectDisplayName,
					},
				]
			: []),
		...(change.toResolvedProjectRef && change.toResolvedProjectDisplayName
			? [
					{
						canonicalProjectRef: change.toCanonicalProjectRef,
						resolvedProjectRef: change.toResolvedProjectRef,
						displayName: change.toResolvedProjectDisplayName,
					},
				]
			: []),
	]);
	const canonicalResolvedProjectLabels = stableProjectPresentationLabels(
		resolvedProjectItems.map((item) => ({
			canonicalId: item.canonicalProjectRef ?? item.resolvedProjectRef,
			displayName: item.displayName,
		})),
	);
	const resolvedProjectLabels = new Map(
		resolvedProjectItems.map((item) => [
			item.resolvedProjectRef,
			canonicalResolvedProjectLabels.get(item.canonicalProjectRef ?? item.resolvedProjectRef) ??
				item.displayName,
		]),
	);
	const canonicalProjectLabels = stableProjectPresentationLabels([
		...detail.projects.flatMap((project) =>
			project.canonicalProjectRef
				? [{ canonicalId: project.canonicalProjectRef, displayName: project.displayName }]
				: [],
		),
		...[...delta.recipientChanges, ...delta.deviceAccessChanges]
			.filter((change) => change.canonicalProjectKind === "project")
			.map((change) => ({
				canonicalId: change.canonicalProjectRef,
				displayName: change.canonicalProjectDisplayName,
			})),
	]);
	const projectItems = delta.projectChanges.map(
		(change) =>
			`${CHANGE_VERBS[change.change]} ${
				projectLabels.get(change.projectRef) ?? change.projectDisplayName
			}: ${
				change.fromResolvedProjectRef
					? (resolvedProjectLabels.get(change.fromResolvedProjectRef) ??
						change.fromResolvedProjectDisplayName ??
						"no Project")
					: "no Project"
			} to ${
				change.toResolvedProjectRef
					? (resolvedProjectLabels.get(change.toResolvedProjectRef) ??
						change.toResolvedProjectDisplayName ??
						"no Project")
					: "no Project"
			}.`,
	);
	const recipientItems = delta.recipientChanges.map((change) =>
		change.canonicalProjectKind === "legacy_default_sharing"
			? `${change.change === "remove" ? "Stop" : "Start"} using legacy default sharing for ${change.recipientDisplayName}.`
			: `${CHANGE_VERBS[change.change]} ${change.recipientDisplayName} ${
					change.change === "remove" ? "from" : "as"
				} a recipient for ${
					canonicalProjectLabels.get(change.canonicalProjectRef) ??
					change.canonicalProjectDisplayName
				}.`,
	);
	const deviceItems = delta.deviceAccessChanges.map((change) =>
		change.canonicalProjectKind === "legacy_default_sharing"
			? `${change.deviceDisplayName} ${
					change.change === "remove" ? "stops" : "starts"
				} inheriting legacy default sharing.`
			: `${CHANGE_VERBS[change.change]} ${change.deviceDisplayName} access ${
					change.change === "remove" ? "from" : "to"
				} ${
					canonicalProjectLabels.get(change.canonicalProjectRef) ??
					change.canonicalProjectDisplayName
				}.`,
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
		() => "project",
	);
	const recipientGroups = groupProjectIdentities(
		delta.recipientChanges,
		(change) => change.canonicalProjectDisplayName,
		(change) => change.canonicalProjectRef,
		(change) => change.canonicalProjectKind,
	);
	const deviceAccessGroups = groupProjectIdentities(
		delta.deviceAccessChanges,
		(change) => change.canonicalProjectDisplayName,
		(change) => change.canonicalProjectRef,
		(change) => change.canonicalProjectKind,
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
	const reviewedProjectCount = Math.max(detail.candidate.projectCount, detail.projects.length);
	const legacyCleanupDeviceCount = new Set(
		delta.deviceAccessChanges.map((change) => change.deviceRef),
	).size;
	const removalCount = [
		...delta.teamChanges,
		...delta.membershipChanges,
		...delta.projectChanges,
		...delta.recipientChanges,
		...delta.deviceAccessChanges,
	].filter((change) => change.change === "remove").length;
	const onlyLegacyDefaultCleanup =
		delta.teamChanges.length === 0 &&
		delta.membershipChanges.length === 0 &&
		delta.projectChanges.length === 0 &&
		delta.recipientChanges.length > 0 &&
		delta.recipientChanges.every(
			(change) =>
				change.change === "remove" && change.canonicalProjectKind === "legacy_default_sharing",
		) &&
		delta.deviceAccessChanges.every(
			(change) =>
				change.change === "remove" && change.canonicalProjectKind === "legacy_default_sharing",
		);
	const netEffect = onlyLegacyDefaultCleanup
		? `No new access will be added. This removes legacy default sharing for ${detail.candidate.displayName}.${
				legacyCleanupDeviceCount > 0
					? ` ${countLabel(legacyCleanupDeviceCount, "device")} will stop receiving memories shared only through that default.`
					: ""
			} Project-scoped access is unchanged across ${countLabel(reviewedProjectCount, "reviewed Project")}.`
		: `${countLabel(accessChangeCount, "server-confirmed access change")} will be applied atomically; ${countLabel(
				removalCount,
				"removal",
			)} ${removalCount === 1 ? "is" : "are"} included.`;

	return (
		<section aria-labelledby="legacy-team-setup-step-review">
			<h3 id="legacy-team-setup-step-review" tabIndex={-1}>
				Review and finish
			</h3>
			<p>Review every server-confirmed access change before activating this Team.</p>
			<section aria-label="Access review summary" className="legacy-team-setup-review-summary">
				<p className="legacy-team-setup-net-effect">
					<strong>Net effect:</strong> {netEffect}
				</p>
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
							`${projectGroupSummary(group, "reviewed Project")}, ${countLabel(group.changeCount, "Project change")}`,
					)}
					title="Projects"
				/>
				<DeltaSection
					empty="No recipient changes."
					exactItemName="recipient change"
					exactItems={recipientItems}
					summaryItems={recipientGroups.map(
						(group) =>
							`${projectGroupSummary(group, "canonical Project")}, ${countLabel(group.changeCount, "recipient change")}`,
					)}
					title="Recipients"
				/>
				<DeltaSection
					empty="No device access changes."
					exactItemName="device-access change"
					exactItems={deviceItems}
					summaryItems={deviceAccessGroups.map(
						(group) =>
							`${projectGroupSummary(group, "canonical Project")}, ${countLabel(group.changeCount, "device-access change")}`,
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
			{finishing ? (
				<p aria-live="polite" className="legacy-team-setup-finish-progress" role="status">
					<span aria-hidden="true" className="legacy-team-setup-spinner" />
					Checking the latest Team roster and applying all reviewed changes atomically. No partial
					changes will be kept if this cannot finish.
				</p>
			) : null}
			<button
				aria-describedby={finishBlockedDescription || undefined}
				aria-disabled={finishBlocked ? "true" : undefined}
				className="settings-button legacy-team-setup-target"
				onClick={() => {
					if (!finishBlocked) onFinish(detail);
				}}
				type="button"
			>
				{finishing ? "Finishing Team setup…" : "Finish Team setup"}
			</button>
		</section>
	);
}
