import { useEffect, useRef, useState } from "preact/hooks";
import { Chip } from "../../components/primitives/chip";
import type {
	ProjectInventoryCallbacks,
	ProjectInventoryProjectViewModel,
	ProjectInventoryRecipientViewModel,
	ProjectsInventoryViewModel,
} from "../projects-inventory-model";
import { ProjectRowDetails } from "./ProjectRowDetails";
import { ProjectRowMenu } from "./ProjectRowMenu";
import { isAssignable, latestLabel, projectBadges, projectSignal } from "./project-view";

export function RecipientSummary({
	available,
	cluster = false,
	recipients,
}: {
	available: boolean;
	cluster?: boolean;
	recipients: ProjectInventoryRecipientViewModel[];
}) {
	if (!available) return <span className="project-recipient-status tertiary">Unavailable</span>;
	if (recipients.length === 0) {
		return <span className="project-recipient-status tertiary">Not shared</span>;
	}
	const visible = recipients.slice(0, 2);
	const remaining = recipients.length - visible.length;
	return (
		<div className="project-recipient-summary">
			<ul aria-label="Active recipients" className="project-recipient-chips">
				{visible.map((recipient) => (
					<li
						className={`project-recipient-chip project-recipient-chip-${recipient.kind.toLowerCase()}`}
						key={recipient.key}
					>
						{recipient.kind}: {recipient.displayName}
					</li>
				))}
				{remaining > 0 ? <li className="project-recipient-chip">+{remaining}</li> : null}
			</ul>
			{cluster ? (
				<span className="project-recipient-status">{recipients.length} recipients</span>
			) : null}
		</div>
	);
}

interface ProjectRowProps {
	callbacks: ProjectInventoryCallbacks;
	child?: boolean;
	model: ProjectInventoryProjectViewModel;
	view: ProjectsInventoryViewModel;
}

type ProjectRowHeaderProps = ProjectRowProps & {
	onOpenSpaceAssignment: () => void;
	titleId: string;
};

function ProjectRowStats({ model, view }: Pick<ProjectRowProps, "model" | "view">) {
	const { project } = model;
	return (
		<div className="project-inventory-row-stats">
			<span className="project-inventory-cell project-inventory-number" data-label="Memories">
				{(project.memory_count ?? 0).toLocaleString()}
			</span>
			<span className="project-inventory-cell project-inventory-number" data-label="Sessions">
				{project.session_count.toLocaleString()}
			</span>
			<span className="project-inventory-cell project-inventory-latest" data-label="Last activity">
				{latestLabel(project.latest_session_at)}
			</span>
			<div className="project-inventory-cell project-inventory-shared" data-label="Shared with">
				<RecipientSummary available={view.recipientPolicyReady} recipients={model.recipients} />
			</div>
		</div>
	);
}

function ProjectRowActions({
	callbacks,
	model,
	onOpenSpaceAssignment,
	view,
}: ProjectRowHeaderProps) {
	const { project } = model;
	const assignable = isAssignable(project);
	return (
		<div className="project-inventory-cell project-inventory-row-actions">
			{model.manageable ? (
				<button
					aria-label={`Update sharing for ${project.display_project}`}
					className="settings-button project-recipient-action project-selection-target"
					data-project-focus-key={`manage:${project.workspace_identity}`}
					disabled={!view.selection.ready}
					onClick={() => callbacks.manageRecipients([project.workspace_identity])}
					type="button"
				>
					Update sharing
				</button>
			) : null}
			{assignable ? (
				<ProjectRowMenu
					canAssign
					canChangeProject={project.session_count > 0}
					canForget={(project.memory_count ?? 0) > 0}
					canRemoveMapping={
						project.mapping_id != null && project.resolution_reason === "exact_mapping"
					}
					label={project.display_project}
					onChangeProject={() => void callbacks.reassignProject(project.workspace_identity)}
					onForget={() => void callbacks.forgetProject(project.workspace_identity)}
					onKeepLocal={() => void callbacks.keepProjectLocal(project.workspace_identity)}
					onOpenSpaceAssignment={onOpenSpaceAssignment}
					onRemoveMapping={() => void callbacks.removeProjectScope(project.workspace_identity)}
				/>
			) : null}
		</div>
	);
}

function ProjectRowHeader(props: ProjectRowHeaderProps) {
	const { callbacks, model, titleId, view } = props;
	const { project } = model;
	const signal = projectSignal(project);
	return (
		<div className="project-inventory-row-header project-inventory-table-row">
			<div className="project-inventory-cell project-inventory-select-cell">
				{model.manageable ? (
					<label className="project-selection-control project-selection-target">
						<input
							aria-label={`Select ${project.display_project} for recipient sharing`}
							checked={model.selected}
							className="project-selection-checkbox"
							data-project-focus-key={`select:${project.workspace_identity}`}
							onChange={() => callbacks.toggleSelection([project.workspace_identity])}
							type="checkbox"
						/>
						<span className="sr-only">Select {project.display_project} for recipient sharing</span>
					</label>
				) : null}
			</div>
			<div className="project-inventory-cell project-inventory-project-cell">
				<strong className="project-inventory-title" id={titleId}>
					{project.display_project}
				</strong>
				{signal ? (
					<span className="project-inventory-signal mono small tertiary">{signal}</span>
				) : null}
				<div className="project-inventory-badges">
					{projectBadges(project).map((badge) => (
						<Chip key={badge.label} tone={badge.tone} variant="badge">
							{badge.label}
						</Chip>
					))}
				</div>
			</div>
			<ProjectRowStats model={model} view={view} />
			<ProjectRowActions {...props} />
		</div>
	);
}

export function ProjectRow({ callbacks, child = false, model, view }: ProjectRowProps) {
	const { project } = model;
	const assignable = isAssignable(project);
	const [open, setOpen] = useState(model.detailsOpen);
	const selectRef = useRef<HTMLSelectElement>(null);
	useEffect(() => {
		if (model.detailsOpen) setOpen(true);
	}, [model.detailsOpen]);
	const setDetailsOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		callbacks.setProjectDetailsOpen(model.key, nextOpen);
	};
	const openSpaceAssignment = () => {
		setDetailsOpen(true);
		queueMicrotask(() => selectRef.current?.focus());
	};
	const titleId = `project-title-${project.workspace_identity.replace(/[^a-z0-9_-]/gi, "-")}`;
	return (
		<article
			aria-labelledby={titleId}
			className={`project-inventory-row${child ? " project-inventory-child-row" : ""}`}
			data-project-repairable={String(assignable)}
			data-project-workspace-identity={project.workspace_identity}
		>
			<ProjectRowHeader
				callbacks={callbacks}
				child={child}
				model={model}
				onOpenSpaceAssignment={openSpaceAssignment}
				titleId={titleId}
				view={view}
			/>
			<ProjectRowDetails
				callbacks={callbacks}
				model={model}
				onOpenChange={setDetailsOpen}
				open={open}
				selectRef={selectRef}
				view={view}
			/>
		</article>
	);
}
