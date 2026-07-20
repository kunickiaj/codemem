import { render } from "preact";
import { useEffect, useId, useMemo, useState } from "preact/hooks";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import type {
	CreatedProjectInvite,
	ProjectInvitePreview,
	ProjectScopeInventoryProject,
} from "../lib/api/sync";

let requestOpen: ((projectIds: string[]) => void) | null = null;

export function openProjectShareFlow(projectIds: string[] = []): void {
	requestOpen?.(projectIds);
}

function canShare(project: ProjectScopeInventoryProject): boolean {
	// This is presentation-only gating. The viewer server re-resolves canonical
	// project identities and remains authoritative at preview and creation time.
	return (
		!project.read_only &&
		project.identity_source !== "unmapped" &&
		project.memory_count != null &&
		!project.guardrail_warnings.some((warning) => warning.requires_confirmation)
	);
}

function sharingError(cause: unknown, fallback: string): string {
	if (!(cause instanceof Error)) return fallback;
	switch (cause.message) {
		case "team_sharing_not_configured":
			return "Set up Team sharing before creating an invitation.";
		case "team_selection_ambiguous":
			return "Choose one active Team in settings before creating an invitation.";
		case "project_selection_ambiguous":
			return "One selected project has a name collision. Review its project identity first.";
		case "project_selection_unsupported":
		case "project_selection_unknown":
		case "reviewed_project_set_changed":
			return "The selected projects changed. Review the invitation again.";
		default:
			return fallback;
	}
}

function ProjectChoice(props: {
	project: ProjectScopeInventoryProject;
	selected: boolean;
	onToggle: (projectId: string) => void;
}) {
	const id = `share-project-${useId()}`;
	const available = canShare(props.project);
	return (
		<label className="sync-dialog-radio-option" htmlFor={id}>
			<input
				checked={props.selected}
				disabled={!available}
				id={id}
				onChange={() => props.onToggle(props.project.workspace_identity)}
				type="checkbox"
			/>
			<span>
				<strong>{props.project.display_project}</strong>
				<span className="small">
					{available
						? `${(props.project.memory_count ?? 0).toLocaleString()} existing memories`
						: "Unavailable until this project identity is reviewed"}
				</span>
			</span>
		</label>
	);
}

function Confirmation({ preview }: { preview: ProjectInvitePreview }) {
	return (
		<div className="sync-dialog-stack">
			<p>
				<strong>{preview.teammate.display_name} will receive:</strong>
			</p>
			{preview.teammate.match === "existing" ? (
				<p className="small">This invitation will use the existing teammate.</p>
			) : null}
			<ul>
				{preview.projects.map((project) => (
					<li key={project.project_id}>
						{project.existing_memory_count.toLocaleString()}
						{" existing memories and future activity from "}
						{project.display_name}
					</li>
				))}
			</ul>
			<p>
				<strong>No other projects will be shared.</strong>
			</p>
		</div>
	);
}

function ProjectShareFlow({
	projects,
	inventoryError,
}: {
	projects: ProjectScopeInventoryProject[];
	inventoryError: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [teammateName, setTeammateName] = useState("");
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [preview, setPreview] = useState<ProjectInvitePreview | null>(null);
	const [created, setCreated] = useState<CreatedProjectInvite | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);
	const availableProjects = useMemo(() => projects.filter(canShare), [projects]);

	useEffect(() => {
		requestOpen = (projectIds) => {
			if (inventoryError) return;
			setTeammateName("");
			setSelectedIds(
				projectIds.filter((id) => availableProjects.some((item) => item.workspace_identity === id)),
			);
			setPreview(null);
			setCreated(null);
			setError(null);
			setCopyStatus(null);
			setOpen(true);
		};
		return () => {
			requestOpen = null;
		};
	}, [availableProjects, inventoryError]);

	useEffect(() => {
		if (!inventoryError) return;
		setOpen(false);
		setTeammateName("");
		setSelectedIds([]);
		setPreview(null);
		setCreated(null);
		setError(null);
		setCopyStatus(null);
	}, [inventoryError]);

	const close = () => {
		if (!busy) setOpen(false);
	};
	const toggle = (projectId: string) => {
		setSelectedIds((current) =>
			current.includes(projectId)
				? current.filter((item) => item !== projectId)
				: [...current, projectId],
		);
	};
	const review = async () => {
		setError(null);
		if (!teammateName.trim()) {
			setError("Enter your teammate's name.");
			return;
		}
		if (selectedIds.length === 0) {
			setError("Select at least one project.");
			return;
		}
		setBusy(true);
		try {
			setPreview(
				await api.previewProjectInvite({
					teammate_name: teammateName.trim(),
					project_ids: selectedIds,
				}),
			);
		} catch (cause) {
			setError(sharingError(cause, "Unable to review this invitation."));
		} finally {
			setBusy(false);
		}
	};
	const create = async () => {
		if (!preview) return;
		setError(null);
		setBusy(true);
		try {
			setCreated(
				await api.createProjectInvite({
					teammate_name: preview.teammate.display_name,
					project_ids: preview.projects.map((project) => project.project_id),
					reviewed_project_set_digest: preview.reviewed_project_set_digest,
				}),
			);
		} catch (cause) {
			if (cause instanceof Error && cause.message === "reviewed_project_set_changed") {
				setPreview(null);
			}
			setError(sharingError(cause, "Unable to create this invitation."));
		} finally {
			setBusy(false);
		}
	};
	const copy = async () => {
		if (!created) return;
		setError(null);
		setCopyStatus(null);
		try {
			if (!navigator.clipboard) throw new Error("Clipboard access is unavailable.");
			await navigator.clipboard.writeText(created.invite.link);
			setCopyStatus("Invite copied.");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Unable to copy the invitation.");
		}
	};

	return (
		<>
			<button
				aria-describedby={inventoryError ? "project-share-inventory-error" : undefined}
				className="settings-button"
				disabled={inventoryError || availableProjects.length === 0}
				onClick={() => requestOpen?.([])}
				type="button"
			>
				Share projects
			</button>
			{inventoryError ? (
				<p className="small" id="project-share-inventory-error" role="status">
					The complete project list is unavailable. Refresh Projects to try again.
				</p>
			) : null}
			{open ? (
				<RadixDialog
					ariaDescribedby="project-share-description"
					ariaLabelledby="project-share-title"
					contentClassName="modal"
					contentId="projectShareDialog"
					onOpenChange={(nextOpen) => {
						if (!nextOpen) close();
					}}
					open
					overlayClassName="modal-backdrop"
					overlayId="projectShareDialogBackdrop"
				>
					<div className="modal-card sync-dialog-card">
						<div className="modal-header">
							<h2 id="project-share-title">Share projects</h2>
							<button
								aria-label="Close Share projects"
								disabled={busy}
								onClick={close}
								type="button"
							>
								×
							</button>
						</div>
						<div aria-busy={busy} className="modal-body">
							<p className="small" id="project-share-description">
								Choose a teammate and the exact projects they may receive after accepting.
							</p>
							{created ? (
								<div>
									<p role="status">Invitation created for {created.teammate.display_name}.</p>
									<p>
										Sharing starts after acceptance:{" "}
										{created.projects.map((project) => project.display_name).join(", ")}.
									</p>
									<p className="small">
										Invitation expires {new Date(created.invite.expires_at).toLocaleString()}.
									</p>
									<button className="settings-button" onClick={() => void copy()} type="button">
										Copy invite
									</button>
									{copyStatus ? <p role="status">{copyStatus}</p> : null}
								</div>
							) : preview ? (
								<Confirmation preview={preview} />
							) : (
								<>
									<label className="field" htmlFor="project-share-teammate">
										<span>Who are you sharing with?</span>
										<input
											autoFocus
											className="sync-dialog-input"
											id="project-share-teammate"
											maxLength={120}
											onInput={(event) => setTeammateName(event.currentTarget.value)}
											type="text"
											value={teammateName}
										/>
									</label>
									<fieldset className="sync-dialog-radio-list">
										<legend>Select exact projects</legend>
										{projects.map((project) => (
											<ProjectChoice
												key={project.workspace_identity}
												onToggle={toggle}
												project={project}
												selected={selectedIds.includes(project.workspace_identity)}
											/>
										))}
									</fieldset>
								</>
							)}
							{error ? <p role="alert">{error}</p> : null}
						</div>
						<div className="modal-footer">
							<button className="settings-button" disabled={busy} onClick={close} type="button">
								{created ? "Done" : "Cancel"}
							</button>
							{!created ? (
								<button
									className="settings-button sync-dialog-confirm"
									disabled={busy}
									onClick={() => void (preview ? create() : review())}
									type="button"
								>
									{busy
										? preview
											? "Creating invite…"
											: "Reviewing…"
										: preview
											? "Create invite"
											: "Review sharing"}
								</button>
							) : null}
						</div>
					</div>
				</RadixDialog>
			) : null}
		</>
	);
}

export function renderProjectShareFlow(
	mount: HTMLElement,
	projects: ProjectScopeInventoryProject[],
	options: { inventoryError?: boolean } = {},
): void {
	render(
		<ProjectShareFlow inventoryError={options.inventoryError === true} projects={projects} />,
		mount,
	);
}
