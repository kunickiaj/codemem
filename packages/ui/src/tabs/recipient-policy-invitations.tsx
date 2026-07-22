import { useRef, useState } from "preact/hooks";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import type {
	CreatedRecipientInvite,
	InspectInviteResult,
	RecipientInvitePreviewRequest,
	RecipientOnboardingPreviewV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import { openProjectShareFlow } from "./project-sharing";

type CreateKind = "team_member" | "add_device";
type DialogMode = "create" | "accept";

function errorMessage(cause: unknown, fallback: string): string {
	if (cause instanceof Error && cause.message === "reviewed_onboarding_stale") {
		return "Invitation details changed. Review them again before creating it.";
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

function request(kind: CreateKind, targetId: string): RecipientInvitePreviewRequest {
	return kind === "team_member"
		? { kind, policy_team_id: targetId }
		: { kind, target_identity_id: targetId };
}

export function RecipientPolicyInvitations({ intent }: { intent: RecipientPolicyIntentGraphV1 }) {
	const teams = intent.teams.filter((team) => team.status === "active");
	const identities = intent.identities.filter((identity) => identity.status === "active");
	const [mode, setMode] = useState<DialogMode | null>(null);
	const [kind, setKind] = useState<CreateKind>("team_member");
	const [targetId, setTargetId] = useState(teams[0]?.teamId ?? "");
	const [invite, setInvite] = useState("");
	const [preview, setPreview] = useState<RecipientOnboardingPreviewV1 | null>(null);
	const [inspected, setInspected] = useState<InspectInviteResult | null>(null);
	const [created, setCreated] = useState<CreatedRecipientInvite | null>(null);
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const returnFocus = useRef<HTMLElement | null>(null);

	const reset = () => {
		setPreview(null);
		setInspected(null);
		setCreated(null);
		setStatus("");
		setError("");
	};
	const open = (nextMode: DialogMode, trigger: HTMLElement) => {
		reset();
		returnFocus.current = trigger;
		setMode(nextMode);
	};
	const close = () => {
		if (!busy) setMode(null);
	};
	const chooseKind = (nextKind: CreateKind) => {
		setKind(nextKind);
		setTargetId(
			nextKind === "team_member" ? (teams[0]?.teamId ?? "") : (identities[0]?.identityId ?? ""),
		);
		reset();
	};
	const reviewCreate = async () => {
		if (!targetId) return;
		setBusy(true);
		setError("");
		setStatus("Reviewing invitation…");
		try {
			const result = await api.previewRecipientInvite(request(kind, targetId));
			setPreview(result.preview);
			setStatus("Review ready. Confirm the invitation details.");
		} catch (cause) {
			setError(errorMessage(cause, "Unable to review this invitation."));
			setStatus("");
		} finally {
			setBusy(false);
		}
	};
	const create = async () => {
		if (!preview) return;
		setBusy(true);
		setError("");
		setStatus("Creating invitation…");
		try {
			const result = await api.createRecipientInvite({
				...request(kind, targetId),
				reviewed_onboarding_digest: preview.reviewedOnboardingDigest,
			});
			setCreated(result);
			setStatus("Invitation created.");
		} catch (cause) {
			if (cause instanceof Error && cause.message === "reviewed_onboarding_stale") {
				setPreview(null);
			}
			setError(errorMessage(cause, "Unable to create this invitation."));
			setStatus("");
		} finally {
			setBusy(false);
		}
	};
	const inspect = async () => {
		if (!invite.trim()) {
			setError("Paste an invitation first.");
			return;
		}
		setBusy(true);
		setError("");
		setStatus("Reviewing invitation…");
		try {
			const result = await api.inspectCoordinatorInvite(invite.trim());
			setInspected(result);
			setStatus(
				result.kind === "team_member" || result.kind === "add_device"
					? "Review ready. Confirm before accepting."
					: "Open Advanced Team administration to continue with this invitation.",
			);
		} catch (cause) {
			setError(errorMessage(cause, "Unable to review this invitation."));
			setStatus("");
		} finally {
			setBusy(false);
		}
	};
	const accept = async () => {
		if (!inspected || (inspected.kind !== "team_member" && inspected.kind !== "add_device")) return;
		setBusy(true);
		setError("");
		setStatus("Accepting invitation…");
		try {
			await api.importCoordinatorInvite(invite.trim(), {
				recipient_name: inspected.recipient_name,
				device_name: inspected.device_name,
				reviewed_onboarding_digest: inspected.onboarding.reviewedOnboardingDigest,
			});
			setStatus(inspected.kind === "team_member" ? "Team invitation accepted." : "Device added.");
			setInspected(null);
			setInvite("");
		} catch (cause) {
			setError(errorMessage(cause, "Unable to accept this invitation."));
			setStatus("");
		} finally {
			setBusy(false);
		}
	};
	const copy = async () => {
		const value = created?.invite.link || created?.invite.encoded || "";
		if (!value) {
			setError("The invitation text is unavailable.");
			return;
		}
		try {
			await navigator.clipboard.writeText(value);
			setStatus("Invitation copied.");
		} catch {
			setError("Unable to copy the invitation.");
		}
	};

	const recipientPreview =
		inspected?.kind === "team_member" || inspected?.kind === "add_device"
			? inspected.onboarding
			: null;
	return (
		<div className="recipient-policy-sharing-grid recipient-policy-sharing-responsive-grid">
			<article className="peer-card peer-card--padded recipient-policy-sharing-card">
				<h3>Create an invitation</h3>
				<p>Invite a Team member, add a device, or share an exact set of Projects.</p>
				<div className="peer-actions recipient-policy-sharing-responsive-actions">
					<button
						className="settings-button recipient-policy-sharing-target-24"
						disabled={teams.length === 0}
						onClick={(event) => {
							chooseKind("team_member");
							open("create", event.currentTarget);
						}}
						type="button"
					>
						Invite Team member
					</button>
					<button
						className="settings-button recipient-policy-sharing-target-24"
						disabled={identities.length === 0}
						onClick={(event) => {
							chooseKind("add_device");
							open("create", event.currentTarget);
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
						Share exact Projects
					</button>
				</div>
				{teams.length === 0 && identities.length === 0 ? (
					<p className="small" role="status">
						No active Teams or Identities are available.
					</p>
				) : null}
			</article>
			<article className="peer-card peer-card--padded recipient-policy-sharing-card">
				<h3>Accept an invitation</h3>
				<p>Review Team membership or device access before accepting.</p>
				<button
					className="settings-button recipient-policy-sharing-target-24"
					onClick={(event) => open("accept", event.currentTarget)}
					type="button"
				>
					Review invitation
				</button>
				<p className="small">
					Legacy invitation import remains under Advanced Team administration.
				</p>
			</article>
			{mode ? (
				<RadixDialog
					ariaDescribedby="recipient-invitation-description"
					ariaLabelledby="recipient-invitation-title"
					contentClassName="modal recipient-policy-invitation-dialog"
					contentId="recipientInvitationDialog"
					onCloseAutoFocus={(event) => {
						event.preventDefault();
						returnFocus.current?.focus();
						returnFocus.current = null;
					}}
					onOpenAutoFocus={(event) => {
						event.preventDefault();
						document.getElementById("recipient-invitation-title")?.focus();
					}}
					onOpenChange={(nextOpen) => {
						if (!nextOpen) close();
					}}
					open
					overlayClassName="modal-backdrop"
					overlayId="recipientInvitationDialogBackdrop"
				>
					<div aria-busy={busy} className="modal-card sync-dialog-card">
						<div className="modal-header">
							<h2 id="recipient-invitation-title" tabIndex={-1}>
								{mode === "create" ? "Create invitation" : "Review invitation"}
							</h2>
							<button aria-label="Close invitation" disabled={busy} onClick={close} type="button">
								×
							</button>
						</div>
						<div className="modal-body">
							<p className="small" id="recipient-invitation-description">
								Confirm exactly what this invitation includes before continuing.
							</p>
							{mode === "create" && !preview && !created ? (
								<label className="field" htmlFor="recipient-invitation-target">
									<span>{kind === "team_member" ? "Team" : "Identity"}</span>
									<select
										id="recipient-invitation-target"
										onChange={(event) => setTargetId(event.currentTarget.value)}
										value={targetId}
									>
										{(kind === "team_member" ? teams : identities).map((item) => (
											<option
												key={"teamId" in item ? item.teamId : item.identityId}
												value={"teamId" in item ? item.teamId : item.identityId}
											>
												{item.displayName}
											</option>
										))}
									</select>
								</label>
							) : mode === "accept" && !inspected ? (
								<label className="field" htmlFor="recipient-invitation-value">
									<span>Invitation</span>
									<textarea
										id="recipient-invitation-value"
										onInput={(event) => {
											setInvite(event.currentTarget.value);
											setInspected(null);
										}}
										rows={5}
										value={invite}
									/>
								</label>
							) : null}
							{preview ? <Confirmation preview={preview} /> : null}
							{recipientPreview ? <Confirmation preview={recipientPreview} /> : null}
							{created ? (
								<div>
									<p>Share the invitation with the recipient.</p>
									<button className="settings-button" onClick={() => void copy()} type="button">
										Copy invitation
									</button>
								</div>
							) : null}
							{inspected?.kind === "legacy_team_invite" ||
							inspected?.kind === "project_share_invite" ? (
								<p>Use Advanced Team administration to review and import this invitation.</p>
							) : null}
							<p aria-live="polite" className="small" role="status">
								{status}
							</p>
							{error ? (
								<p aria-live="assertive" role="alert">
									{error}
								</p>
							) : null}
						</div>
						<div className="modal-footer recipient-policy-sharing-responsive-actions">
							<button className="settings-button" disabled={busy} onClick={close} type="button">
								{created ? "Done" : "Cancel"}
							</button>
							{mode === "create" && !created ? (
								<button
									className="settings-button sync-dialog-confirm"
									disabled={busy || !targetId}
									onClick={() => void (preview ? create() : reviewCreate())}
									type="button"
								>
									{busy ? "Working…" : preview ? "Create invitation" : "Review invitation"}
								</button>
							) : mode === "accept" && !inspected ? (
								<button
									className="settings-button sync-dialog-confirm"
									disabled={busy}
									onClick={() => void inspect()}
									type="button"
								>
									{busy ? "Reviewing…" : "Review invitation"}
								</button>
							) : recipientPreview ? (
								<button
									className="settings-button sync-dialog-confirm"
									disabled={busy}
									onClick={() => void accept()}
									type="button"
								>
									{busy ? "Accepting…" : "Accept invitation"}
								</button>
							) : null}
						</div>
					</div>
				</RadixDialog>
			) : null}
		</div>
	);
}
