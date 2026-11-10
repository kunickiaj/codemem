import { useEffect, useRef, useState } from "preact/hooks";
import { Chip } from "../../components/primitives/chip";
import { NativeSelect } from "../../components/primitives/native-select";
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
	entriesId: string;
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
							aria-label={`Select all Project entries for ${model.label}`}
							checked={allSelected}
							className="project-selection-checkbox"
							onChange={() => callbacks.toggleSelection(model.projectIds)}
							ref={checkboxRef}
							type="checkbox"
						/>
						<span className="sr-only">Select all Project entries for {model.label}</span>
					</label>
				) : null}
			</td>
			<th className="project-inventory-cell project-inventory-project-cell" scope="row">
				<strong className="project-inventory-title" id={titleId}>
					{model.label}
				</strong>
				<div className="project-inventory-badges">
					<Chip variant="badge">{model.projects.length} Project entries</Chip>
					<button
						aria-controls={props.entriesId}
						aria-expanded={worktreesOpen}
						aria-label={`${worktreesOpen ? "Hide" : "Show"} entries for ${model.label}${groupLabel}`}
						className="settings-button project-worktrees-toggle"
						onClick={(event) => {
							if (worktreesOpen) event.currentTarget.focus();
							onToggleWorktrees();
						}}
						type="button"
					>
						{worktreesOpen ? "Hide entries" : "Show entries"}
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
	onReviewEntries: () => void;
	entriesId: string;
};

function ClusterAssignmentControls(props: ClusterDetailsProps) {
	const { callbacks, model, scopeId, selectRef, setScopeId, summary, view } = props;
	if (summary.assignable.length === 0) {
		const message = model.projects.every((item) => item.project.read_only)
			? "These Project entries were received from other devices. Change Project or Space assignments on their source devices."
			: "These Project entries cannot be bulk assigned until they have stable local identities. Expand each entry for details.";
		return <div className="settings-note">{message}</div>;
	}
	const scopeAvailable = scopeIsAvailable(scopeId, view);
	return (
		<>
			<NativeSelect
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
			</NativeSelect>
			<button
				className="settings-button"
				disabled={!scopeAvailable || summary.blocking.length > 0}
				onClick={() => void callbacks.saveClusterScope(model.key, scopeId)}
				type="button"
			>
				Save Space for {summary.assignable.length}{" "}
				{summary.assignable.length === 1 ? "Project entry" : "Project entries"}
			</button>
		</>
	);
}

function ClusterWarnings({
	summary,
	onReviewEntries,
	entriesId,
}: Pick<ClusterDetailsProps, "summary" | "onReviewEntries" | "entriesId">) {
	if (summary.blocking.length > 0) {
		return (
			<div className="settings-note project-attention-note">
				<strong>Project match needs review.</strong> One or more Project entries need individual
				review before bulk assignment. Review the remote or recorded path before assigning a Space.
				<button
					aria-controls={entriesId}
					className="settings-button project-review-entries"
					onClick={onReviewEntries}
					type="button"
				>
					Review entries
				</button>
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
						<span>Advanced Space assignment</span>
						{summary.warningTotal > 0 ? (
							<span className="badge badge-offline">Needs attention · {summary.warningTotal}</span>
						) : null}
					</summary>
					<div className="project-inventory-details-body">
						<div className="project-inventory-actions">
							<ClusterAssignmentControls {...props} />
							<ClusterWarnings {...props} />
						</div>
					</div>
				</details>
			</td>
		</tr>
	);
}

function ClusterEntries({
	callbacks,
	model,
	view,
	entriesId,
	regionRef,
	summary,
}: ProjectClusterRowProps & {
	entriesId: string;
	regionRef: ReturnType<typeof useRef<HTMLElement>>;
	summary: ClusterSummary;
}) {
	return (
		<tr className="project-cluster-entries-row" hidden={!model.worktreesOpen}>
			<td colSpan={7}>
				<section
					aria-label={`Project entries for ${model.label}`}
					className="project-cluster-entries"
					id={entriesId}
					ref={regionRef}
					tabIndex={-1}
				>
					<table className="project-inventory-table project-entries-table">
						<caption className="sr-only">Project entries for {model.label}</caption>
						<thead className="sr-only">
							<tr>
								{[
									"Select",
									"Project entry",
									"Memories",
									"Sessions",
									"Last activity",
									"Shared with",
									"Actions",
								].map((label) => (
									<th key={label} scope="col">
										{label}
									</th>
								))}
							</tr>
						</thead>
						{model.worktreesOpen
							? model.projects.map((project) => (
									<ProjectRow
										callbacks={callbacks}
										child
										clusterKey={model.key}
										key={`${project.project.read_only ? "received" : "local"}:${project.key}`}
										model={project}
										view={view}
									/>
								))
							: null}
					</table>
					{summary.blocking.length > 0 ? (
						<details className="project-entry-review-details">
							<summary>Project matches needing review · {summary.blocking.length}</summary>
							<ul>
								{summary.blocking.map(({ project, warning }) => (
									<li key={`${project.key}:${warning.code}`}>
										<strong>Project entry: {project.project.workspace_identity}</strong> —{" "}
										{warning.message}
									</li>
								))}
							</ul>
						</details>
					) : null}
				</section>
			</td>
		</tr>
	);
}

export function ProjectClusterRow(props: ProjectClusterRowProps) {
	const { callbacks, model } = props;
	const [open, setOpen] = useState(model.detailsOpen);
	const [scopeId, setScopeId] = useState(model.draftScopeId ?? "");
	const selectRef = useRef<HTMLSelectElement>(null);
	const regionRef = useRef<HTMLElement>(null);
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
	const entriesId = projectDomId("project-cluster-entries", model.key);
	const reviewEntries = () => {
		callbacks.setClusterWorktreesOpen(model.key, true);
		queueMicrotask(() => regionRef.current?.focus());
	};
	return (
		<tbody
			aria-labelledby={titleId}
			className="project-inventory-row project-inventory-cluster"
			data-project-cluster-key={model.key}
		>
			<ClusterHeader
				{...props}
				entriesId={entriesId}
				onOpenAssignment={openAssignment}
				onToggleWorktrees={() => callbacks.setClusterWorktreesOpen(model.key, !model.worktreesOpen)}
				summary={summary}
				titleId={titleId}
				worktreesOpen={model.worktreesOpen}
			/>
			<ClusterEntries {...props} entriesId={entriesId} regionRef={regionRef} summary={summary} />
			<ClusterDetails
				{...props}
				entriesId={entriesId}
				onReviewEntries={reviewEntries}
				onOpenChange={setDetailsOpen}
				open={open}
				scopeId={scopeId}
				selectRef={selectRef}
				setScopeId={setScopeId}
				summary={summary}
			/>
		</tbody>
	);
}
