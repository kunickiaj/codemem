import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
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
	const preview = props.preview;
	const matches =
		request?.purpose !== "check_status" &&
		matchesRecoveryPreview(preview, selection, activeRequest.current);
	const statusPreview = matchStatusPreview(preview, request, activeRequest.current);
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
		preview,
		matches,
		canPreview,
		statusPreview,
		status,
		...consent,
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
		onSubmitted: (preview: RecoveryPreview) => void;
	},
) {
	const dispatched = useRef(new WeakSet<RecoveryPreview>());
	const [acknowledged, setAcknowledged] = useState<RecoveryPreview | null>(null);
	const preview = props.preview;
	useLayoutEffect(() => setAcknowledged(null), [preview]);
	const canConfirm = Boolean(
		preview &&
			review.matches &&
			review.request?.purpose === "review" &&
			acknowledged === preview &&
			preview.history.complete &&
			preview.approvalDigest &&
			!preview.groupPreviews.some((group) => group.action === "blocked") &&
			!props.busy &&
			!props.error &&
			props.reviewAccess === "operator" &&
			!dispatched.current.has(preview) &&
			props.result?.preview !== preview,
	);
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
		acknowledged,
		setAcknowledged,
		confirm,
	};
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
						onClick={review.confirm}
					>
						Confirm account ownership
					</button>
				</div>
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
	const statusMessage = props.busy ? "Waiting for the current request…" : props.message;
	return (
		<div className="modal-body">
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
				<label className="legacy-team-setup-target" style={{ display: "block", minHeight: 24 }}>
					<input
						type="checkbox"
						checked={acknowledged === preview}
						disabled={
							props.busy ||
							!preview.history.complete ||
							preview.groupPreviews.some((group) => group.action === "blocked")
						}
						onChange={(event) => setAcknowledged(event.currentTarget.checked ? preview : null)}
					/>
					I reviewed these records and groups and confirm this device belongs to {review.owner}. I
					understand this approval may allow account changes; existing memory authors and sharing
					access will not change.
				</label>
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
			{statusMessage ? <p role="status">{statusMessage}</p> : null}
			{props.error ? <p role="alert">{props.error}</p> : null}
		</div>
	);
}

function RecoveryDisclosure({ id, profile }: { id: string; profile: RecoveryProfile }) {
	return (
		<>
			<p id={`${id}-description`}>
				Choose the Identity already linked to your Google account. This does not create a new
				account, and your computer username does not choose the owner.
			</p>
			<p>
				Memories keep their current author, <code>{profile.memoryActorId}</code>. Existing Team and
				Project access stays unchanged; coordinator groups are separate from Teams.
			</p>
			<p>
				This approval can allow account changes when the coordinator permits them. It does not merge
				Identities, move history, or grant access to Teams or Projects.
			</p>
			<p>
				The confirmed owner will be used for future ownership checks. Old assignments stay in the
				record; changes to Teams or Projects still need a separate review.
			</p>
			<dl>
				<dt>Coordinator</dt>
				<dd>
					{profile.coordinatorOrigin} ({profile.coordinatorId})
				</dd>
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
	return (
		<fieldset disabled={props.busy}>
			<legend>Existing account owner</legend>
			<p>Names are suggestions. The coordinator checks the selected Identity ID.</p>
			<label htmlFor={`${props.id}-owner`}>Choose an already-linked owner</label>
			<select
				id={`${props.id}-owner`}
				className="settings-input"
				value={
					props.candidates.some((candidate) => candidate.id === props.owner) ? props.owner : ""
				}
				onChange={(event) => props.onChange(event.currentTarget.value)}
			>
				<option value="">Choose an existing owner</option>
				{props.candidates.map((candidate) => (
					<option key={candidate.id} value={candidate.id}>
						{candidate.label} ({candidate.id})
					</option>
				))}
			</select>
			<details>
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
	new: "Approval needed",
	reuse: "Already approved",
	blocked: "Needs operator attention",
};
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
						{group.groupId}: {GROUP_ACTION_LABELS[group.action]} — {group.reason}
					</li>
				))}
			</ul>
			{preview.groupPreviews.some((group) => group.action === "blocked") ? (
				<p role="alert">
					Ask the coordinator operator to check these blockers and upgrade the coordinator if
					needed. Operators can inspect the required SQL with{" "}
					<code>
						codemem coordinator upgrade-account-schema --owner-resolution --export-sql --json
					</code>
					. This export applies nothing. Back up the coordinator and pause auth writers before
					applying an upgrade. Do not reset this profile or create a new Identity.
				</p>
			) : null}
			<h4>Recorded assignments ({preview.history.rows.length})</h4>
			<p>These records explain why ownership needs review. They will be kept unchanged.</p>
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
			{preview.reviewedWeakLabels ? <WeakLabels preview={preview} /> : null}
		</section>
	);
}

function WeakLabels({ preview }: { preview: RecoveryPreview }) {
	return (
		<section aria-label="Reviewed weak labels">
			<h4>Reviewed labels (display only)</h4>
			<p>
				These labels are evidence for account owner display only, not device assignments or sharing
				access.
			</p>
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
