import { useEffect, useId, useState } from "preact/hooks";
import type { LegacyTeamSetupDetailResponseV1, LegacyTeamSetupProjectV1 } from "../lib/api";
import { stableProjectPresentationLabels } from "../lib/project-identity-presentation";

export interface LegacyTeamSetupProjectsProps {
	blocked: boolean;
	blockedDescriptionId?: string;
	busyProjectRef: string | null;
	detail: LegacyTeamSetupDetailResponseV1;
	onContinue: () => void;
	onMap: (project: LegacyTeamSetupProjectV1, resolvedProjectRef: string) => void;
}

function mappingName(
	project: LegacyTeamSetupProjectV1,
	labels: ReadonlyMap<string, string>,
): string | null {
	if (!project.resolvedProjectRef) return null;
	return labels.get(project.resolvedProjectRef) ?? "Unavailable Project";
}

function ProjectRow({
	blocked,
	blockedDescriptionId,
	busy,
	index,
	onMap,
	project,
}: Pick<LegacyTeamSetupProjectsProps, "blocked" | "blockedDescriptionId" | "onMap"> & {
	busy: boolean;
	index: number;
	project: LegacyTeamSetupProjectV1;
}) {
	const generatedId = useId();
	const controlId = `${generatedId}-mapping`;
	const helpId = `${generatedId}-help`;
	const savedMapping = project.resolvedProjectRef ?? "";
	const labels = stableProjectPresentationLabels(
		project.mappingChoices.map((choice) => ({
			canonicalId: choice.resolvedProjectRef,
			displayName: choice.displayName,
		})),
	);
	const choiceRefs = [
		...new Set(project.mappingChoices.map((choice) => choice.resolvedProjectRef)),
	];
	const sortedChoiceRefs = [...choiceRefs].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	const choiceTokens = new Map(
		sortedChoiceRefs.map((resolvedProjectRef, index) => [
			resolvedProjectRef,
			`project-choice-${index + 1}`,
		]),
	);
	const choiceByRef = new Map(
		project.mappingChoices.map((choice) => [choice.resolvedProjectRef, choice]),
	);
	const choices = choiceRefs.flatMap((resolvedProjectRef) => {
		const choice = choiceByRef.get(resolvedProjectRef);
		return choice
			? [
					{
						...choice,
						label: labels.get(resolvedProjectRef) ?? choice.displayName,
						token: choiceTokens.get(resolvedProjectRef) ?? "",
					},
				]
			: [];
	});
	const availableSavedMapping =
		choices.find((choice) => choice.resolvedProjectRef === savedMapping)?.token ?? "";
	const choiceKey = JSON.stringify(sortedChoiceRefs);
	const [draftMapping, setDraftMapping] = useState(availableSavedMapping);
	useEffect(() => setDraftMapping(availableSavedMapping), [availableSavedMapping, choiceKey]);
	const selectedMapping = choices.find(
		(choice) => choice.token === draftMapping,
	)?.resolvedProjectRef;
	const controlsBlocked = blocked || busy || !project.actions.map.enabled;
	const saveBlocked = controlsBlocked || !selectedMapping || selectedMapping === savedMapping;
	const savedName = mappingName(project, labels);
	const controlDescription = [
		!draftMapping ? helpId : undefined,
		blocked ? blockedDescriptionId : undefined,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<fieldset
			aria-busy={busy ? "true" : "false"}
			className="legacy-team-project-row"
			id={`legacy-team-project-row-${index}`}
			tabIndex={project.resolution === "unresolved" ? -1 : undefined}
		>
			<legend>{project.displayName}</legend>
			<div className="legacy-team-project-row-content">
				{project.resolution === "deterministic" ? (
					<p className="small">Mapped automatically from matching Project evidence.</p>
				) : (
					<>
						<p className="small">
							{savedName ? `Saved mapping: ${savedName}` : "This Project still needs a mapping."}
						</p>
						<label htmlFor={controlId}>Canonical Project</label>
						<select
							aria-describedby={controlDescription || undefined}
							className="feed-search legacy-team-project-select"
							disabled={controlsBlocked}
							id={controlId}
							onChange={(event) => setDraftMapping(event.currentTarget.value)}
							value={draftMapping}
						>
							<option value="">Choose a Project</option>
							{choices.map((choice) => (
								<option key={choice.resolvedProjectRef} value={choice.token}>
									{choice.label}
								</option>
							))}
						</select>
						{!draftMapping ? (
							<p className="small" id={helpId}>
								Choose and save one of the server-provided Project mappings.
							</p>
						) : null}
						<button
							aria-describedby={controlDescription || undefined}
							aria-disabled={saveBlocked ? "true" : undefined}
							className="settings-button legacy-team-setup-target"
							onClick={() => {
								if (!saveBlocked && selectedMapping) onMap(project, selectedMapping);
							}}
							type="button"
						>
							Save mapping
						</button>
					</>
				)}
			</div>
		</fieldset>
	);
}

export function LegacyTeamSetupProjects(props: LegacyTeamSetupProjectsProps) {
	const automaticallyMappedCount = props.detail.projects.filter(
		(project) => project.resolution === "deterministic",
	).length;
	const projectCount = Math.max(
		props.detail.candidate.projectCount,
		props.detail.projects.length,
		props.detail.unresolvedProjectCount,
	);
	return (
		<section aria-labelledby="legacy-team-setup-step-projects">
			<h3 id="legacy-team-setup-step-projects" tabIndex={-1}>
				Review Projects
			</h3>
			<p>
				{props.detail.unresolvedProjectCount === 0
					? `All ${projectCount.toLocaleString()} Team Projects are mapped.`
					: `${props.detail.unresolvedProjectCount.toLocaleString()} of ${projectCount.toLocaleString()} Team Projects need attention.`}
			</p>
			{automaticallyMappedCount > 0 ? (
				<p className="small">Review the automatic mappings below before continuing.</p>
			) : null}
			<div className="legacy-team-project-list">
				{props.detail.projects.map((project, index) => (
					<ProjectRow
						blocked={props.blocked}
						blockedDescriptionId={props.blockedDescriptionId}
						busy={props.busyProjectRef === project.projectRef}
						index={index}
						key={project.projectRef}
						onMap={props.onMap}
						project={project}
					/>
				))}
			</div>
			{props.detail.unresolvedProjectCount === 0 ? (
				<button
					aria-describedby={props.blocked ? props.blockedDescriptionId : undefined}
					aria-disabled={props.blocked ? "true" : undefined}
					className="settings-button legacy-team-setup-target"
					onClick={() => {
						if (!props.blocked) props.onContinue();
					}}
					type="button"
				>
					Continue to Review
				</button>
			) : null}
		</section>
	);
}
