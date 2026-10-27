import { useEffect, useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { RadixDialog, RadixDialogTitle } from "../components/primitives/radix-dialog";
import {
	RecoveryAssistance,
	type RecoveryAssistanceProps,
} from "./account-owner-recovery-assistance";
import {
	matchesRecoveryPreview,
	type RecoveryPreview,
	type RecoveryPreviewRequest,
	type RecoveryProfile,
	type RecoveryResult,
	type RecoverySelection,
	recoveryProfileKey,
	sameGroups,
} from "./account-owner-recovery-types";

/** Inert UI contract. Callbacks dispatch commands; the adapter owns async errors and authority. */
export interface AccountOwnerRecoveryProps {
	open: boolean;
	profile: RecoveryProfile;
	candidates: readonly { id: string; label?: string }[];
	reviewAccess: "operator" | "request";
	preview: RecoveryPreview | null;
	result?: RecoveryResult | null;
	/** Original dispatched target, retained by the adapter across dialog openings. */
	submittedPreview?: RecoveryPreview | null;
	busy: boolean;
	error?: string | null;
	message?: string | null;
	returnFocus: { readonly current: HTMLElement | null };
	onClose: () => void;
	onSelectionChange?: () => void;
	/** Both purposes are read-only; check_status must never reapply an operation. */
	onPreview: (args: RecoveryPreviewRequest) => void;
	onConfirm: (args: { preview: RecoveryPreview; approvalDigest: string }) => void;
	onCopyRequest?: RecoveryAssistanceProps["onCopyRequest"];
	onImportReply?: RecoveryAssistanceProps["onImportReply"];
}

export function AccountOwnerRecovery(props: AccountOwnerRecoveryProps) {
	// Remount local choices on any public profile change and on every new opening.
	if (!props.open) return null;
	return <RecoveryDialog key={recoveryProfileKey(props.profile)} {...props} />;
}

function matchStatusPreview(
	preview: RecoveryPreview | null,
	request: RecoveryPreviewRequest | null,
	requestId: string | null,
): RecoveryPreview | null {
	if (request?.purpose !== "check_status") return null;
	return matchesRecoveryPreview(preview, request, requestId) ? preview : null;
}

function useRecoveryReview(props: AccountOwnerRecoveryProps, id: string) {
	const status = useRecoveryStatusTarget(props);
	const activeRequest = useRef<string | null>(null);
	const [owner, setOwner] = useState("");
	const [groups, setGroups] = useState<readonly string[]>([...props.profile.configuredGroups]);
	const [request, setRequest] = useState<RecoveryPreviewRequest | null>(null);
	const selection = { profile: props.profile, existingOwnerId: owner, groups };
	const matches =
		request?.purpose !== "check_status" &&
		matchesRecoveryPreview(props.preview, selection, activeRequest.current);
	const statusPreview = matchStatusPreview(props.preview, request, activeRequest.current);
	const canPreview = !props.busy && owner.trim().length > 0 && groups.length > 0;
	const consent = useRecoveryConsent(props, {
		matches,
		request,
		activeRequest,
		onSubmitted: status.markSubmitted,
	});
	const invalidate = () => {
		props.onSelectionChange?.();
		activeRequest.current = null;
		setRequest(null);
		consent.setAcknowledged(null);
	};
	const loadPreview = (purpose: RecoveryPreviewRequest["purpose"]) => {
		const target = purpose === "check_status" ? status.target : selection;
		const allowed = purpose === "check_status" ? status.canCheck : canPreview;
		if (!allowed || !target) return;
		const next = recoveryPreviewRequest(target, crypto.randomUUID(), purpose);
		activeRequest.current = next.requestId;
		setRequest(next);
		consent.setAcknowledged(null);
		props.onPreview(next);
	};
	return {
		id,
		owner,
		groups,
		selection,
		preview: props.preview,
		matches,
		canPreview,
		statusPreview,
		status,
		...consent,
		request,
		loadPreview,
		changeOwner: (value: string) => {
			invalidate();
			setOwner(value);
		},
		changeGroups: (value: readonly string[]) => {
			invalidate();
			setGroups(value);
		},
	};
}

function recoveryPreviewRequest(
	selection: RecoverySelection,
	requestId: string,
	purpose: RecoveryPreviewRequest["purpose"],
): RecoveryPreviewRequest {
	return {
		profile: selection.profile,
		existingOwnerId: selection.existingOwnerId,
		groups: [...selection.groups],
		requestId,
		purpose,
	};
}

function sameReviewTarget(left: RecoveryPreview, right: RecoveryPreview): boolean {
	return (
		recoveryProfileKey(left.profile) === recoveryProfileKey(right.profile) &&
		left.existingOwnerId === right.existingOwnerId &&
		sameGroups(left.groups, right.groups)
	);
}

function useRecoveryStatusTarget(props: AccountOwnerRecoveryProps) {
	const [submitted, markSubmitted] = useState<RecoveryPreview | null>(null);
	let result = props.result ?? null;
	if (submitted && result && !sameReviewTarget(submitted, result.preview)) result = null;
	const target = submitted ?? props.submittedPreview ?? result?.preview ?? null;
	const canCheck = Boolean(
		target &&
			!props.busy &&
			recoveryProfileKey(target.profile) === recoveryProfileKey(props.profile) &&
			matchesRecoveryPreview(target, target, target.requestId),
	);
	return { submitted, markSubmitted, result, target, canCheck };
}

function useRecoveryConsent(
	props: AccountOwnerRecoveryProps,
	review: {
		matches: boolean;
		request: RecoveryPreviewRequest | null;
		activeRequest: { current: string | null };
		onSubmitted: (preview: RecoveryPreview | null) => void;
	},
) {
	const dispatched = useRef(new WeakSet<RecoveryPreview>());
	const [acknowledged, setAcknowledged] = useState<RecoveryPreview | null>(null);
	const preview = props.preview;
	useLayoutEffect(() => setAcknowledged(null), [preview]);
	const fresh = preview && review.matches && review.request?.purpose === "review";
	// A new review preview replaces the earlier submission's reported result.
	useLayoutEffect(() => {
		if (fresh && !dispatched.current.has(preview)) review.onSubmitted(null);
	}, [preview, fresh]);
	const expired = usePreviewExpiry(review.request);
	const blocker = confirmDisabledReason({
		props,
		preview,
		matches: review.matches && review.request?.purpose === "review",
		acknowledged: acknowledged === preview,
		expired,
		dispatched: Boolean(preview && dispatched.current.has(preview)),
	});
	const canConfirm = blocker === null;
	const confirm = () => {
		if (
			!canConfirm ||
			!preview ||
			review.activeRequest.current !== preview.requestId ||
			dispatched.current.has(preview)
		)
			return;
		dispatched.current.add(preview);
		setAcknowledged(null);
		review.onSubmitted(preview);
		props.onConfirm({ preview, approvalDigest: preview.approvalDigest });
	};
	return {
		canConfirm,
		confirmBlockerText: blocker,
		acknowledged,
		setAcknowledged,
		confirm,
	};
}

/**
 * The server forgets a preview 5 minutes after it starts the review. Timing from the
 * request, not the reply, keeps a slow preview from outliving the server's copy.
 */
const PREVIEW_LIFETIME_MS = 5 * 60_000;

function usePreviewExpiry(request: RecoveryPreviewRequest | null): boolean {
	const [expired, setExpired] = useState<RecoveryPreviewRequest | null>(null);
	useEffect(() => {
		if (!request) return;
		const timer = setTimeout(() => setExpired(request), PREVIEW_LIFETIME_MS);
		return () => clearTimeout(timer);
	}, [request]);
	return request !== null && expired === request;
}

/** Why Confirm is disabled, in the order a user can act on, or null when it is enabled. */
function confirmDisabledReason(state: {
	props: AccountOwnerRecoveryProps;
	preview: RecoveryPreview | null;
	matches: boolean;
	acknowledged: boolean;
	expired: boolean;
	dispatched: boolean;
}): string | null {
	const { props, preview } = state;
	if (props.reviewAccess !== "operator")
		return "Only the coordinator operator can confirm. Send them the request below.";
	if (props.busy) return "Wait for the current request to finish.";
	if (!preview || !state.matches) return "Preview account ownership first.";
	if (state.dispatched || props.result?.preview === preview)
		return "This preview was already submitted. Check review status, or preview again.";
	if (props.error) return "Preview again after the error above.";
	if (state.expired) return "This preview expired after 5 minutes. Preview again.";
	if (confirmBlocker(preview) || !preview.approvalDigest)
		return "Some groups can't be confirmed. See the details above.";
	if (!state.acknowledged) return "Check the confirmation box first.";
	return null;
}

type ReviewState = ReturnType<typeof useRecoveryReview>;

function RecoveryDialog(props: AccountOwnerRecoveryProps) {
	const id = useId();
	const cancel = useRef<HTMLButtonElement>(null);
	const review = useRecoveryReview(props, id);
	return (
		<RadixDialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose();
			}}
			contentId={`${id}-dialog`}
			overlayId={`${id}-overlay`}
			contentClassName="modal"
			overlayClassName="modal-backdrop"
			ariaLabelledby={`${id}-title`}
			ariaDescribedby={`${id}-description`}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				cancel.current?.focus();
			}}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				if (props.returnFocus.current?.isConnected) props.returnFocus.current.focus();
			}}
		>
			<div className="modal-card" aria-busy={props.busy}>
				<div className="modal-header">
					<RadixDialogTitle id={`${id}-title`}>Review account ownership</RadixDialogTitle>
				</div>
				<RecoveryBody props={props} review={review} />
				<div className="modal-footer">
					<button ref={cancel} type="button" className="settings-button" onClick={props.onClose}>
						{review.status.submitted || review.status.result ? "Close" : "Cancel"}
					</button>
					<button
						type="button"
						className="settings-save"
						disabled={!review.canConfirm}
						aria-describedby={review.confirmBlockerText ? `${id}-confirm-reason` : undefined}
						onClick={review.confirm}
					>
						Confirm account ownership
					</button>
				</div>
				{review.confirmBlockerText ? (
					<p id={`${id}-confirm-reason`} className="account-owner-recovery-confirm-reason">
						{review.confirmBlockerText}
					</p>
				) : null}
			</div>
		</RadixDialog>
	);
}

function RecoveryBody({
	props,
	review,
}: {
	props: AccountOwnerRecoveryProps;
	review: ReviewState;
}) {
	const { id, preview, matches, canPreview, acknowledged, setAcknowledged, loadPreview } = review;
	const { statusPreview } = review;
	const statusMessage = props.busy ? busyMessage(review) : props.message;
	return (
		<div className="modal-body account-owner-recovery-body">
			<RecoveryDisclosure id={id} profile={props.profile} />
			<OwnerChoice
				id={id}
				owner={review.owner}
				candidates={props.candidates}
				busy={props.busy}
				onChange={review.changeOwner}
			/>
			<GroupChoice
				configured={props.profile.configuredGroups}
				selected={review.groups}
				busy={props.busy}
				onChange={review.changeGroups}
			/>
			<button
				type="button"
				className="settings-button"
				disabled={!canPreview}
				onClick={() => loadPreview("review")}
			>
				Preview account ownership
			</button>
			{preview && !matches && !statusPreview ? (
				<p role="status">The preview is not current. Request a new preview for these choices.</p>
			) : null}
			{matches ? <PreviewDetails preview={preview} /> : null}
			{statusPreview ? <ReviewStatusDetails preview={statusPreview} /> : null}
			{matches && props.reviewAccess === "operator" ? (
				<Acknowledgement
					id={id}
					preview={preview}
					owner={review.owner}
					busy={props.busy}
					checked={acknowledged === preview}
					onChange={(checked) => setAcknowledged(checked ? preview : null)}
				/>
			) : null}
			{review.status.result ? <RecoveryOutcomes result={review.status.result} /> : null}
			{review.status.submitted && !review.status.result ? (
				<p role="status">
					Closing does not undo an approval already sent. If the result is unknown, check review
					status before retrying.
				</p>
			) : null}
			{review.status.target ? (
				<button
					type="button"
					className="settings-button"
					disabled={!review.status.canCheck}
					onClick={() => loadPreview("check_status")}
				>
					Check review status
				</button>
			) : null}
			{props.reviewAccess === "request" ? (
				<RecoveryAssistance
					selection={review.selection}
					busy={props.busy}
					onCopyRequest={props.onCopyRequest}
					onImportReply={props.onImportReply}
				/>
			) : null}
			<p>
				Codemem runs one ownership request at a time. If another tab or window is confirming, this
				one waits until it finishes.
			</p>
			{statusMessage ? <p role="status">{statusMessage}</p> : null}
			{props.error ? <p role="alert">{props.error}</p> : null}
		</div>
	);
}

function busyMessage(review: ReviewState): string {
	const request = review.request;
	if (review.status.submitted && review.status.submitted.requestId === request?.requestId)
		return "Confirming account ownership with the coordinator…";
	if (request?.purpose === "check_status") return "Checking review status with the coordinator…";
	if (request) return "Loading the ownership preview from the coordinator…";
	return "Waiting for the coordinator to answer…";
}

/** The coordinator ID is often its origin; show it once in that case. */
function coordinatorLabel(profile: RecoveryProfile): string {
	if (profile.coordinatorId === profile.coordinatorOrigin) return profile.coordinatorOrigin;
	return `${profile.coordinatorOrigin} (${profile.coordinatorId})`;
}

function RecoveryDisclosure({ id, profile }: { id: string; profile: RecoveryProfile }) {
	return (
		<>
			<p id={`${id}-description`}>
				Confirm which existing Identity owns this device. Pick the Identity that is linked to your
				Google account.
			</p>
			<p id={`${id}-consequence`}>
				The coordinator will use the confirmed owner for future ownership checks, which can allow
				account changes. Memories keep their author, <code>{profile.memoryActorId}</code>. Team
				membership, Project access, and old records don't change.
			</p>
			<dl>
				<dt>Coordinator</dt>
				<dd>{coordinatorLabel(profile)}</dd>
				<dt>Current device</dt>
				<dd>{profile.deviceId}</dd>
				<dt>Key fingerprint</dt>
				<dd>{profile.fingerprint}</dd>
			</dl>
		</>
	);
}

function GroupChoice(props: {
	configured: readonly string[];
	selected: readonly string[];
	busy: boolean;
	onChange: (groups: readonly string[]) => void;
}) {
	return (
		<fieldset disabled={props.busy}>
			<legend>Coordinator groups to review</legend>
			{props.configured.map((group) => (
				<label
					key={group}
					className="legacy-team-setup-target"
					style={{ display: "block", minHeight: 24 }}
				>
					<input
						type="checkbox"
						checked={props.selected.includes(group)}
						onChange={(event) => {
							props.onChange(
								event.currentTarget.checked
									? [...props.selected, group]
									: props.selected.filter((item) => item !== group),
							);
						}}
					/>{" "}
					{group}
				</label>
			))}
		</fieldset>
	);
}

function OwnerChoice(props: {
	id: string;
	owner: string;
	candidates: AccountOwnerRecoveryProps["candidates"];
	busy: boolean;
	onChange: (owner: string) => void;
}) {
	const empty = props.candidates.length === 0;
	const hint = empty
		? "No recorded owner was found for this device. Enter the Identity ID that is linked to your Google account."
		: "These Identities are recorded for this device. The coordinator checks the one you pick.";
	return (
		<fieldset disabled={props.busy}>
			<legend>Existing account owner</legend>
			<p>{hint}</p>
			<label htmlFor={`${props.id}-owner`}>Choose an already-linked owner</label>
			<select
				id={`${props.id}-owner`}
				className="settings-input"
				disabled={empty}
				value={
					props.candidates.some((candidate) => candidate.id === props.owner) ? props.owner : ""
				}
				onChange={(event) => props.onChange(event.currentTarget.value)}
			>
				<option value="">{empty ? "No recorded owners" : "Choose an existing owner"}</option>
				{props.candidates.map((candidate) => (
					<option key={candidate.id} value={candidate.id}>
						{candidate.label} ({candidate.id})
					</option>
				))}
			</select>
			<details open={empty}>
				<summary style={{ minHeight: 24 }}>Advanced: enter an existing owner ID</summary>
				<label htmlFor={`${props.id}-manual`}>Existing owner Identity ID (not a new account)</label>
				<input
					id={`${props.id}-manual`}
					className="settings-input"
					value={props.owner}
					autoComplete="off"
					onInput={(event) => props.onChange(event.currentTarget.value.trim())}
				/>
			</details>
			<p>
				Selected account owner: <code>{props.owner || "None selected"}</code>
			</p>
		</fieldset>
	);
}

const GROUP_ACTION_LABELS = {
	new: "Ready to confirm",
	reuse: "Already confirmed",
	blocked: "Blocked",
};
/** Plain-language meaning of coordinator blocker codes that a requester can act on. */
const BLOCKED_REASON_TEXT: Record<string, string> = {
	account_owner_target_unavailable:
		"The coordinator has no Google account link for this Identity. Check that you entered the Identity linked to your Google account.",
	account_owner_conflict: "The coordinator records a different owner for this Google account.",
};

/** The service joins several blocker codes with "; ", and each may carry ": detail". */
function blockedReasonText(reason: string): string {
	return reason
		.split("; ")
		.map((part) => BLOCKED_REASON_TEXT[part.split(":", 1)[0] ?? part] ?? part)
		.join(" ");
}

/** A ready group's reason only restates its label; other states explain themselves. */
function groupReason(group: RecoveryPreview["groupPreviews"][number]): string | null {
	if (group.action === "new") return null;
	if (group.action === "blocked") return blockedReasonText(group.reason);
	return group.reason;
}

function reasonSuffix(group: RecoveryPreview["groupPreviews"][number]): string {
	const reason = groupReason(group);
	return reason ? ` — ${reason}` : "";
}

function blockedGroups(preview: RecoveryPreview): string[] {
	return preview.groupPreviews
		.filter((group) => group.action === "blocked")
		.map((group) => group.groupId);
}

function confirmBlocker(preview: RecoveryPreview): string | null {
	if (!preview.history.complete)
		return "You can't confirm yet because some ownership records didn't load.";
	const blocked = blockedGroups(preview);
	if (blocked.length === 0) return null;
	return `You can't confirm yet because ${blocked.join(", ")} ${blocked.length === 1 ? "is" : "are"} blocked. Clear blocked groups or fix them, then preview again.`;
}

function Acknowledgement(props: {
	id: string;
	preview: RecoveryPreview;
	owner: string;
	busy: boolean;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	const blocker = confirmBlocker(props.preview);
	const reasonId = `${props.id}-confirm-blocker`;
	// Without a blocker, screen readers hear what confirming allows.
	const describedBy = blocker ? reasonId : `${props.id}-consequence`;
	return (
		<>
			<label className="legacy-team-setup-target" style={{ display: "block", minHeight: 24 }}>
				<input
					type="checkbox"
					checked={props.checked}
					disabled={props.busy || blocker !== null}
					aria-describedby={describedBy}
					onChange={(event) => props.onChange(event.currentTarget.checked)}
				/>
				I reviewed these records and groups. This device belongs to {props.owner}.
			</label>
			{blocker ? <p id={reasonId}>{blocker}</p> : null}
		</>
	);
}
const HISTORY_RELATION_LABELS = {
	exact_subject: "This device",
	alias: "Same device key",
	other: "Another recorded device",
};

function ReviewStatusDetails({ preview }: { preview: RecoveryPreview }) {
	return (
		<section aria-label="Read-only review status" aria-live="polite">
			<p>
				Latest status for the original submitted owner and groups. This check does not repeat an
				approval or retain a local owner association.
			</p>
			<p>
				Device {preview.profile.deviceId} at {preview.profile.coordinatorOrigin}.
			</p>
			<PreviewDetails preview={preview} />
		</section>
	);
}

function PreviewDetails({ preview }: { preview: RecoveryPreview }) {
	return (
		<section aria-label="Server ownership preview">
			<h3>Ownership review for {preview.existingOwnerId}</h3>
			<ul>
				{preview.groupPreviews.map((group) => (
					<li key={group.groupId}>
						{group.groupId}: {GROUP_ACTION_LABELS[group.action]}
						{reasonSuffix(group)}
					</li>
				))}
			</ul>
			{blockedGroups(preview).length > 0 ? <BlockedHelp preview={preview} /> : null}
			<h4>Recorded assignments ({preview.history.rows.length})</h4>
			{preview.history.complete === false ? (
				<p role="alert">
					We could not load all ownership records. Approval is disabled. Ask the coordinator
					operator to inspect the records before retrying. {preview.history.operatorHelp}
				</p>
			) : null}
			<ol>
				{preview.history.rows.map((row) => (
					<li key={row.id}>
						<strong>
							{row.assignment === "included" ? "Previously included" : "Previously excluded"}
						</strong>{" "}
						— {HISTORY_RELATION_LABELS[row.relation]} — {row.reason}
						<dl>
							<dt>Group</dt>
							<dd>{row.groupId}</dd>
							<dt>Device</dt>
							<dd>{row.deviceId}</dd>
							<dt>Fingerprint</dt>
							<dd>{row.fingerprint}</dd>
							<dt>Identity</dt>
							<dd>{row.identityId}</dd>
						</dl>
					</li>
				))}
			</ol>
			{preview.reviewedWeakLabels?.length ? <WeakLabels preview={preview} /> : null}
		</section>
	);
}

function BlockedHelp({ preview }: { preview: RecoveryPreview }) {
	const groups = blockedGroups(preview);
	return (
		<div role="alert">
			<p>
				{groups.join(", ")} can't be confirmed for {preview.existingOwnerId}. If the Identity is
				correct, ask the coordinator operator to check the coordinator. Don't reset this profile or
				create a new Identity.
			</p>
			<details>
				<summary style={{ minHeight: 24 }}>Operator details</summary>
				<ul>
					{preview.groupPreviews
						.filter((group) => group.action === "blocked")
						.map((group) => (
							<li key={group.groupId}>
								{group.groupId}: <code>{group.reason}</code>
							</li>
						))}
				</ul>
				<p>
					A coordinator without owner-resolution storage needs a schema upgrade. Inspect the SQL
					with{" "}
					<code>
						codemem coordinator upgrade-account-schema --owner-resolution --export-sql --json
					</code>
					. The export applies nothing. Back up the coordinator and pause auth writers before
					applying an upgrade.
				</p>
			</details>
		</div>
	);
}

function WeakLabels({ preview }: { preview: RecoveryPreview }) {
	return (
		<section aria-label="Reviewed weak labels">
			<h4>Reviewed labels (display only)</h4>
			<p>These labels only change how the account owner is displayed.</p>
			<ul>
				{preview.reviewedWeakLabels?.map((label) => (
					<li key={JSON.stringify(label)}>
						<strong>{label.label}</strong>
						<dl>
							<dt>Kind</dt>
							<dd>{label.kind}</dd>
							<dt>Group</dt>
							<dd>{label.group_id}</dd>
							<dt>Device</dt>
							<dd>{label.device_id}</dd>
							<dt>Evidence reference</dt>
							<dd>{label.evidence_ref}</dd>
							<dt>Effect</dt>
							<dd>{label.effect}</dd>
						</dl>
					</li>
				))}
			</ul>
		</section>
	);
}

function RecoveryOutcomes({ result }: { result: RecoveryResult }) {
	return (
		<section aria-label="Reported review outcomes" aria-live="polite">
			<h3>Reported results for owner {result.preview.existingOwnerId}</h3>
			<p>
				Device {result.preview.profile.deviceId} at {result.preview.profile.coordinatorOrigin}. Each
				group has its own result. Missing or unknown results do not confirm ownership; checking
				status does not reapply changes.
			</p>
			<p>
				Reviewed key fingerprint: <code>{result.preview.profile.fingerprint}</code>. Coordinator:{" "}
				<code>{result.preview.profile.coordinatorId}</code>.
			</p>
			<ul>
				{result.preview.groups.map((group) => {
					const outcome = result.groups.find((item) => item.groupId === group);
					return (
						<li key={group}>
							{group}: {outcome?.status ?? "unknown"} —{" "}
							{outcome?.message ??
								"No result received. Check review status before taking further action."}
						</li>
					);
				})}
			</ul>
		</section>
	);
}
