import { useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import type { TeamInvitationRevokeResult } from "../lib/api/team-member-removal";

export interface TeamMemberRemovalActions {
	preview: typeof api.previewTeamMemberRemoval;
	commit: typeof api.commitTeamMemberRemoval;
	retryRevokes: typeof api.retryTeamInvitationRevokes;
}

// Read at call time, so a module that mocks the API only in part can still load this one.
const defaultActions: TeamMemberRemovalActions = {
	preview: (input) => api.previewTeamMemberRemoval(input),
	commit: (input) => api.commitTeamMemberRemoval(input),
	retryRevokes: (input) => api.retryTeamInvitationRevokes(input),
};

const ERRORS: Partial<Record<string, string>> = {
	coordinator_admin_required:
		"Only a device that holds the coordinator admin secret can remove people. Use that device.",
	team_not_found: "This Team is no longer available. Refresh Sharing and try again.",
	team_not_linked:
		"This Team isn't connected to a coordinator group yet, so nobody can be removed from it here.",
	team_link_conflict:
		"This Team's coordinator group is unclear, so removals are paused. Bind the Team to one group on the coordinator, then try again.",
	team_coordinator_not_configured:
		"This Team belongs to a coordinator or group this device isn't set up for. Use a device configured for it.",
	member_not_found: "This person is no longer a member. Refresh Sharing.",
	member_already_removed: "This person was already removed from the Team. Refresh Sharing.",
	cannot_remove_yourself: "You can't remove yourself from a Team.",
	invitations_unavailable:
		"The Team's pending invitations couldn't be read from the coordinator. Nothing changed. Try again.",
	removal_preview_stale:
		"Something changed since you reviewed this removal. Nothing changed. Review it again.",
	coordinator_unavailable:
		"The coordinator couldn't record the removal. Nothing changed. Try again.",
};

/** The commit's answer was lost or unreadable, so the removal may have been recorded. */
const COMMIT_OUTCOME_UNKNOWN =
	"codemem couldn't confirm whether the removal was recorded. Close this dialog to refresh Sharing, then check the Team before trying again.";

function errorCode(cause: unknown): string {
	return cause instanceof api.TeamMemberRemovalApiError ? cause.errorCode : "";
}

function errorMessage(cause: unknown): string {
	return (
		ERRORS[errorCode(cause)] ?? "The removal couldn't be completed. Nothing changed. Try again."
	);
}

/**
 * A commit may have been recorded before its answer was lost: with no known
 * refusal code, and with `coordinator_unavailable`, which core also returns
 * when the coordinator's answer to the record call timed out or was unreadable.
 */
function commitOutcomeUnknown(cause: unknown): boolean {
	const code = errorCode(cause);
	return !ERRORS[code] || code === "coordinator_unavailable";
}

const STILL_OPEN: ReadonlySet<TeamInvitationRevokeResult> = new Set(["unknown"]);

type Step =
	| { kind: "choose" }
	| { kind: "review"; preview: api.TeamMemberRemovalPreview; revoke: Set<string> }
	| {
			kind: "done";
			name: string;
			result: api.TeamMemberRemovalCommit;
			/** The invitations the review listed, to name them in the result. */
			reviewed: api.TeamMemberRemovalPreview["pendingInvitations"];
	  };

export interface RemovableMember {
	identityId: string;
	displayName: string;
}

/**
 * Removing one person from one Team: pick the person, review what they lose and
 * which pending invitations to revoke, then remove. Shown only on a device that
 * holds the coordinator admin secret.
 */
/** The dialog's steps and the calls behind them. */
function useTeamMemberRemoval(input: {
	actions: TeamMemberRemovalActions;
	onRemoved?: () => Promise<unknown> | unknown;
	teamId: string;
}) {
	const { actions, onRemoved, teamId } = input;
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState<Step>({ kind: "choose" });
	const [chosen, setChosen] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// Set when a commit's outcome is unknown: closing then refreshes Sharing.
	const [maybeRemoved, setMaybeRemoved] = useState(false);

	const run = async (work: () => Promise<void>, options: { committing?: boolean } = {}) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (cause) {
			const unknown = options.committing === true && commitOutcomeUnknown(cause);
			if (unknown) setMaybeRemoved(true);
			setError(unknown ? COMMIT_OUTCOME_UNKNOWN : errorMessage(cause));
		} finally {
			setBusy(false);
		}
	};
	const close = () => {
		if (busy) return;
		const refresh = step.kind === "done" || maybeRemoved;
		setOpen(false);
		setStep({ kind: "choose" });
		setChosen("");
		setError("");
		setMaybeRemoved(false);
		if (refresh) void onRemoved?.();
	};
	const handlers = {
		onBack: () => setStep({ kind: "choose" }),
		onChoose: setChosen,
		onClose: close,
		onReview: () =>
			run(async () => {
				const preview = await actions.preview({ teamId, identityId: chosen });
				const revoke = new Set(preview.pendingInvitations.map((invite) => invite.inviteId));
				setStep({ kind: "review", preview, revoke });
			}),
		onRemove: (current: ReviewState) =>
			run(async () => setStep(await commitReviewed(actions, teamId, current)), {
				committing: true,
			}),
		onRetry: (current: DoneState) =>
			run(async () => setStep(await retryFailedRevokes(actions, teamId, current))),
		onToggle: (current: ReviewState, inviteId: string) => setStep(toggled(current, inviteId)),
	};
	return { open, setOpen, step, chosen, busy, error, close, handlers };
}

type ReviewState = Extract<Step, { kind: "review" }>;
type DoneState = Extract<Step, { kind: "done" }>;

async function commitReviewed(
	actions: TeamMemberRemovalActions,
	teamId: string,
	current: ReviewState,
): Promise<DoneState> {
	const result = await actions.commit({
		teamId,
		identityId: current.preview.identityId,
		expectedDigest: current.preview.expectedDigest,
		revokeInvitationIds: [...current.revoke],
	});
	return {
		kind: "done",
		name: current.preview.displayName,
		result,
		reviewed: current.preview.pendingInvitations,
	};
}

async function retryFailedRevokes(
	actions: TeamMemberRemovalActions,
	teamId: string,
	current: DoneState,
): Promise<DoneState> {
	const failed = current.result.invitations.filter((row) => STILL_OPEN.has(row.result));
	const retried = await actions.retryRevokes({
		teamId,
		inviteIds: failed.map((row) => row.inviteId),
	});
	const byId = new Map(retried.map((row) => [row.inviteId, row.result]));
	const invitations = current.result.invitations.map((row) => ({
		...row,
		result: byId.get(row.inviteId) ?? row.result,
	}));
	return { ...current, result: { ...current.result, invitations } };
}

function toggled(current: ReviewState, inviteId: string): ReviewState {
	const revoke = new Set(current.revoke);
	if (revoke.has(inviteId)) revoke.delete(inviteId);
	else revoke.add(inviteId);
	return { ...current, revoke };
}

/**
 * Removing one person from one Team: pick the person, review what they lose and
 * which pending invitations to revoke, then remove. Shown only on a device that
 * holds the coordinator admin secret.
 */
export function RecipientPolicyTeamMemberRemoval({
	actions = defaultActions,
	disabled,
	members,
	onRemoved,
	teamId,
	teamName,
}: {
	actions?: TeamMemberRemovalActions;
	disabled: boolean;
	members: RemovableMember[];
	onRemoved?: () => Promise<unknown> | unknown;
	teamId: string;
	teamName: string;
}) {
	const removal = useTeamMemberRemoval({ actions, onRemoved, teamId });
	const trigger = useRef<HTMLButtonElement>(null);
	return (
		<>
			<button
				aria-disabled={disabled ? "true" : undefined}
				aria-label={`Remove a member from ${teamName}`}
				className="settings-button recipient-policy-sharing-target recipient-policy-sharing-target-24"
				onClick={() => {
					if (!disabled) removal.setOpen(true);
				}}
				ref={trigger}
				type="button"
			>
				Remove member
			</button>
			<RemovalDialog removal={removal} members={members} teamName={teamName} trigger={trigger} />
		</>
	);
}

function RemovalDialog({
	members,
	removal,
	teamName,
	trigger,
}: {
	members: RemovableMember[];
	removal: ReturnType<typeof useTeamMemberRemoval>;
	teamName: string;
	trigger: { current: HTMLButtonElement | null };
}) {
	const { busy } = removal;
	return (
		<RadixDialog
			ariaDescribedby="recipient-policy-team-member-removal-description"
			ariaLabelledby="recipient-policy-team-member-removal-title"
			contentClassName="modal recipient-policy-team-member-removal-dialog"
			contentId="recipientPolicyTeamMemberRemovalDialog"
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				trigger.current?.focus();
			}}
			onEscapeKeyDown={(event) => {
				if (busy) event.preventDefault();
			}}
			onInteractOutside={(event) => {
				if (busy) event.preventDefault();
			}}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) removal.close();
			}}
			open={removal.open}
			overlayClassName="modal-backdrop"
			overlayId="recipientPolicyTeamMemberRemovalDialogBackdrop"
		>
			<div aria-busy={busy ? "true" : "false"} className="modal-card sync-dialog-card">
				<div className="modal-header">
					<h2 id="recipient-policy-team-member-removal-title">Remove a member from {teamName}</h2>
					<DialogCloseButton ariaLabel="Close" disabled={busy} onClick={removal.close} />
				</div>
				<RemovalStep
					{...removal.handlers}
					busy={busy}
					chosen={removal.chosen}
					error={removal.error}
					members={members}
					step={removal.step}
					teamName={teamName}
				/>
			</div>
		</RadixDialog>
	);
}

interface StepProps {
	busy: boolean;
	chosen: string;
	error: string;
	members: RemovableMember[];
	onBack: () => void;
	onChoose: (identityId: string) => void;
	onClose: () => void;
	onRemove: (step: ReviewState) => void;
	onRetry: (step: DoneState) => void;
	onReview: () => void;
	onToggle: (step: ReviewState, inviteId: string) => void;
	step: Step;
	teamName: string;
}

function RemovalStep(props: StepProps) {
	const { step } = props;
	if (step.kind === "review") return <ReviewStep {...props} step={step} />;
	if (step.kind === "done") return <DoneStep {...props} step={step} />;
	return <ChooseStep {...props} />;
}

function Status({ busy, error, busyText }: { busy: boolean; error: string; busyText: string }) {
	return (
		<>
			{busy ? (
				<p aria-live="polite" role="status">
					{busyText}
				</p>
			) : null}
			{error ? (
				<p aria-live="assertive" role="alert">
					{error}
				</p>
			) : null}
		</>
	);
}

function ChooseStep({ busy, chosen, error, members, onChoose, onClose, onReview }: StepProps) {
	return (
		<>
			<div className="modal-body">
				<p className="small" id="recipient-policy-team-member-removal-description">
					Choose who to remove. You'll review what changes before anything happens.
				</p>
				<fieldset className="recipient-policy-team-member-removal-members">
					<legend>Members</legend>
					{members.map((member) => (
						<label className="form-field form-field--inline" key={member.identityId}>
							<input
								checked={chosen === member.identityId}
								disabled={busy}
								name="recipient-policy-team-member-removal-member"
								onChange={() => onChoose(member.identityId)}
								type="radio"
								value={member.identityId}
							/>
							<span>{member.displayName}</span>
						</label>
					))}
				</fieldset>
				<Status busy={busy} busyText="Checking what changes…" error={error} />
			</div>
			<div className="modal-footer">
				<button className="settings-button" disabled={busy} onClick={onClose} type="button">
					Cancel
				</button>
				<button
					className="settings-button sync-dialog-confirm"
					disabled={busy || !chosen}
					onClick={onReview}
					type="button"
				>
					Review removal
				</button>
			</div>
		</>
	);
}

function ReviewStep({
	busy,
	error,
	onBack,
	onRemove,
	onToggle,
	step,
	teamName,
}: StepProps & { step: Extract<Step, { kind: "review" }> }) {
	const { preview } = step;
	return (
		<>
			<div className="modal-body">
				<p id="recipient-policy-team-member-removal-description">
					{preview.displayName} stops receiving {teamName}'s Projects. This can't be undone: they
					can rejoin only through a new Team invitation, as a new person.
				</p>
				<DeviceList devices={preview.devices} />
				<InvitationChoices
					busy={busy}
					onToggle={(inviteId) => onToggle(step, inviteId)}
					step={step}
				/>
				<Status busy={busy} busyText={`Removing ${preview.displayName}…`} error={error} />
			</div>
			<div className="modal-footer">
				<button className="settings-button" disabled={busy} onClick={onBack} type="button">
					Back
				</button>
				<button
					className="settings-button sync-dialog-confirm"
					disabled={busy}
					onClick={() => onRemove(step)}
					type="button"
				>
					Remove {preview.displayName}
				</button>
			</div>
		</>
	);
}

function DeviceList({ devices }: { devices: api.TeamMemberRemovalPreview["devices"] }) {
	if (devices.length === 0) return <p className="small">They have no registered devices.</p>;
	return (
		<>
			<p className="small">These devices stop receiving the Team's Projects:</p>
			<ul>
				{devices.map((device) => (
					<li key={device.deviceId}>{device.displayName || "Unnamed device"}</li>
				))}
			</ul>
		</>
	);
}

function InvitationChoices({
	busy,
	onToggle,
	step,
}: {
	busy: boolean;
	onToggle: (inviteId: string) => void;
	step: Extract<Step, { kind: "review" }>;
}) {
	const invitations = step.preview.pendingInvitations;
	if (invitations.length === 0)
		return <p className="small">The Team has no pending invitations.</p>;
	return (
		<fieldset className="recipient-policy-team-member-removal-invitations">
			<legend>Revoke pending invitations</legend>
			<p className="small">
				The coordinator can't tell whose invitation is whose. Revoke any that{" "}
				{step.preview.displayName} could still use to rejoin.
			</p>
			{invitations.map((invite) => (
				<label className="form-field form-field--inline" key={invite.inviteId}>
					<input
						checked={step.revoke.has(invite.inviteId)}
						disabled={busy}
						onChange={() => onToggle(invite.inviteId)}
						type="checkbox"
					/>
					<span>{invitationLabel(invite)}</span>
				</label>
			))}
		</fieldset>
	);
}

type ReviewedInvitation = api.TeamMemberRemovalPreview["pendingInvitations"][number];

function invitationLabel(invite: ReviewedInvitation): string {
	return `Created ${invite.createdAt.slice(0, 10)}, expires ${invite.expiresAt.slice(0, 10)}`;
}

function failedRevokeText(count: number): string {
	if (count === 1) return "1 invitation couldn't be revoked and can still be used.";
	return `${count} invitations couldn't be revoked and can still be used.`;
}

function acceptedText(invite: ReviewedInvitation | undefined): string {
	const name = invite ? `The invitation created ${invite.createdAt.slice(0, 10)}` : "An invitation";
	return `${name} was accepted before it could be revoked. Check the Team's members.`;
}

/** Invitations someone accepted before they could be revoked. */
function AcceptedInvitations({ step }: { step: DoneState }) {
	const accepted = step.result.invitations
		.filter((row) => row.result === "accepted")
		.map((row) => ({
			inviteId: row.inviteId,
			text: acceptedText(step.reviewed.find((invite) => invite.inviteId === row.inviteId)),
		}));
	if (accepted.length === 0) return null;
	return (
		<ul className="small" role="alert">
			{accepted.map((row) => (
				<li key={row.inviteId}>{row.text}</li>
			))}
		</ul>
	);
}

function DoneStep({ busy, error, onClose, onRetry, step }: StepProps & { step: DoneState }) {
	const failed = step.result.invitations.filter((row) => STILL_OPEN.has(row.result)).length;
	return (
		<>
			<div className="modal-body">
				<p aria-live="polite" id="recipient-policy-team-member-removal-description" role="status">
					{step.name} was removed from the Team.
				</p>
				{step.result.appliedHere ? null : (
					<p className="small">
						This device couldn't apply the removal yet. It applies it at its next coordinator check.
					</p>
				)}
				<AcceptedInvitations step={step} />
				{failed > 0 ? (
					<p className="small" role="alert">
						{failedRevokeText(failed)}
					</p>
				) : null}
				<Status busy={busy} busyText="Revoking invitations…" error={error} />
			</div>
			<div className="modal-footer">
				{failed > 0 ? (
					<button
						className="settings-button"
						disabled={busy}
						onClick={() => onRetry(step)}
						type="button"
					>
						Retry revoking
					</button>
				) : null}
				<button
					className="settings-button sync-dialog-confirm"
					disabled={busy}
					onClick={onClose}
					type="button"
				>
					Done
				</button>
			</div>
		</>
	);
}
