import type { RefObject } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
	ProjectInventoryCallbacks,
	ProjectInventoryProjectViewModel,
	ProjectsInventoryViewModel,
} from "../projects-inventory-model";
import {
	detailFields,
	firstScopeSelection,
	isAssignable,
	isPeerReceived,
	latestLabel,
	projectDomainLabel,
	relationshipLabel,
	resolutionLabel,
	scopeOptionLabel,
	scopeSummary,
	warningCount,
} from "./project-view";

interface ProjectRowDetailsProps {
	callbacks: ProjectInventoryCallbacks;
	confirmationActionRef: RefObject<HTMLButtonElement>;
	model: ProjectInventoryProjectViewModel;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	selectRef: RefObject<HTMLSelectElement>;
	view: ProjectsInventoryViewModel;
}

type DetailsContentProps = Omit<ProjectRowDetailsProps, "onOpenChange" | "open"> & {
	currentAssignable: boolean;
	scopeId: string;
	setScopeId: (scopeId: string) => void;
};

function GuardrailHeading({ code }: { code: string }) {
	const labels: Record<string, string> = {
		basename_collision_review: "Name collision",
		broad_org_domain_pattern: "Broad mapping",
		home_directory_org_domain_pattern: "Broad mapping",
		scope_reassignment_old_copies: "Previous copies",
		unknown_project_local_only: "Current behavior",
	};
	return <strong>{labels[code] ?? "Review item"}: </strong>;
}

function ProjectSharingSummary({ model }: Pick<ProjectRowDetailsProps, "model">) {
	const { project } = model;
	if (!project.sharing?.length) return null;
	return (
		<div className="settings-note project-sharing-summary">
			<strong>Project sharing</strong>
			<ul aria-label={`People sharing ${project.display_project}`}>
				{project.sharing.map((summary) => (
					<li key={summary.person.actor_id}>
						<strong>{relationshipLabel(summary)}</strong> — {summary.lifecycle.label}.{" "}
						{summary.lifecycle.explanation}
					</li>
				))}
			</ul>
		</div>
	);
}

function ProjectDetailsOverview({ model, view }: Pick<ProjectRowDetailsProps, "model" | "view">) {
	const { project } = model;
	const peerReceived = isPeerReceived(project);
	const warnings = (project.guardrail_warnings ?? []).filter(
		(warning) => warning.severity === "warning",
	);
	return (
		<>
			<div className="project-inventory-domain">{projectDomainLabel(project, view)}</div>
			<div className="project-inventory-meta">
				{peerReceived ? "source-owned project" : resolutionLabel(project.resolution_reason)} ·{" "}
				{project.identity_source} · {latestLabel(project.latest_session_at)}
			</div>
			<ProjectSharingSummary model={model} />
			{peerReceived ? (
				<div className="settings-note">Read-only here. Change it on the source device.</div>
			) : null}
			{project.identity_source === "unmapped" ? (
				<div className="settings-note">
					Stays on this device until it has a path, git remote, or workspace id.
				</div>
			) : null}
			{project.suggested_scope_id && project.suggested_scope_id !== project.resolved_scope_id ? (
				<div className="settings-note project-suggestion-note">
					{project.suggestion_reason
						? `Suggestion: ${project.suggestion_reason}`
						: `Suggestion: assign this project to ${scopeSummary(project.suggested_scope_id, view)}.`}
				</div>
			) : null}
			{warnings.length > 0 ? (
				<div className="settings-note project-attention-note">
					Needs attention: {warnings.map((warning) => warning.message).join(" ")}
				</div>
			) : null}
			<dl className="project-detail-grid">
				{detailFields(project, view).map(([label, value]) => (
					<div className="project-detail-pair" key={label}>
						<dt>{label}</dt>
						<dd>{value == null || value === "" ? "—" : String(value)}</dd>
					</div>
				))}
			</dl>
		</>
	);
}

function ProjectSpaceSelect(props: DetailsContentProps) {
	const { callbacks, currentAssignable, model, scopeId, selectRef, setScopeId, view } = props;
	const { project } = model;
	const selectId = `project-domain-${model.key.replace(/[^a-z0-9_-]/gi, "-")}`;
	const saveDisabled = !scopeId || (scopeId === project.resolved_scope_id && !currentAssignable);
	const saveLabel =
		project.suggested_scope_id && scopeId === project.suggested_scope_id
			? "Confirm suggestion"
			: "Save Space";
	return (
		<>
			<label className="sr-only" htmlFor={selectId}>
				Space for {project.display_project}
			</label>
			<select
				className="project-domain-select"
				id={selectId}
				onBlur={callbacks.onSpaceSelectBlur}
				onChange={(event) => {
					setScopeId(event.currentTarget.value);
					callbacks.setProjectScopeDraft(project.workspace_identity, event.currentTarget.value);
				}}
				ref={selectRef}
				value={scopeId}
			>
				{!currentAssignable && project.resolved_scope_id ? (
					<option disabled value={project.resolved_scope_id}>
						{scopeSummary(project.resolved_scope_id, view)} — not assignable
					</option>
				) : null}
				{view.scopeGroups.map((group) => (
					<optgroup key={group.label} label={group.label}>
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
				disabled={saveDisabled}
				onClick={() => void callbacks.saveProjectScope(project.workspace_identity, scopeId)}
				type="button"
			>
				{saveLabel}
			</button>
		</>
	);
}

function ProjectSecondaryActions({
	callbacks,
	model,
}: Pick<DetailsContentProps, "callbacks" | "model">) {
	const { project } = model;
	return (
		<>
			<button
				className="settings-button"
				onClick={() => void callbacks.keepProjectLocal(project.workspace_identity)}
				type="button"
			>
				Keep local-only
			</button>
			<button
				className="settings-button"
				disabled={project.mapping_id == null || project.resolution_reason !== "exact_mapping"}
				onClick={() => void callbacks.removeProjectScope(project.workspace_identity)}
				type="button"
			>
				Remove mapping
			</button>
			<button
				className="settings-button"
				disabled={project.session_count === 0}
				title={
					project.session_count === 0
						? "No sessions are available to reassign for this saved mapping."
						: undefined
				}
				onClick={() => void callbacks.reassignProject(project.workspace_identity)}
				type="button"
			>
				Change project…
			</button>
			<button
				className="settings-button danger"
				disabled={(project.memory_count ?? 0) === 0}
				onClick={() => void callbacks.forgetProject(project.workspace_identity)}
				type="button"
			>
				Forget local memories…
			</button>
		</>
	);
}

function SpaceConfirmation({
	callbacks,
	confirmationActionRef,
	model,
}: Pick<DetailsContentProps, "callbacks" | "confirmationActionRef" | "model">) {
	const confirmation = model.pendingConfirmation;
	if (!confirmation) return null;
	return (
		<div
			className="settings-note project-guardrail-confirmation project-space-guardrail-confirmation"
			role="alert"
		>
			<strong>Confirmation required before saving this Space.</strong>
			<p>
				Codemem can save this change after you acknowledge the checks below. Verify the workspace
				details, then confirm to complete the save.
			</p>
			<ul>
				{confirmation.warnings.map((warning) => (
					<li key={`${warning.code}:${warning.message}`}>
						<GuardrailHeading code={warning.code} />
						<span>{warning.message}</span>
					</li>
				))}
			</ul>
			<button
				className="settings-button"
				onClick={() => void callbacks.confirmProjectScope(model.project.workspace_identity)}
				ref={confirmationActionRef}
				type="button"
			>
				I understand, save Space
			</button>
			<button
				className="settings-button"
				onClick={() => callbacks.cancelProjectScopeConfirmation(model.project.workspace_identity)}
				type="button"
			>
				Cancel
			</button>
		</div>
	);
}

function ForgetConfirmation({
	callbacks,
	confirmationActionRef,
	model,
}: Pick<DetailsContentProps, "callbacks" | "confirmationActionRef" | "model">) {
	const confirmation = model.pendingForgetConfirmation;
	if (!confirmation) return null;
	const localLabel = confirmation.localOwnedMemoryCount === 1 ? "memory" : "memories";
	const peerLabel = confirmation.peerOwnedMemoryCount === 1 ? "memory" : "memories";
	return (
		<div className="settings-note project-guardrail-confirmation" role="alert">
			<strong>Confirm project memory cleanup.</strong>
			<p>
				{confirmation.localOwnedMemoryCount.toLocaleString()} locally owned {localLabel} will be
				forgotten. {confirmation.peerOwnedMemoryCount.toLocaleString()} peer-owned {peerLabel} will
				be left unchanged.
			</p>
			<p>
				Use this only to clean up wrongly attributed local project inventory; it forgets actual
				local memories on this device.
			</p>
			<button
				className="settings-button danger"
				onClick={() => void callbacks.forgetProject(model.project.workspace_identity, true)}
				ref={confirmationActionRef}
				type="button"
			>
				I understand, forget local memories
			</button>
			<button
				className="settings-button"
				onClick={() => callbacks.cancelProjectForgetConfirmation(model.project.workspace_identity)}
				type="button"
			>
				Cancel
			</button>
		</div>
	);
}

function ProjectDetailsActions(props: DetailsContentProps) {
	const { callbacks, model, view } = props;
	const { project } = model;
	const assignable = isAssignable(project);
	const canShare =
		assignable &&
		project.memory_count != null &&
		!project.guardrail_warnings.some((warning) => warning.requires_confirmation);
	return (
		<div className="project-inventory-actions">
			{canShare ? (
				<button
					className="settings-button"
					disabled={!view.shareInventoryReady}
					onClick={() => callbacks.shareProject(project.workspace_identity)}
					title={view.shareInventoryReady ? undefined : "The complete project list is unavailable."}
					type="button"
				>
					Share
				</button>
			) : null}
			{assignable ? (
				<>
					<ProjectSpaceSelect {...props} />
					<ProjectSecondaryActions callbacks={callbacks} model={model} />
					<SpaceConfirmation
						callbacks={callbacks}
						confirmationActionRef={props.confirmationActionRef}
						model={model}
					/>
					<ForgetConfirmation
						callbacks={callbacks}
						confirmationActionRef={props.confirmationActionRef}
						model={model}
					/>
				</>
			) : null}
		</div>
	);
}

export function ProjectRowDetails(props: ProjectRowDetailsProps) {
	const { model, onOpenChange, open, view } = props;
	const { project } = model;
	const assignable = isAssignable(project);
	const [scopeId, setScopeId] = useState(() =>
		firstScopeSelection(project, model.draftScopeId, view),
	);
	useEffect(() => {
		setScopeId(firstScopeSelection(project, model.draftScopeId, view));
	}, [model.draftScopeId, project, view]);
	const currentAssignable = view.scopeGroups.some((group) =>
		group.scopes.some((scope) => scope.scope_id === project.resolved_scope_id),
	);
	return (
		<tr className="project-inventory-details-row">
			<td className="project-inventory-details-cell" colSpan={7}>
				<details
					className="project-inventory-details"
					onToggle={(event) => onOpenChange(event.currentTarget.open)}
					open={open}
				>
					<summary data-project-focus-key={`admin:${assignable}:${project.workspace_identity}`}>
						<span>Details</span>
						{warningCount(project) > 0 ? (
							<span className="badge badge-offline">Needs attention · {warningCount(project)}</span>
						) : null}
					</summary>
					<div className="project-inventory-details-body">
						<ProjectDetailsOverview model={model} view={view} />
						<ProjectDetailsActions
							{...props}
							currentAssignable={currentAssignable}
							scopeId={scopeId}
							setScopeId={setScopeId}
						/>
					</div>
				</details>
			</td>
		</tr>
	);
}
