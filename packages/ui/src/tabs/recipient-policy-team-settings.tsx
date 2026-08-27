import { useEffect, useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import { isMachinePresentationLabel } from "../lib/identity-presentation";

function validation(value: string): string {
	const reviewed = value.trim();
	if (!reviewed) return "Team name is required.";
	if ([...reviewed].length > 120) return "Team name must use 120 characters or fewer.";
	if ([...reviewed].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
		return "Team name cannot include control or format characters.";
	}
	if (isMachinePresentationLabel(reviewed)) return "Enter a human-readable Team name.";
	return "";
}

function safeError(cause: unknown): string {
	if (!(cause instanceof api.RecipientPolicyTeamRenameApiError)) {
		return "The Team could not be renamed. Try again.";
	}
	if (cause.errorCode === "team_name_invalid") return "Enter a valid human-readable Team name.";
	if (cause.errorCode === "team_not_found") {
		return "This Team is no longer available. Refresh Sharing and try again.";
	}
	if (cause.errorCode === "team_rename_stale") {
		return "This Team changed since you opened settings. Refresh Sharing and try again.";
	}
	if (cause.errorCode === "team_link_stale") {
		return "This Team’s connected setup is no longer configured. Refresh Sharing before renaming it.";
	}
	if (cause.errorCode === "team_link_ambiguous") {
		return "This Team has conflicting connected setup records. Nothing was changed. Review the Team setup before retrying.";
	}
	if (cause.errorCode === "team_coordinator_rename_failed") {
		return "The connected Team service could not be updated. Nothing changed locally. Try again.";
	}
	if (cause.errorCode === "team_local_rename_pending") {
		return "The connected Team service was updated, but Sharing could not save the name locally. Try again to finish.";
	}
	return "The Team could not be renamed safely. Try again.";
}

export function RecipientPolicyTeamSettings({
	descriptionId,
	disabled,
	displayName,
	onRenamed,
	renameTeam = api.renameRecipientPolicyTeam,
	teamId,
}: {
	descriptionId?: string;
	disabled: boolean;
	displayName: string;
	onRenamed?: () => Promise<unknown> | unknown;
	renameTeam?: typeof api.renameRecipientPolicyTeam;
	teamId: string;
}) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState(displayName);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [success, setSuccess] = useState("");
	const trigger = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const done = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (success && !busy) done.current?.focus();
	}, [busy, success]);

	const close = () => {
		if (busy) return;
		setOpen(false);
		setError("");
		setSuccess("");
	};
	const save = async () => {
		const invalid = validation(draft);
		if (invalid) {
			setError(invalid);
			return;
		}
		if (busy) return;
		setBusy(true);
		setError("");
		setSuccess("");
		try {
			const result = await renameTeam({
				teamId,
				displayName: draft,
				expectedDisplayName: displayName,
			});
			setDraft(result.displayName);
			setSuccess(`Team renamed to ${result.displayName}.`);
			try {
				const refreshed = await onRenamed?.();
				if (refreshed === false) {
					setSuccess(`Team renamed to ${result.displayName}, but Sharing could not refresh.`);
				}
			} catch {
				setSuccess(`Team renamed to ${result.displayName}, but Sharing could not refresh.`);
			}
		} catch (cause) {
			setError(safeError(cause));
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<button
				aria-describedby={descriptionId}
				aria-disabled={disabled ? "true" : undefined}
				aria-label={`Team settings for ${displayName}`}
				className="settings-button recipient-policy-sharing-target recipient-policy-sharing-target-24"
				onClick={() => {
					if (disabled) return;
					setDraft(displayName);
					setError("");
					setSuccess("");
					setOpen(true);
				}}
				ref={trigger}
				type="button"
			>
				Team settings
			</button>
			<RadixDialog
				ariaDescribedby="recipient-policy-team-settings-description"
				ariaLabelledby="recipient-policy-team-settings-title"
				contentClassName="modal recipient-policy-team-settings-dialog"
				contentId="recipientPolicyTeamSettingsDialog"
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
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					input.current?.focus();
					input.current?.select();
				}}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) close();
				}}
				open={open}
				overlayClassName="modal-backdrop"
				overlayId="recipientPolicyTeamSettingsDialogBackdrop"
			>
				<div aria-busy={busy ? "true" : "false"} className="modal-card sync-dialog-card">
					<div className="modal-header">
						<h2 id="recipient-policy-team-settings-title">Team settings</h2>
						<DialogCloseButton ariaLabel="Close Team settings" disabled={busy} onClick={close} />
					</div>
					<div className="modal-body">
						<p className="small" id="recipient-policy-team-settings-description">
							Change the name shown for this Team in Sharing.
						</p>
						<label className="form-field" htmlFor="recipient-policy-team-settings-name">
							<span>Team name</span>
							<input
								disabled={busy || Boolean(success)}
								id="recipient-policy-team-settings-name"
								maxLength={120}
								onInput={(event) => {
									setDraft(event.currentTarget.value);
									setError("");
								}}
								ref={input}
								value={draft}
							/>
						</label>
						{busy ? (
							<p aria-live="polite" role="status">
								Saving Team name…
							</p>
						) : null}
						{error ? (
							<p aria-live="assertive" role="alert">
								{error}
							</p>
						) : null}
						{success ? (
							<p aria-live="polite" role="status">
								{success}
							</p>
						) : null}
					</div>
					<div className="modal-footer recipient-policy-team-settings-actions">
						<button
							className="settings-button"
							disabled={busy}
							onClick={close}
							ref={done}
							type="button"
						>
							{success ? "Done" : "Cancel"}
						</button>
						{success ? null : (
							<button
								className="settings-button sync-dialog-confirm"
								disabled={busy || !draft.trim() || draft.trim() === displayName}
								onClick={() => void save()}
								type="button"
							>
								{busy ? "Saving…" : error ? "Try again" : "Save"}
							</button>
						)}
					</div>
				</div>
			</RadixDialog>
		</>
	);
}
