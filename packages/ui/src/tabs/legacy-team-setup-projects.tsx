import { useEffect, useId, useState } from "preact/hooks";
import type { LegacyTeamSetupDetailResponseV1, LegacyTeamSetupProjectV1 } from "../lib/api";

export interface LegacyTeamSetupProjectsProps {
	blocked: boolean;
	busyProjectRef: string | null;
	detail: LegacyTeamSetupDetailResponseV1;
	onMap: (project: LegacyTeamSetupProjectV1, resolvedProjectRef: string) => void;
}

function mappingName(project: LegacyTeamSetupProjectV1): string | null {
	if (!project.resolvedProjectRef) return null;
	return (
		project.mappingChoices.find(
			(choice) => choice.resolvedProjectRef === project.resolvedProjectRef,
		)?.displayName ?? "Unavailable Project"
	);
}

function ProjectRow({
	blocked,
	busy,
	index,
	onMap,
	project,
}: Pick<LegacyTeamSetupProjectsProps, "blocked" | "onMap"> & {
	busy: boolean;
	index: number;
	project: LegacyTeamSetupProjectV1;
}) {
	const generatedId = useId();
	const controlId = `${generatedId}-mapping`;
	const helpId = `${generatedId}-help`;
	const savedMapping = project.resolvedProjectRef ?? "";
	const availableSavedMapping = project.mappingChoices.some(
		(choice) => choice.resolvedProjectRef === savedMapping,
	)
		? savedMapping
		: "";
	const choiceKey = JSON.stringify(
		project.mappingChoices.map((choice) => choice.resolvedProjectRef),
	);
	const [draftMapping, setDraftMapping] = useState(availableSavedMapping);
	useEffect(() => setDraftMapping(availableSavedMapping), [availableSavedMapping, choiceKey]);
	const controlsBlocked = blocked || busy;
	const saveBlocked = controlsBlocked || !draftMapping || draftMapping === savedMapping;
	const savedName = mappingName(project);

	return (
		<fieldset
			aria-busy={busy ? "true" : "false"}
			className="legacy-team-project-row"
			id={`legacy-team-project-row-${index}`}
			tabIndex={project.resolution === "unresolved" ? -1 : undefined}
		>
			<legend>{project.displayName}</legend>
			{project.resolution === "deterministic" ? (
				<p className="small">Mapped automatically from matching Project evidence.</p>
			) : (
				<>
					<p className="small">
						{savedName ? `Saved mapping: ${savedName}` : "This Project still needs a mapping."}
					</p>
					<label htmlFor={controlId}>Canonical Project</label>
					<select
						aria-describedby={!draftMapping ? helpId : undefined}
						className="feed-search legacy-team-project-select"
						disabled={controlsBlocked}
						id={controlId}
						onChange={(event) => setDraftMapping(event.currentTarget.value)}
						value={draftMapping}
					>
						<option value="">Choose a Project</option>
						{project.mappingChoices.map((choice) => (
							<option key={choice.resolvedProjectRef} value={choice.resolvedProjectRef}>
								{choice.displayName}
							</option>
						))}
					</select>
					{!draftMapping ? (
						<p className="small" id={helpId}>
							Choose and save one of the server-provided Project mappings.
						</p>
					) : null}
					<button
						aria-disabled={saveBlocked ? "true" : undefined}
						className="settings-button legacy-team-setup-target"
						onClick={() => {
							if (!saveBlocked) onMap(project, draftMapping);
						}}
						type="button"
					>
						Save mapping
					</button>
				</>
			)}
		</fieldset>
	);
}

export function LegacyTeamSetupProjects(props: LegacyTeamSetupProjectsProps) {
	return (
		<section aria-labelledby="legacy-team-setup-step-projects">
			<h3 id="legacy-team-setup-step-projects" tabIndex={-1}>
				Review Projects
			</h3>
			<p>
				{props.detail.unresolvedProjectCount.toLocaleString()} of{" "}
				{props.detail.candidate.projectCount.toLocaleString()} Team Projects still need a mapping.
			</p>
			<div className="legacy-team-project-list">
				{props.detail.projects.map((project, index) => (
					<ProjectRow
						blocked={props.blocked}
						busy={props.busyProjectRef === project.projectRef}
						index={index}
						key={project.projectRef}
						onMap={props.onMap}
						project={project}
					/>
				))}
			</div>
		</section>
	);
}
