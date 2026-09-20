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
import {
	isAssignable,
	latestLabel,
	projectBadges,
	projectDomId,
	projectSignal,
} from "./project-view";

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
	if (recipients.length === 0)
		return <span className="project-recipient-status tertiary">Not shared</span>;
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
	clusterKey?: string;
	model: ProjectInventoryProjectViewModel;
	view: ProjectsInventoryViewModel;
}

type ProjectRowHeaderProps = ProjectRowProps & { onOpenDetails: () => void; titleId: string };

function ProjectRowStats({ model, view }: Pick<ProjectRowProps, "model" | "view">) {
	const { project } = model;
	return (
		<>
			<td className="project-inventory-cell project-inventory-number" data-label="Memories">
				{(project.memory_count ?? 0).toLocaleString()}
			</td>
			<td className="project-inventory-cell project-inventory-number" data-label="Sessions">
				{project.session_count.toLocaleString()}
			</td>
			<td className="project-inventory-cell project-inventory-latest" data-label="Last activity">
				{latestLabel(project.latest_session_at)}
			</td>
			<td className="project-inventory-cell project-inventory-shared" data-label="Shared with">
				<RecipientSummary available={view.recipientPolicyReady} recipients={model.recipients} />
			</td>
		</>
	);
}

function ProjectRowActions({ callbacks, model, onOpenDetails, view }: ProjectRowHeaderProps) {
	const { project } = model;
	if (!isAssignable(project) && !model.manageable)
		return <td className="project-inventory-cell project-inventory-row-actions" />;
	return (
		<td className="project-inventory-cell project-inventory-row-actions">
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
			{isAssignable(project) ? (
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
					onOpenSpaceAssignment={onOpenDetails}
					onRemoveMapping={() => void callbacks.removeProjectScope(project.workspace_identity)}
				/>
			) : null}
		</td>
	);
}

function ProjectRowHeader(props: ProjectRowHeaderProps) {
	const { callbacks, child, model, titleId, view } = props;
	const { project } = model;
	const signal = projectSignal(project);
	return (
		<tr
			className={`project-inventory-row-header project-inventory-table-row${child ? " project-inventory-child-row" : ""}`}
		>
			<td className="project-inventory-cell project-inventory-select-cell">
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
			</td>
			<th className="project-inventory-cell project-inventory-project-cell" scope="row">
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
			</th>
			<ProjectRowStats model={model} view={view} />
			<ProjectRowActions {...props} />
		</tr>
	);
}

export function ProjectRow({ callbacks, child = false, clusterKey, model, view }: ProjectRowProps) {
	const { project } = model;
	const [open, setOpen] = useState(model.detailsOpen);
	const selectRef = useRef<HTMLSelectElement>(null);
	const confirmationActionRef = useRef<HTMLButtonElement>(null);
	const setDetailsOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		callbacks.setProjectDetailsOpen(model.detailKey, nextOpen);
	};
	useEffect(() => {
		if (model.detailsOpen) setOpen(true);
	}, [model.detailsOpen]);
	const hasPendingConfirmation = Boolean(
		model.pendingConfirmation || model.pendingForgetConfirmation,
	);
	useEffect(() => {
		if (!hasPendingConfirmation) return;
		setDetailsOpen(true);
		queueMicrotask(() => confirmationActionRef.current?.focus());
	}, [hasPendingConfirmation]);
	const openDetails = () => {
		setDetailsOpen(true);
		queueMicrotask(() => selectRef.current?.focus());
	};
	const titleId = projectDomId("project-title", model.detailKey);
	return (
		<tbody
			aria-labelledby={titleId}
			className={`project-inventory-row${child ? " project-inventory-child" : ""}`}
			data-project-cluster-key={clusterKey}
			data-project-repairable={String(isAssignable(project))}
			data-project-workspace-identity={project.workspace_identity}
		>
			<ProjectRowHeader
				callbacks={callbacks}
				child={child}
				model={model}
				onOpenDetails={openDetails}
				titleId={titleId}
				view={view}
			/>
			<ProjectRowDetails
				callbacks={callbacks}
				confirmationActionRef={confirmationActionRef}
				model={model}
				onOpenChange={setDetailsOpen}
				open={open}
				selectRef={selectRef}
				view={view}
			/>
		</tbody>
	);
}
