import { createHash } from "node:crypto";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import { type Database, fromJson } from "./db.js";
import { assertLegacyShareGrantAllowed } from "./recipient-policy-reconciler.js";
import { serializeRecipientPolicyPublicationMutation } from "./recipient-policy-team-metadata.js";
import {
	canonicalRepositoryProjectIdentity,
	hasConflictingRepositoryMappings,
	hasRecordedRepositoryWorkspace,
	normalizeRepositoryWorkspaceIdentity,
	repositoryIdentitiesByWorkspace,
	repositoryIdentityForWorkspace,
	withRepositoryMappingAliasesFromIdentities,
} from "./repository-mapping-aliases.js";
import {
	canonicalWorkspaceIdentity,
	resolveProjectScope,
	type ScopeMapping,
} from "./scope-resolution.js";
import {
	DEFAULT_SYNC_SCOPE_ID,
	recordReplicationOp,
	recordScopeReassignment,
	syncProjectAllowed,
	syncProjectAllowedByFilters,
} from "./sync-replication.js";

export interface ManagedProjectPlan {
	canonicalIdentity: string;
	operationIdentity?: string;
	displayName: string;
	boundaryId: string;
	memoryIds: number[];
	localOnlyMemoryIds: number[];
	reassignedMemoryIds: number[];
	memberDeviceIds: string[];
	reassignmentSourceDeviceIds: string[];
}

function provisioningStepIdentity(project: ManagedProjectPlan): string {
	return project.operationIdentity ?? project.canonicalIdentity;
}

function assertLegacyShareGrantForProject(
	db: Database,
	project: ManagedProjectPlan,
	deviceId: string,
): void {
	for (const canonicalProjectIdentity of [project.canonicalIdentity, project.operationIdentity]) {
		if (!canonicalProjectIdentity) continue;
		assertLegacyShareGrantAllowed(db, { canonicalProjectIdentity, deviceId });
	}
}

export interface ShareProvisioningPlan {
	operationId: string;
	groupId: string;
	recipientDeviceId: string;
	projects: ManagedProjectPlan[];
	requiredCapabilityDeviceIds: string[];
}

export type ReassignScopeCapability = "supported" | "unsupported" | "undetermined";

export interface ShareProvisioningDependencies {
	beforeStep?(stepKey: string): Promise<void> | void;
	createOrGetBoundary(project: ManagedProjectPlan, groupId: string): Promise<CoordinatorScope>;
	grantMembership(input: {
		effectId: string;
		groupId: string;
		scopeId: string;
		deviceId: string;
		role: "admin" | "member";
	}): Promise<CoordinatorScopeMembership>;
	supportsReassignScope(deviceId: string): Promise<ReassignScopeCapability>;
	refreshAuthorization(groupId: string): Promise<void>;
	runInitialSync(recipientDeviceId: string): Promise<{
		ok: boolean;
		failureCategory?: string;
		perScopeResults?: Array<{ scope_id: string; ok: boolean; error?: string }>;
	}>;
}

interface OperationRow {
	operation_id: string;
	state: string;
	inviter_device_ids_json: string;
	coordinator_group_id: string;
	recipient_device_id: string | null;
}

interface ProjectRow {
	canonical_project_identity: string;
	display_name: string;
}

interface MemoryCandidateRow {
	id: number;
	import_key: string | null;
	visibility: string | null;
	scope_id: string | null;
	project: string | null;
	cwd: string | null;
	git_remote: string | null;
	git_branch: string | null;
	workspace_id: string | null;
	origin_device_id: string | null;
	session_user: string | null;
	session_tool_version: string | null;
	session_metadata_json: string | null;
}

function clean(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseStringList(value: string): string[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		return Array.isArray(parsed)
			? [...new Set(parsed.map(clean).filter((item): item is string => item != null))].toSorted()
			: [];
	} catch {
		return [];
	}
}

function peerFilters(
	db: Database,
	deviceId: string,
): { include: string[]; exclude: string[] } | null {
	const row = db
		.prepare(
			"SELECT projects_include_json, projects_exclude_json FROM sync_peers WHERE peer_device_id = ?",
		)
		.get(deviceId) as
		| { projects_include_json: string | null; projects_exclude_json: string | null }
		| undefined;
	if (!row) return null;
	const list = (raw: string | null): string[] | null => {
		if (raw == null) return [];
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return null;
			return parsed;
		} catch {
			return null;
		}
	};
	const include = list(row.projects_include_json);
	const exclude = list(row.projects_exclude_json);
	return include && exclude ? { include, exclude } : null;
}

function memoryCandidates(db: Database): MemoryCandidateRow[] {
	return db
		.prepare(`SELECT mi.id, mi.import_key, mi.visibility, mi.scope_id, mi.origin_device_id,
			COALESCE(mi.project, s.project) AS project, s.cwd, s.git_remote, s.git_branch,
			mi.workspace_id, s.user AS session_user, s.tool_version AS session_tool_version,
			s.metadata_json AS session_metadata_json
		 FROM memory_items mi
		 JOIN sessions s ON s.id = mi.session_id
		 WHERE mi.active = 1`)
		.all() as MemoryCandidateRow[];
}

function neverReplicationEligible(db: Database, row: MemoryCandidateRow): boolean {
	if (row.import_key) return false;
	return !db
		.prepare(
			"SELECT 1 FROM replication_ops WHERE entity_type = 'memory_item' AND entity_id = ? LIMIT 1",
		)
		.get(String(row.id));
}

function shareableForManagedProject(row: MemoryCandidateRow): boolean {
	const visibility = clean(row.visibility)?.toLowerCase() ?? "";
	return !visibility.startsWith("private") && !visibility.startsWith("personal");
}

function isInitiatingDeviceMemory(row: MemoryCandidateRow, initiatingDeviceId: string): boolean {
	const originDeviceId = clean(row.origin_device_id);
	if (!originDeviceId || originDeviceId === initiatingDeviceId) return true;
	if (originDeviceId !== "local") return false;
	return (
		clean(row.session_user) !== "sync" && clean(row.session_tool_version) !== "sync_replication"
	);
}

function memoryCandidateIdentity(
	row: MemoryCandidateRow,
	repositoryIdentities: ReadonlyMap<string, string>,
): string {
	return canonicalWorkspaceIdentity({
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		repositoryIdentity: repositoryIdentityForWorkspace(repositoryIdentities, {
			cwd: row.cwd,
			gitRemote: row.git_remote,
			metadataJson: row.session_metadata_json,
		}),
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
	}).value;
}

export function countShareableProjectMemories(
	db: Database,
	input: { canonicalIdentity: string; initiatingDeviceId: string },
): number {
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db);
	return memoryCandidates(db).filter((row) => {
		if (!shareableForManagedProject(row)) return false;
		if (!isInitiatingDeviceMemory(row, input.initiatingDeviceId)) return false;
		return memoryCandidateIdentity(row, repositoryIdentities) === input.canonicalIdentity;
	}).length;
}

function effectiveInviterDevices(
	db: Database,
	input: {
		initiatingDeviceId: string;
		inviterDeviceIds: string[];
		sourceScopeIds: string[];
		projectNames: string[];
	},
): string[] {
	const allowed = new Set([input.initiatingDeviceId]);
	for (const deviceId of input.inviterDeviceIds) {
		if (deviceId === input.initiatingDeviceId) continue;
		const filters = peerFilters(db, deviceId);
		if (!filters || input.projectNames.length === 0) {
			throw new Error("inviter_project_access_ambiguous");
		}
		const membershipsAreExact = input.sourceScopeIds.every((scopeId) =>
			db
				.prepare(`SELECT 1 FROM scope_memberships
				 WHERE scope_id = ? AND device_id = ? AND status = 'active' LIMIT 1`)
				.get(scopeId, deviceId),
		);
		const filtersAllowEveryName = input.projectNames.every((project) =>
			syncProjectAllowedByFilters(project, filters),
		);
		if (!membershipsAreExact || !filtersAllowEveryName) {
			throw new Error("inviter_project_access_ambiguous");
		}
		allowed.add(deviceId);
	}
	return [...allowed].toSorted();
}

function persistedProjectMembers(
	db: Database,
	operationId: string,
	canonicalIdentity: string,
): string[] {
	const prefix = `provisioning_member:${canonicalIdentity}:`;
	return (
		db
			.prepare(`SELECT step_key FROM share_operation_steps
			 WHERE operation_id = ? AND status = 'completed' AND step_key LIKE 'provisioning_member:%'`)
			.all(operationId) as Array<{ step_key: string }>
	)
		.map((row) => row.step_key)
		.filter((stepKey) => stepKey.startsWith(prefix))
		.map((stepKey) => clean(stepKey.slice(prefix.length)))
		.filter((deviceId): deviceId is string => deviceId != null)
		.toSorted();
}

function activeScopeMemberDeviceIds(db: Database, scopeIds: string[]): string[] {
	const members = new Set<string>();
	for (const scopeId of scopeIds) {
		for (const row of db
			.prepare(`SELECT device_id FROM scope_memberships
				WHERE scope_id = ? AND status = 'active'`)
			.all(scopeId) as Array<{ device_id: string }>) {
			const deviceId = clean(row.device_id);
			if (deviceId) members.add(deviceId);
		}
	}
	return [...members].toSorted();
}

function projectAllowedPeerDeviceIds(db: Database, projectValues: Array<string | null>): string[] {
	if (projectValues.length === 0) return [];
	return (
		db.prepare("SELECT peer_device_id FROM sync_peers").all() as Array<{
			peer_device_id: string;
		}>
	)
		.map((row) => clean(row.peer_device_id))
		.filter(
			(deviceId): deviceId is string =>
				deviceId != null &&
				projectValues.some((project) => syncProjectAllowed(db, project, deviceId)),
		)
		.toSorted();
}

interface ProvisioningMappingEvidence {
	repositoryIdentities: ReadonlyMap<string, string>;
	mappings: ScopeMapping[];
	effectiveMappings: ScopeMapping[];
}

function loadProvisioningMappingEvidence(db: Database): ProvisioningMappingEvidence {
	const mappings = db
		.prepare(`SELECT id, workspace_identity, project_pattern, scope_id, priority, source, updated_at
			FROM project_scope_mappings ORDER BY priority DESC, id ASC`)
		.all() as ScopeMapping[];
	const repositoryIdentities = repositoryIdentitiesByWorkspace(db, {
		knownRepositoryIdentities: mappings.flatMap((mapping) => [
			mapping.workspace_identity,
			mapping.project_pattern,
		]),
	});
	return {
		repositoryIdentities,
		mappings,
		effectiveMappings: withRepositoryMappingAliasesFromIdentities(mappings, repositoryIdentities, {
			discoverFilesystem: true,
		}),
	};
}

function assertValidProvisioningProjects(
	projects: ProjectRow[],
	evidence: ProvisioningMappingEvidence,
): void {
	const { repositoryIdentities, mappings } = evidence;
	if (projects.length === 0) throw new Error("operation_intent_invalid");
	if (
		projects.some((project) => {
			const identity = normalizeRepositoryWorkspaceIdentity(project.canonical_project_identity);
			return (
				hasRecordedRepositoryWorkspace(repositoryIdentities, project.canonical_project_identity) &&
				Boolean(identity && !repositoryIdentities.has(identity))
			);
		})
	) {
		throw new Error("operation_intent_invalid");
	}
	const canonicalIdentities = projects.map((project) =>
		canonicalRepositoryProjectIdentity(repositoryIdentities, project.canonical_project_identity),
	);
	if (new Set(canonicalIdentities).size !== canonicalIdentities.length) {
		throw new Error("operation_intent_invalid");
	}
	if (
		canonicalIdentities.some((identity) =>
			hasConflictingRepositoryMappings(mappings, repositoryIdentities, identity),
		)
	) {
		throw new Error("conflicting_repository_mappings");
	}
}

function loadProvisioningContext(
	db: Database,
	input: { operationId: string; initiatingDeviceId: string },
): {
	operation: OperationRow;
	recipientDeviceId: string;
	initiatingDeviceId: string;
	inviterDeviceIds: string[];
} {
	const operation = db
		.prepare(`SELECT operation_id, state, inviter_device_ids_json, coordinator_group_id,
			recipient_device_id FROM share_operations WHERE operation_id = ?`)
		.get(input.operationId) as OperationRow | undefined;
	if (!operation) throw new Error("operation_not_found");
	if (
		![
			"accepted",
			"provisioning",
			"initial_sync",
			"active",
			"needs_attention",
			"waiting_for_device",
		].includes(operation.state)
	) {
		throw new Error("operation_not_accepted");
	}
	const recipientDeviceId = clean(operation.recipient_device_id);
	const initiatingDeviceId = clean(input.initiatingDeviceId);
	if (!recipientDeviceId || !initiatingDeviceId) {
		throw new Error("operation_device_binding_missing");
	}
	const inviterDeviceIds = parseStringList(operation.inviter_device_ids_json);
	if (!inviterDeviceIds.includes(initiatingDeviceId)) {
		throw new Error("initiating_device_not_reviewed");
	}
	return { operation, recipientDeviceId, initiatingDeviceId, inviterDeviceIds };
}

function plannedMemberDeviceIds(
	db: Database,
	input: {
		operationId: string;
		projectIdentity: string;
		initiatingDeviceId: string;
		inviterDeviceIds: string[];
		recipientDeviceId: string;
		sourceScopeIds: string[];
		projectNames: string[];
	},
): string[] {
	const persisted = persistedProjectMembers(db, input.operationId, input.projectIdentity);
	const requiresValidation = persisted.some(
		(deviceId) =>
			stepStatus(db, input.operationId, `space_grant:${input.projectIdentity}:${deviceId}`) !==
			"completed",
	);
	const current =
		persisted.length === 0 || requiresValidation
			? [
					...effectiveInviterDevices(db, {
						initiatingDeviceId: input.initiatingDeviceId,
						inviterDeviceIds: input.inviterDeviceIds,
						sourceScopeIds: input.sourceScopeIds,
						projectNames: input.projectNames,
					}),
					input.recipientDeviceId,
				]
			: persisted;
	if (persisted.some((deviceId) => !current.includes(deviceId))) {
		throw new Error("inviter_project_access_ambiguous");
	}
	const members = persisted.length > 0 ? persisted : current;
	if (!members.includes(input.initiatingDeviceId) || !members.includes(input.recipientDeviceId)) {
		throw new Error("provisioning_membership_plan_invalid");
	}
	if (
		members.some(
			(deviceId) =>
				deviceId !== input.recipientDeviceId && !input.inviterDeviceIds.includes(deviceId),
		)
	) {
		throw new Error("provisioning_membership_plan_invalid");
	}
	return members;
}

function reassignmentSourceDevices(
	db: Database,
	rows: MemoryCandidateRow[],
	boundaryId: string,
): string[] {
	const scopeIds = [
		...new Set(
			rows
				.map((row) => clean(row.scope_id) ?? DEFAULT_SYNC_SCOPE_ID)
				.filter((scopeId) => scopeId !== boundaryId),
		),
	];
	const defaultScopeProjects = rows
		.filter((row) => (clean(row.scope_id) ?? DEFAULT_SYNC_SCOPE_ID) === DEFAULT_SYNC_SCOPE_ID)
		.map((row) => clean(row.project));
	return [
		...new Set([
			...activeScopeMemberDeviceIds(
				db,
				scopeIds.filter((scopeId) => scopeId !== DEFAULT_SYNC_SCOPE_ID),
			),
			...projectAllowedPeerDeviceIds(db, defaultScopeProjects),
		]),
	].toSorted();
}

function buildManagedProjectPlan(
	db: Database,
	project: ProjectRow,
	candidates: MemoryCandidateRow[],
	repositoryIdentities: ReadonlyMap<string, string>,
	context: ReturnType<typeof loadProvisioningContext>,
): ManagedProjectPlan {
	const canonicalProjectIdentity = canonicalRepositoryProjectIdentity(
		repositoryIdentities,
		project.canonical_project_identity,
	);
	const matched = candidates.filter(
		(row) =>
			shareableForManagedProject(row) &&
			isInitiatingDeviceMemory(row, context.initiatingDeviceId) &&
			memoryCandidateIdentity(row, repositoryIdentities) === canonicalProjectIdentity,
	);
	const sourceScopeIds = [
		...new Set(matched.map((row) => clean(row.scope_id) ?? "local-default")),
	].toSorted();
	const projectNames = [
		...new Set(
			matched.map((row) => clean(row.project)).filter((item): item is string => item != null),
		),
	].toSorted();
	const memberDeviceIds = plannedMemberDeviceIds(db, {
		...context,
		operationId: context.operation.operation_id,
		projectIdentity: project.canonical_project_identity,
		sourceScopeIds,
		projectNames,
	});
	const boundaryId = db
		.prepare(`SELECT effect_id FROM share_operation_steps WHERE operation_id = ? AND step_key = ?`)
		.pluck()
		.get(
			context.operation.operation_id,
			`managed_boundary:${project.canonical_project_identity}`,
		) as string;
	const localOnlyRows = matched.filter((row) => neverReplicationEligible(db, row));
	const reassignedRows = matched.filter((row) => !neverReplicationEligible(db, row));
	return {
		canonicalIdentity: canonicalProjectIdentity,
		...(canonicalProjectIdentity === project.canonical_project_identity
			? {}
			: { operationIdentity: project.canonical_project_identity }),
		displayName: project.display_name,
		boundaryId,
		memoryIds: matched.map((row) => row.id).toSorted((a, b) => a - b),
		localOnlyMemoryIds: localOnlyRows.map((row) => row.id).toSorted((a, b) => a - b),
		reassignedMemoryIds: reassignedRows.map((row) => row.id).toSorted((a, b) => a - b),
		memberDeviceIds: [...new Set(memberDeviceIds)].toSorted(),
		reassignmentSourceDeviceIds: reassignmentSourceDevices(db, reassignedRows, boundaryId),
	};
}

export function planShareProvisioning(
	db: Database,
	input: { operationId: string; initiatingDeviceId: string },
): ShareProvisioningPlan {
	const context = loadProvisioningContext(db, input);
	const projects = db
		.prepare(`SELECT canonical_project_identity, display_name FROM share_operation_projects
		 WHERE operation_id = ? ORDER BY ordinal`)
		.all(context.operation.operation_id) as ProjectRow[];
	const evidence = loadProvisioningMappingEvidence(db);
	const repositoryIdentities = evidence.repositoryIdentities;
	assertValidProvisioningProjects(projects, evidence);
	const candidates = memoryCandidates(db);
	const plans = projects.map((project) =>
		buildManagedProjectPlan(db, project, candidates, repositoryIdentities, context),
	);
	if (plans.some((project) => !clean(project.boundaryId)))
		throw new Error("managed_boundary_plan_missing");
	for (const project of plans) assertCompatibleEffectiveMapping(project, evidence);
	return {
		operationId: context.operation.operation_id,
		groupId: context.operation.coordinator_group_id,
		recipientDeviceId: context.recipientDeviceId,
		projects: plans,
		requiredCapabilityDeviceIds: [
			...new Set(
				plans
					.filter((project) => project.reassignedMemoryIds.length > 0)
					.flatMap((project) => [
						...project.memberDeviceIds,
						...project.reassignmentSourceDeviceIds,
					]),
			),
		].toSorted(),
	};
}

function persistMembershipPlan(db: Database, plan: ShareProvisioningPlan): void {
	const now = new Date().toISOString();
	db.transaction(() => {
		for (const project of plan.projects) {
			const stepIdentity = provisioningStepIdentity(project);
			for (const deviceId of project.memberDeviceIds) {
				const stepKey = `provisioning_member:${stepIdentity}:${deviceId}`;
				const effectId = `provisioning-member:${plan.operationId}:${stepIdentity}:${deviceId}`;
				db.prepare(`INSERT OR IGNORE INTO share_operation_steps(
					operation_id, step_key, effect_id, status, attempt_count, started_at,
					completed_at, last_attempt_at, updated_at
				) VALUES (?, ?, ?, 'completed', 1, ?, ?, ?, ?)`).run(
					plan.operationId,
					stepKey,
					effectId,
					now,
					now,
					now,
					now,
				);
			}
		}
	})();
}

function ensureStep(
	db: Database,
	operationId: string,
	stepKey: string,
	effectId: string,
	now: string,
): void {
	db.prepare(`INSERT OR IGNORE INTO share_operation_steps(
		operation_id, step_key, effect_id, status, attempt_count, updated_at
	) VALUES (?, ?, ?, 'pending', 0, ?)`).run(operationId, stepKey, effectId, now);
}

function stepStatus(db: Database, operationId: string, stepKey: string): string | null {
	return (
		(db
			.prepare("SELECT status FROM share_operation_steps WHERE operation_id = ? AND step_key = ?")
			.pluck()
			.get(operationId, stepKey) as string | undefined) ?? null
	);
}

function startStep(db: Database, operationId: string, stepKey: string, now: string): void {
	db.prepare(`UPDATE share_operation_steps SET status = 'running', attempt_count = attempt_count + 1,
		started_at = COALESCE(started_at, ?), last_attempt_at = ?, safe_error_code = NULL, updated_at = ?
		WHERE operation_id = ? AND step_key = ?`).run(now, now, now, operationId, stepKey);
}

function finishStep(db: Database, operationId: string, stepKey: string, now: string): void {
	db.prepare(`UPDATE share_operation_steps SET status = 'completed', completed_at = ?,
		last_attempt_at = ?, safe_error_code = NULL, updated_at = ?
		WHERE operation_id = ? AND step_key = ?`).run(now, now, now, operationId, stepKey);
}

function failStep(
	db: Database,
	operationId: string,
	stepKey: string,
	code: string,
	now: string,
): void {
	const failed = db
		.prepare(`UPDATE share_operation_steps SET
			status = CASE WHEN ? = 'waiting_for_device' OR attempt_count >= 3 THEN 'failed' ELSE 'pending' END,
			last_attempt_at = ?, safe_error_code = ?, updated_at = ?
			WHERE operation_id = ? AND step_key = ? RETURNING attempt_count`)
		.get(code, now, code, now, operationId, stepKey) as { attempt_count: number } | undefined;
	const state =
		code === "waiting_for_device"
			? "waiting_for_device"
			: Number(failed?.attempt_count ?? 0) >= 3
				? "needs_attention"
				: null;
	// Never overwrite a concurrent cancellation with a failure state — the
	// superseded operation must stay cancelled even when its in-flight step
	// fails afterwards.
	if (state) {
		db.prepare(
			"UPDATE share_operations SET state = ?, updated_at = ? WHERE operation_id = ? AND state != 'cancelled'",
		).run(state, now, operationId);
	} else {
		db.prepare("UPDATE share_operations SET updated_at = ? WHERE operation_id = ?").run(
			now,
			operationId,
		);
	}
}

function persistedEffectId(
	db: Database,
	operationId: string,
	stepKey: string,
	fallback: string,
): string {
	return (
		clean(
			db
				.prepare(
					"SELECT effect_id FROM share_operation_steps WHERE operation_id = ? AND step_key = ?",
				)
				.pluck()
				.get(operationId, stepKey),
		) ?? fallback
	);
}

function capabilityPreflightEffectId(plan: ShareProvisioningPlan): string {
	const deviceSetDigest = createHash("sha256")
		.update(JSON.stringify(plan.requiredCapabilityDeviceIds))
		.digest("hex");
	return `capability:${plan.operationId}:${deviceSetDigest}`;
}

function reopenStepWhenEffectChanges(
	db: Database,
	operationId: string,
	stepKey: string,
	effectId: string,
): void {
	const now = new Date().toISOString();
	const reopened = db
		.prepare(`UPDATE share_operation_steps SET effect_id = ?, status = 'pending', attempt_count = 0,
		started_at = NULL, completed_at = NULL, last_attempt_at = NULL, safe_error_code = NULL,
		updated_at = ? WHERE operation_id = ? AND step_key = ? AND effect_id <> ?`)
		.run(effectId, now, operationId, stepKey, effectId);
	if (reopened.changes > 0) {
		db.prepare(`UPDATE share_operations SET state = 'accepted', updated_at = ?
			WHERE operation_id = ? AND state = 'needs_attention'`).run(now, operationId);
	}
}

async function runStep(
	db: Database,
	operationId: string,
	stepKey: string,
	effectId: string,
	work: () => Promise<void> | void,
): Promise<void> {
	const now = new Date().toISOString();
	ensureStep(db, operationId, stepKey, effectId, now);
	if (stepStatus(db, operationId, stepKey) === "completed") return;
	startStep(db, operationId, stepKey, now);
	try {
		await work();
		finishStep(db, operationId, stepKey, new Date().toISOString());
	} catch (error) {
		const code =
			clean(error instanceof Error ? error.message : String(error)) ?? "provisioning_failed";
		failStep(db, operationId, stepKey, code, new Date().toISOString());
		throw error;
	}
}

function localReassign(db: Database, memoryIds: number[], scopeId: string, deviceId: string): void {
	const now = new Date().toISOString();
	db.transaction(() => {
		for (const memoryId of memoryIds) {
			const row = db
				.prepare("SELECT scope_id, rev, metadata_json FROM memory_items WHERE id = ?")
				.get(memoryId) as
				| { scope_id: string | null; rev: number | null; metadata_json: string | null }
				| undefined;
			if (!row || clean(row.scope_id) === scopeId) continue;
			const metadata = fromJson(row.metadata_json);
			metadata.clock_device_id = deviceId;
			db.prepare(`UPDATE memory_items SET scope_id = ?, rev = COALESCE(rev, 0) + 1,
				updated_at = ?, metadata_json = ? WHERE id = ?`).run(
				scopeId,
				now,
				JSON.stringify(metadata),
				memoryId,
			);
			recordReplicationOp(db, { memoryId, opType: "upsert", deviceId, scopeId, createdAt: now });
		}
	})();
}

function assertCompatibleEffectiveMapping(
	project: ManagedProjectPlan,
	evidence: ProvisioningMappingEvidence,
): boolean {
	const resolution = resolveProjectScope({
		repositoryIdentity: project.canonicalIdentity,
		allowRepositoryCwdFallback: false,
		mappings: evidence.effectiveMappings,
	});
	if (resolution.mapping && resolution.scopeId !== project.boundaryId) {
		throw new Error("project_mapping_conflict");
	}
	return resolution.reason === "exact_mapping";
}

function exactMapping(db: Database, project: ManagedProjectPlan): void {
	if (assertCompatibleEffectiveMapping(project, loadProvisioningMappingEvidence(db))) return;
	const now = new Date().toISOString();
	db.prepare(`INSERT INTO project_scope_mappings(
		workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
	) VALUES (?, ?, ?, 1000, 'share_operation', ?, ?)`).run(
		project.canonicalIdentity,
		project.canonicalIdentity,
		project.boundaryId,
		now,
		now,
	);
}

async function executeShareProvisioningWithStableMappings(
	db: Database,
	input: { operationId: string; initiatingDeviceId: string },
	dependencies: ShareProvisioningDependencies,
): Promise<ShareProvisioningPlan & { superseded: boolean }> {
	const plan = planShareProvisioning(db, input);
	const executeStep = (
		stepKey: string,
		effectId: string,
		work: () => Promise<void> | void,
	): Promise<void> =>
		runStep(
			db,
			plan.operationId,
			stepKey,
			persistedEffectId(db, plan.operationId, stepKey, effectId),
			async () => {
				await dependencies.beforeStep?.(stepKey);
				await work();
			},
		);
	const capabilityEffectId = capabilityPreflightEffectId(plan);
	reopenStepWhenEffectChanges(db, plan.operationId, "capability_preflight", capabilityEffectId);
	await runStep(db, plan.operationId, "capability_preflight", capabilityEffectId, async () => {
		await dependencies.beforeStep?.("capability_preflight");
		for (const deviceId of plan.requiredCapabilityDeviceIds) {
			const capability = await dependencies.supportsReassignScope(deviceId);
			if (capability === "unsupported") throw new Error("reassign_capability_required");
			if (capability === "undetermined") throw new Error("waiting_for_device");
		}
	});
	persistMembershipPlan(db, plan);
	// Every state transition in this flow is guarded against 'cancelled' so a
	// concurrently superseded operation can never overwrite its cancellation
	// while this invocation is between async steps.
	db.prepare(
		"UPDATE share_operations SET state = 'provisioning', updated_at = ? WHERE operation_id = ? AND state != 'cancelled'",
	).run(new Date().toISOString(), plan.operationId);
	for (const project of plan.projects) {
		const stepIdentity = provisioningStepIdentity(project);
		await executeStep(`managed_boundary:${stepIdentity}`, project.boundaryId, async () => {
			const scope = await dependencies.createOrGetBoundary(project, plan.groupId);
			if (
				scope.scope_id !== project.boundaryId ||
				scope.group_id !== plan.groupId ||
				scope.kind !== "managed_project" ||
				scope.authority_type !== "coordinator" ||
				scope.status !== "active"
			) {
				throw new Error("managed_boundary_conflict");
			}
		});
		for (const deviceId of project.memberDeviceIds) {
			const stepKey = `space_grant:${stepIdentity}:${deviceId}`;
			const expectedRole = deviceId === input.initiatingDeviceId ? "admin" : "member";
			const effectId = persistedEffectId(
				db,
				plan.operationId,
				stepKey,
				`space-grant:${project.boundaryId}:${deviceId}:1`,
			);
			await executeStep(stepKey, effectId, async () => {
				assertLegacyShareGrantForProject(db, project, deviceId);
				const membership = await dependencies.grantMembership({
					effectId,
					groupId: plan.groupId,
					scopeId: project.boundaryId,
					deviceId,
					role: expectedRole,
				});
				if (
					membership.scope_id !== project.boundaryId ||
					membership.device_id !== deviceId ||
					membership.role !== expectedRole ||
					membership.status !== "active"
				) {
					throw new Error("managed_grant_conflict");
				}
			});
		}
		await executeStep(
			`memory_reassignment:${stepIdentity}`,
			`memory-reassignment:${plan.operationId}:${stepIdentity}`,
			() => {
				localReassign(db, project.localOnlyMemoryIds, project.boundaryId, input.initiatingDeviceId);
				for (const memoryId of project.reassignedMemoryIds) {
					const oldScopeId =
						clean(
							db.prepare("SELECT scope_id FROM memory_items WHERE id = ?").pluck().get(memoryId) as
								| string
								| null,
						) ?? "local-default";
					if (oldScopeId === project.boundaryId) continue;
					recordScopeReassignment(db, {
						operationId: plan.operationId,
						memoryId,
						oldScopeId,
						newScopeId: project.boundaryId,
						deviceId: input.initiatingDeviceId,
					});
				}
			},
		);
		await executeStep(`project_assignment:${stepIdentity}`, project.boundaryId, () =>
			exactMapping(db, project),
		);
	}
	await executeStep("authorization_refresh", `refresh:${plan.operationId}`, () =>
		dependencies.refreshAuthorization(plan.groupId),
	);
	db.prepare(
		"UPDATE share_operations SET state = 'initial_sync', updated_at = ? WHERE operation_id = ? AND state != 'cancelled'",
	).run(new Date().toISOString(), plan.operationId);
	await executeStep("initial_sync", `initial-sync:${plan.operationId}`, async () => {
		const result = await dependencies.runInitialSync(plan.recipientDeviceId);
		if (!result.ok && result.failureCategory === "connectivity") {
			throw new Error("waiting_for_device");
		}
		for (const project of plan.projects) {
			const scoped = result.perScopeResults?.find((item) => item.scope_id === project.boundaryId);
			if (!scoped?.ok) throw new Error(scoped?.error || "initial_sync_scope_incomplete");
		}
	});
	const activatedAt = new Date().toISOString();
	// The state guard keeps a concurrently superseded (cancelled) duplicate from
	// resurrecting itself to active after its own initial sync resolves. Only an
	// invocation whose row actually transitioned to active may supersede others;
	// a cancelled invocation finishing late has no authority to cancel anything.
	const activation = db
		.prepare(
			"UPDATE share_operations SET state = 'active', updated_at = ? WHERE operation_id = ? AND state != 'cancelled'",
		)
		.run(activatedAt, plan.operationId);
	if (activation.changes > 0) {
		cancelSupersededShareOperations(db, plan.operationId, activatedAt);
	}
	// superseded: a duplicate won the race and cancelled this operation while it
	// was in flight. Callers must not report it as active.
	return { ...plan, superseded: activation.changes === 0 };
}

export function executeShareProvisioning(
	db: Database,
	input: { operationId: string; initiatingDeviceId: string },
	dependencies: ShareProvisioningDependencies,
): Promise<ShareProvisioningPlan & { superseded: boolean }> {
	return serializeRecipientPolicyPublicationMutation(db, () =>
		executeShareProvisioningWithStableMappings(db, input, dependencies),
	);
}

/**
 * When a redone invite flow reaches active, older accepted-but-unfinished
 * duplicates for the same recipient device and exact project set become
 * zombies that report misleading states like "waiting for device". Cancel them
 * so only the active operation represents the share.
 *
 * A duplicate must match the coordinator group (managed boundaries and
 * memberships are group-specific), the reviewed inviter-device set (different
 * sets are different provisioning intents), the recipient_device_id (the same
 * person accepting the same project set on a different device is a legitimate
 * in-flight share), and the exact project set. Operations in needs_attention
 * are deliberately excluded — a user may still want to inspect or retry them
 * explicitly.
 */
function cancelSupersededShareOperations(db: Database, operationId: string, now: string): void {
	const active = db
		.prepare(
			`SELECT inviter_actor_id, inviter_device_ids_json, person_id, recipient_actor_id,
				recipient_device_id, coordinator_group_id
			 FROM share_operations WHERE operation_id = ?`,
		)
		.get(operationId) as
		| {
				inviter_actor_id: string;
				inviter_device_ids_json: string;
				person_id: string;
				recipient_actor_id: string | null;
				recipient_device_id: string | null;
				coordinator_group_id: string;
		  }
		| undefined;
	if (!active?.recipient_device_id) return;
	const projectSet = (id: string): string =>
		(
			db
				.prepare(
					`SELECT canonical_project_identity FROM share_operation_projects
					 WHERE operation_id = ? ORDER BY canonical_project_identity`,
				)
				.all(id) as Array<{ canonical_project_identity: string }>
		)
			.map((row) => row.canonical_project_identity)
			.join("\u0000");
	const activeProjects = projectSet(operationId);
	const candidates = db
		.prepare(
			`SELECT operation_id FROM share_operations
			 WHERE operation_id != ? AND inviter_actor_id = ?
			   AND state IN ('accepted', 'provisioning', 'initial_sync', 'waiting_for_device')
			   AND coordinator_group_id = ?
			   AND inviter_device_ids_json = ?
			   AND recipient_device_id = ?
			   AND (person_id = ? OR (recipient_actor_id IS NOT NULL AND recipient_actor_id = ?))`,
		)
		.all(
			operationId,
			active.inviter_actor_id,
			active.coordinator_group_id,
			active.inviter_device_ids_json,
			active.recipient_device_id,
			active.person_id,
			active.recipient_actor_id ?? active.person_id,
		) as Array<{ operation_id: string }>;
	// Re-check the candidate state at write time: a concurrent provisioning
	// process may have activated this candidate between selection and update,
	// and a successfully activated operation must never be overwritten.
	const cancel = db.prepare(
		`UPDATE share_operations SET state = 'cancelled', updated_at = ?
		 WHERE operation_id = ?
		   AND state IN ('accepted', 'provisioning', 'initial_sync', 'waiting_for_device')`,
	);
	for (const row of candidates) {
		if (projectSet(row.operation_id) !== activeProjects) continue;
		cancel.run(now, row.operation_id);
	}
}
