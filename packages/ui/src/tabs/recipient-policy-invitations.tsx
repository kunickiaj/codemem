import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import type {
	CreatedRecipientInvite,
	InspectInviteResult,
	RecipientInvitePreviewRequest,
	RecipientOnboardingPreviewV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import type { ImportInviteResult } from "../lib/api/types";
import { humanPresentationLabel, isMachinePresentationLabel } from "../lib/identity-presentation";
import { openProjectShareFlow } from "./project-sharing";

type CreateKind = "team_member" | "add_device";
type DialogMode = "create" | "accept";
type ProjectShareInvite = Extract<InspectInviteResult, { kind: "project_share_invite" }>;
type ProjectShareAcceptance = Omit<ImportInviteResult, "status"> & {
	status?: "pending_setup";
	setup_state?: "pending_inviter" | "restart_required";
	restart_required?: boolean;
	detail?: string;
	type?: "project_share";
};
type RecipientAcceptance = {
	kind: CreateKind;
	restartRequired: boolean;
	detail: string;
	deliveryPending: boolean;
};

/**
 * Machine identifiers (device ids, identity ids, uuid fragments) make terrible
 * display names. Seed the name fields empty instead so the required-field
 * validation asks the person for a real name, with placeholder text as the hint.
 */
function humanProvidedNameOrEmpty(value: string | null | undefined): string {
	return humanPresentationLabel(String(value ?? "").trim());
}

function displayNameError(value: string, label: string): string {
	const reviewed = value.trim();
	if (!reviewed) return `${label} is required.`;
	if ([...reviewed].length > 120) return `${label} must use 120 characters or fewer.`;
	if ([...reviewed].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
		return `${label} cannot include control or format characters.`;
	}
	if (isMachinePresentationLabel(reviewed)) {
		return `${label} must use a human-readable name.`;
	}
	return "";
}

function normalizeProjectShareAcceptance(result: ImportInviteResult): ProjectShareAcceptance {
	return {
		...result,
		status: result.status === "pending_setup" ? "pending_setup" : undefined,
		setup_state:
			result.setup_state === "pending_inviter" || result.setup_state === "restart_required"
				? result.setup_state
				: undefined,
		restart_required: result.restart_required === true,
		detail: typeof result.detail === "string" ? result.detail : undefined,
		type: result.type === "project_share" ? "project_share" : undefined,
	};
}

function errorMessage(cause: unknown, fallback: string): string {
	if (!(cause instanceof Error)) return fallback;
	if (cause instanceof api.ProjectInviteAcceptanceError) {
		const guidance: Record<string, string> = {
			device_display_name_invalid:
				"Enter a human-readable device name instead of an internal identifier.",
			device_display_name_required: "Enter a device display name.",
			device_display_name_too_long: "Use a device display name with 120 characters or fewer.",
			invite_already_bound:
				"This invitation was accepted by another device. Ask the owner to create a new invitation.",
			invite_expired: "This invitation expired. Ask the owner to create a new invitation.",
			invite_identity_conflict:
				"This invitation does not match this Identity. Ask the owner to create a new invitation for this recipient.",
			invite_invalid:
				"This invitation is no longer valid. Ask the owner to create a new invitation.",
			inviter_identity_invalid:
				"The owner's device identity could not be verified. Ask the owner to review the share and create a new invitation.",
			project_invite_acceptance_failed:
				"The invitation could not be accepted safely. Retry once, then ask the owner to review the share.",
			project_invite_bootstrap_incomplete:
				"The owner's device is not ready to establish trust yet. Retry once, then ask the owner to review the share.",
			project_invite_self_acceptance_forbidden:
				"The owner cannot accept this recipient invitation on the owner's device.",
			project_invite_trust_state_invalid:
				"The owner's trust setup could not be verified. Ask the owner to review the share.",
			project_sync_enablement_failed:
				"The invitation was accepted, but Project setup could not be enabled because the codemem config is not writable. Make the config writable, then check Sync to finish setup.",
			recipient_display_name_invalid:
				"Enter a human-readable Identity name instead of an internal identifier.",
			recipient_display_name_required: "Enter an Identity display name.",
			recipient_display_name_too_long: "Use an Identity display name with 120 characters or fewer.",
		};
		return guidance[cause.errorCode] ?? fallback;
	}
	if (cause.message === "reviewed_onboarding_stale") {
		return "Invitation details changed. Review them again before creating it.";
	}
	if (cause.message === "recipient_invite_review_unavailable") {
		return "The invitation review is unavailable. Ask the owner to create a new invitation.";
	}
	if (cause.message === "recipient_invite_intent_mismatch") {
		return "The invitation details do not match the reviewed access. Ask the owner to create a new invitation.";
	}
	if (cause.message === "invite_identity_conflict") {
		return "This device already belongs to a different Identity. Use a fresh device or ask the owner for the correct invitation.";
	}
	if (cause.message === "recipient_display_name_invalid") {
		return "Enter a human-readable Identity name instead of an internal identifier.";
	}
	if (cause.message === "recipient_display_name_required") {
		return "Enter an Identity display name before accepting.";
	}
	if (cause.message === "recipient_display_name_too_long") {
		return "Use an Identity display name with 120 characters or fewer.";
	}
	return fallback;
}

function memoryLabel(count: number): string {
	return `${count.toLocaleString()} existing ${count === 1 ? "memory" : "memories"}`;
}

function ProjectList({ preview }: { preview: RecipientOnboardingPreviewV1 }) {
	if (preview.projects.length === 0) {
		return <p className="small">No Projects are currently shared with this Team.</p>;
	}
	return (
		<ul>
			{preview.projects.map((project) => (
				<li key={project.canonicalProjectIdentity}>
					<strong>{project.displayName}</strong> — {memoryLabel(project.existingMemoryCount)} and
					future activity
				</li>
			))}
		</ul>
	);
}

function TeamConfirmation({ preview }: { preview: RecipientOnboardingPreviewV1 }) {
	return (
		<div className="sync-dialog-stack">
			<p>
				<strong>Current Projects for {preview.team?.displayName ?? "this Team"}</strong>
			</p>
			<ProjectList preview={preview} />
			<p>Future Projects shared with this Team will also be inherited by this member.</p>
			<p>
				<strong>No other Projects will be shared through this invitation.</strong>
			</p>
		</div>
	);
}

function AddDeviceConfirmation({ preview }: { preview: RecipientOnboardingPreviewV1 }) {
	const direct = preview.projects.filter((project) =>
		project.sources.some((source) => source.kind === "direct"),
	);
	const inherited = preview.projects.filter((project) =>
		project.sources.some((source) => source.kind === "team"),
	);
	return (
		<div className="sync-dialog-stack">
			<section aria-labelledby="add-device-direct-projects">
				<h3 id="add-device-direct-projects">Direct Projects</h3>
				{direct.length ? (
					<ul>
						{direct.map((project) => (
							<li key={project.canonicalProjectIdentity}>
								{project.displayName} — {memoryLabel(project.existingMemoryCount)} and future
								activity
							</li>
						))}
					</ul>
				) : (
					<p className="small">No Projects are shared directly.</p>
				)}
			</section>
			<section aria-labelledby="add-device-team-projects">
				<h3 id="add-device-team-projects">Projects through Teams</h3>
				{inherited.length ? (
					<ul>
						{inherited.map((project) => {
							const teams = project.sources
								.filter((source) => source.kind === "team")
								.map((source) => source.displayName);
							return (
								<li key={project.canonicalProjectIdentity}>
									{project.displayName} — {memoryLabel(project.existingMemoryCount)} and future
									activity
									{teams.length ? ` through ${teams.join(", ")}` : " through a Team"}
								</li>
							);
						})}
					</ul>
				) : (
					<p className="small">No Projects are inherited through Teams.</p>
				)}
			</section>
			<section aria-labelledby="add-device-excluded-projects">
				<h3 id="add-device-excluded-projects">Not included</h3>
				{preview.excludedProjects.length ? (
					<ul>
						{preview.excludedProjects.map((project) => (
							<li key={project.canonicalProjectIdentity}>
								{project.displayName} — {memoryLabel(project.existingMemoryCount)}
							</li>
						))}
					</ul>
				) : (
					<p className="small">No other Projects are excluded.</p>
				)}
				<p className="small">This device will not receive the Projects listed here.</p>
			</section>
			{preview.projects.length > 0 ? (
				<p className="small" role="note">
					The lists above describe access, not delivery: Project data does not sync to the invited
					device until the Project owner’s device completes access setup for it. Until then, shared
					memories remain on the Identity’s existing devices.
				</p>
			) : null}
		</div>
	);
}

function Confirmation({ preview }: { preview: RecipientOnboardingPreviewV1 }) {
	return preview.journey === "team" ? (
		<TeamConfirmation preview={preview} />
	) : (
		<AddDeviceConfirmation preview={preview} />
	);
}

function RecipientNameConfirmation({
	error,
	name,
	onChange,
}: {
	error: string;
	name: string;
	onChange: (value: string) => void;
}) {
	return (
		<section aria-labelledby="recipient-onboarding-name-title">
			<h3 id="recipient-onboarding-name-title">Who will receive access</h3>
			<label className="field" htmlFor="recipient-onboarding-name">
				<span>Identity display name</span>
				<input
					aria-describedby={error ? "recipient-onboarding-name-error" : undefined}
					aria-invalid={Boolean(error)}
					id="recipient-onboarding-name"
					onInput={(event) => onChange(event.currentTarget.value)}
					placeholder="Your name — e.g. Alex Rivera"
					value={name}
				/>
			</label>
			{error ? (
				<p className="small" id="recipient-onboarding-name-error" role="alert">
					{error}
				</p>
			) : null}
		</section>
	);
}

function ProjectShareConfirmation({
	deviceName,
	deviceNameError,
	invite,
	onDeviceNameChange,
	onRecipientNameChange,
	recipientName,
	recipientNameError,
}: {
	deviceName: string;
	deviceNameError: string;
	invite: ProjectShareInvite;
	onDeviceNameChange: (value: string) => void;
	onRecipientNameChange: (value: string) => void;
	recipientName: string;
	recipientNameError: string;
}) {
	const projects = invite.projects ?? [];
	return (
		<div className="sync-dialog-stack">
			<section aria-labelledby="project-share-invitation-recipient">
				<h3 id="project-share-invitation-recipient">Who will receive access</h3>
				<p>Review these display names before importing the invitation.</p>
				<label className="field" htmlFor="project-share-recipient-name">
					<span>Identity display name</span>
					<input
						aria-describedby={recipientNameError ? "project-share-recipient-name-error" : undefined}
						aria-invalid={Boolean(recipientNameError)}
						id="project-share-recipient-name"
						onInput={(event) => onRecipientNameChange(event.currentTarget.value)}
						placeholder="Your name — e.g. Alex Rivera"
						value={recipientName}
					/>
				</label>
				{recipientNameError ? (
					<p className="small" id="project-share-recipient-name-error" role="alert">
						{recipientNameError}
					</p>
				) : null}
				<label className="field" htmlFor="project-share-device-name">
					<span>Device display name</span>
					<input
						aria-describedby={deviceNameError ? "project-share-device-name-error" : undefined}
						aria-invalid={Boolean(deviceNameError)}
						id="project-share-device-name"
						onInput={(event) => onDeviceNameChange(event.currentTarget.value)}
						placeholder="This device — e.g. Work Laptop"
						value={deviceName}
					/>
				</label>
				{deviceNameError ? (
					<p className="small" id="project-share-device-name-error" role="alert">
						{deviceNameError}
					</p>
				) : null}
			</section>
			<section aria-labelledby="project-share-invitation-projects">
				<h3 id="project-share-invitation-projects" tabIndex={-1}>
					Exact Projects shared directly
				</h3>
				{invite.inviter_name ? <p>Invitation from {invite.inviter_name}.</p> : null}
				<p>
					You will receive <strong>direct access only</strong> to the exact Projects listed below.
				</p>
				{projects.length ? (
					<ul>
						{projects.map((project, index) => (
							<li key={`${project.display_name}:${index}`}>
								<strong>{project.display_name}</strong> —{" "}
								{memoryLabel(project.existing_memory_count)} and future activity
							</li>
						))}
					</ul>
				) : (
					<p role="alert">
						Project details are unavailable. Ask the owner to create a new invitation before
						accepting.
					</p>
				)}
			</section>
			<p>
				<strong>Accepting this invitation does not join a Team.</strong>
			</p>
			<p>
				<strong>No other Projects are included.</strong>
			</p>
		</div>
	);
}

function ProjectShareResult({ result }: { result: ProjectShareAcceptance }) {
	const restartRequired =
		result.restart_required === true || result.setup_state === "restart_required";
	const pending = result.type === "project_share" && result.status === "pending_setup";
	return (
		<div className="sync-dialog-stack">
			<h3 id="project-share-invitation-result" tabIndex={-1}>
				Project invitation accepted
			</h3>
			<ProjectShareResultMessage pending={pending} restartRequired={restartRequired} />
		</div>
	);
}

function ProjectShareResultMessage({
	pending,
	restartRequired,
}: {
	pending: boolean;
	restartRequired: boolean;
}) {
	if (restartRequired) {
		return (
			<p role="status">
				<strong>Project setup is pending and codemem must be restarted.</strong> Restart codemem to
				start the sync service. Access remains pending until setup and the first sync finish.
			</p>
		);
	}
	if (pending) {
		return (
			<p role="status">
				<strong>Project setup is pending.</strong> The owner still needs to finish access setup, and
				the Projects will appear after the first sync completes.
			</p>
		);
	}
	return (
		<p role="status">
			The invitation was accepted, but Project setup status could not be confirmed. Check Sync
			before expecting Project data.
		</p>
	);
}

function RecipientAcceptanceResult({ result }: { result: RecipientAcceptance }) {
	const title = result.kind === "team_member" ? "Team invitation accepted" : "Device added";
	const describedBy =
		[
			result.restartRequired ? "recipient-invitation-result-detail" : null,
			result.deliveryPending ? "recipient-invitation-result-delivery" : null,
		]
			.filter(Boolean)
			.join(" ") || undefined;
	return (
		<section
			aria-describedby={describedBy}
			aria-labelledby="recipient-invitation-result-title"
			className="recipient-policy-invitation-result"
			id="recipient-invitation-result"
			tabIndex={-1}
		>
			<span aria-hidden="true" className="recipient-policy-invitation-result-mark">
				✓
			</span>
			<div className="recipient-policy-invitation-result-copy">
				<h3 id="recipient-invitation-result-title">{title}</h3>
				{result.restartRequired ? (
					<p id="recipient-invitation-result-detail">{result.detail}</p>
				) : null}
				{result.deliveryPending ? (
					<p className="small" id="recipient-invitation-result-delivery">
						Existing shared Projects do not sync to this device until the Project owner’s device
						completes access setup for it.
					</p>
				) : null}
			</div>
		</section>
	);
}

function request(kind: CreateKind, targetId: string): RecipientInvitePreviewRequest {
	return kind === "team_member"
		? { kind, policy_team_id: targetId }
		: { kind, target_identity_id: targetId };
}

function useInvitationResultFocus(
	inspected: InspectInviteResult | null,
	projectAcceptance: ProjectShareAcceptance | null,
	recipientAcceptance: RecipientAcceptance | null,
): void {
	useEffect(() => {
		if (recipientAcceptance) {
			document.getElementById("recipient-invitation-result")?.focus();
			return;
		}
		if (projectAcceptance) {
			document.getElementById("project-share-invitation-result")?.focus();
			return;
		}
		if (inspected?.kind === "project_share_invite") {
			document.getElementById("project-share-invitation-projects")?.focus();
		}
	}, [inspected, projectAcceptance, recipientAcceptance]);
}

function useInvitationDialogState(teams: RecipientPolicyIntentGraphV1["teams"]) {
	const [mode, setMode] = useState<DialogMode | null>(null);
	const [kind, setKind] = useState<CreateKind>("team_member");
	const [targetId, setTargetId] = useState(teams[0]?.teamId ?? "");
	const [invite, setInvite] = useState("");
	return { mode, setMode, kind, setKind, targetId, setTargetId, invite, setInvite };
}

function useInvitationReviewState() {
	const [preview, setPreview] = useState<RecipientOnboardingPreviewV1 | null>(null);
	const [inspected, setInspected] = useState<InspectInviteResult | null>(null);
	const [projectAcceptance, setProjectAcceptance] = useState<ProjectShareAcceptance | null>(null);
	const [recipientAcceptance, setRecipientAcceptance] = useState<RecipientAcceptance | null>(null);
	const [recipientName, setRecipientName] = useState("");
	const [projectRecipientName, setProjectRecipientName] = useState("");
	const [projectDeviceName, setProjectDeviceName] = useState("");
	return {
		preview,
		setPreview,
		inspected,
		setInspected,
		projectAcceptance,
		setProjectAcceptance,
		recipientAcceptance,
		setRecipientAcceptance,
		recipientName,
		setRecipientName,
		projectRecipientName,
		setProjectRecipientName,
		projectDeviceName,
		setProjectDeviceName,
	};
}

function useInvitationFeedbackState() {
	const [created, setCreated] = useState<CreatedRecipientInvite | null>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	return { created, setCreated, busy, setBusy, status, setStatus, error, setError };
}

function useInvitationRefs() {
	return {
		returnFocus: useRef<HTMLElement | null>(null),
		inviteRevision: useRef(0),
		inviteValue: useRef(""),
		accepting: useRef(false),
	};
}

function useInvitationState(teams: RecipientPolicyIntentGraphV1["teams"]) {
	const dialog = useInvitationDialogState(teams);
	const review = useInvitationReviewState();
	const feedback = useInvitationFeedbackState();
	const refs = useInvitationRefs();
	useInvitationResultFocus(review.inspected, review.projectAcceptance, review.recipientAcceptance);
	return { ...dialog, ...review, ...feedback, ...refs };
}

type InvitationState = ReturnType<typeof useInvitationState>;

function useInvitationControls(
	state: InvitationState,
	teams: RecipientPolicyIntentGraphV1["teams"],
	identities: RecipientPolicyIntentGraphV1["identities"],
) {
	const reset = () => {
		state.inviteRevision.current += 1;
		state.inviteValue.current = "";
		state.accepting.current = false;
		state.setInvite("");
		state.setPreview(null);
		state.setInspected(null);
		state.setProjectAcceptance(null);
		state.setRecipientAcceptance(null);
		state.setRecipientName("");
		state.setProjectRecipientName("");
		state.setProjectDeviceName("");
		state.setCreated(null);
		state.setStatus("");
		state.setError("");
	};
	const open = (nextMode: DialogMode, trigger: HTMLElement) => {
		reset();
		state.returnFocus.current = trigger;
		state.setMode(nextMode);
	};
	const close = () => {
		if (state.busy) return;
		state.setMode(null);
		reset();
	};
	const updateInvite = (nextInvite: string) => {
		state.inviteRevision.current += 1;
		state.inviteValue.current = nextInvite;
		state.setInvite(nextInvite);
	};
	const chooseKind = (nextKind: CreateKind) => {
		state.setKind(nextKind);
		state.setTargetId(
			nextKind === "team_member" ? (teams[0]?.teamId ?? "") : (identities[0]?.identityId ?? ""),
		);
		reset();
	};
	return { reset, open, close, updateInvite, chooseKind };
}

type InvitationControls = ReturnType<typeof useInvitationControls>;

async function reviewCreateInvitation(state: InvitationState): Promise<void> {
	if (!state.targetId) return;
	state.setBusy(true);
	state.setError("");
	state.setStatus("Reviewing invitation…");
	try {
		const result = await api.previewRecipientInvite(request(state.kind, state.targetId));
		state.setPreview(result.preview);
		state.setStatus("Review ready. Confirm the invitation details.");
	} catch (cause) {
		state.setError(errorMessage(cause, "Unable to review this invitation."));
		state.setStatus("");
	} finally {
		state.setBusy(false);
	}
}

async function createRecipientInvitation(state: InvitationState): Promise<void> {
	if (!state.preview) return;
	state.setBusy(true);
	state.setError("");
	state.setStatus("Creating invitation…");
	try {
		const result = await api.createRecipientInvite({
			...request(state.kind, state.targetId),
			reviewed_onboarding_digest: state.preview.reviewedOnboardingDigest,
		});
		state.setCreated(result);
		state.setStatus("Invitation created.");
	} catch (cause) {
		if (cause instanceof Error && cause.message === "reviewed_onboarding_stale") {
			state.setPreview(null);
		}
		state.setError(errorMessage(cause, "Unable to create this invitation."));
		state.setStatus("");
	} finally {
		state.setBusy(false);
	}
}

function inspectionStatus(result: InspectInviteResult): string {
	if (result.kind === "add_device") {
		if ((result.onboarding?.projects?.length ?? 0) > 0) {
			return "Review ready. Existing shared Projects sync to the invited device only after the owner’s device completes access setup. Confirm before accepting.";
		}
		return "Review ready. Confirm before accepting.";
	}
	if (result.kind === "team_member") return "Review ready. Confirm before accepting.";
	if (result.kind === "project_share_invite") {
		return "Review ready. Confirm the exact Projects before accepting.";
	}
	return "Open Advanced, then Sync, to review and import this legacy invitation.";
}

function applyInspectedNames(state: InvitationState, result: InspectInviteResult): void {
	if (result.kind === "team_member") {
		state.setRecipientName(humanProvidedNameOrEmpty(result.recipient_name));
		return;
	}
	if (result.kind === "project_share_invite") {
		state.setProjectRecipientName(humanProvidedNameOrEmpty(result.recipient_name));
		state.setProjectDeviceName(humanProvidedNameOrEmpty(result.device_name));
	}
}

async function inspectRecipientInvitation(state: InvitationState): Promise<void> {
	const reviewedInvite = state.inviteValue.current.trim();
	const reviewedRevision = state.inviteRevision.current;
	if (!reviewedInvite) {
		state.setError("Paste an invitation first.");
		return;
	}
	const isCurrentInspection = () =>
		state.inviteRevision.current === reviewedRevision &&
		state.inviteValue.current.trim() === reviewedInvite;
	state.setBusy(true);
	state.setError("");
	state.setStatus("Reviewing invitation…");
	try {
		const result = await api.inspectCoordinatorInvite(reviewedInvite);
		if (!isCurrentInspection()) return;
		state.setInspected(result);
		applyInspectedNames(state, result);
		state.setStatus(inspectionStatus(result));
	} catch (cause) {
		if (!isCurrentInspection()) return;
		state.setError(errorMessage(cause, "Unable to review this invitation."));
		state.setStatus("");
	} finally {
		state.setBusy(false);
	}
}

type AcceptableInspection = Exclude<InspectInviteResult, { kind: "legacy_team_invite" }>;

function canAcceptInvitation(
	state: InvitationState,
	inspected: InspectInviteResult,
): inspected is AcceptableInspection {
	if (state.busy || state.accepting.current) return false;
	if (state.recipientAcceptance || inspected.kind === "legacy_team_invite") return false;
	if (inspected.kind === "project_share_invite" && !(inspected.projects?.length ?? 0)) return false;
	if (
		inspected.kind === "project_share_invite" &&
		(displayNameError(state.projectRecipientName, "Identity display name") ||
			displayNameError(state.projectDeviceName, "Device display name"))
	) {
		return false;
	}
	if (
		inspected.kind === "team_member" &&
		displayNameError(state.recipientName, "Identity display name")
	) {
		return false;
	}
	return true;
}

async function importInspectedInvitation(
	state: InvitationState,
	inspected: AcceptableInspection,
): Promise<ImportInviteResult> {
	if (inspected.kind === "project_share_invite") {
		return api.importCoordinatorInvite(
			state.invite.trim(),
			{
				recipient_name: state.projectRecipientName.trim(),
				device_name: state.projectDeviceName.trim(),
			},
			inspected.kind,
		);
	}
	const recipientName =
		inspected.kind === "team_member" ? { recipient_name: state.recipientName.trim() } : {};
	return api.importCoordinatorInvite(
		state.invite.trim(),
		{
			...recipientName,
			device_name: inspected.device_name,
			reviewed_onboarding_digest: inspected.onboarding.reviewedOnboardingDigest,
		},
		inspected.kind,
	);
}

function recipientAcceptanceFor(
	inspected: Extract<AcceptableInspection, { kind: "team_member" | "add_device" }>,
	result: ImportInviteResult,
): RecipientAcceptance {
	const restartRequired =
		result.restart_required === true || result.setup_state === "restart_required";
	return {
		kind: inspected.kind,
		restartRequired,
		detail:
			inspected.kind === "team_member"
				? "Restart codemem to finish joining this Team."
				: "Restart codemem to finish adding this device.",
		deliveryPending:
			inspected.kind === "add_device" && (inspected.onboarding?.projects?.length ?? 0) > 0,
	};
}

async function acceptRecipientInvitation(state: InvitationState): Promise<void> {
	const inspected = state.inspected;
	if (!inspected || !canAcceptInvitation(state, inspected)) return;
	state.accepting.current = true;
	state.setBusy(true);
	state.setError("");
	state.setStatus("Accepting invitation…");
	try {
		const result = await importInspectedInvitation(state, inspected);
		if (inspected.kind === "project_share_invite") {
			state.setProjectAcceptance(normalizeProjectShareAcceptance(result));
		} else {
			state.setRecipientAcceptance(recipientAcceptanceFor(inspected, result));
		}
		state.setStatus("");
	} catch (cause) {
		state.accepting.current = false;
		const fallback =
			inspected.kind === "project_share_invite"
				? "Unable to accept this Project invitation. Ask the owner to create a new invitation, then try again."
				: "Unable to accept this invitation.";
		state.setError(errorMessage(cause, fallback));
		state.setStatus("");
	} finally {
		state.setBusy(false);
	}
}

async function copyCreatedInvitation(state: InvitationState): Promise<void> {
	const value = state.created?.invite.link || state.created?.invite.encoded || "";
	if (!value) {
		state.setError("The invitation text is unavailable.");
		return;
	}
	try {
		await navigator.clipboard.writeText(value);
		state.setStatus("Invitation copied.");
	} catch {
		state.setError("Unable to copy the invitation.");
	}
}

function useInvitationActions(state: InvitationState) {
	const reviewCreate = () => reviewCreateInvitation(state);
	const create = () => createRecipientInvitation(state);
	const inspect = () => inspectRecipientInvitation(state);
	const accept = () => acceptRecipientInvitation(state);
	const copy = () => copyCreatedInvitation(state);
	return { reviewCreate, create, inspect, accept, copy };
}

type InvitationActions = ReturnType<typeof useInvitationActions>;

function InvitationLanding({
	teams,
	identities,
	controls,
	onNavigateAdvancedSync,
	dialog,
}: {
	teams: RecipientPolicyIntentGraphV1["teams"];
	identities: RecipientPolicyIntentGraphV1["identities"];
	controls: InvitationControls;
	onNavigateAdvancedSync?: () => void;
	dialog: ComponentChildren;
}) {
	return (
		<div className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
			<article className="peer-card peer-card--padded recipient-policy-sharing-card">
				<h3>Invite someone</h3>
				<div className="peer-actions recipient-policy-sharing-responsive-actions">
					<button
						className="settings-save recipient-policy-sharing-target-24"
						disabled={teams.length === 0}
						onClick={(event) => {
							controls.chooseKind("team_member");
							controls.open("create", event.currentTarget);
						}}
						type="button"
					>
						Invite a teammate
					</button>
					<button
						className="settings-button recipient-policy-sharing-target-24"
						disabled={identities.length === 0}
						onClick={(event) => {
							controls.chooseKind("add_device");
							controls.open("create", event.currentTarget);
						}}
						type="button"
					>
						Add a device
					</button>
					<button
						className="settings-button recipient-policy-sharing-target-24"
						onClick={() => openProjectShareFlow()}
						type="button"
					>
						Share specific projects
					</button>
				</div>
				{teams.length === 0 && identities.length === 0 ? (
					<p className="small" role="status">
						No active Teams or Identities are available.
					</p>
				) : null}
			</article>
			<article className="peer-card peer-card--padded recipient-policy-sharing-card">
				<h3>Accept an invite</h3>
				<button
					className="settings-button recipient-policy-sharing-target-24"
					onClick={(event) => controls.open("accept", event.currentTarget)}
					type="button"
				>
					Review an invite
				</button>
				<button
					className="recipient-policy-sharing-pointer sync-subview-link"
					onClick={() => onNavigateAdvancedSync?.()}
					type="button"
				>
					Older invite codes →
				</button>
			</article>
			{dialog}
		</div>
	);
}

function InvitationDialogInput({
	state,
	controls,
	teams,
	identities,
}: {
	state: InvitationState;
	controls: InvitationControls;
	teams: RecipientPolicyIntentGraphV1["teams"];
	identities: RecipientPolicyIntentGraphV1["identities"];
}) {
	if (state.mode === "create" && !state.preview && !state.created) {
		const choices = state.kind === "team_member" ? teams : identities;
		return (
			<label className="field" htmlFor="recipient-invitation-target">
				<span>{state.kind === "team_member" ? "Team" : "Identity"}</span>
				<select
					id="recipient-invitation-target"
					onChange={(event) => state.setTargetId(event.currentTarget.value)}
					value={state.targetId}
				>
					{choices.map((item) => (
						<option
							key={"teamId" in item ? item.teamId : item.identityId}
							value={"teamId" in item ? item.teamId : item.identityId}
						>
							{item.displayName}
						</option>
					))}
				</select>
			</label>
		);
	}
	if (state.mode === "accept" && !state.inspected && !state.recipientAcceptance) {
		return (
			<label className="field" htmlFor="recipient-invitation-value">
				<span>Invitation</span>
				<textarea
					id="recipient-invitation-value"
					onInput={(event) => {
						controls.updateInvite(event.currentTarget.value);
						state.setInspected(null);
						state.setProjectAcceptance(null);
						state.setStatus("");
						state.setError("");
					}}
					rows={5}
					value={state.invite}
				/>
			</label>
		);
	}
	return null;
}

function InvitationDialogReview({ state }: { state: InvitationState }) {
	const recipientPreview =
		state.inspected?.kind === "team_member" || state.inspected?.kind === "add_device"
			? state.inspected.onboarding
			: null;
	const projectShareInvite =
		state.inspected?.kind === "project_share_invite" ? state.inspected : null;
	const recipientNameError =
		state.inspected?.kind === "team_member"
			? displayNameError(state.recipientName, "Identity display name")
			: "";
	const projectRecipientNameError = projectShareInvite
		? displayNameError(state.projectRecipientName, "Identity display name")
		: "";
	const projectDeviceNameError = projectShareInvite
		? displayNameError(state.projectDeviceName, "Device display name")
		: "";
	return (
		<>
			{state.preview ? <Confirmation preview={state.preview} /> : null}
			{recipientPreview && !state.recipientAcceptance ? (
				<Confirmation preview={recipientPreview} />
			) : null}
			{state.inspected?.kind === "team_member" && !state.recipientAcceptance ? (
				<RecipientNameConfirmation
					error={recipientNameError}
					name={state.recipientName}
					onChange={(value) => {
						state.setRecipientName(value);
						state.setError("");
					}}
				/>
			) : null}
			{projectShareInvite && !state.projectAcceptance ? (
				<ProjectShareConfirmation
					deviceName={state.projectDeviceName}
					deviceNameError={projectDeviceNameError}
					invite={projectShareInvite}
					onDeviceNameChange={(value) => {
						state.setProjectDeviceName(value);
						state.setError("");
					}}
					onRecipientNameChange={(value) => {
						state.setProjectRecipientName(value);
						state.setError("");
					}}
					recipientName={state.projectRecipientName}
					recipientNameError={projectRecipientNameError}
				/>
			) : null}
			{state.projectAcceptance ? <ProjectShareResult result={state.projectAcceptance} /> : null}
			{state.recipientAcceptance ? (
				<RecipientAcceptanceResult result={state.recipientAcceptance} />
			) : null}
		</>
	);
}

function InvitationDialogMessages({
	state,
	actions,
}: {
	state: InvitationState;
	actions: InvitationActions;
}) {
	return (
		<>
			{state.created ? (
				<div>
					<p>Share the invitation with the recipient.</p>
					<button className="settings-button" onClick={() => void actions.copy()} type="button">
						Copy invitation
					</button>
				</div>
			) : null}
			{state.inspected?.kind === "legacy_team_invite" ? (
				<p>Open Advanced, then Sync, to review and import this legacy invitation.</p>
			) : null}
			<p aria-live="polite" className="small" role="status">
				{state.status}
			</p>
			{state.error ? (
				<p aria-live="assertive" role="alert">
					{state.error}
				</p>
			) : null}
		</>
	);
}

function InvitationDialogBody({
	state,
	controls,
	actions,
	teams,
	identities,
}: {
	state: InvitationState;
	controls: InvitationControls;
	actions: InvitationActions;
	teams: RecipientPolicyIntentGraphV1["teams"];
	identities: RecipientPolicyIntentGraphV1["identities"];
}) {
	return (
		<div className="modal-body">
			<p className="small" id="recipient-invitation-description">
				{state.recipientAcceptance
					? "The invitation has been accepted."
					: "Confirm exactly what this invitation includes before continuing."}
			</p>
			<InvitationDialogInput
				controls={controls}
				identities={identities}
				state={state}
				teams={teams}
			/>
			<InvitationDialogReview state={state} />
			<InvitationDialogMessages actions={actions} state={state} />
		</div>
	);
}

function invitationDialogTitle(state: InvitationState): string {
	if (state.recipientAcceptance) return "Invitation accepted";
	if (state.mode === "create") return "Create invitation";
	return "Review invitation";
}

function createInvitationActionButton(
	state: InvitationState,
	actions: InvitationActions,
): ComponentChildren {
	let label = "Review invitation";
	if (state.busy) label = "Working…";
	else if (state.preview) label = "Create invitation";
	return (
		<button
			className="settings-button sync-dialog-confirm"
			disabled={state.busy || !state.targetId}
			onClick={() => void (state.preview ? actions.create() : actions.reviewCreate())}
			type="button"
		>
			{label}
		</button>
	);
}

function reviewInvitationActionButton(
	state: InvitationState,
	actions: InvitationActions,
): ComponentChildren {
	return (
		<button
			className="settings-button sync-dialog-confirm"
			disabled={state.busy}
			onClick={() => void actions.inspect()}
			type="button"
		>
			{state.busy ? "Reviewing…" : "Review invitation"}
		</button>
	);
}

function acceptInvitationActionButton(
	state: InvitationState,
	actions: InvitationActions,
): ComponentChildren {
	const recipientPreview =
		state.inspected?.kind === "team_member" || state.inspected?.kind === "add_device";
	const projectShareInvite = state.inspected?.kind === "project_share_invite";
	if (
		state.recipientAcceptance ||
		state.projectAcceptance ||
		(!recipientPreview && !projectShareInvite)
	)
		return null;
	const recipientNameError =
		state.inspected?.kind === "team_member"
			? displayNameError(state.recipientName, "Identity display name")
			: "";
	const projectRecipientNameError = projectShareInvite
		? displayNameError(state.projectRecipientName, "Identity display name")
		: "";
	const projectDeviceNameError = projectShareInvite
		? displayNameError(state.projectDeviceName, "Device display name")
		: "";
	const missingProjectDetails =
		state.inspected?.kind === "project_share_invite" && !state.inspected.projects?.length;
	const invalidProject =
		projectShareInvite &&
		(missingProjectDetails || projectRecipientNameError || projectDeviceNameError);
	let label = "Accept invitation";
	if (state.busy) label = "Accepting…";
	else if (projectShareInvite) label = "Accept Project access";
	return (
		<button
			className="settings-button sync-dialog-confirm"
			disabled={state.busy || Boolean(recipientNameError) || Boolean(invalidProject)}
			onClick={() => void actions.accept()}
			type="button"
		>
			{label}
		</button>
	);
}

function invitationActionButton({
	state,
	actions,
}: {
	state: InvitationState;
	actions: InvitationActions;
}): ComponentChildren {
	if (state.mode === "create" && !state.created)
		return createInvitationActionButton(state, actions);
	if (state.mode === "accept" && !state.inspected && !state.recipientAcceptance) {
		return reviewInvitationActionButton(state, actions);
	}
	return acceptInvitationActionButton(state, actions);
}

function InvitationDialogFooter({
	state,
	controls,
	actions,
}: {
	state: InvitationState;
	controls: InvitationControls;
	actions: InvitationActions;
}) {
	const done = state.created || state.projectAcceptance || state.recipientAcceptance;
	return (
		<div className="modal-footer recipient-policy-sharing-responsive-actions">
			<button
				className="settings-button"
				disabled={state.busy}
				onClick={controls.close}
				type="button"
			>
				{done ? "Done" : "Cancel"}
			</button>
			{invitationActionButton({ actions, state })}
		</div>
	);
}

function InvitationDialog({
	state,
	controls,
	actions,
	teams,
	identities,
}: {
	state: InvitationState;
	controls: InvitationControls;
	actions: InvitationActions;
	teams: RecipientPolicyIntentGraphV1["teams"];
	identities: RecipientPolicyIntentGraphV1["identities"];
}) {
	return (
		<RadixDialog
			ariaDescribedby="recipient-invitation-description"
			ariaLabelledby="recipient-invitation-title"
			contentClassName="modal recipient-policy-invitation-dialog"
			contentId="recipientInvitationDialog"
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				state.returnFocus.current?.focus();
				state.returnFocus.current = null;
			}}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				document.getElementById("recipient-invitation-title")?.focus();
			}}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) controls.close();
			}}
			open
			overlayClassName="modal-backdrop"
			overlayId="recipientInvitationDialogBackdrop"
		>
			<div aria-busy={state.busy} className="modal-card sync-dialog-card">
				<div className="modal-header">
					<h2 id="recipient-invitation-title" tabIndex={-1}>
						{invitationDialogTitle(state)}
					</h2>
					<DialogCloseButton
						ariaLabel="Close invitation"
						className="modal-close-button recipient-policy-sharing-target-24"
						disabled={state.busy}
						onClick={controls.close}
					/>
				</div>
				<InvitationDialogBody
					actions={actions}
					controls={controls}
					identities={identities}
					state={state}
					teams={teams}
				/>
				<InvitationDialogFooter actions={actions} controls={controls} state={state} />
			</div>
		</RadixDialog>
	);
}

export function RecipientPolicyInvitations({
	intent,
	onNavigateAdvancedSync,
}: {
	intent: RecipientPolicyIntentGraphV1;
	onNavigateAdvancedSync?: () => void;
}) {
	const teams = intent.teams.filter((team) => team.status === "active");
	const identities = intent.identities.filter((identity) => identity.status === "active");
	const state = useInvitationState(teams);
	const controls = useInvitationControls(state, teams, identities);
	const actions = useInvitationActions(state);
	const dialog = state.mode ? (
		<InvitationDialog
			actions={actions}
			controls={controls}
			identities={identities}
			state={state}
			teams={teams}
		/>
	) : null;
	return (
		<InvitationLanding
			controls={controls}
			dialog={dialog}
			identities={identities}
			onNavigateAdvancedSync={onNavigateAdvancedSync}
			teams={teams}
		/>
	);
}
