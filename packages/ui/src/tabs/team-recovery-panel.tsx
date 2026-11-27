import { useEffect, useState } from "preact/hooks";
import * as api from "../lib/api";
import type {
	TeamRecoveryDeviceV1,
	TeamRecoveryPersonV1,
	TeamRecoveryPreviewV1,
	TeamRecoveryProjectV1,
} from "../lib/api/team-recovery";

export interface TeamRecoveryActions {
	loadSummary: typeof api.loadLegacyTeamSetupSummary;
	preview: typeof api.previewTeamRecovery;
	commit: typeof api.commitTeamRecovery;
}

// Read at call time, so a module that mocks the API only in part can still load this one.
const defaultActions: TeamRecoveryActions = {
	loadSummary: (options) => api.loadLegacyTeamSetupSummary(options),
	preview: (input) => api.previewTeamRecovery(input),
	commit: (input) => api.commitTeamRecovery(input),
};

const TRY_AGAIN = "Nothing changed. Try again.";
const COORDINATOR_UNREAD = `The coordinator couldn't be read in time. ${TRY_AGAIN}`;

const ERRORS: Partial<Record<string, string>> = {
	coordinator_admin_required:
		"Only a device that holds the coordinator admin secret can recover a Team. Use that device.",
	admin_authority_changed:
		"This device stopped being an admin of the Team's coordinator group while the recovery ran. Nothing changed. Use an admin device.",
	team_not_found: "This Team is no longer available. Close this dialog and refresh Sharing.",
	team_coordinator_not_configured:
		"This Team belongs to a coordinator or group this device isn't set up for. Use a device configured for it.",
	team_not_quarantined: "This Team is not turned off, so there is nothing to recover.",
	team_setup_busy:
		"Team setup is changing this Team right now. Nothing changed. Try again shortly.",
	setup_record_missing:
		"This device has no record of the Team's completed setup, so it can't recover the Team. Use the device that set the Team up.",
	roster_unavailable: `The coordinator's device list couldn't be read. ${TRY_AGAIN}`,
	device_removals_unavailable: `Device removal records couldn't be read from the coordinator. ${TRY_AGAIN}`,
	device_blocks_unavailable: `The coordinator couldn't confirm which devices are blocked. ${TRY_AGAIN}`,
	completion_unavailable: `The Team's saved setup couldn't be read from the coordinator. ${TRY_AGAIN}`,
	member_removals_unavailable: `Team member removals couldn't be read from the coordinator. ${TRY_AGAIN}`,
	team_group_unavailable: `The Team's coordinator group couldn't be read. ${TRY_AGAIN}`,
	evidence_stale: COORDINATOR_UNREAD,
	device_block_unchecked: `The coordinator couldn't confirm that a device is still enrolled and not blocked. ${TRY_AGAIN}`,
	completion_missing:
		"The coordinator holds no saved setup for this Team, so there is nothing to recover from.",
	completion_invalid:
		"The Team's saved setup on the coordinator couldn't be verified, so the Team can't be recovered from it.",
	setup_differs_from_completion:
		"The setup saved on this device differs from the one on the coordinator, so the Team can't be recovered here.",
	team_group_conflict:
		"This Team's coordinator group is unclear. Bind the Team to one group on the coordinator, then try again.",
	team_group_mismatch:
		"This Team is bound to a different coordinator group than the one it was set up from, so it can't be recovered.",
	team_policy_blocked:
		"A member or device of this Team is in a state that would block sharing for everyone. Resolve it in Sharing, then try again.",
	device_blocked:
		"The coordinator blocks a device this Team includes. Remove the device from the coordinator group, then try again.",
	device_evidence_contradictory:
		"The coordinator lists a device as both enrolled and removed. Check the device on the coordinator, then try again.",
	device_key_unverified:
		"This device has no trusted key on record for a device the Team includes, so it can't confirm the device is the same one.",
	device_key_changed:
		"A device the Team includes now has a different key than the one that was reviewed. Remove it from the coordinator group or set the Team up again.",
	device_disabled:
		"A device the Team includes is disabled on the coordinator. Enable it or remove it from the group, then try again.",
	device_missing_without_removal:
		"A device the Team includes is missing from the coordinator group and no removal is on record for it.",
	device_decision_changed:
		"A device's place in this Team changed since the Team was set up, so the Team can't be recovered as it was.",
	recovery_preview_stale:
		"Something changed since you reviewed this recovery. Nothing changed. Review it again.",
	recovery_state_changed:
		"The Team changed while the recovery ran. Nothing changed. Review it again.",
	recovery_superseded:
		"Another recovery of this Team finished first. Close this dialog and refresh Sharing.",
};

const UNSETTLED: Record<string, string> = {
	evidence_changed:
		"The coordinator changed while the recovery ran, so the Team was turned off again. What the recovery left out stays out. Review the recovery again.",
	evidence_unavailable:
		"The coordinator couldn't be read to confirm the recovery, so the Team was turned off again. What the recovery left out stays out. Review the recovery again.",
	disabled_before_verification:
		"The Team was turned off again before the recovery could be confirmed. Review the recovery again.",
	evidence_stale:
		"The recovery was saved, but the coordinator answered too slowly to confirm it. The Team shares nothing until a recovery is confirmed. Review the recovery again now to finish it.",
	admin_authority_changed:
		"The recovery was saved, but this device stopped being an admin before it was confirmed. The Team shares nothing until an admin device recovers it again.",
};

function errorMessage(cause: unknown): string {
	if (!(cause instanceof api.TeamRecoveryApiError))
		return `The recovery couldn't be completed. ${TRY_AGAIN}`;
	const unsettled = cause.detail.reason ? UNSETTLED[cause.detail.reason] : undefined;
	const message =
		unsettled ?? ERRORS[cause.errorCode] ?? `The recovery couldn't be completed. ${TRY_AGAIN}`;
	const devices = cause.detail.deviceIds;
	return devices?.length ? `${message} Device ID: ${devices.join(", ")}.` : message;
}

const PERSON_REASONS: Record<string, string> = {
	removed_from_team: "removed from the Team",
	identity_missing: "no longer known on this device",
	merged: "merged into another person",
	deactivated: "deactivated",
	identity_not_active: "not active",
	not_a_member: "membership had already ended",
};

const DEVICE_REASONS: Record<string, string> = {
	removed_from_group: "removed from the coordinator group",
	blocked_by_coordinator: "blocked on the coordinator",
	left_out_by_recovery: "left out by an earlier recovery",
	excluded_in_review: "excluded when the Team was set up",
	not_included: "not included in the Team",
	person_left_out: "its person is left out",
	not_eligible: "not eligible for the Team",
};

const PROJECT_REASONS: Record<string, string> = {
	sharing_changed: "its sharing was changed after the Team was turned off",
	mapping_changed: "its Project mapping was changed after the Team was turned off",
	scope_unavailable: "its sharing scope is no longer available",
};

interface Row {
	key: string;
	label: string;
}

const named = (name: string | null, fallback: string, reason?: string): string =>
	reason ? `${name ?? fallback} (${reason})` : (name ?? fallback);

/** One titled list of the review. Nothing is rendered for an empty one. */
function ReviewList({ title, rows }: { title: string; rows: Row[] }) {
	if (rows.length === 0) return null;
	return (
		<>
			<strong>{title}</strong>
			<ul className="team-recovery-list">
				{rows.map((row) => (
					<li key={row.key}>{row.label}</li>
				))}
			</ul>
		</>
	);
}

const personRow = (person: TeamRecoveryPersonV1): Row => ({
	key: person.identityId,
	label: named(person.displayName, "Unnamed person", PERSON_REASONS[person.reason ?? ""]),
});
const deviceRow = (device: TeamRecoveryDeviceV1): Row => ({
	key: device.deviceId,
	label: named(device.displayName, device.deviceId, DEVICE_REASONS[device.reason ?? ""]),
});
const projectRow = (project: TeamRecoveryProjectV1): Row => ({
	key: project.projectIdentity,
	label: named(project.displayName, project.projectIdentity, PROJECT_REASONS[project.reason ?? ""]),
});

function discardedNote(count: number): string | null {
	if (count === 0) return null;
	const attempts =
		count === 1 ? "1 unfinished setup attempt" : `${count} unfinished setup attempts`;
	return `${attempts} started since the Team was turned off will be discarded.`;
}

/** What a recovery would bring back and leave out, as the admin confirms it. */
function RecoveryReview({ preview }: { preview: TeamRecoveryPreviewV1 }) {
	const { people, devices, projects } = preview;
	const discarded = discardedNote(preview.discardedSetupAttempts);
	return (
		<div className="team-recovery-review" id="team-recovery-review">
			<ReviewList
				rows={people.filter((person) => person.outcome === "member").map(personRow)}
				title="People who become members again"
			/>
			<ReviewList
				rows={devices.filter((device) => device.outcome === "regains_access").map(deviceRow)}
				title="Devices that receive the Team's Projects again"
			/>
			<ReviewList
				rows={projects.filter((project) => project.outcome !== "skipped").map(projectRow)}
				title="Projects shared with the Team again"
			/>
			<ReviewList
				rows={people.filter((person) => person.outcome === "left_out").map(personRow)}
				title="People left out"
			/>
			<ReviewList
				rows={devices.filter((device) => device.outcome === "stays_out").map(deviceRow)}
				title="Devices left out"
			/>
			<ReviewList
				rows={projects.filter((project) => project.outcome === "skipped").map(projectRow)}
				title="Projects not shared again"
			/>
			{discarded ? <p className="small">{discarded}</p> : null}
		</div>
	);
}

const TURNED_OFF_INTRO =
	"This Team was turned off because its saved setup no longer matched the coordinator. Recovery turns it back on with the people, devices and Projects of that setup, and leaves out every device that was removed from the coordinator group since.";
const UNCONFIRMED_INTRO =
	"A recovery of this Team was saved but could not be confirmed, so the Team shares nothing yet. Review the recovery again to finish it.";

type Step =
	| { kind: "idle" }
	| { kind: "review"; preview: TeamRecoveryPreviewV1 }
	/** The commit's answer was lost or unreadable, so the recovery may have gone through. */
	| { kind: "unconfirmed" }
	| { kind: "recovered"; teamName: string; refresh: "running" | "done" | "failed" };

interface RecoverableTeam {
	teamId: string;
	/** A recovery was saved and not confirmed: the Team is on, on hold, and shares nothing. */
	unconfirmed: boolean;
}

/**
 * The Team the candidate's recovery would restore, read from the summary again
 * whenever `refreshKey` changes or `reload` is called. `offered` says whether
 * this panel was ever given a Team, so that one no longer named reads as done.
 */
function useRecoverableTeam(
	candidateRef: string,
	actions: TeamRecoveryActions,
	refreshKey: unknown,
) {
	const [team, setTeam] = useState<RecoverableTeam | null>(null);
	const [offered, setOffered] = useState(false);
	const [reloads, setReloads] = useState(0);
	useEffect(() => {
		let current = true;
		void reloads;
		void refreshKey;
		actions
			.loadSummary()
			.then((summary) => {
				if (!current) return;
				const candidate = summary.candidates.find((item) => item.candidateRef === candidateRef);
				const teamId = candidate?.recoverableTeamId;
				const unconfirmed = candidate?.blockingReason === "team_recovery_unconfirmed";
				setTeam(teamId ? { teamId, unconfirmed } : null);
				if (teamId) setOffered(true);
			})
			// The last answer stays. Retry in the dialog, or Check status here, reads it again.
			.catch(() => undefined);
		return () => {
			current = false;
		};
	}, [actions, candidateRef, refreshKey, reloads]);
	return { team, offered, reload: () => setReloads((count) => count + 1) };
}

/** Whether a failed commit may have gone through: no answer, an unreadable one, or no known refusal. */
function commitOutcomeUnknown(cause: unknown): boolean {
	return !(cause instanceof api.TeamRecoveryApiError) || cause.errorCode === "team_recovery_failed";
}

/** The recovery's steps and the calls behind them. */
function useTeamRecovery(
	teamId: string | null,
	actions: TeamRecoveryActions,
	onRecovered: (() => Promise<unknown> | unknown) | undefined,
) {
	const [step, setStep] = useState<Step>({ kind: "idle" });
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const run = async (work: (teamId: string) => Promise<Step>, committing = false) => {
		if (busy || !teamId) return;
		setBusy(true);
		setError("");
		try {
			setStep(await work(teamId));
		} catch (cause) {
			if (committing && commitOutcomeUnknown(cause)) return setStep({ kind: "unconfirmed" });
			// A refused or unsettled recovery needs a new review: its digest no longer holds.
			setStep({ kind: "idle" });
			setError(errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const refreshed = (teamName: string) => refreshAfterRecovery(teamName, onRecovered);
	const review = () =>
		run(async (id) => ({ kind: "review", preview: await actions.preview({ teamId: id }) }));
	const recover = (preview: TeamRecoveryPreviewV1) =>
		run(async (id) => {
			await actions.commit({ teamId: id, expectedDigest: preview.expectedDigest });
			return refreshed(preview.teamName);
		}, true);
	// Refreshes again after a failed refresh. It never recovers the Team a second time.
	const refresh = async (teamName: string) => {
		setStep({ kind: "recovered", teamName, refresh: "running" });
		setStep(await refreshed(teamName));
	};
	const reset = () => setStep({ kind: "idle" });
	return { step, busy, error, review, recover, refresh, reset };
}

/** Refreshes what the dialog was opened from once a recovery went through, and says how that went. */
async function refreshAfterRecovery(
	teamName: string,
	onRecovered: (() => Promise<unknown> | unknown) | undefined,
): Promise<Step> {
	try {
		await onRecovered?.();
		return { kind: "recovered", teamName, refresh: "done" };
	} catch {
		return { kind: "recovered", teamName, refresh: "failed" };
	}
}

export interface TeamRecoveryPanelProps {
	candidateRef: string;
	actions?: Partial<TeamRecoveryActions>;
	/** Runs once the Team is recovered, to refresh what the dialog was opened from. */
	onRecovered?: () => Promise<unknown> | unknown;
	/** Changes when the dialog retries or refreshes, so the panel reads the summary again. */
	refreshKey?: unknown;
}

function PanelButton(props: { busy: boolean; id: string; label: string; onClick: () => void }) {
	return (
		<button
			aria-busy={props.busy ? "true" : undefined}
			aria-disabled={props.busy ? "true" : undefined}
			className="settings-button"
			id={props.id}
			onClick={() => {
				if (!props.busy) props.onClick();
			}}
			type="button"
		>
			{props.label}
		</button>
	);
}

/** The panel once the recovery went through, with a retry for the refresh after it. */
function RecoveredStatus(props: {
	step: Extract<Step, { kind: "recovered" }>;
	onRefresh: (teamName: string) => void;
}) {
	const { teamName, refresh } = props.step;
	return (
		<section className="team-recovery-panel" id="team-recovery-panel">
			<p id="team-recovery-status" role="status">
				{teamName} is recovered. Its devices receive its Projects again.
				{refresh === "failed"
					? " Sharing couldn't be refreshed to show it."
					: " Close this dialog to see the Team in Sharing."}
			</p>
			{refresh === "failed" ? (
				<PanelButton
					busy={false}
					id="team-recovery-refresh"
					label="Refresh Sharing"
					onClick={() => props.onRefresh(teamName)}
				/>
			) : null}
		</section>
	);
}

const NO_LONGER_NEEDED =
	"This Team no longer needs recovery. Close this dialog to see it in Sharing.";
const OUTCOME_UNKNOWN =
	"codemem couldn't confirm whether the Team was recovered. It may already be sharing its Projects again. Check its status before trying again.";

/** The panel's buttons for the step it is at. */
function RecoveryActions(props: {
	step: Step;
	busy: boolean;
	recovery: ReturnType<typeof useTeamRecovery>;
	onCheckStatus: () => void;
}) {
	const { step, busy, recovery } = props;
	if (step.kind === "unconfirmed")
		return (
			<PanelButton
				busy={busy}
				id="team-recovery-check"
				label="Check the Team's status"
				onClick={props.onCheckStatus}
			/>
		);
	if (step.kind !== "review")
		return (
			<PanelButton
				busy={busy}
				id="team-recovery-review-button"
				label={busy ? "Checking the coordinator…" : "Review recovery"}
				onClick={recovery.review}
			/>
		);
	return (
		<div className="team-recovery-actions">
			<PanelButton
				busy={busy}
				id="team-recovery-commit"
				label={busy ? "Recovering…" : "Recover Team"}
				onClick={() => recovery.recover(step.preview)}
			/>
			<PanelButton busy={busy} id="team-recovery-cancel" label="Cancel" onClick={recovery.reset} />
		</div>
	);
}

/**
 * Recovering a Team that was turned off after device removals: review what
 * comes back and what stays out, then recover. Renders nothing unless the Team
 * setup summary names a Team to recover, which it does only on an admin device.
 */
export function TeamRecoveryPanel(props: TeamRecoveryPanelProps) {
	const [actions] = useState(() => ({ ...defaultActions, ...props.actions }));
	const { team, offered, reload } = useRecoverableTeam(
		props.candidateRef,
		actions,
		props.refreshKey,
	);
	const recovery = useTeamRecovery(team?.teamId ?? null, actions, props.onRecovered);
	const { step, busy, error } = recovery;
	if (step.kind === "recovered")
		return <RecoveredStatus onRefresh={recovery.refresh} step={step} />;
	if (!team) return offered ? <NoLongerNeeded /> : null;
	// Checking the status refreshes what the dialog was opened from and reads the summary again.
	const checkStatus = () => {
		recovery.reset();
		Promise.resolve(props.onRecovered?.()).catch(() => undefined);
		reload();
	};
	return (
		<section
			aria-busy={busy ? "true" : "false"}
			className="team-recovery-panel"
			id="team-recovery-panel"
		>
			<strong>Recover this Team</strong>
			<p className="small">{team.unconfirmed ? UNCONFIRMED_INTRO : TURNED_OFF_INTRO}</p>
			{error || step.kind === "unconfirmed" ? (
				<p aria-live="assertive" id="team-recovery-error" role="alert">
					{step.kind === "unconfirmed" ? OUTCOME_UNKNOWN : error}
				</p>
			) : null}
			{step.kind === "review" ? <RecoveryReview preview={step.preview} /> : null}
			<RecoveryActions busy={busy} onCheckStatus={checkStatus} recovery={recovery} step={step} />
		</section>
	);
}

function NoLongerNeeded() {
	return (
		<section className="team-recovery-panel" id="team-recovery-panel">
			<p id="team-recovery-status" role="status">
				{NO_LONGER_NEEDED}
			</p>
		</section>
	);
}
