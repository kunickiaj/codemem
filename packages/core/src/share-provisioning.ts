import { createHash } from "node:crypto";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import { type Database, fromJson } from "./db.js";
import { assertLegacyShareGrantAllowed } from "./recipient-policy-reconciler.js";
import { canonicalWorkspaceIdentity } from "./scope-resolution.js";
import {
	DEFAULT_SYNC_SCOPE_ID,
	recordReplicationOp,
	recordScopeReassignment,
	syncProjectAllowed,
	syncProjectAllowedByFilters,
} from "./sync-replication.js";

export interface ManagedProjectPlan {
	canonicalIdentity: string;
	displayName: string;
	boundaryId: string;
	memoryIds: number[];
	localOnlyMemoryIds: number[];
	reassignedMemoryIds: number[];
	memberDeviceIds: string[];
	reassignmentSourceDeviceIds: string[];
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
			mi.workspace_id, s.user AS session_user, s.tool_version AS session_tool_version
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

export function countShareableProjectMemories(
	db: Database,
	input: { canonicalIdentity: string; initiatingDeviceId: string },
): number {
	return memoryCandidates(db).filter((row) => {
		if (!shareableForManagedProject(row)) return false;
		if (!isInitiatingDeviceMemory(row, input.initiatingDeviceId)) return false;
		return (
			canonicalWorkspaceIdentity({
				gitRemote: row.git_remote,
				gitBranch: row.git_branch,
				cwd: row.cwd,
				project: row.project,
				workspaceId: row.workspace_id,
			}).value === input.canonicalIdentity
		);
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

export function planShareProvisioning(
	db: Database,
	input: { operationId: string; initiatingDeviceId: string },
): ShareProvisioningPlan {
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
	if (!recipientDeviceId || !initiatingDeviceId)
		throw new Error("operation_device_binding_missing");
	const inviterDeviceIds = parseStringList(operation.inviter_device_ids_json);
	if (!inviterDeviceIds.includes(initiatingDeviceId))
		throw new Error("initiating_device_not_reviewed");
	const projects = db
		.prepare(`SELECT canonical_project_identity, display_name FROM share_operation_projects
		 WHERE operation_id = ? ORDER BY ordinal`)
		.all(operation.operation_id) as ProjectRow[];
	if (projects.length === 0) throw new Error("operation_intent_invalid");
	const candidates = memoryCandidates(db);
	const plans = projects.map((project): ManagedProjectPlan => {
		const matched = candidates.filter((row) => {
			if (!shareableForManagedProject(row)) return false;
			if (!isInitiatingDeviceMemory(row, initiatingDeviceId)) return false;
			const identity = canonicalWorkspaceIdentity({
				gitRemote: row.git_remote,
				gitBranch: row.git_branch,
				cwd: row.cwd,
				project: row.project,
				workspaceId: row.workspace_id,
			});
			return identity.value === project.canonical_project_identity;
		});
		const sourceScopeIds = [
			...new Set(matched.map((row) => clean(row.scope_id) ?? "local-default")),
		].toSorted();
		const projectNames = [
			...new Set(
				matched.map((row) => clean(row.project)).filter((item): item is string => item != null),
			),
		].toSorted();
		const persistedMembers = persistedProjectMembers(
			db,
			operation.operation_id,
			project.canonical_project_identity,
		);
		const persistedMembersNeedValidation = persistedMembers.some(
			(deviceId) =>
				stepStatus(
					db,
					operation.operation_id,
					`space_grant:${project.canonical_project_identity}:${deviceId}`,
				) !== "completed",
		);
		const currentMemberDeviceIds =
			persistedMembers.length === 0 || persistedMembersNeedValidation
				? [
						...effectiveInviterDevices(db, {
							initiatingDeviceId,
							inviterDeviceIds,
							sourceScopeIds,
							projectNames,
						}),
						recipientDeviceId,
					]
				: persistedMembers;
		if (
			persistedMembers.length > 0 &&
			persistedMembers.some((deviceId) => !currentMemberDeviceIds.includes(deviceId))
		) {
			throw new Error("inviter_project_access_ambiguous");
		}
		const memberDeviceIds = persistedMembers.length > 0 ? persistedMembers : currentMemberDeviceIds;
		if (
			!memberDeviceIds.includes(initiatingDeviceId) ||
			!memberDeviceIds.includes(recipientDeviceId)
		) {
			throw new Error("provisioning_membership_plan_invalid");
		}
		if (
			memberDeviceIds.some(
				(deviceId) => deviceId !== recipientDeviceId && !inviterDeviceIds.includes(deviceId),
			)
		) {
			throw new Error("provisioning_membership_plan_invalid");
		}
		const boundaryId = db
			.prepare(`SELECT effect_id FROM share_operation_steps
				WHERE operation_id = ? AND step_key = ?`)
			.pluck()
			.get(
				operation.operation_id,
				`managed_boundary:${project.canonical_project_identity}`,
			) as string;
		const localOnlyRows = matched.filter((row) => neverReplicationEligible(db, row));
		const reassignedRows = matched.filter((row) => !neverReplicationEligible(db, row));
		const reassignmentScopeIds = [
			...new Set(
				reassignedRows
					.map((row) => clean(row.scope_id) ?? DEFAULT_SYNC_SCOPE_ID)
					.filter((scopeId) => scopeId !== boundaryId),
			),
		];
		const legacyDefaultProjects = reassignedRows
			.filter(
				(row) =>
					(clean(row.scope_id) ?? DEFAULT_SYNC_SCOPE_ID) === DEFAULT_SYNC_SCOPE_ID &&
					DEFAULT_SYNC_SCOPE_ID !== boundaryId,
			)
			.map((row) => clean(row.project));
		const reassignmentSourceDeviceIds = [
			...new Set([
				...activeScopeMemberDeviceIds(
					db,
					reassignmentScopeIds.filter((scopeId) => scopeId !== DEFAULT_SYNC_SCOPE_ID),
				),
				...projectAllowedPeerDeviceIds(db, legacyDefaultProjects),
			]),
		].toSorted();
		return {
			canonicalIdentity: project.canonical_project_identity,
			displayName: project.display_name,
			boundaryId,
			memoryIds: matched.map((row) => row.id).toSorted((a, b) => a - b),
			localOnlyMemoryIds: localOnlyRows.map((row) => row.id).toSorted((a, b) => a - b),
			reassignedMemoryIds: reassignedRows.map((row) => row.id).toSorted((a, b) => a - b),
			memberDeviceIds: [...new Set(memberDeviceIds)].toSorted(),
			reassignmentSourceDeviceIds,
		};
	});
	if (plans.some((project) => !clean(project.boundaryId)))
		throw new Error("managed_boundary_plan_missing");
	return {
		operationId: operation.operation_id,
		groupId: operation.coordinator_group_id,
		recipientDeviceId,
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
			for (const deviceId of project.memberDeviceIds) {
				const stepKey = `provisioning_member:${project.canonicalIdentity}:${deviceId}`;
				const effectId = `provisioning-member:${plan.operationId}:${project.canonicalIdentity}:${deviceId}`;
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
	if (state) {
		db.prepare("UPDATE share_operations SET state = ?, updated_at = ? WHERE operation_id = ?").run(
			state,
			now,
			operationId,
		);
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

function exactMapping(db: Database, project: ManagedProjectPlan): void {
	const existing = db
		.prepare(`SELECT id, scope_id FROM project_scope_mappings
		 WHERE workspace_identity = ? ORDER BY priority DESC, updated_at DESC, id DESC LIMIT 1`)
		.get(project.canonicalIdentity) as { id: number; scope_id: string } | undefined;
	if (existing && existing.scope_id !== project.boundaryId)
		throw new Error("project_mapping_conflict");
	if (existing) return;
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

export async function executeShareProvisioning(
	db: Database,
	input: { operationId: string; initiatingDeviceId: string },
	dependencies: ShareProvisioningDependencies,
): Promise<ShareProvisioningPlan> {
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
	db.prepare(
		"UPDATE share_operations SET state = 'provisioning', updated_at = ? WHERE operation_id = ?",
	).run(new Date().toISOString(), plan.operationId);
	for (const project of plan.projects) {
		await executeStep(
			`managed_boundary:${project.canonicalIdentity}`,
			project.boundaryId,
			async () => {
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
			},
		);
		for (const deviceId of project.memberDeviceIds) {
			const stepKey = `space_grant:${project.canonicalIdentity}:${deviceId}`;
			const expectedRole = deviceId === input.initiatingDeviceId ? "admin" : "member";
			const effectId = persistedEffectId(
				db,
				plan.operationId,
				stepKey,
				`space-grant:${project.boundaryId}:${deviceId}:1`,
			);
			await executeStep(stepKey, effectId, async () => {
				assertLegacyShareGrantAllowed(db, {
					canonicalProjectIdentity: project.canonicalIdentity,
					deviceId,
				});
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
			`memory_reassignment:${project.canonicalIdentity}`,
			`memory-reassignment:${plan.operationId}:${project.canonicalIdentity}`,
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
		await executeStep(`project_assignment:${project.canonicalIdentity}`, project.boundaryId, () =>
			exactMapping(db, project),
		);
	}
	await executeStep("authorization_refresh", `refresh:${plan.operationId}`, () =>
		dependencies.refreshAuthorization(plan.groupId),
	);
	db.prepare(
		"UPDATE share_operations SET state = 'initial_sync', updated_at = ? WHERE operation_id = ?",
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
	db.prepare(
		"UPDATE share_operations SET state = 'active', updated_at = ? WHERE operation_id = ?",
	).run(new Date().toISOString(), plan.operationId);
	return plan;
}
