import { type ComponentChildren, render } from "preact";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { DialogCloseButton } from "../components/primitives/dialog-close-button";
import { RadixDialog } from "../components/primitives/radix-dialog";
import * as api from "../lib/api";
import type {
	RecipientPolicyEdgeChangeV1,
	RecipientPolicyEdgeCommitOutcomeV1,
	RecipientPolicyEdgeCommitResultV1,
	RecipientPolicyEdgePreviewResponseV1,
	RecipientPolicyEdgeRecipientRefV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import { stableProjectPresentationLabels } from "../lib/project-identity-presentation";

export interface RecipientPolicyManagementProject {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
}

export type RecipientPolicyManagementRequest =
	| { mode: "project-add"; projectIds: string[] }
	| { mode: "project-manage"; projectId: string }
	| { mode: "recipient-add"; recipient: RecipientPolicyEdgeRecipientRefV1 }
	| { mode: "recipient-manage"; recipient: RecipientPolicyEdgeRecipientRefV1 };

export interface RecipientPolicyManagementMountOptions {
	loading?: boolean;
	loadError?: boolean;
	onCommitted?: (result: RecipientPolicyEdgeCommitResultV1) => void | Promise<void>;
}

type ManagementData = {
	projects: RecipientPolicyManagementProject[];
	intent: RecipientPolicyIntentGraphV1;
	options: RecipientPolicyManagementMountOptions;
};

const MAX_CHANGES = 500;

let pendingOpen: RecipientPolicyManagementRequest | null = null;
let requestOpen: ((request: RecipientPolicyManagementRequest) => boolean) | null = null;
let returnFocus: HTMLElement | null = null;

export function openRecipientPolicyManagement(request: RecipientPolicyManagementRequest): boolean {
	if (requestOpen) {
		if (!requestOpen(request)) return false;
		returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		return true;
	}
	returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
	pendingOpen = request;
	return true;
}

function recipientKey(recipient: RecipientPolicyEdgeRecipientRefV1): string {
	return recipient.recipientKind === "identity"
		? `identity:${recipient.identityId}`
		: `team:${recipient.teamId}`;
}

function recipientFromKey(key: string): RecipientPolicyEdgeRecipientRefV1 | null {
	const separator = key.indexOf(":");
	const kind = key.slice(0, separator);
	const id = key.slice(separator + 1);
	if (!id) return null;
	if (kind === "identity") return { recipientKind: "identity", identityId: id };
	if (kind === "team") return { recipientKind: "team", teamId: id };
	return null;
}

function edgeRecipientKey(edge: RecipientPolicyIntentGraphV1["projectRecipients"][number]): string {
	return edge.recipientKind === "identity"
		? recipientKey({ recipientKind: "identity", identityId: edge.identityId })
		: recipientKey({ recipientKind: "team", teamId: edge.teamId });
}

function sameRecipient(
	edge: RecipientPolicyIntentGraphV1["projectRecipients"][number],
	recipient: RecipientPolicyEdgeRecipientRefV1,
): boolean {
	return edgeRecipientKey(edge) === recipientKey(recipient);
}

function ordinalLabels(keys: readonly string[], label: string): ReadonlyMap<string, string> {
	const sorted = [...new Set(keys)].sort((left, right) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
	return new Map(
		sorted.map((key, index) => [
			key,
			sorted.length === 1 ? label : `${label} ${index + 1} of ${sorted.length}`,
		]),
	);
}

function unavailableRecipientLabels(
	intent: RecipientPolicyIntentGraphV1,
	request: RecipientPolicyManagementRequest | null,
): ReadonlyMap<string, string> {
	if (!request?.mode.startsWith("project-")) return new Map();
	const projectIds = new Set(requestProjectIds(request));
	const knownTeamIds = new Set(intent.teams.map((team) => team.teamId));
	const knownIdentityIds = new Set(intent.identities.map((identity) => identity.identityId));
	const activeEdges = intent.projectRecipients.filter(
		(edge) => edge.status === "active" && projectIds.has(edge.canonicalProjectIdentity),
	);
	const missingTeams = activeEdges.flatMap((edge) =>
		edge.recipientKind === "team" && !knownTeamIds.has(edge.teamId) ? [edgeRecipientKey(edge)] : [],
	);
	const missingIdentities = activeEdges.flatMap((edge) =>
		edge.recipientKind === "identity" && !knownIdentityIds.has(edge.identityId)
			? [edgeRecipientKey(edge)]
			: [],
	);
	return new Map([
		...ordinalLabels(missingTeams, "Unavailable Team"),
		...ordinalLabels(missingIdentities, "Unavailable Identity"),
	]);
}

function unavailableProjectLabels(
	projects: readonly RecipientPolicyManagementProject[],
	request: RecipientPolicyManagementRequest | null,
	initial: readonly string[],
): ReadonlyMap<string, string> {
	if (request?.mode !== "recipient-manage") return new Map();
	const visibleProjectIds = new Set(projects.map((project) => project.canonicalProjectIdentity));
	return ordinalLabels(
		initial.filter((canonicalProjectIdentity) => !visibleProjectIds.has(canonicalProjectIdentity)),
		"Unavailable Project",
	);
}

function safeError(cause: unknown, fallback: string): string {
	if (cause instanceof api.RecipientPolicyEdgesStaleError) {
		return "Recipient access changed after this review. Review the refreshed changes before trying again.";
	}
	return fallback;
}

function Choice({
	ariaLabel,
	checked,
	description,
	disabled,
	label,
	onChange,
}: {
	ariaLabel?: string;
	checked: boolean;
	description: string;
	disabled?: boolean;
	label: string;
	onChange: () => void;
}) {
	const id = `recipient-policy-choice-${useId()}`;
	return (
		<label
			className="sync-dialog-radio-option recipient-policy-management-choice recipient-policy-management-target"
			htmlFor={id}
		>
			<input
				aria-label={ariaLabel}
				aria-describedby={`${id}-description`}
				checked={checked}
				disabled={disabled}
				id={id}
				onChange={onChange}
				type="checkbox"
			/>
			<span className="sync-dialog-choice-copy">
				<strong className="recipient-policy-management-name">{label}</strong>
				<span id={`${id}-description`} className="small recipient-policy-management-description">
					{description}
				</span>
			</span>
		</label>
	);
}

type RecipientChoice = { key: string; label: string; description: string; unavailable?: boolean };

function recipientChoices(
	intent: RecipientPolicyIntentGraphV1,
	request: RecipientPolicyManagementRequest | null,
	unavailableLabels: ReadonlyMap<string, string>,
) {
	const activeMemberships = intent.teamMemberships.filter((item) => item.status === "active");
	const identitiesById = new Map(
		intent.identities.map((identity) => [identity.identityId, identity]),
	);
	const choices: RecipientChoice[] = [
		...intent.teams
			.filter((team) => team.status === "active")
			.map((team) => {
				const members = activeMemberships
					.filter((membership) => membership.teamId === team.teamId)
					.map((membership) => identitiesById.get(membership.identityId)?.displayName)
					.filter((name): name is string => Boolean(name));
				return {
					key: recipientKey({ recipientKind: "team", teamId: team.teamId }),
					label: team.displayName,
					description: `Team · ${members.length.toLocaleString()} current ${members.length === 1 ? "member" : "members"}${members.length ? `: ${members.join(", ")}` : ""}. Eligible current and future members inherit access.`,
				};
			}),
		...intent.identities
			.filter((identity) => identity.status === "active" || identity.status === "pending")
			.map((identity) => ({
				key: recipientKey({ recipientKind: "identity", identityId: identity.identityId }),
				label: identity.displayName,
				description: `Identity · ${identity.status === "pending" ? "pending · " : ""}direct access, independent of Team membership.`,
			})),
	];
	if (!request?.mode.startsWith("project-")) return choices;
	const projectIds = new Set(requestProjectIds(request));
	const choiceKeys = new Set(choices.map((choice) => choice.key));
	for (const edge of intent.projectRecipients) {
		if (edge.status !== "active" || !projectIds.has(edge.canonicalProjectIdentity)) continue;
		const key = edgeRecipientKey(edge);
		if (choiceKeys.has(key)) continue;
		if (edge.recipientKind === "team") {
			const team = intent.teams.find((candidate) => candidate.teamId === edge.teamId);
			const unavailableLabel = unavailableLabels.get(key) ?? "Unavailable Team";
			choices.push({
				key,
				label: team?.displayName ?? unavailableLabel,
				unavailable: true,
				description: `${team?.status === "archived" ? "Archived Team" : unavailableLabel} · unavailable for additions.`,
			});
		} else {
			const identity = identitiesById.get(edge.identityId);
			const unavailableLabel = unavailableLabels.get(key) ?? "Unavailable Identity";
			choices.push({
				key,
				label: identity?.displayName ?? unavailableLabel,
				unavailable: true,
				description: `${identity?.status === "merged" ? "Merged Identity" : unavailableLabel} · unavailable for additions.`,
			});
		}
		choiceKeys.add(key);
	}
	return choices;
}

function recipientCoverage(
	intent: RecipientPolicyIntentGraphV1,
	projectIds: string[],
	key: string,
): Set<string> {
	return new Set(
		intent.projectRecipients
			.filter(
				(edge) =>
					edge.status === "active" &&
					projectIds.includes(edge.canonicalProjectIdentity) &&
					edgeRecipientKey(edge) === key,
			)
			.map((edge) => edge.canonicalProjectIdentity),
	);
}

function inheritedTeamDescriptions(
	intent: RecipientPolicyIntentGraphV1,
	projectIds: string[],
	key: string,
): string[] {
	const recipient = recipientFromKey(key);
	if (recipient?.recipientKind !== "identity") return [];
	return intent.teams
		.filter((team) => team.status === "active")
		.flatMap((team) => {
			const member = intent.teamMemberships.some(
				(membership) =>
					membership.status === "active" &&
					membership.teamId === team.teamId &&
					membership.identityId === recipient.identityId,
			);
			if (!member) return [];
			const count = recipientCoverage(intent, projectIds, `team:${team.teamId}`).size;
			if (!count) return [];
			return [
				`Access through Team ${team.displayName}: ${count} of ${projectIds.length} selected Project entries. Device eligibility is checked in Review.`,
			];
		});
}

function recipientChoicePresentation(
	choice: ReturnType<typeof recipientChoices>[number],
	intent: RecipientPolicyIntentGraphV1,
	request: RecipientPolicyManagementRequest,
) {
	const projectIds = requestProjectIds(request);
	const direct = recipientCoverage(intent, projectIds, choice.key).size;
	const descriptions = [choice.description];
	const bulk = request.mode === "project-add";
	const fullyCovered = projectIds.length > 0 && direct === projectIds.length;
	const unavailable = Boolean(choice.unavailable);
	if (unavailable && !bulk) descriptions.push("Existing access can only be removed.");
	if (bulk) {
		descriptions.push(
			direct
				? `Added to ${direct} of ${projectIds.length} selected Project entries directly.`
				: "Not added directly.",
		);
		if (fullyCovered) descriptions.push("Already added.");
	}
	descriptions.push(...inheritedTeamDescriptions(intent, projectIds, choice.key));
	let ariaLabel: string | undefined;
	if (bulk) {
		ariaLabel = `Add ${choice.label} to remaining Project entries`;
		if (unavailable) ariaLabel = `${choice.label} unavailable for additions`;
		else if (fullyCovered)
			ariaLabel = `${choice.label} already added to all selected Project entries`;
	}
	return {
		description: descriptions.join(" "),
		disabled: bulk && (fullyCovered || unavailable),
		ariaLabel,
	};
}

function RecipientChoices({
	choices,
	intent,
	request,
	selected,
	busy,
	toggle,
}: {
	choices: RecipientChoice[];
	intent: RecipientPolicyIntentGraphV1;
	request: RecipientPolicyManagementRequest;
	selected: string[];
	busy: boolean;
	toggle: (key: string) => void;
}) {
	return (
		<>
			{choices.map((choice) => {
				const presentation = recipientChoicePresentation(choice, intent, request);
				return (
					<Choice
						ariaLabel={presentation.ariaLabel}
						checked={selected.includes(choice.key)}
						description={presentation.description}
						disabled={busy || presentation.disabled}
						key={choice.key}
						label={choice.label}
						onChange={() => toggle(choice.key)}
					/>
				);
			})}
		</>
	);
}

function requestProjectIds(request: RecipientPolicyManagementRequest): string[] {
	if (request.mode === "project-add") return [...new Set(request.projectIds)];
	if (request.mode === "project-manage") return [request.projectId];
	return [];
}

function initialSelection(
	request: RecipientPolicyManagementRequest,
	intent: RecipientPolicyIntentGraphV1,
): string[] {
	const activeEdges = intent.projectRecipients.filter((edge) => edge.status === "active");
	if (request.mode === "project-add") return [];
	if (request.mode === "project-manage") {
		return activeEdges
			.filter((edge) => edge.canonicalProjectIdentity === request.projectId)
			.map(edgeRecipientKey);
	}
	return activeEdges
		.filter((edge) => sameRecipient(edge, request.recipient))
		.map((edge) => edge.canonicalProjectIdentity);
}

function projectChoices(
	projects: RecipientPolicyManagementProject[],
	request: RecipientPolicyManagementRequest,
	initial: string[],
	unavailableLabels: ReadonlyMap<string, string>,
): Array<RecipientPolicyManagementProject & { description: string }> {
	const presentationLabels = stableProjectPresentationLabels(
		projects.map((project) => ({
			canonicalId: project.canonicalProjectIdentity,
			displayName: project.displayName,
		})),
	);
	const visibleProjects =
		request.mode === "recipient-add"
			? projects.filter((project) => !initial.includes(project.canonicalProjectIdentity))
			: projects;
	const choices = visibleProjects.map((project) => ({
		...project,
		displayName: presentationLabels.get(project.canonicalProjectIdentity) ?? project.displayName,
		description: `${project.existingMemoryCount.toLocaleString()} existing memories`,
	}));
	if (request.mode !== "recipient-manage") return choices;
	const visibleProjectIds = new Set(
		visibleProjects.map((project) => project.canonicalProjectIdentity),
	);
	const unavailableProjectIds = initial.filter(
		(canonicalProjectIdentity) => !visibleProjectIds.has(canonicalProjectIdentity),
	);
	for (const canonicalProjectIdentity of unavailableProjectIds) {
		const label = unavailableLabels.get(canonicalProjectIdentity) ?? "Unavailable Project";
		choices.push({
			canonicalProjectIdentity,
			displayName: label,
			existingMemoryCount: 0,
			description: `${label} · existing access can only be removed`,
		});
	}
	return choices;
}

function buildChanges(
	request: RecipientPolicyManagementRequest,
	selected: string[],
	initial: string[],
): RecipientPolicyEdgeChangeV1[] {
	if (request.mode === "project-add") {
		return requestProjectIds(request).flatMap((canonicalProjectIdentity) =>
			selected.flatMap((key) => {
				const recipient = recipientFromKey(key);
				return recipient ? [{ canonicalProjectIdentity, recipient, action: "add" as const }] : [];
			}),
		);
	}
	if (request.mode === "project-manage") {
		const allKeys = [...new Set([...initial, ...selected])];
		return allKeys.flatMap((key) => {
			const recipient = recipientFromKey(key);
			if (!recipient || initial.includes(key) === selected.includes(key)) return [];
			return [
				{
					canonicalProjectIdentity: request.projectId,
					recipient,
					action: selected.includes(key) ? ("add" as const) : ("remove" as const),
				},
			];
		});
	}
	if (request.mode === "recipient-add") {
		return selected.map((canonicalProjectIdentity) => ({
			canonicalProjectIdentity,
			recipient: request.recipient,
			action: "add" as const,
		}));
	}
	const allProjects = [...new Set([...initial, ...selected])];
	return allProjects.flatMap((canonicalProjectIdentity) => {
		if (
			initial.includes(canonicalProjectIdentity) === selected.includes(canonicalProjectIdentity)
		) {
			return [];
		}
		return [
			{
				canonicalProjectIdentity,
				recipient: request.recipient,
				action: selected.includes(canonicalProjectIdentity)
					? ("add" as const)
					: ("remove" as const),
			},
		];
	});
}

function ProjectChoices({
	choices,
	selected,
	busy,
	toggle,
	emptyMessage,
}: {
	choices: ReturnType<typeof projectChoices>;
	selected: string[];
	busy: boolean;
	toggle: (key: string) => void;
	emptyMessage: string;
}) {
	if (!choices.length)
		return (
			<p className="small" role="status">
				{emptyMessage}
			</p>
		);
	return (
		<>
			{choices.map((project) => (
				<Choice
					checked={selected.includes(project.canonicalProjectIdentity)}
					description={project.description}
					disabled={busy}
					key={project.canonicalProjectIdentity}
					label={project.displayName}
					onChange={() => toggle(project.canonicalProjectIdentity)}
				/>
			))}
		</>
	);
}

function dialogCopy(request: RecipientPolicyManagementRequest) {
	if (request.mode === "project-add") {
		return {
			title: "Add Teams or Identities",
			description:
				"Existing sharing stays unchanged. Select additions below. Unchecked boxes mean no addition requested. One person can have separate personal and work Identities.",
			legend: "Choose additions",
		};
	}
	if (request.mode === "project-manage") {
		return {
			title: "Update sharing",
			description:
				"Checked boxes are saved direct relationships. Removing one relationship does not remove access through another Team or direct relationship. One person can have separate personal and work Identities.",
			legend: "Project recipients",
		};
	}
	if (request.mode === "recipient-add") {
		return {
			title: "Add Projects",
			description:
				"Choose additional Projects for this recipient. Existing access cannot be removed here.",
			legend: "Additional Projects",
		};
	}
	return {
		title: "Manage recipient Projects",
		description: "Choose exactly which Projects this recipient receives.",
		legend: "Recipient Projects",
	};
}

function recipientActionLabel(
	outcomes: RecipientPolicyEdgeCommitOutcomeV1[],
	recipient: RecipientPolicyEdgeRecipientRefV1,
): string {
	let addsAccess = false;
	let removesAccess = false;
	let requestedAdd = false;
	let requestedRemove = false;
	const key = recipientKey(recipient);
	for (const item of outcomes) {
		const { change, outcome } = item;
		if (recipientKey(change.recipient) !== key) continue;
		if (change.action === "add") {
			requestedAdd = true;
			if (outcome === "added") addsAccess = true;
		} else {
			requestedRemove = true;
			if (outcome === "removed") removesAccess = true;
		}
	}
	if (addsAccess && removesAccess) return "Mixed changes";
	if (removesAccess) return "Removing access";
	if (addsAccess) return "Adding access";
	if (requestedAdd && !requestedRemove) return "Already has access";
	if (requestedRemove && !requestedAdd) return "Already without access";
	return "No changes";
}

function changedRecipientsMissingFromPreview(
	preview: RecipientPolicyEdgePreviewResponseV1,
): RecipientPolicyEdgeRecipientRefV1[] {
	const selectedKeys = new Set(preview.selectedRecipients.map(recipientKey));
	const missing = new Map<string, RecipientPolicyEdgeRecipientRefV1>();
	for (const change of preview.normalizedChanges) {
		const key = recipientKey(change.recipient);
		if (!selectedKeys.has(key)) missing.set(key, change.recipient);
	}
	return [...missing.values()];
}

function effectiveDeviceCoverage(
	devices: RecipientPolicyEdgePreviewResponseV1["effectiveDevices"],
) {
	const coverage = new Map<string, { device: (typeof devices)[number]; projectIds: Set<string> }>();
	for (const device of devices) {
		const key = `${device.identityId}:${device.deviceId}`;
		const entry = coverage.get(key) ?? { device, projectIds: new Set<string>() };
		entry.projectIds.add(device.canonicalProjectIdentity);
		coverage.set(key, entry);
	}
	return [...coverage.values()];
}

function previewProjectLabel(
	project: RecipientPolicyEdgePreviewResponseV1["projects"][number],
	projectLabels: ReadonlyMap<string, string>,
): string {
	const localLabel = projectLabels.get(project.canonicalProjectIdentity);
	if (localLabel) return localLabel;
	return project.displayName !== project.canonicalProjectIdentity
		? project.displayName
		: "Unavailable Project";
}

function Review({
	preview,
	projectLabels,
	recipientLabels,
}: {
	preview: RecipientPolicyEdgePreviewResponseV1;
	projectLabels: ReadonlyMap<string, string>;
	recipientLabels: ReadonlyMap<string, string>;
}) {
	const effectiveDevices = effectiveDeviceCoverage(preview.effectiveDevices);
	const affectedProjectCount = new Set(
		preview.projects.map((project) => project.canonicalProjectIdentity),
	).size;
	const missingChangedRecipients = changedRecipientsMissingFromPreview(preview);
	return (
		<div className="sync-dialog-stack recipient-policy-management-review">
			<section aria-labelledby="recipient-policy-review-projects">
				<h3 id="recipient-policy-review-projects">Projects affected</h3>
				<ul>
					{preview.projects.map((project) => (
						<li key={project.canonicalProjectIdentity}>
							<strong className="recipient-policy-management-name">
								{previewProjectLabel(project, projectLabels)}
							</strong>
							<span>
								{" "}
								— Access changes affect {project.existingMemoryCount.toLocaleString()} existing
								memories
								{project.futureMemoriesShared
									? " and future activity"
									: "; future activity is not included"}
							</span>
						</li>
					))}
				</ul>
			</section>
			<section aria-labelledby="recipient-policy-review-recipients">
				<h3 id="recipient-policy-review-recipients">Recipient changes</h3>
				<ul>
					{preview.selectedRecipients.map((recipient) => (
						<li key={recipientKey(recipient)}>
							<strong className="recipient-policy-management-name">{recipient.displayName}</strong>{" "}
							<span>— {recipientActionLabel(preview.outcomes, recipient)} · </span>
							{recipient.recipientKind === "identity" ? (
								<span>Identity · direct access, independent of Team membership</span>
							) : (
								<span className="recipient-policy-management-recipient-context">
									Team · {recipient.currentMembers.length.toLocaleString()} current{" "}
									{recipient.currentMembers.length === 1 ? "member" : "members"}
									{recipient.currentMembers.length ? (
										<>
											:{" "}
											<span className="recipient-policy-management-member-names">
												{recipient.currentMembers.map((member) => member.displayName).join(", ")}
											</span>
										</>
									) : null}
									. Eligible future Team members{" "}
									{recipient.futureMembersInherit ? "inherit" : "do not inherit"} access.
								</span>
							)}
						</li>
					))}
					{missingChangedRecipients.map((recipient) => (
						<li key={recipientKey(recipient)}>
							<strong className="recipient-policy-management-name">
								{recipientLabels.get(recipientKey(recipient)) ??
									(recipient.recipientKind === "team"
										? "Unavailable Team"
										: "Unavailable Identity")}
							</strong>{" "}
							<span>
								— {recipientActionLabel(preview.outcomes, recipient)} ·{" "}
								{recipient.recipientKind === "team" ? "Team" : "Identity"}
							</span>
						</li>
					))}
				</ul>
			</section>
			<section aria-labelledby="recipient-policy-review-availability">
				<h3 id="recipient-policy-review-availability">Devices included after this update</h3>
				<p>Access settings do not confirm delivery. Devices sync in the background.</p>
				{effectiveDevices.length ? (
					<>
						<p>
							The reviewed access settings include {effectiveDevices.length.toLocaleString()}{" "}
							current {effectiveDevices.length === 1 ? "device" : "devices"}.
						</p>
						<ul>
							{effectiveDevices.map(({ device, projectIds }) => (
								<li
									className="recipient-policy-management-name"
									key={`${device.identityId}:${device.deviceId}`}
								>
									<details>
										<summary>
											<span className="recipient-policy-management-name">{device.displayName}</span>{" "}
											—{" "}
											{recipientLabels.get(`identity:${device.identityId}`) ??
												"Unavailable Identity"}{" "}
											— {projectIds.size} of {affectedProjectCount} affected Project entries
										</summary>
										<ul>
											{[...projectIds].map((projectId) => {
												const project = preview.projects.find(
													(item) => item.canonicalProjectIdentity === projectId,
												);
												return (
													<li key={projectId}>
														{project
															? previewProjectLabel(project, projectLabels)
															: "Unavailable Project"}
													</li>
												);
											})}
										</ul>
									</details>
								</li>
							))}
						</ul>
					</>
				) : (
					<p>
						No recipient devices are included in this preview. Your own access on this device is not
						affected.
					</p>
				)}
			</section>
			<details className="recipient-policy-management-details">
				<summary>Change details</summary>
				<p className="small">
					{preview.addCount.toLocaleString()} {preview.addCount === 1 ? "add" : "adds"} ·{" "}
					{preview.removeCount.toLocaleString()} {preview.removeCount === 1 ? "remove" : "removes"}{" "}
					· {preview.netWriteCount.toLocaleString()}{" "}
					{preview.netWriteCount === 1 ? "write" : "writes"}
				</p>
				{preview.unchangedProjects.length ? (
					<>
						<p className="small recipient-policy-management-detail-label">
							<strong>Unchanged Projects</strong>
						</p>
						<ul aria-label="Unchanged Projects">
							{preview.unchangedProjects.map((project) => (
								<li
									className="recipient-policy-management-name"
									key={project.canonicalProjectIdentity}
								>
									{previewProjectLabel(project, projectLabels)}
								</li>
							))}
						</ul>
					</>
				) : null}
			</details>
		</div>
	);
}

function CommitResult({
	preview,
	projectLabels,
	recipientLabels,
	result,
}: {
	preview: RecipientPolicyEdgePreviewResponseV1;
	projectLabels: ReadonlyMap<string, string>;
	recipientLabels: ReadonlyMap<string, string>;
	result: RecipientPolicyEdgeCommitResultV1;
}) {
	const technicalStatus =
		result.status === "applied"
			? "Applied"
			: result.status === "not_found"
				? "Not found"
				: `${result.status.charAt(0).toUpperCase()}${result.status.slice(1)}`;
	return (
		<div className="sync-dialog-stack recipient-policy-management-result">
			<details className="recipient-policy-management-details">
				<summary>Technical details</summary>
				<p>
					Status: {technicalStatus}. Writes: {result.writeCount.toLocaleString()}.
				</p>
				{result.errorCode ? <p>Error code: {result.errorCode.replaceAll("_", " ")}.</p> : null}
				{result.outcomes.length ? (
					<ul>
						{result.outcomes.map((item) => {
							const previewProject = preview.projects.find(
								(project) =>
									project.canonicalProjectIdentity === item.change.canonicalProjectIdentity,
							);
							const projectName = previewProject
								? previewProjectLabel(previewProject, projectLabels)
								: (projectLabels.get(item.change.canonicalProjectIdentity) ??
									"Unavailable Project");
							const recipientName =
								preview.selectedRecipients.find(
									(recipient) => recipientKey(recipient) === recipientKey(item.change.recipient),
								)?.displayName ??
								recipientLabels.get(recipientKey(item.change.recipient)) ??
								(item.change.recipient.recipientKind === "team" ? "Team" : "Identity");
							return (
								<li
									key={`${item.change.canonicalProjectIdentity}:${recipientKey(item.change.recipient)}`}
								>
									{item.change.action === "add" ? "Add" : "Remove"} {recipientName}{" "}
									{item.change.action === "add" ? "to" : "from"} {projectName}:{" "}
									{item.outcome.replaceAll("_", " ")}
								</li>
							);
						})}
					</ul>
				) : null}
			</details>
		</div>
	);
}

function RecipientPolicyManagementHost({ intent, options, projects }: ManagementData) {
	const [request, setRequest] = useState<RecipientPolicyManagementRequest | null>(null);
	const [selected, setSelected] = useState<string[]>([]);
	const [initial, setInitial] = useState<string[]>([]);
	const [preview, setPreview] = useState<RecipientPolicyEdgePreviewResponseV1 | null>(null);
	const [result, setResult] = useState<RecipientPolicyEdgeCommitResultV1 | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	const submitting = useRef(false);
	const reviewedRecipientLabels = useRef<ReadonlyMap<string, string>>(new Map());
	const reviewedProjectLabels = useRef<ReadonlyMap<string, string>>(new Map());
	const unavailableRecipients = useMemo(
		() => unavailableRecipientLabels(intent, request),
		[intent, request],
	);
	const choices = useMemo(
		() => recipientChoices(intent, request, unavailableRecipients),
		[intent, request, unavailableRecipients],
	);
	const recipientLabels = useMemo(
		() =>
			new Map([
				...intent.teams.map((team) => [`team:${team.teamId}`, team.displayName] as const),
				...intent.identities.map(
					(identity) => [`identity:${identity.identityId}`, identity.displayName] as const,
				),
				...unavailableRecipients,
			]),
		[intent, unavailableRecipients],
	);
	const unavailableProjects = useMemo(
		() => unavailableProjectLabels(projects, request, initial),
		[initial, projects, request],
	);
	const projectIds = useMemo(
		() => new Set(projects.map((project) => project.canonicalProjectIdentity)),
		[projects],
	);
	const projectLabels = useMemo(() => {
		const labels = stableProjectPresentationLabels(
			projects.map((project) => ({
				canonicalId: project.canonicalProjectIdentity,
				displayName: project.displayName,
			})),
		);
		return new Map([...labels, ...unavailableProjects]);
	}, [projects, unavailableProjects]);

	useEffect(() => {
		requestOpen = (nextRequest) => {
			if (submitting.current) return false;
			const nextInitial = initialSelection(nextRequest, intent);
			setRequest(nextRequest);
			setInitial(nextInitial);
			setSelected(nextRequest.mode === "recipient-add" ? [] : nextInitial);
			setPreview(null);
			setResult(null);
			reviewedRecipientLabels.current = new Map();
			reviewedProjectLabels.current = new Map();
			setError(null);
			setStatus("");
			setBusy(false);
			submitting.current = false;
			return true;
		};
		if (pendingOpen) {
			const pending = pendingOpen;
			pendingOpen = null;
			requestOpen(pending);
		}
		return () => {
			requestOpen = null;
		};
	}, [intent]);

	useEffect(() => {
		if (!result) return;
		document.getElementById("recipient-policy-management-title")?.focus();
	}, [result]);

	if (!request) return null;
	const copy = dialogCopy(request);
	const fixedProjects = requestProjectIds(request);
	const missingProject =
		request.mode === "recipient-manage"
			? false
			: fixedProjects.some((projectId) => !projectIds.has(projectId));
	const fixedRecipientMissing =
		(request.mode === "recipient-add" || request.mode === "recipient-manage") &&
		!choices.some((choice) => choice.key === recipientKey(request.recipient));
	const dataUnavailable =
		options.loading || options.loadError || missingProject || fixedRecipientMissing;
	const changes = buildChanges(request, selected, initial);
	const changeLimitExceeded = changes.length > MAX_CHANGES;
	const selectionEmpty =
		(request.mode === "project-add" || request.mode === "recipient-add") && selected.length === 0;
	const noChanges =
		request.mode !== "project-add" && request.mode !== "recipient-add" && changes.length === 0;
	const availableProjects = projectChoices(projects, request, initial, unavailableProjects);
	const resultApplied = result?.status === "applied";
	let title = copy.title;
	let description = copy.description;
	if (preview) {
		title = "Review recipient access";
		description = "Confirm the exact Projects, recipients, and resulting access.";
	}
	if (result) {
		title = resultApplied ? "Sharing settings saved" : "Recipient access needs attention";
		description = resultApplied
			? "Access settings do not confirm delivery. Devices sync in the background."
			: "Some reviewed recipient access changes were not applied. Review the technical details.";
	}

	const close = () => {
		if (submitting.current) return;
		setRequest(null);
		setPreview(null);
		setResult(null);
		reviewedRecipientLabels.current = new Map();
		reviewedProjectLabels.current = new Map();
		setError(null);
		setStatus("");
	};
	const toggle = (key: string) => {
		setSelected((current) =>
			current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
		);
		setError(null);
		setStatus("");
	};
	const review = async () => {
		if (
			dataUnavailable ||
			selectionEmpty ||
			noChanges ||
			changeLimitExceeded ||
			submitting.current
		) {
			return;
		}
		submitting.current = true;
		setBusy(true);
		setError(null);
		setStatus("Reviewing exact recipient access changes.");
		try {
			const reviewed = await api.previewRecipientPolicyEdges({ version: 1, changes });
			reviewedRecipientLabels.current = new Map(recipientLabels);
			reviewedProjectLabels.current = new Map(projectLabels);
			setPreview(reviewed);
			setStatus("Review ready. Confirm the exact changes.");
		} catch (cause) {
			setError(safeError(cause, "Unable to review recipient access changes."));
			setStatus("");
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	};
	const commit = async () => {
		if (!preview || submitting.current) return;
		submitting.current = true;
		setBusy(true);
		setError(null);
		setStatus("Saving recipient access changes.");
		try {
			const committed = await api.commitRecipientPolicyEdges({
				version: 1,
				changes: preview.normalizedChanges,
				reviewedPolicyDigest: preview.reviewedPolicyDigest,
			});
			setResult(committed);
			setStatus("");
			try {
				await options.onCommitted?.(committed);
			} catch {
				setError("Recipient access was saved, but this view could not refresh.");
			}
		} catch (cause) {
			if (cause instanceof api.RecipientPolicyEdgesStaleError) {
				setPreview(null);
				reviewedRecipientLabels.current = new Map();
				reviewedProjectLabels.current = new Map();
				setStatus("");
			}
			setError(safeError(cause, "Unable to save recipient access changes."));
		} finally {
			submitting.current = false;
			setBusy(false);
		}
	};

	let unavailableMessage: string | null = null;
	if (options.loading) unavailableMessage = "Loading the complete recipient access inventory…";
	else if (options.loadError) {
		unavailableMessage =
			"The complete recipient access inventory is unavailable. Refresh and try again.";
	} else if (missingProject) {
		unavailableMessage = "One selected Project is no longer available. Refresh and try again.";
	} else if (fixedRecipientMissing) {
		unavailableMessage = "This recipient is no longer available. Refresh and try again.";
	}

	let content: ComponentChildren;
	if (unavailableMessage) {
		content = (
			<p aria-live="polite" role={options.loadError ? "alert" : "status"}>
				{unavailableMessage}
			</p>
		);
	} else if (result && preview) {
		content = (
			<CommitResult
				preview={preview}
				projectLabels={reviewedProjectLabels.current}
				recipientLabels={reviewedRecipientLabels.current}
				result={result}
			/>
		);
	} else if (preview) {
		content = (
			<Review
				preview={preview}
				projectLabels={reviewedProjectLabels.current}
				recipientLabels={reviewedRecipientLabels.current}
			/>
		);
	} else if (request.mode === "recipient-add" || request.mode === "recipient-manage") {
		const emptyMessage =
			request.mode === "recipient-add"
				? "No additional Projects are available."
				: "No Projects are available.";
		content = (
			<fieldset className="sync-dialog-radio-list" disabled={busy}>
				<legend>{copy.legend}</legend>
				<ProjectChoices
					choices={availableProjects}
					selected={selected}
					busy={busy}
					toggle={toggle}
					emptyMessage={emptyMessage}
				/>
			</fieldset>
		);
	} else {
		content = (
			<fieldset className="sync-dialog-radio-list" disabled={busy}>
				<legend>{copy.legend}</legend>
				{choices.length ? (
					<RecipientChoices
						choices={choices}
						intent={intent}
						request={request}
						selected={selected}
						busy={busy}
						toggle={toggle}
					/>
				) : (
					<p className="small" role="status">
						No active Teams or Identities are available.
					</p>
				)}
			</fieldset>
		);
	}

	return (
		<RadixDialog
			ariaDescribedby="recipient-policy-management-description"
			ariaLabelledby="recipient-policy-management-title"
			contentClassName="modal recipient-policy-management-dialog"
			contentId="recipientPolicyManagementDialog"
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				const fallbackId = request.mode.startsWith("project-")
					? "tabBtn-projects"
					: "tabBtn-sharing";
				const target = returnFocus?.isConnected ? returnFocus : document.getElementById(fallbackId);
				if (target instanceof HTMLElement) target.focus();
				returnFocus = null;
			}}
			onOpenAutoFocus={(event) => {
				const titleElement = document.getElementById("recipient-policy-management-title");
				if (!titleElement) return;
				event.preventDefault();
				titleElement.focus();
			}}
			onOpenChange={(open) => {
				if (!open) close();
			}}
			open
			overlayClassName="modal-backdrop"
			overlayId="recipientPolicyManagementDialogBackdrop"
		>
			<div
				aria-busy={busy || options.loading ? "true" : "false"}
				className="modal-card sync-dialog-card"
			>
				<div className="modal-header">
					<h2 id="recipient-policy-management-title" tabIndex={-1}>
						{title}
					</h2>
					<DialogCloseButton
						ariaLabel={`Close ${title}`}
						className="modal-close-button recipient-policy-management-target"
						disabled={busy}
						onClick={close}
					/>
				</div>
				<div className="modal-body recipient-policy-management-selection">
					<p className="small" id="recipient-policy-management-description">
						{description}
					</p>
					{content}
					{result ? null : (
						<p
							aria-live="polite"
							className="small recipient-policy-management-status"
							role="status"
						>
							{status}
						</p>
					)}
					{error ? (
						<p aria-live="assertive" role="alert">
							{error}
						</p>
					) : null}
					{changeLimitExceeded ? (
						<p aria-live="assertive" role="alert">
							This selection creates {changes.length.toLocaleString()} access changes. Review at
							most {MAX_CHANGES.toLocaleString()} changes at a time; reduce the selection and try
							again.
						</p>
					) : null}
				</div>
				<div className="modal-footer recipient-policy-management-actions">
					<button
						className="settings-button recipient-policy-management-target"
						disabled={busy}
						onClick={
							preview && !result
								? () => {
										setPreview(null);
										reviewedRecipientLabels.current = new Map();
										reviewedProjectLabels.current = new Map();
										setStatus("");
									}
								: close
						}
						type="button"
					>
						{result ? "Done" : preview ? "Back" : "Cancel"}
					</button>
					{!result && !unavailableMessage ? (
						<button
							className="settings-button sync-dialog-confirm recipient-policy-management-target"
							disabled={busy || (!preview && (selectionEmpty || noChanges || changeLimitExceeded))}
							onClick={() => void (preview ? commit() : review())}
							type="button"
						>
							{busy
								? preview
									? "Saving…"
									: "Reviewing…"
								: preview
									? "Confirm changes"
									: "Review changes"}
						</button>
					) : null}
				</div>
			</div>
		</RadixDialog>
	);
}

export function mountRecipientPolicyManagement(
	mount: HTMLElement,
	projects: RecipientPolicyManagementProject[],
	intent: RecipientPolicyIntentGraphV1,
	options: RecipientPolicyManagementMountOptions = {},
): void {
	render(
		<RecipientPolicyManagementHost intent={intent} options={options} projects={projects} />,
		mount,
	);
}
