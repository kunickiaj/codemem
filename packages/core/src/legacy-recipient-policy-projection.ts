import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import {
	RECIPIENT_POLICY_CONTRACT_VERSION,
	type RecipientPolicyContractVersion,
	type RecipientPolicyProjectRecipientV1,
	type RecipientPolicyProjectV1,
} from "./recipient-policy-contract.js";
import {
	canonicalWorkspaceIdentity,
	LOCAL_DEFAULT_SCOPE_ID,
	type WorkspaceIdentitySource,
} from "./scope-resolution.js";
import { shareProjectSetDigest } from "./share-operation.js";
import { SYNC_BOOTSTRAP_CWD_PREFIX } from "./sync-bootstrap.js";

export type LegacyRecipientPolicyConfidenceV1 = "high" | "medium" | "low";

export type LegacyRecipientPolicyProvenanceV1 =
	| "active_scope_membership"
	| "coordinator_group_enrollment"
	| "exact_project_invite"
	| "exact_project_mapping"
	| "local_identity"
	| "personal_scope"
	| "peer_identity_assignment";

export interface LegacyRecipientPolicyIdentityCandidateV1 {
	version: RecipientPolicyContractVersion;
	identityId: string;
	displayName: string;
	status: "active" | "pending" | "merged";
	mergedIntoIdentityId: string | null;
	isLocal: boolean;
	suggestedKind: "personal" | null;
	confidence: LegacyRecipientPolicyConfidenceV1;
	provenance: LegacyRecipientPolicyProvenanceV1[];
}

export interface LegacyRecipientPolicyTeamCandidateV1 {
	version: RecipientPolicyContractVersion;
	teamCandidateId: string;
	displayName: string;
	confidence: LegacyRecipientPolicyConfidenceV1;
	provenance: LegacyRecipientPolicyProvenanceV1[];
}

export interface LegacyRecipientPolicyEffectiveDeviceV1 {
	version: RecipientPolicyContractVersion;
	deviceId: string;
	displayName: string;
	identityId: string | null;
	assignment: "assigned" | "unassigned";
	access: "current_effective";
	provenance: "active_scope_membership" | "local_runtime";
}

export type LegacyRecipientPolicyEnforcementStateV1 =
	| "managed_exact_project"
	| "legacy_shared"
	| "local_only"
	| "ambiguous";

export interface LegacyRecipientPolicyEnforcementV1 {
	version: RecipientPolicyContractVersion;
	authority: "legacy_scope";
	parity: "unknown";
	cutoverState: "legacy";
	state: LegacyRecipientPolicyEnforcementStateV1;
	currentDeviceIds: string[];
	safeErrorCode: string | null;
}

export type LegacyRecipientPolicyConditionCodeV1 =
	| "suggest_local_identity"
	| "suggest_team_candidate"
	| "unassigned_effective_device"
	| "ambiguous_multi_project_scope"
	| "wildcard_scope_mapping"
	| "noncanonical_project_identity"
	| "ambiguous_scope_mapping"
	| "inactive_scope_boundary";

export interface LegacyRecipientPolicyConditionV1 {
	version: RecipientPolicyContractVersion;
	code: LegacyRecipientPolicyConditionCodeV1;
	kind: "actionable" | "diagnostic";
	message: string;
}

export interface LegacyRecipientPolicyProjectionV1 {
	version: RecipientPolicyContractVersion;
	project: RecipientPolicyProjectV1;
	/** Legacy evidence is never promoted to canonical recipient intent. */
	intent: RecipientPolicyProjectRecipientV1[];
	identityCandidates: LegacyRecipientPolicyIdentityCandidateV1[];
	teamCandidates: LegacyRecipientPolicyTeamCandidateV1[];
	effectiveDevices: LegacyRecipientPolicyEffectiveDeviceV1[];
	enforcement: LegacyRecipientPolicyEnforcementV1;
	conditions: LegacyRecipientPolicyConditionV1[];
}

export interface LegacyProjectSnapshot {
	canonicalIdentity: string;
	displayName: string;
	identitySource: WorkspaceIdentitySource;
	scopeIds: string[];
}

export interface LegacyMappingSnapshot {
	id?: number;
	workspaceIdentity: string | null;
	projectPattern: string;
	scopeId: string;
	priority?: number;
	updatedAt?: string | null;
}

export interface LegacyScopeSnapshot {
	scopeId: string;
	label: string;
	kind: string;
	authorityType: string;
	coordinatorId: string | null;
	groupId: string | null;
}

export interface LegacyMembershipSnapshot {
	scopeId: string;
	deviceId: string;
}

export interface LegacyIdentitySnapshot {
	identityId: string;
	displayName: string;
	isLocal: boolean;
	status: string;
	mergedIntoIdentityId: string | null;
}

export interface LegacyDeviceSnapshot {
	deviceId: string;
	displayName: string;
	identityId: string | null;
}

export interface LegacyShareOperationSnapshot {
	canonicalProjectIdentity: string;
	displayName: string;
	identityId: string;
	coordinatorGroupId: string;
	state: string;
}

export interface LegacyRecipientPolicySnapshot {
	projects: LegacyProjectSnapshot[];
	mappings: LegacyMappingSnapshot[];
	scopes: LegacyScopeSnapshot[];
	memberships: LegacyMembershipSnapshot[];
	identities: LegacyIdentitySnapshot[];
	devices: LegacyDeviceSnapshot[];
	shareOperations: LegacyShareOperationSnapshot[];
}

export interface ListLegacyRecipientPolicyProjectionsOptions {
	localActorId: string;
	localDeviceId: string;
}

function clean(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hasWildcard(value: string): boolean {
	return /[*?]/u.test(value);
}

function normalizedIdentity(value: string): string {
	return value.trim().replaceAll("\\", "/").replace(/\/+$/u, "");
}

function wildcardMatches(identity: string, pattern: string): boolean {
	const normalizedPattern = normalizedIdentity(pattern);
	if (normalizedPattern === "*") return true;
	if (!hasWildcard(normalizedPattern) || !/[\\/:]/u.test(normalizedPattern)) return false;
	const escaped = normalizedPattern.replace(/[|\\{}()[\]^$+?.*]/gu, "\\$&");
	const regex = new RegExp(`^${escaped.replaceAll("\\*", ".*").replaceAll("\\?", ".")}$`, "u");
	return regex.test(identity);
}

function mappingUpdatedAt(mapping: LegacyMappingSnapshot): number {
	if (!mapping.updatedAt) return 0;
	const time = Date.parse(mapping.updatedAt);
	return Number.isFinite(time) ? time : 0;
}

function bestMapping(
	mappings: LegacyMappingSnapshot[],
	specificity: (mapping: LegacyMappingSnapshot) => number,
): LegacyMappingSnapshot | null {
	return (
		mappings.toSorted(
			(left, right) =>
				(right.priority ?? 0) - (left.priority ?? 0) ||
				specificity(right) - specificity(left) ||
				mappingUpdatedAt(right) - mappingUpdatedAt(left) ||
				(right.id ?? 0) - (left.id ?? 0) ||
				left.scopeId.localeCompare(right.scopeId),
		)[0] ?? null
	);
}

function selectedMapping(
	mappings: LegacyMappingSnapshot[],
	project: LegacyProjectSnapshot,
): LegacyMappingSnapshot | null {
	const exact = bestMapping(
		mappings.filter(
			(mapping) =>
				mapping.workspaceIdentity != null &&
				normalizedIdentity(mapping.workspaceIdentity) === project.canonicalIdentity,
		),
		() => project.canonicalIdentity.length,
	);
	if (exact) return exact;
	return bestMapping(
		mappings.filter(
			(mapping) =>
				mapping.workspaceIdentity == null &&
				(normalizedIdentity(mapping.projectPattern) === project.canonicalIdentity ||
					wildcardMatches(project.canonicalIdentity, mapping.projectPattern)),
		),
		(mapping) => mapping.projectPattern.replace(/[*?]/gu, "").length,
	);
}

function isExactMapping(mapping: LegacyMappingSnapshot, project: LegacyProjectSnapshot): boolean {
	if (
		mapping.workspaceIdentity != null &&
		normalizedIdentity(mapping.workspaceIdentity) === project.canonicalIdentity
	) {
		return true;
	}
	return (
		!hasWildcard(mapping.projectPattern) &&
		normalizedIdentity(mapping.projectPattern) === project.canonicalIdentity
	);
}

function candidateId(coordinatorId: string, groupId: string): string {
	const digest = createHash("sha256")
		.update(JSON.stringify([coordinatorId, groupId]))
		.digest("hex")
		.slice(0, 32);
	return `legacy-team-candidate:${digest}`;
}

function identityStatus(value: string): "active" | "pending" | "merged" {
	if (value === "pending" || value === "merged") return value;
	return "active";
}

function uniqueSorted(values: Iterable<string>): string[] {
	return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function condition(
	code: LegacyRecipientPolicyConditionCodeV1,
	kind: LegacyRecipientPolicyConditionV1["kind"],
	message: string,
): LegacyRecipientPolicyConditionV1 {
	return { version: RECIPIENT_POLICY_CONTRACT_VERSION, code, kind, message };
}

function blockingConditions(input: {
	ambiguousScopeMapping: boolean;
	inactiveScopeBoundary: boolean;
	multiProjectScope: boolean;
	noncanonicalProjectIdentity: boolean;
	wildcardMapping: boolean;
}): LegacyRecipientPolicyConditionV1[] {
	return [
		input.noncanonicalProjectIdentity
			? condition(
					"noncanonical_project_identity",
					"diagnostic",
					"This Project has no stable canonical identity, so no recipient is inferred.",
				)
			: null,
		input.multiProjectScope
			? condition(
					"ambiguous_multi_project_scope",
					"diagnostic",
					"Current enforcement contains multiple canonical Projects, so recipients remain unresolved.",
				)
			: null,
		input.wildcardMapping
			? condition(
					"wildcard_scope_mapping",
					"diagnostic",
					"A wildcard mapping can cover multiple Projects, so recipients remain unresolved.",
				)
			: null,
		input.ambiguousScopeMapping
			? condition(
					"ambiguous_scope_mapping",
					"diagnostic",
					"Multiple enforcement boundaries apply to this Project, so recipients remain unresolved.",
				)
			: null,
		input.inactiveScopeBoundary
			? condition(
					"inactive_scope_boundary",
					"diagnostic",
					"The recorded enforcement boundary is not active, so current access cannot be projected safely.",
				)
			: null,
	].filter((item): item is LegacyRecipientPolicyConditionV1 => item != null);
}

function relevantScopeIds(
	project: LegacyProjectSnapshot,
	mappings: LegacyMappingSnapshot[],
): string[] {
	const mapping = selectedMapping(mappings, project);
	return uniqueSorted([...project.scopeIds, ...(mapping ? [mapping.scopeId] : [])]);
}

function scopeProjectIndex(snapshot: LegacyRecipientPolicySnapshot): Map<string, Set<string>> {
	const index = new Map<string, Set<string>>();
	const add = (scopeId: string, projectId: string) => {
		const projects = index.get(scopeId) ?? new Set<string>();
		projects.add(projectId);
		index.set(scopeId, projects);
	};
	for (const project of snapshot.projects) {
		for (const scopeId of project.scopeIds) add(scopeId, project.canonicalIdentity);
		const mapping = selectedMapping(snapshot.mappings, project);
		if (mapping) add(mapping.scopeId, project.canonicalIdentity);
	}
	return index;
}

function effectiveDevices(
	scopeIds: string[],
	snapshot: LegacyRecipientPolicySnapshot,
	options: ListLegacyRecipientPolicyProjectionsOptions,
): LegacyRecipientPolicyEffectiveDeviceV1[] {
	const membershipDevices = snapshot.memberships
		.filter((membership) => scopeIds.includes(membership.scopeId))
		.map((membership) => membership.deviceId);
	const includeLocal =
		scopeIds.length === 0 ||
		scopeIds.includes(LOCAL_DEFAULT_SCOPE_ID) ||
		snapshot.scopes.some(
			(scope) => scope.authorityType === "local" && scopeIds.includes(scope.scopeId),
		);
	const deviceIds = uniqueSorted([
		...membershipDevices,
		...(includeLocal ? [options.localDeviceId] : []),
	]);
	const devices = new Map(snapshot.devices.map((device) => [device.deviceId, device]));
	const identities = new Map(
		snapshot.identities.map((identity) => [identity.identityId, identity]),
	);
	return deviceIds.map((deviceId) => {
		const device = devices.get(deviceId);
		const assignedIdentityId =
			deviceId === options.localDeviceId ? options.localActorId : (device?.identityId ?? null);
		const assignedIdentity = assignedIdentityId ? identities.get(assignedIdentityId) : null;
		const mergedIdentity =
			assignedIdentity?.status === "merged" && assignedIdentity.mergedIntoIdentityId
				? identities.get(assignedIdentity.mergedIntoIdentityId)
				: null;
		const identityId =
			assignedIdentity?.status === "active" || assignedIdentity?.status === "pending"
				? assignedIdentity.identityId
				: mergedIdentity?.status === "active"
					? mergedIdentity.identityId
					: null;
		return {
			version: RECIPIENT_POLICY_CONTRACT_VERSION,
			deviceId,
			displayName:
				device?.displayName ||
				(deviceId === options.localDeviceId ? "This device" : "Unassigned device"),
			identityId,
			assignment: identityId ? "assigned" : "unassigned",
			access: "current_effective",
			provenance: deviceId === options.localDeviceId ? "local_runtime" : "active_scope_membership",
		};
	});
}

function identityCandidates(
	devices: LegacyRecipientPolicyEffectiveDeviceV1[],
	shareOperations: LegacyShareOperationSnapshot[],
	snapshot: LegacyRecipientPolicySnapshot,
	options: ListLegacyRecipientPolicyProjectionsOptions,
	personalSuggestion: boolean,
): LegacyRecipientPolicyIdentityCandidateV1[] {
	const identities = new Map(
		snapshot.identities.map((identity) => [identity.identityId, identity]),
	);
	const resolveIdentityId = (identityId: string): string | null => {
		const identity = identities.get(identityId);
		if (identity?.status === "active" || identity?.status === "pending") return identityId;
		if (identity?.status !== "merged" || !identity.mergedIntoIdentityId) return null;
		return identities.get(identity.mergedIntoIdentityId)?.status === "active"
			? identity.mergedIntoIdentityId
			: null;
	};
	const operationIdentityIds = new Set(
		shareOperations
			.map((operation) => resolveIdentityId(operation.identityId))
			.filter((identityId): identityId is string => identityId != null),
	);
	const identityIds = new Set(
		devices.flatMap((device) => (device.identityId ? [device.identityId] : [])),
	);
	for (const identityId of operationIdentityIds) identityIds.add(identityId);
	if (personalSuggestion && identities.has(options.localActorId))
		identityIds.add(options.localActorId);
	return [...identityIds]
		.flatMap((identityId): LegacyRecipientPolicyIdentityCandidateV1[] => {
			const identity = identities.get(identityId);
			if (!identity) return [];
			const isLocal = identityId === options.localActorId || identity.isLocal;
			const hasInviteEvidence = operationIdentityIds.has(identityId);
			const hasAssignedDevice = devices.some((device) => device.identityId === identityId);
			const hasActiveInvite = shareOperations.some(
				(operation) => operation.identityId === identityId && operation.state === "active",
			);
			const provenance = uniqueSorted([
				...(isLocal ? (["local_identity"] as const) : []),
				...(hasAssignedDevice ? (["peer_identity_assignment"] as const) : []),
				...(hasInviteEvidence ? (["exact_project_invite"] as const) : []),
				...(personalSuggestion && isLocal ? (["personal_scope"] as const) : []),
			]) as LegacyRecipientPolicyProvenanceV1[];
			return [
				{
					version: RECIPIENT_POLICY_CONTRACT_VERSION,
					identityId,
					displayName: identity.displayName,
					status: identityStatus(identity.status),
					mergedIntoIdentityId: identity.mergedIntoIdentityId,
					isLocal,
					suggestedKind: personalSuggestion && isLocal ? "personal" : null,
					confidence: hasActiveInvite || hasAssignedDevice ? "high" : "medium",
					provenance,
				} satisfies LegacyRecipientPolicyIdentityCandidateV1,
			];
		})
		.toSorted(
			(left, right) =>
				left.displayName.localeCompare(right.displayName) ||
				left.identityId.localeCompare(right.identityId),
		);
}

function teamCandidates(
	scopes: LegacyScopeSnapshot[],
	shareOperations: LegacyShareOperationSnapshot[],
): LegacyRecipientPolicyTeamCandidateV1[] {
	const byId = new Map<string, LegacyRecipientPolicyTeamCandidateV1>();
	for (const scope of scopes) {
		if (scope.authorityType !== "coordinator" || !scope.coordinatorId || !scope.groupId) continue;
		const teamCandidateId = candidateId(scope.coordinatorId, scope.groupId);
		const teamLikeLabel = ["team", "team_default", "org", "client"].includes(scope.kind)
			? scope.label
			: "Legacy Team candidate";
		const current = byId.get(teamCandidateId);
		if (!current || current.displayName === "Legacy Team candidate") {
			byId.set(teamCandidateId, {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				teamCandidateId,
				displayName: teamLikeLabel,
				confidence: "medium",
				provenance: ["coordinator_group_enrollment"],
			});
		}
	}
	for (const operation of shareOperations) {
		const matchingScope = scopes.find(
			(scope) => scope.groupId === operation.coordinatorGroupId && scope.coordinatorId,
		);
		const teamCandidateId = candidateId(
			matchingScope?.coordinatorId ?? "legacy-share-operation",
			operation.coordinatorGroupId,
		);
		const current = byId.get(teamCandidateId);
		byId.set(teamCandidateId, {
			version: RECIPIENT_POLICY_CONTRACT_VERSION,
			teamCandidateId,
			displayName: current?.displayName ?? "Legacy Team candidate",
			confidence: "medium",
			provenance: uniqueSorted([
				...(current?.provenance ?? []),
				"coordinator_group_enrollment",
				"exact_project_invite",
			]) as LegacyRecipientPolicyProvenanceV1[],
		});
	}
	return [...byId.values()].toSorted(
		(left, right) =>
			left.displayName.localeCompare(right.displayName) ||
			left.teamCandidateId.localeCompare(right.teamCandidateId),
	);
}

export function projectLegacyRecipientPolicyProjections(
	snapshot: LegacyRecipientPolicySnapshot,
	options: ListLegacyRecipientPolicyProjectionsOptions,
): LegacyRecipientPolicyProjectionV1[] {
	const scopes = new Map(snapshot.scopes.map((scope) => [scope.scopeId, scope]));
	const projectsByScope = scopeProjectIndex(snapshot);
	return snapshot.projects
		.map((project): LegacyRecipientPolicyProjectionV1 => {
			const projectShareOperations = snapshot.shareOperations.filter(
				(operation) => operation.canonicalProjectIdentity === project.canonicalIdentity,
			);
			const selectedProjectMapping = selectedMapping(snapshot.mappings, project);
			const scopeIds = relevantScopeIds(project, snapshot.mappings);
			const relevantScopes = scopeIds.flatMap((scopeId) => {
				const scope = scopes.get(scopeId);
				return scope ? [scope] : [];
			});
			const exactMappings =
				selectedProjectMapping && isExactMapping(selectedProjectMapping, project)
					? [selectedProjectMapping]
					: [];
			const wildcardMapping = Boolean(
				selectedProjectMapping &&
					!isExactMapping(selectedProjectMapping, project) &&
					hasWildcard(selectedProjectMapping.projectPattern),
			);
			const inactiveScopeBoundary = scopeIds.some(
				(scopeId) => scopeId !== LOCAL_DEFAULT_SCOPE_ID && !scopes.has(scopeId),
			);
			const multiProjectScope = relevantScopes.some(
				(scope) =>
					scope.scopeId !== LOCAL_DEFAULT_SCOPE_ID &&
					(projectsByScope.get(scope.scopeId)?.size ?? 0) > 1,
			);
			const managedScopes = relevantScopes.filter((scope) => scope.kind === "managed_project");
			const mappedScopeIds = uniqueSorted(exactMappings.map((mapping) => mapping.scopeId));
			const multipleScopeBoundaries =
				uniqueSorted(scopeIds.filter((scopeId) => scopeId !== LOCAL_DEFAULT_SCOPE_ID)).length > 1;
			const managedExact =
				project.identitySource !== "unmapped" &&
				exactMappings.length === 1 &&
				mappedScopeIds.length === 1 &&
				managedScopes.length === 1 &&
				managedScopes[0]?.scopeId === mappedScopeIds[0] &&
				(projectsByScope.get(mappedScopeIds[0] ?? "")?.size ?? 0) === 1 &&
				!wildcardMapping &&
				!multiProjectScope &&
				scopeIds.every((scopeId) => scopeId === mappedScopeIds[0]);
			const personalSuggestion =
				project.identitySource !== "unmapped" &&
				!multiProjectScope &&
				!wildcardMapping &&
				!multipleScopeBoundaries &&
				!inactiveScopeBoundary &&
				(scopeIds.length === 0 ||
					scopeIds.every((scopeId) => {
						if (scopeId === LOCAL_DEFAULT_SCOPE_ID) return true;
						return scopes.get(scopeId)?.kind === "personal";
					}));
			const clearTeamEvidence =
				!managedExact &&
				!multiProjectScope &&
				!wildcardMapping &&
				!multipleScopeBoundaries &&
				!inactiveScopeBoundary &&
				relevantScopes.some(
					(scope) =>
						scope.authorityType === "coordinator" &&
						Boolean(scope.groupId && scope.coordinatorId) &&
						["team", "team_default", "org", "client"].includes(scope.kind) &&
						(projectsByScope.get(scope.scopeId)?.size ?? 0) === 1,
				);
			const activeEffectiveScopeIds = uniqueSorted([
				...relevantScopes.map((scope) => scope.scopeId),
				...(scopeIds.includes(LOCAL_DEFAULT_SCOPE_ID) ? [LOCAL_DEFAULT_SCOPE_ID] : []),
			]);
			const devices = effectiveDevices(activeEffectiveScopeIds, snapshot, options);
			const unassigned = devices.filter((device) => device.assignment === "unassigned");
			const diagnostics = blockingConditions({
				ambiguousScopeMapping:
					!managedExact && (exactMappings.length > 1 || multipleScopeBoundaries),
				inactiveScopeBoundary,
				multiProjectScope,
				noncanonicalProjectIdentity: project.identitySource === "unmapped",
				wildcardMapping,
			});
			const conditions: LegacyRecipientPolicyConditionV1[] = [...diagnostics];
			if (personalSuggestion) {
				conditions.push(
					condition(
						"suggest_local_identity",
						"actionable",
						"Consider keeping this Project with the local Personal Identity.",
					),
				);
			}
			if (clearTeamEvidence) {
				conditions.push(
					condition(
						"suggest_team_candidate",
						"actionable",
						"Coordinator enrollment is a non-authoritative Team candidate; confirm recipients before creating policy.",
					),
				);
			}
			if (unassigned.length > 0) {
				conditions.push(
					condition(
						"unassigned_effective_device",
						"actionable",
						"A device with current effective access is not assigned to an Identity.",
					),
				);
			}
			const blockingDiagnostic = diagnostics[0] ?? null;
			const state: LegacyRecipientPolicyEnforcementStateV1 = managedExact
				? "managed_exact_project"
				: blockingDiagnostic
					? "ambiguous"
					: personalSuggestion
						? "local_only"
						: "legacy_shared";
			const safeErrorCode = state === "ambiguous" ? (blockingDiagnostic?.code ?? null) : null;
			return {
				version: RECIPIENT_POLICY_CONTRACT_VERSION,
				project: {
					version: RECIPIENT_POLICY_CONTRACT_VERSION,
					canonicalIdentity: project.canonicalIdentity,
					displayName: project.displayName,
				},
				intent: [],
				identityCandidates:
					state === "ambiguous"
						? []
						: identityCandidates(
								devices,
								projectShareOperations,
								snapshot,
								options,
								personalSuggestion,
							),
				teamCandidates:
					state === "ambiguous" ? [] : teamCandidates(relevantScopes, projectShareOperations),
				effectiveDevices: devices,
				enforcement: {
					version: RECIPIENT_POLICY_CONTRACT_VERSION,
					authority: "legacy_scope",
					parity: "unknown",
					cutoverState: "legacy",
					state,
					currentDeviceIds: devices.map((device) => device.deviceId),
					safeErrorCode,
				},
				conditions: conditions.toSorted((left, right) => left.code.localeCompare(right.code)),
			};
		})
		.toSorted(
			(left, right) =>
				left.project.displayName.localeCompare(right.project.displayName) ||
				left.project.canonicalIdentity.localeCompare(right.project.canonicalIdentity),
		);
}

function loadSnapshot(
	db: Database,
	options: ListLegacyRecipientPolicyProjectionsOptions,
): LegacyRecipientPolicySnapshot {
	const projectRows = db
		.prepare(
			`SELECT s.cwd, s.project, s.git_remote, s.git_branch,
				mi.id AS memory_id, mi.workspace_id, mi.scope_id
			 FROM sessions s
			 LEFT JOIN memory_items mi ON mi.session_id = s.id
				AND mi.active = 1 AND mi.deleted_at IS NULL
			 WHERE (COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), TRIM(mi.workspace_id), '') <> '')
			   AND (s.cwd IS NULL OR substr(s.cwd, 1, length(?)) <> ?)
			 ORDER BY s.id, mi.id`,
		)
		.all(SYNC_BOOTSTRAP_CWD_PREFIX, SYNC_BOOTSTRAP_CWD_PREFIX) as Array<{
		cwd: string | null;
		project: string | null;
		git_remote: string | null;
		git_branch: string | null;
		memory_id: number | null;
		workspace_id: string | null;
		scope_id: string | null;
	}>;
	const projects = new Map<string, LegacyProjectSnapshot>();
	for (const row of projectRows) {
		const identity = canonicalWorkspaceIdentity({
			cwd: row.cwd,
			project: row.project,
			gitRemote: row.git_remote,
			gitBranch: row.git_branch,
			workspaceId: row.workspace_id,
		});
		const existing = projects.get(identity.value);
		const scopeId = row.memory_id == null ? null : (clean(row.scope_id) ?? LOCAL_DEFAULT_SCOPE_ID);
		if (existing) {
			if (scopeId) existing.scopeIds = uniqueSorted([...existing.scopeIds, scopeId]);
			continue;
		}
		projects.set(identity.value, {
			canonicalIdentity: identity.value,
			displayName: clean(identity.displayProject) ?? identity.value,
			identitySource: identity.source,
			scopeIds: scopeId ? [scopeId] : [],
		});
	}
	const mappings = db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, priority, updated_at
			 FROM project_scope_mappings
			 ORDER BY priority DESC, updated_at DESC, id DESC`,
		)
		.all()
		.map((row) => {
			const record = row as Record<string, unknown>;
			return {
				id: Number(record.id ?? 0),
				workspaceIdentity: clean(record.workspace_identity),
				projectPattern: String(record.project_pattern ?? ""),
				scopeId: String(record.scope_id ?? ""),
				priority: Number(record.priority ?? 0),
				updatedAt: clean(record.updated_at),
			};
		});
	for (const mapping of mappings) {
		if (!mapping.workspaceIdentity || projects.has(normalizedIdentity(mapping.workspaceIdentity)))
			continue;
		const canonicalIdentity = normalizedIdentity(mapping.workspaceIdentity);
		projects.set(canonicalIdentity, {
			canonicalIdentity,
			displayName: clean(mapping.projectPattern) ?? canonicalIdentity,
			identitySource: canonicalIdentity.startsWith("unmapped:") ? "unmapped" : "workspace_id",
			scopeIds: [],
		});
	}
	const scopes = db
		.prepare(
			`SELECT scope_id, label, kind, authority_type, coordinator_id, group_id
			 FROM replication_scopes
			 WHERE status = 'active'
			 ORDER BY scope_id`,
		)
		.all()
		.map((row) => {
			const record = row as Record<string, unknown>;
			return {
				scopeId: String(record.scope_id ?? ""),
				label: String(record.label ?? ""),
				kind: String(record.kind ?? ""),
				authorityType: String(record.authority_type ?? ""),
				coordinatorId: clean(record.coordinator_id),
				groupId: clean(record.group_id),
			};
		});
	const memberships = db
		.prepare(
			`SELECT sm.scope_id, sm.device_id
			 FROM scope_memberships sm
			 JOIN replication_scopes rs ON rs.scope_id = sm.scope_id
			 WHERE sm.status = 'active'
			   AND rs.status = 'active'
			   AND sm.membership_epoch >= rs.membership_epoch
			 ORDER BY sm.scope_id, sm.device_id`,
		)
		.all()
		.map((row) => {
			const record = row as Record<string, unknown>;
			return { scopeId: String(record.scope_id ?? ""), deviceId: String(record.device_id ?? "") };
		});
	const identities = db
		.prepare(
			`SELECT actor_id, display_name, is_local, status, merged_into_actor_id
			 FROM actors
			 WHERE status <> 'deactivated'
			 ORDER BY display_name, actor_id`,
		)
		.all()
		.map((row) => {
			const record = row as Record<string, unknown>;
			return {
				identityId: String(record.actor_id ?? ""),
				displayName: String(record.display_name ?? ""),
				isLocal: Number(record.is_local ?? 0) === 1,
				status: String(record.status ?? "active"),
				mergedIntoIdentityId: clean(record.merged_into_actor_id),
			};
		});
	const peerDevices = db
		.prepare(
			`SELECT peer_device_id, name, actor_id
			 FROM sync_peers
			 ORDER BY peer_device_id`,
		)
		.all()
		.map((row) => {
			const record = row as Record<string, unknown>;
			return {
				deviceId: String(record.peer_device_id ?? ""),
				displayName: clean(record.name) ?? "Peer device",
				identityId: clean(record.actor_id),
			};
		});
	const shareOperationRows = db
		.prepare(
			`SELECT o.operation_id, o.reviewed_project_set_digest,
				p.canonical_project_identity, p.display_name, p.identity_source,
				p.existing_memory_count,
				o.recipient_actor_id AS identity_id,
				o.coordinator_group_id, o.state
			 FROM share_operations o
			 JOIN share_operation_projects p ON p.operation_id = o.operation_id
			 WHERE o.inviter_actor_id = ?
			   AND o.state IN ('accepted', 'provisioning', 'initial_sync', 'active', 'needs_attention')
			   AND o.recipient_actor_id IS NOT NULL
			   AND TRIM(o.recipient_actor_id) <> ''
			   AND o.recipient_device_id IS NOT NULL
			   AND TRIM(o.recipient_device_id) <> ''
			   AND o.acceptance_consumed_at IS NOT NULL
			   AND TRIM(o.acceptance_consumed_at) <> ''
			 ORDER BY o.created_at, o.operation_id, p.ordinal`,
		)
		.all(options.localActorId)
		.map((row) => {
			const record = row as Record<string, unknown>;
			return {
				operationId: String(record.operation_id ?? ""),
				reviewedProjectSetDigest: String(record.reviewed_project_set_digest ?? ""),
				canonicalProjectIdentity: normalizedIdentity(
					String(record.canonical_project_identity ?? ""),
				),
				displayName: String(record.display_name ?? ""),
				identitySource: String(record.identity_source ?? ""),
				existingMemoryCount: Number(record.existing_memory_count ?? 0),
				identityId: String(record.identity_id ?? ""),
				coordinatorGroupId: String(record.coordinator_group_id ?? ""),
				state: String(record.state ?? ""),
			};
		});
	const rowsByOperation = new Map<string, typeof shareOperationRows>();
	for (const row of shareOperationRows) {
		const rows = rowsByOperation.get(row.operationId) ?? [];
		rows.push(row);
		rowsByOperation.set(row.operationId, rows);
	}
	const shareOperations = [...rowsByOperation.values()].flatMap(
		(rows): LegacyShareOperationSnapshot[] => {
			const reviewedProjectSetDigest = rows[0]?.reviewedProjectSetDigest;
			const projects = rows.map((row) => ({
				canonicalIdentity: row.canonicalProjectIdentity,
				displayName: row.displayName,
				identitySource: row.identitySource,
				existingMemoryCount: row.existingMemoryCount,
			}));
			if (
				!reviewedProjectSetDigest ||
				shareProjectSetDigest(projects) !== reviewedProjectSetDigest
			) {
				return [];
			}
			return rows
				.map((row) => ({
					canonicalProjectIdentity: row.canonicalProjectIdentity,
					displayName: row.displayName,
					identityId: row.identityId,
					coordinatorGroupId: row.coordinatorGroupId,
					state: row.state,
				}))
				.filter(
					(operation) =>
						operation.canonicalProjectIdentity &&
						operation.identityId &&
						operation.coordinatorGroupId,
				);
		},
	);
	for (const operation of shareOperations) {
		if (projects.has(operation.canonicalProjectIdentity)) continue;
		projects.set(operation.canonicalProjectIdentity, {
			canonicalIdentity: operation.canonicalProjectIdentity,
			displayName: clean(operation.displayName) ?? operation.canonicalProjectIdentity,
			identitySource: operation.canonicalProjectIdentity.startsWith("unmapped:")
				? "unmapped"
				: "workspace_id",
			scopeIds: [],
		});
	}
	return {
		projects: [...projects.values()],
		mappings,
		scopes,
		memberships,
		identities,
		devices: [
			...peerDevices,
			{
				deviceId: options.localDeviceId,
				displayName: "This device",
				identityId: options.localActorId,
			},
		],
		shareOperations,
	};
}

export function resolveLegacyRecipientPolicyLocalIdentity(
	db: Database,
	options: ListLegacyRecipientPolicyProjectionsOptions,
): ListLegacyRecipientPolicyProjectionsOptions {
	const storedDeviceId = clean(
		db
			.prepare("SELECT device_id FROM sync_device ORDER BY created_at, device_id LIMIT 1")
			.pluck()
			.get(),
	);
	const localDeviceId = storedDeviceId ?? options.localDeviceId;
	const storedActorId = clean(
		db
			.prepare(
				`SELECT actor_id FROM actors
				 WHERE is_local = 1 AND status = 'active'
				 ORDER BY CASE WHEN actor_id = ? THEN 0 WHEN actor_id = ? THEN 1 ELSE 2 END,
					actor_id
				 LIMIT 1`,
			)
			.pluck()
			.get(options.localActorId, `local:${localDeviceId}`),
	);
	return {
		localActorId: storedActorId ?? options.localActorId,
		localDeviceId,
	};
}

export function listLegacyRecipientPolicyProjections(
	db: Database,
	options: ListLegacyRecipientPolicyProjectionsOptions,
): LegacyRecipientPolicyProjectionV1[] {
	const localActorId = options.localActorId.trim();
	const localDeviceId = options.localDeviceId.trim();
	if (!localActorId || !localDeviceId) throw new Error("legacy_projection_local_identity_required");
	const normalizedOptions = resolveLegacyRecipientPolicyLocalIdentity(db, {
		localActorId,
		localDeviceId,
	});
	return projectLegacyRecipientPolicyProjections(
		loadSnapshot(db, normalizedOptions),
		normalizedOptions,
	);
}
