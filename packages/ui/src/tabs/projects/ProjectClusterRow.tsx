import { useEffect, useRef, useState } from "preact/hooks";
import { Chip } from "../../components/primitives/chip";
import type {
	ProjectInventoryCallbacks,
	ProjectInventoryClusterViewModel,
	ProjectsInventoryViewModel,
} from "../projects-inventory-model";
import { ProjectRow, RecipientSummary } from "./ProjectRow";
import { ProjectClusterMenu } from "./ProjectRowMenu";
import { isAssignable, projectDomId, scopeIsAvailable, scopeOptionLabel } from "./project-view";

interface ProjectClusterRowProps {
	callbacks: ProjectInventoryCallbacks;
	model: ProjectInventoryClusterViewModel;
	view: ProjectsInventoryViewModel;
}

function buildClusterSummary(model: ProjectInventoryClusterViewModel) {
	const assignable = model.projects.filter((project) => isAssignable(project.project));
	const blocking = assignable.flatMap((project) =>
		(project.project.guardrail_warnings ?? [])
			.filter((warning) => warning.requires_confirmation)
			.map((warning) => ({ project, warning })),
	);
	const suggestedScopes = new Set(
		assignable
			.map((project) => project.project.suggested_scope_id)
			.filter((scopeId): scopeId is string => Boolean(scopeId)),
	);
	const resolvedScopes = new Set(assignable.map((project) => project.project.resolved_scope_id));
	return {
		assignable,
		blocking,
		hasMixed: suggestedScopes.size > 1 || resolvedScopes.size > 1,
		memoryCount: model.projects.reduce(
			(total, item) => total + (item.project.memory_count ?? 0),
			0,
		),
		sessionCount: model.projects.reduce((total, item) => total + item.project.session_count, 0),
		warningTotal: model.projects.reduce(
			(total, item) =>
				total +
				(item.project.guardrail_warnings ?? []).filter((warning) => warning.severity === "warning")
					.length,
			0,
		),
	};
}

type ClusterSummary = ReturnType<typeof buildClusterSummary>;
type ClusterContentProps = ProjectClusterRowProps & { summary: ClusterSummary };

function useClusterCheckbox(model: ProjectInventoryClusterViewModel) {
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (!ref.current) return;
		ref.current.indeterminate =
			model.selectedProjectIds.length > 0 &&
			model.selectedProjectIds.length < model.projectIds.length;
	}, [model.projectIds.length, model.selectedProjectIds.length]);
	return ref;
}

function ClusterStats({ model, summary, view }: ClusterContentProps) {
	return (
		<>
			<td className="project-inventory-cell project-inventory-number" data-label="Memories">
				{summary.memoryCount.toLocaleString()}
			</td>
			<td className="project-inventory-cell project-inventory-number" data-label="Sessions">
				{summary.sessionCount.toLocaleString()}
			</td>
			<td className="project-inventory-cell project-inventory-latest" data-label="Last activity">
				—
			</td>
			<td className="project-inventory-cell project-inventory-shared" data-label="Shared with">
				<RecipientSummary
					available={view.recipientPolicyReady}
					cluster
					recipients={model.recipients}
				/>
			</td>
		</>
	);
}

type ClusterHeaderProps = ClusterContentProps & {
	onOpenAssignment: () => void;
	onToggleWorktrees: () => void;
	titleId: string;
	worktreesOpen: boolean;
};

function ClusterActions({ callbacks, model, onOpenAssignment, summary, view }: ClusterHeaderProps) {
	return (
		<td className="project-inventory-cell project-inventory-row-actions">
			{model.projectIds.length > 0 ? (
				<button
					aria-label={`Manage sharing for ${model.label}`}
					className="settings-button project-recipient-action project-selection-target"
					disabled={!view.selection.ready}
					onClick={() => callbacks.manageRecipients(model.projectIds)}
					type="button"
				>
					Manage sharing
				</button>
			) : null}
			{summary.assignable.length > 0 ? (
				<ProjectClusterMenu label={model.label} onOpenSpaceAssignment={onOpenAssignment} />
			) : null}
		</td>
	);
}

function ClusterHeader(props: ClusterHeaderProps) {
	const { callbacks, model, onToggleWorktrees, summary, titleId, worktreesOpen } = props;
	const checkboxRef = useClusterCheckbox(model);
	const sameNameClusters = props.view.rows.filter(
		(row) => row.kind === "cluster" && row.label === model.label,
	);
	const groupLabel =
		sameNameClusters.length > 1
			? ` (group ${sameNameClusters.findIndex((row) => row.key === model.key) + 1} of ${sameNameClusters.length})`
			: "";
	const allSelected =
		model.projectIds.length > 0 && model.selectedProjectIds.length === model.projectIds.length;
	return (
		<tr className="project-inventory-row-header project-inventory-table-row">
			<td className="project-inventory-cell project-inventory-select-cell">
				{model.projectIds.length > 0 ? (
					<label className="project-selection-control project-selection-target">
						<input
							aria-label={`Select all identities for ${model.label}`}
							checked={allSelected}
							className="project-selection-checkbox"
							onChange={() => callbacks.toggleSelection(model.projectIds)}
							ref={checkboxRef}
							type="checkbox"
						/>
						<span className="sr-only">Select all identities for {model.label}</span>
					</label>
				) : null}
			</td>
			<th className="project-inventory-cell project-inventory-project-cell" scope="row">
				<strong className="project-inventory-title" id={titleId}>
					{model.label}
				</strong>
				<div className="project-inventory-badges">
					<Chip variant="badge">{model.projects.length} worktrees</Chip>
					<button
						aria-expanded={worktreesOpen}
						aria-label={`${worktreesOpen ? "Hide" : "Show"} worktrees for ${model.label}${groupLabel}`}
						className="settings-button project-worktrees-toggle"
						onClick={(event) => {
							if (worktreesOpen) event.currentTarget.focus();
							onToggleWorktrees();
						}}
						type="button"
					>
						{worktreesOpen ? "Hide worktrees" : "Show worktrees"}
					</button>
					{summary.warningTotal > 0 ? (
						<Chip tone="badge-offline" variant="badge">
							Needs attention · {summary.warningTotal}
						</Chip>
					) : null}
				</div>
			</th>
			<ClusterStats {...props} />
			<ClusterActions {...props} />
		</tr>
	);
}

type ClusterDetailsProps = ClusterContentProps & {
	onOpenChange: (open: boolean) => void;
	open: boolean;
	scopeId: string;
	selectRef: ReturnType<typeof useRef<HTMLSelectElement>>;
	setScopeId: (scopeId: string) => void;
};

function ClusterAssignmentControls(props: ClusterDetailsProps) {
	const { callbacks, model, scopeId, selectRef, setScopeId, summary, view } = props;
	if (summary.assignable.length === 0) {
		const message = model.projects.every((item) => item.project.read_only)
			? "These project identities were received from other devices. Change project or Space assignments on their source devices."
			: "These project identities cannot be bulk assigned until they have stable local identities. Expand each identity for details.";
		return <div className="settings-note">{message}</div>;
	}
	const scopeAvailable = scopeIsAvailable(scopeId, view);
	return (
		<>
			<select
				aria-label={`Space for ${model.label} group`}
				className="project-domain-select"
				onBlur={callbacks.onSpaceSelectBlur}
				onChange={(event) => {
					setScopeId(event.currentTarget.value);
					callbacks.setClusterScopeDraft(model.key, event.currentTarget.value);
				}}
				ref={selectRef}
				value={scopeId}
			>
				<option value="">Choose Space…</option>
				{view.scopeGroups.map((group) => (
					<optgroup key={group.key} label={group.label}>
						{group.scopes.map((scope) => (
							<option key={scope.scope_id} value={scope.scope_id}>
								{scopeOptionLabel(scope, group.scopes)}
							</option>
						))}
					</optgroup>
				))}
			</select>
			<button
				className="settings-button"
				disabled={!scopeAvailable || summary.blocking.length > 0}
				onClick={() => void callbacks.saveClusterScope(model.key, scopeId)}
				type="button"
			>
				Save Space for {summary.assignable.length}{" "}
				{summary.assignable.length === 1 ? "identity" : "identities"}
			</button>
		</>
	);
}

function ClusterWarnings({ summary }: Pick<ClusterContentProps, "summary">) {
	if (summary.blocking.length > 0) {
		return (
			<div className="settings-note project-attention-note">
				One or more identities in this group need individual review before bulk assignment.
				<ul>
					{summary.blocking.map(({ project, warning }) => (
						<li key={`${project.key}:${warning.code}`}>
							<strong>Blocked identity: {project.project.workspace_identity}</strong> —{" "}
							{warning.message}
						</li>
					))}
				</ul>
			</div>
		);
	}
	if (!summary.hasMixed) return null;
	return (
		<div className="settings-note project-attention-note">
			This group has mixed suggestions or current Spaces. Choose a Space explicitly before bulk
			assignment.
		</div>
	);
}

function ClusterDetails(props: ClusterDetailsProps) {
	const { onOpenChange, open, summary } = props;
	return (
		<tr className="project-inventory-details-row project-inventory-cluster-details-row">
			<td className="project-inventory-details-cell" colSpan={7}>
				<details
					className="project-inventory-details"
					onToggle={(event) => onOpenChange(event.currentTarget.open)}
					open={open}
				>
					<summary>
						<span>Bulk details</span>
						{summary.warningTotal > 0 ? (
							<span className="badge badge-offline">Needs attention · {summary.warningTotal}</span>
						) : null}
					</summary>
					<div className="project-inventory-details-body">
						<div className="project-inventory-actions">
							<ClusterAssignmentControls {...props} />
							<ClusterWarnings summary={summary} />
						</div>
					</div>
				</details>
			</td>
		</tr>
	);
}

export function ProjectClusterRow(props: ProjectClusterRowProps) {
	const { callbacks, model } = props;
	const [open, setOpen] = useState(model.detailsOpen);
	const [scopeId, setScopeId] = useState(model.draftScopeId ?? "");
	const selectRef = useRef<HTMLSelectElement>(null);
	useEffect(() => {
		if (model.detailsOpen) setOpen(true);
	}, [model.detailsOpen]);
	useEffect(() => setScopeId(model.draftScopeId ?? ""), [model.draftScopeId]);
	const summary = buildClusterSummary(model);
	const setDetailsOpen = (nextOpen: boolean) => {
		setOpen(nextOpen);
		callbacks.setClusterDetailsOpen(model.key, nextOpen);
	};
	const openAssignment = () => {
		setDetailsOpen(true);
		queueMicrotask(() => selectRef.current?.focus());
	};
	const titleId = projectDomId("project-cluster-title", model.key);
	return (
		<>
			<tbody
				aria-labelledby={titleId}
				className="project-inventory-row project-inventory-cluster"
				data-project-cluster-key={model.key}
			>
				<ClusterHeader
					{...props}
					onOpenAssignment={openAssignment}
					onToggleWorktrees={() =>
						callbacks.setClusterWorktreesOpen(model.key, !model.worktreesOpen)
					}
					summary={summary}
					titleId={titleId}
					worktreesOpen={model.worktreesOpen}
				/>
				<ClusterDetails
					{...props}
					onOpenChange={setDetailsOpen}
					open={open}
					scopeId={scopeId}
					selectRef={selectRef}
					setScopeId={setScopeId}
					summary={summary}
				/>
			</tbody>
			{model.worktreesOpen
				? model.projects.map((project) => (
						<ProjectRow
							callbacks={callbacks}
							child
							clusterKey={model.key}
							key={`${project.project.read_only ? "received" : "local"}:${project.key}`}
							model={project}
							view={props.view}
						/>
					))
				: null}
		</>
	);
}
