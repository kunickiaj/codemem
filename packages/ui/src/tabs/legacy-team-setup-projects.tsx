import { useEffect, useId, useState } from "preact/hooks";
import type { LegacyTeamSetupDetailResponseV1, LegacyTeamSetupProjectV1 } from "../lib/api";
import { stableProjectPresentationLabels } from "../lib/project-identity-presentation";
import { setupItemErrorId } from "./legacy-team-setup-dom";
import { orderedSetupProjects } from "./legacy-team-setup-order";

export interface LegacyTeamSetupProjectsProps {
	blocked: boolean;
	blockedProjectRefs?: ReadonlySet<string>;
	blockedDescriptionId?: string;
	busyProjectRefs: ReadonlySet<string>;
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
	blockedProjectRefs,
	busy,
	index,
	onMap,
	presentationName,
	project,
}: Pick<
	LegacyTeamSetupProjectsProps,
	"blocked" | "blockedDescriptionId" | "blockedProjectRefs" | "onMap"
> & {
	busy: boolean;
	index: number;
	presentationName: string;
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
	const itemBlocked = blockedProjectRefs?.has(project.projectRef) ?? false;
	const mappingUnavailable = project.actions.map.blockedReason === "mapping_unavailable";
	const needsMappingSelection = project.actions.map.enabled && !draftMapping;
	const controlsBlocked = blocked || itemBlocked || busy || !project.actions.map.enabled;
	const saveBlocked = controlsBlocked || !selectedMapping || selectedMapping === savedMapping;
	const savedName = mappingName(project, labels);
	const controlDescription = [
		mappingUnavailable || needsMappingSelection ? helpId : undefined,
		blocked
			? blockedDescriptionId
			: itemBlocked
				? setupItemErrorId("project", project.projectRef)
				: undefined,
	]
		.filter(Boolean)
		.join(" ");
	const needsAttention = project.resolution === "unresolved";

	return (
		<fieldset
			aria-busy={busy ? "true" : "false"}
			className={`legacy-team-project-row${needsAttention ? " legacy-team-setup-row-needs-attention" : ""}`}
			id={`legacy-team-project-row-${index}`}
			tabIndex={needsAttention ? -1 : undefined}
		>
			<legend>{presentationName}</legend>
			<div className="legacy-team-project-row-content">
				{needsAttention ? <span className="legacy-team-setup-status">Needs attention</span> : null}
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
						{mappingUnavailable ? (
							<p className="small" id={helpId}>
								No safe Project mapping is available. Refresh after Project evidence changes.
							</p>
						) : needsMappingSelection ? (
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
	const projects = orderedSetupProjects(props.detail.projects);
	const presentationNames = stableProjectPresentationLabels(
		projects.map((project) => ({
			canonicalId: project.projectRef,
			displayName: project.displayName,
		})),
	);
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
				{projects.map((project, index) => (
					<ProjectRow
						blocked={props.blocked}
						blockedDescriptionId={props.blockedDescriptionId}
						blockedProjectRefs={props.blockedProjectRefs}
						busy={props.busyProjectRefs.has(project.projectRef)}
						index={index}
						key={project.projectRef}
						onMap={props.onMap}
						presentationName={presentationNames.get(project.projectRef) ?? project.displayName}
						project={project}
					/>
				))}
			</div>
			{props.detail.unresolvedProjectCount === 0 ? (
				<div className="legacy-team-setup-next-action">
					<p className="small" id="legacy-team-project-continue-help">
						Continue to review the exact people, devices, and Projects that will receive access.
					</p>
					<button
						aria-describedby={[
							"legacy-team-project-continue-help",
							props.blocked ? props.blockedDescriptionId : null,
						]
							.filter(Boolean)
							.join(" ")}
						aria-disabled={props.blocked ? "true" : undefined}
						className="settings-button legacy-team-setup-target"
						onClick={() => {
							if (!props.blocked) props.onContinue();
						}}
						type="button"
					>
						Continue to Review
					</button>
				</div>
			) : null}
		</section>
	);
}
