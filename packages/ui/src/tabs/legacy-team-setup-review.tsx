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

function DeltaSection({ empty, items, title }: { empty: string; items: string[]; title: string }) {
	return (
		<section>
			<h4>{title}</h4>
			{items.length > 0 ? (
				<ul>
					{items.map((item, index) => (
						<li key={`${title}-${index}`}>{item}</li>
					))}
				</ul>
			) : (
				<p className="small">{empty}</p>
			)}
		</section>
	);
}

export function LegacyTeamSetupReview({
	blocked,
	blockedDescriptionId,
	detail,
	onFinish,
}: LegacyTeamSetupReviewProps) {
	const delta = detail.accessDelta;
	const evidenceKey = `${detail.attemptId}:${detail.finishDigest}:${detail.accessDeltaDigest}:${detail.viewerAccessDeltaDigest}`;
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
		teamItems.length +
		membershipItems.length +
		projectItems.length +
		recipientItems.length +
		deviceItems.length;

	return (
		<section aria-labelledby="legacy-team-setup-step-review">
			<h3 id="legacy-team-setup-step-review" tabIndex={-1}>
				Review and finish
			</h3>
			<p>Review every server-confirmed access change before activating this Team.</p>
			<p className="small">
				{accessChangeCount} access {accessChangeCount === 1 ? "change" : "changes"} to review.
			</p>
			<div className="legacy-team-setup-delta">
				<DeltaSection empty="No Team policy changes." items={teamItems} title="Team policy" />
				<DeltaSection empty="No membership changes." items={membershipItems} title="Memberships" />
				<DeltaSection empty="No Project mapping changes." items={projectItems} title="Projects" />
				<DeltaSection empty="No recipient changes." items={recipientItems} title="Recipients" />
				<DeltaSection empty="No device access changes." items={deviceItems} title="Device access" />
			</div>
			<label className="legacy-team-setup-confirmation" id="legacy-team-setup-confirmation-label">
				<input
					aria-disabled={blocked ? "true" : undefined}
					aria-describedby={blocked ? blockedDescriptionId : undefined}
					checked={confirmed}
					onChange={(event) => {
						if (!blocked) setConfirmedEvidenceKey(event.currentTarget.checked ? evidenceKey : null);
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
