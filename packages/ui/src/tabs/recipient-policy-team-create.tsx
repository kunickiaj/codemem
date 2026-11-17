import { useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import { isMachinePresentationLabel } from "../lib/identity-presentation";

/** What this device can do on the coordinator, from its coordinator admin status. */
export type CoordinatorAccess =
	| "ready"
	| "admin_secret_missing"
	| "coordinator_missing"
	| "unknown";

const ADMIN_REASON =
	"Only a device that holds the coordinator admin secret can create Teams. Use that device.";
const COORDINATOR_REASON =
	"Connect this device to a coordinator before creating a Team. Set the coordinator URL and group in Settings.";
const UNKNOWN_REASON =
	"codemem couldn't check whether this device can create Teams. Refresh Sharing to try again.";
const REFRESH_REASON =
	"Sharing could not refresh, so changes are paused. Refresh Sharing, then create the Team.";

const UNAVAILABLE_REASONS: Record<Exclude<CoordinatorAccess, "ready">, string> = {
	admin_secret_missing: ADMIN_REASON,
	coordinator_missing: COORDINATOR_REASON,
	unknown: UNKNOWN_REASON,
};

export function teamCreationBlockedReason(
	access: CoordinatorAccess,
	options: { refreshFailed: boolean },
): string | null {
	if (options.refreshFailed) return REFRESH_REASON;
	if (access === "ready") return null;
	return UNAVAILABLE_REASONS[access];
}

function nameValidation(value: string): string {
	const reviewed = value.trim();
	if (!reviewed) return "Team name is required.";
	if ([...reviewed].length > 120) return "Team name must use 120 characters or fewer.";
	if ([...reviewed].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
		return "Team name cannot include control or format characters.";
	}
	if (isMachinePresentationLabel(reviewed)) return "Enter a human-readable Team name.";
	return "";
}

export interface TeamCreateFailure {
	text: string;
	outcomeKnown: boolean;
}

export function teamCreateFailure(cause: unknown, name: string): TeamCreateFailure {
	if (!(cause instanceof api.RecipientPolicyTeamCreateApiError) || !cause.outcomeKnown) {
		return {
			text: "codemem couldn't confirm whether the Team was created. Close this dialog to refresh Sharing, then check the Teams list before trying again.",
			outcomeKnown: false,
		};
	}
	const known: Record<api.RecipientPolicyTeamCreateErrorCode, string> = {
		team_name_invalid: "That name was not accepted. Enter a human-readable Team name.",
		team_name_taken: `A Team named ${name} already exists. Choose a different name.`,
		team_creator_unavailable:
			"codemem couldn't confirm your person on this device, so the Team was not created. Check Devices for setup that needs attention, then try again.",
		team_create_admin_required: `The Team was not created. ${ADMIN_REASON}`,
		team_create_coordinator_required: `The Team was not created. ${COORDINATOR_REASON}`,
		team_create_failed: "The Team was not created. Try again.",
	};
	return { text: known[cause.errorCode], outcomeKnown: true };
}

function useTeamCreation(
	createTeam: (displayName: string) => Promise<api.RecipientPolicyTeamCreateResultV1>,
	blockedReason: string | null,
	onCreated?: () => Promise<unknown> | unknown,
) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [created, setCreated] = useState("");
	const changed = useRef(false);

	const openDialog = () => {
		setDraft("");
		setError("");
		setCreated("");
		changed.current = false;
		setOpen(true);
	};
	// Refresh after closing so the new Team card appears behind the dialog only once.
	const close = () => {
		if (busy) return;
		setOpen(false);
		if (!changed.current) return;
		changed.current = false;
		void onCreated?.();
	};
	const create = async () => {
		if (busy) return;
		const invalid = blockedReason ?? nameValidation(draft);
		if (invalid) {
			setError(invalid);
			return;
		}
		const name = draft.trim();
		setBusy(true);
		setError("");
		try {
			const team = await createTeam(name);
			changed.current = true;
			setCreated(
				`${team.displayName} was created with you as its admin. Add Projects or invite people to it next.`,
			);
		} catch (cause) {
			const failure = teamCreateFailure(cause, name);
			if (!failure.outcomeKnown) changed.current = true;
			setError(failure.text);
		} finally {
			setBusy(false);
		}
	};
	return { busy, close, create, created, draft, error, open, openDialog, setDraft, setError };
}

export function RecipientPolicyTeamCreate({
	access,
	createTeam = api.createRecipientPolicyTeam,
	onCreated,
	refreshFailed,
}: {
	access: CoordinatorAccess;
	createTeam?: (displayName: string) => Promise<api.RecipientPolicyTeamCreateResultV1>;
	onCreated?: () => Promise<unknown> | unknown;
	refreshFailed: boolean;
}) {
	const blockedReason = teamCreationBlockedReason(access, { refreshFailed });
	const state = useTeamCreation((displayName) => createTeam(displayName), blockedReason, onCreated);
	const trigger = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const reasonId = "recipient-policy-team-create-reason";
	return (
		<div className="recipient-policy-team-create">
			<button
				aria-describedby={blockedReason ? reasonId : undefined}
				aria-disabled={blockedReason ? "true" : undefined}
				className="settings-save recipient-policy-sharing-target recipient-policy-sharing-target-24"
				onClick={() => {
					if (!blockedReason) state.openDialog();
				}}
				ref={trigger}
				type="button"
			>
				Create Team
			</button>
			{blockedReason ? (
				<p className="small" id={reasonId}>
					{blockedReason}
				</p>
			) : null}
			<RadixDialog
				ariaDescribedby="recipient-policy-team-create-description"
				ariaLabelledby="recipient-policy-team-create-title"
				contentClassName="modal recipient-policy-team-settings-dialog"
				contentId="recipientPolicyTeamCreateDialog"
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					trigger.current?.focus();
				}}
				onEscapeKeyDown={(event) => {
					if (state.busy) event.preventDefault();
				}}
				onInteractOutside={(event) => {
					if (state.busy) event.preventDefault();
				}}
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					input.current?.focus();
				}}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) state.close();
				}}
				open={state.open}
				overlayClassName="modal-backdrop"
				overlayId="recipientPolicyTeamCreateDialogBackdrop"
			>
				<TeamCreateCard blockedReason={blockedReason} input={input} state={state} />
			</RadixDialog>
		</div>
	);
}

function TeamCreateCard({
	blockedReason,
	input,
	state,
}: {
	blockedReason: string | null;
	input: { current: HTMLInputElement | null };
	state: ReturnType<typeof useTeamCreation>;
}) {
	const { busy, created } = state;
	return (
		<div aria-busy={busy ? "true" : "false"} className="modal-card sync-dialog-card">
			<div className="modal-header">
				<h2 id="recipient-policy-team-create-title">Create Team</h2>
				<DialogCloseButton ariaLabel="Close Create Team" disabled={busy} onClick={state.close} />
			</div>
			<div className="modal-body">
				<p className="small" id="recipient-policy-team-create-description">
					You become the Team's admin. The Team shares nothing until you add Projects to it.
				</p>
				<label className="form-field" htmlFor="recipient-policy-team-create-name">
					<span>Team name</span>
					<input
						disabled={busy || Boolean(created)}
						id="recipient-policy-team-create-name"
						maxLength={120}
						onInput={(event) => {
							state.setDraft(event.currentTarget.value);
							state.setError("");
						}}
						ref={input}
						value={state.draft}
					/>
				</label>
				{blockedReason && !created ? <p className="small">{blockedReason}</p> : null}
				{state.error ? (
					<p aria-live="assertive" role="alert">
						{state.error}
					</p>
				) : null}
				{created ? (
					<p aria-live="polite" role="status">
						{created}
					</p>
				) : null}
			</div>
			<TeamCreateFooter blockedReason={blockedReason} state={state} />
		</div>
	);
}

function TeamCreateFooter({
	blockedReason,
	state,
}: {
	blockedReason: string | null;
	state: ReturnType<typeof useTeamCreation>;
}) {
	const { busy, created } = state;
	if (created) {
		return (
			<div className="modal-footer recipient-policy-team-settings-actions">
				<button className="settings-button" onClick={state.close} type="button">
					Done
				</button>
			</div>
		);
	}
	return (
		<div className="modal-footer recipient-policy-team-settings-actions">
			<button className="settings-button" disabled={busy} onClick={state.close} type="button">
				Cancel
			</button>
			<button
				className="settings-button sync-dialog-confirm"
				disabled={busy || Boolean(blockedReason) || !state.draft.trim()}
				onClick={() => void state.create()}
				type="button"
			>
				{busy ? "Creating…" : "Create Team"}
			</button>
		</div>
	);
}
