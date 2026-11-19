import { useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import { PERSON_NAME_LIMIT, personNameProblem } from "../lib/identity-presentation";

export interface PersonSettingsActions {
	rename: (identityId: string, displayName: string) => Promise<unknown>;
	merge: (survivingIdentityId: string, duplicateIdentityId: string) => Promise<unknown>;
	deactivate: (identityId: string) => Promise<unknown>;
	/** Reads current coordinator status; Sharing's copy can be stale while this dialog is open. */
	canChangeAccess: () => Promise<boolean>;
}

/** Access changes apply only on a ready device that holds the coordinator admin secret. */
export function canChangePersonAccess(status: unknown): boolean {
	if (!status || typeof status !== "object") return false;
	const value = status as { readiness?: unknown; has_admin_secret?: unknown };
	return value.readiness === "ready" && value.has_admin_secret === true;
}

export interface PersonMergeTarget {
	identityId: string;
	label: string;
}

/**
 * The API helpers turn an empty or unreadable success body into `{}`. Success
 * is shown only when the body matches what the route returns after applying the
 * change. Anything else is reported as unconfirmed.
 */
function confirmed(
	payload: unknown,
	applied: (body: Record<string, unknown>) => boolean,
): Record<string, unknown> {
	const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
	if (!applied(body)) throw new Error("person_change_unconfirmed");
	return body;
}

// Resolve the API at call time so importing this module does not read the API surface.
const DEFAULT_ACTIONS: PersonSettingsActions = {
	rename: async (identityId, displayName) =>
		confirmed(
			await api.renameActor(identityId, displayName),
			(body) => body.display_name === displayName,
		),
	merge: async (survivingIdentityId, duplicateIdentityId) =>
		confirmed(
			await api.mergeActor(survivingIdentityId, duplicateIdentityId),
			(body) => typeof body.merged_count === "number",
		),
	deactivate: async (identityId) =>
		confirmed(await api.deactivateActor(identityId), (body) => body.ok === true),
	canChangeAccess: async () => canChangePersonAccess(await api.loadCoordinatorAdminStatus()),
};

type Stage =
	| { kind: "edit" }
	| { kind: "confirm-merge"; target: PersonMergeTarget }
	| { kind: "confirm-remove" }
	| { kind: "done"; message: string };

const DIALOG_ID = "recipientPolicyPersonSettingsDialog";

/**
 * True while a Person settings dialog is open. Sharing's automatic refresh waits
 * for it, because a merged or removed person's card, and the dialog inside it,
 * leave the list as soon as Sharing reloads.
 */
export function isPersonSettingsDialogOpen(): boolean {
	return document.getElementById(DIALOG_ID) !== null;
}
const ACCESS_CHANGE_REASON =
	"Merging or removing a person changes who receives Projects. Only a device with the coordinator admin secret can make that change. Use that device.";

const REFRESH_REASON =
	"Sharing could not refresh, so changes are paused. Close this dialog and refresh Sharing.";

/** Why changes to who receives Projects are unavailable right now, read from current props. */
function accessBlockedReason(disabled: boolean, accessChangesAllowed: boolean): string | null {
	if (disabled) return REFRESH_REASON;
	if (!accessChangesAllowed) return ACCESS_CHANGE_REASON;
	return null;
}

function errorText(cause: unknown): string {
	return cause instanceof Error ? cause.message : "";
}

/**
 * A recognized server rejection means nothing changed. Anything else (a network
 * failure, an unreadable response, an unknown error) may have happened after the
 * server applied the change, so the outcome is reported as unconfirmed.
 */
export interface PersonActionFailure {
	text: string;
	outcomeKnown: boolean;
}

const STALE_PERSON: PersonActionFailure = {
	text: "This person was already removed or merged. Nothing changed. Refresh Sharing to see the current list.",
	outcomeKnown: true,
};

/** Thrown before a merge or removal starts, so nothing changed. */
class AccessCheckFailure extends Error {}

const ACCESS_CHECK_FAILED =
	"codemem couldn't check whether this device can change who receives Projects. Nothing changed. Try again.";

/**
 * Sharing pauses its refresh while this dialog is open, so the access status it
 * passed in can be stale. Read it again right before the change.
 */
async function requireAccess(canChangeAccess: () => Promise<boolean>): Promise<void> {
	let allowed: boolean;
	try {
		allowed = await canChangeAccess();
	} catch {
		throw new AccessCheckFailure(ACCESS_CHECK_FAILED);
	}
	if (!allowed) throw new AccessCheckFailure(ACCESS_CHANGE_REASON);
}

function rejected(text: string): PersonActionFailure {
	return { text, outcomeKnown: true };
}

function unconfirmed(action: string): PersonActionFailure {
	return {
		text: `codemem couldn't confirm whether ${action}. Close this dialog to refresh Sharing, then check before trying again.`,
		outcomeKnown: false,
	};
}

export function renameFailure(cause: unknown): PersonActionFailure {
	const message = errorText(cause);
	if (message === "actor not found") return STALE_PERSON;
	if (message.startsWith("display_name_")) {
		return rejected(
			"That name was not accepted. Enter a human-readable name of 120 characters or fewer.",
		);
	}
	return unconfirmed("the name was saved");
}

const STALE_MERGE_ERRORS = new Set([
	"actor not found",
	"primary actor not active",
	"secondary actor not active",
]);

export function mergeFailure(cause: unknown, name: string, target: string): PersonActionFailure {
	const message = errorText(cause);
	if (message === "actor team memberships conflict") {
		return rejected(
			`${name} and ${target} have different roles or invitation states in the same Team, so they can't be merged. Nothing changed. Keep them separate, or remove ${name} if that entry is no longer used.`,
		);
	}
	if (message === "actor project recipients conflict") {
		return rejected(
			`A Project is shared with both ${name} and ${target}, but one of those shares was stopped. Nothing changed. Make both shares match in Manage projects, then merge again.`,
		);
	}
	if (message === "cannot merge this device's own local actor") {
		return rejected(
			`${name} is you on this device, so it can't be merged away. Nothing changed. Merge the other entry into ${name} instead.`,
		);
	}
	if (STALE_MERGE_ERRORS.has(message)) return STALE_PERSON;
	return unconfirmed(`${name} was merged into ${target}`);
}

export function removeFailure(cause: unknown, name: string): PersonActionFailure {
	const message = errorText(cause);
	if (message === "actor not found" || message === "actor not active") return STALE_PERSON;
	if (message === "cannot deactivate this device's own local actor") {
		return rejected(`${name} is you on this device, so it can't be removed here. Nothing changed.`);
	}
	return unconfirmed(`${name} was removed`);
}

function MergeSection({
	accessChangesAllowed,
	busy,
	mergeTargets,
	name,
	onReview,
}: {
	accessChangesAllowed: boolean;
	busy: boolean;
	mergeTargets: PersonMergeTarget[];
	name: string;
	onReview: (target: PersonMergeTarget) => void;
}) {
	const [targetId, setTargetId] = useState("");
	const target = mergeTargets.find((candidate) => candidate.identityId === targetId);
	const unavailable = !accessChangesAllowed || mergeTargets.length === 0;
	return (
		<section aria-labelledby="recipient-policy-person-merge-title">
			<h3 id="recipient-policy-person-merge-title">Merge duplicates</h3>
			<p className="small">
				If {name} is the same person as someone else here, merge {name} into them.
			</p>
			<label className="form-field" htmlFor="recipient-policy-person-merge-target">
				<span>Same person as</span>
				<select
					disabled={busy || unavailable}
					id="recipient-policy-person-merge-target"
					onChange={(event) => setTargetId(event.currentTarget.value)}
					value={targetId}
				>
					<option value="">Choose a person</option>
					{mergeTargets.map((candidate) => (
						<option key={candidate.identityId} value={candidate.identityId}>
							{candidate.label}
						</option>
					))}
				</select>
			</label>
			{mergeTargets.length === 0 ? (
				<p className="small">No one else is listed in Sharing to merge with.</p>
			) : null}
			<button
				className="settings-button"
				disabled={busy || unavailable || !target}
				onClick={() => target && onReview(target)}
				type="button"
			>
				Review merge
			</button>
		</section>
	);
}

function ConfirmPanel({
	blockedReason,
	busy,
	cancelLabel,
	confirmLabel,
	detail,
	onCancel,
	onConfirm,
	title,
}: {
	blockedReason: string | null;
	busy: boolean;
	cancelLabel: string;
	confirmLabel: string;
	detail: string;
	onCancel: () => void;
	onConfirm: () => void;
	title: string;
}) {
	return (
		<section aria-labelledby="recipient-policy-person-confirm-title">
			<h3 id="recipient-policy-person-confirm-title">{title}</h3>
			<p>{detail}</p>
			{blockedReason ? <p className="small">{blockedReason}</p> : null}
			<div className="recipient-policy-team-settings-actions">
				<button className="settings-button" disabled={busy} onClick={onCancel} type="button">
					{cancelLabel}
				</button>
				<button
					className="settings-button danger"
					disabled={busy || Boolean(blockedReason)}
					onClick={onConfirm}
					type="button"
				>
					{busy ? "Working…" : confirmLabel}
				</button>
			</div>
		</section>
	);
}

function confirmPanelProps(
	stage: Extract<Stage, { kind: "confirm-merge" | "confirm-remove" }>,
	name: string,
) {
	if (stage.kind === "confirm-merge") {
		const target = stage.target.label;
		return {
			title: `Merge ${name} into ${target}?`,
			detail: `${name}'s devices, Teams, and shared Projects move to ${target}, and ${name} is no longer listed in Sharing. This can't be undone.`,
			confirmLabel: "Merge people",
			cancelLabel: "Keep separate",
		};
	}
	return {
		title: `Remove ${name}?`,
		detail: `${name}'s devices stop receiving every Project shared with ${name}, directly or through a Team. Memories already on those devices stay there. This can't be undone.`,
		confirmLabel: "Remove person",
		cancelLabel: "Keep",
	};
}

function usePersonAction(onSuccess: (message: string) => void) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const changed = useRef(false);
	const run = async (
		action: () => Promise<unknown>,
		success: string,
		failure: (cause: unknown) => PersonActionFailure,
	) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await action();
			changed.current = true;
			onSuccess(success);
		} catch (cause) {
			const outcome = failure(cause);
			// An unconfirmed change may have been applied, so refresh on close.
			if (!outcome.outcomeKnown) changed.current = true;
			setError(outcome.text);
		} finally {
			setBusy(false);
		}
	};
	return { busy, changed, error, run, setError };
}

function accessChangeRequest(
	stage: Extract<Stage, { kind: "confirm-merge" | "confirm-remove" }>,
	person: { actions: PersonSettingsActions; displayName: string; identityId: string },
) {
	const request = unguardedAccessChange(stage, person);
	return {
		action: async () => {
			await requireAccess(person.actions.canChangeAccess);
			return request.action();
		},
		success: request.success,
		failure: (cause: unknown) =>
			cause instanceof AccessCheckFailure ? rejected(cause.message) : request.failure(cause),
	};
}

function unguardedAccessChange(
	stage: Extract<Stage, { kind: "confirm-merge" | "confirm-remove" }>,
	person: { actions: PersonSettingsActions; displayName: string; identityId: string },
) {
	const { actions, displayName, identityId } = person;
	if (stage.kind === "confirm-merge") {
		const target = stage.target;
		return {
			action: () => actions.merge(target.identityId, identityId),
			success: `${displayName} was merged into ${target.label}.`,
			failure: (cause: unknown) => mergeFailure(cause, displayName, target.label),
		};
	}
	return {
		action: () => actions.deactivate(identityId),
		success: `${displayName} was removed. Their devices stop receiving shared Projects once this device updates the coordinator.`,
		failure: (cause: unknown) => removeFailure(cause, displayName),
	};
}

function usePersonSettingsState({
	actions,
	blockedReason,
	disabled,
	displayName,
	identityId,
	onChanged,
}: {
	actions: PersonSettingsActions;
	/** Current reason access changes are unavailable; checked again at submit time. */
	blockedReason: string | null;
	disabled: boolean;
	displayName: string;
	identityId: string;
	onChanged?: () => Promise<unknown> | unknown;
}) {
	const [open, setOpen] = useState(false);
	const [stage, setStage] = useState<Stage>({ kind: "edit" });
	const [draft, setDraft] = useState(displayName);
	const { busy, changed, error, run, setError } = usePersonAction((message) =>
		setStage({ kind: "done", message }),
	);

	const openDialog = () => {
		setStage({ kind: "edit" });
		setDraft(displayName);
		setError("");
		changed.current = false;
		setOpen(true);
	};
	// Refresh only after the dialog closes, so a merged or removed card does not
	// unmount while its result is still on screen.
	const close = () => {
		if (busy) return;
		setOpen(false);
		if (!changed.current) return;
		changed.current = false;
		void onChanged?.();
	};
	const saveName = () => {
		const invalid = disabled ? REFRESH_REASON : personNameProblem(draft);
		if (invalid) {
			setError(invalid);
			return;
		}
		// Match the server, which collapses runs of whitespace before saving.
		const nextName = draft.replace(/\s+/gu, " ").trim();
		void run(() => actions.rename(identityId, nextName), `Renamed to ${nextName}.`, renameFailure);
	};
	const confirm = () => {
		if (stage.kind !== "confirm-merge" && stage.kind !== "confirm-remove") return;
		if (blockedReason) {
			setError(blockedReason);
			return;
		}
		const request = accessChangeRequest(stage, { actions, displayName, identityId });
		void run(request.action, request.success, request.failure);
	};
	return {
		blockedReason,
		busy,
		close,
		confirm,
		disabled,
		draft,
		error,
		open,
		openDialog,
		saveName,
		setDraft: (value: string) => {
			setDraft(value);
			setError("");
		},
		setStage: (next: Stage) => {
			setStage(next);
			setError("");
		},
		stage,
	};
}

export function RecipientPolicyPersonSettings({
	accessChangesAllowed,
	actions = DEFAULT_ACTIONS,
	disabled,
	displayName,
	identityId,
	mergeTargets,
	onChanged,
}: {
	accessChangesAllowed: boolean;
	actions?: PersonSettingsActions;
	disabled: boolean;
	displayName: string;
	identityId: string;
	mergeTargets: PersonMergeTarget[];
	onChanged?: () => Promise<unknown> | unknown;
}) {
	const settings = usePersonSettingsState({
		actions,
		blockedReason: accessBlockedReason(disabled, accessChangesAllowed),
		disabled,
		displayName,
		identityId,
		onChanged,
	});
	const trigger = useRef<HTMLButtonElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const { busy } = settings;

	return (
		<>
			<button
				aria-disabled={disabled ? "true" : undefined}
				aria-label={`Person settings for ${displayName}`}
				className="settings-button recipient-policy-sharing-target recipient-policy-sharing-target-24"
				onClick={() => {
					if (!disabled) settings.openDialog();
				}}
				ref={trigger}
				type="button"
			>
				Person settings
			</button>
			<RadixDialog
				ariaDescribedby="recipient-policy-person-settings-description"
				ariaLabelledby="recipient-policy-person-settings-title"
				contentClassName="modal recipient-policy-team-settings-dialog recipient-policy-person-settings-dialog"
				contentId={DIALOG_ID}
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
					if (!nextOpen) settings.close();
				}}
				open={settings.open}
				overlayClassName="modal-backdrop"
				overlayId="recipientPolicyPersonSettingsDialogBackdrop"
			>
				<PersonSettingsCard
					input={input}
					mergeTargets={mergeTargets}
					name={displayName}
					settings={settings}
				/>
			</RadixDialog>
		</>
	);
}

function PersonSettingsCard({
	input,
	mergeTargets,
	name,
	settings,
}: {
	input: { current: HTMLInputElement | null };
	mergeTargets: PersonMergeTarget[];
	name: string;
	settings: ReturnType<typeof usePersonSettingsState>;
}) {
	const { busy, stage } = settings;
	return (
		<div aria-busy={busy ? "true" : "false"} className="modal-card sync-dialog-card">
			<div className="modal-header">
				<h2 id="recipient-policy-person-settings-title">Person settings</h2>
				<DialogCloseButton
					ariaLabel="Close person settings"
					disabled={busy}
					onClick={settings.close}
				/>
			</div>
			<div className="modal-body">
				<p className="small" id="recipient-policy-person-settings-description">
					Rename {name}, merge a duplicate entry, or remove {name} from Sharing.
				</p>
				<PersonSettingsBody
					input={input}
					mergeTargets={mergeTargets}
					name={name}
					settings={settings}
				/>
				{settings.error ? (
					<p aria-live="assertive" role="alert">
						{settings.error}
					</p>
				) : null}
			</div>
			<div className="modal-footer recipient-policy-team-settings-actions">
				<button className="settings-button" disabled={busy} onClick={settings.close} type="button">
					{stage.kind === "done" ? "Done" : "Close"}
				</button>
			</div>
		</div>
	);
}

function PersonSettingsBody({
	input,
	mergeTargets,
	name,
	settings,
}: {
	input: { current: HTMLInputElement | null };
	mergeTargets: PersonMergeTarget[];
	name: string;
	settings: ReturnType<typeof usePersonSettingsState>;
}) {
	const { blockedReason, busy, stage } = settings;
	if (stage.kind === "done") {
		return (
			<p aria-live="polite" role="status">
				{stage.message}
			</p>
		);
	}
	if (stage.kind !== "edit") {
		return (
			<ConfirmPanel
				{...confirmPanelProps(stage, name)}
				blockedReason={blockedReason}
				busy={busy}
				onCancel={() => settings.setStage({ kind: "edit" })}
				onConfirm={settings.confirm}
			/>
		);
	}
	return (
		<>
			<section aria-labelledby="recipient-policy-person-name-title">
				<h3 id="recipient-policy-person-name-title">Name</h3>
				<label className="form-field" htmlFor="recipient-policy-person-settings-name">
					<span>Name shown in Sharing</span>
					<input
						disabled={busy}
						id="recipient-policy-person-settings-name"
						maxLength={PERSON_NAME_LIMIT}
						onInput={(event) => settings.setDraft(event.currentTarget.value)}
						ref={input}
						value={settings.draft}
					/>
				</label>
				<button
					className="settings-button sync-dialog-confirm"
					disabled={
						busy || settings.disabled || !settings.draft.trim() || settings.draft.trim() === name
					}
					onClick={settings.saveName}
					type="button"
				>
					{busy ? "Saving…" : "Save name"}
				</button>
			</section>
			<MergeSection
				accessChangesAllowed={!blockedReason}
				busy={busy}
				mergeTargets={mergeTargets}
				name={name}
				onReview={(target) => settings.setStage({ kind: "confirm-merge", target })}
			/>
			<section aria-labelledby="recipient-policy-person-remove-title">
				<h3 id="recipient-policy-person-remove-title">Remove person</h3>
				<p className="small">
					{name}'s devices stop receiving the Projects shared with {name}.
				</p>
				<button
					className="settings-button danger"
					disabled={busy || Boolean(blockedReason)}
					onClick={() => settings.setStage({ kind: "confirm-remove" })}
					type="button"
				>
					Remove {name}
				</button>
			</section>
			{blockedReason ? <p className="small">{blockedReason}</p> : null}
		</>
	);
}
