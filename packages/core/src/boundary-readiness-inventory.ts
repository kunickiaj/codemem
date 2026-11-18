import {
	type BoundaryReadinessProject,
	type BoundaryReadinessProjectState,
	fitBoundaryReadinessProjects,
} from "./coordinator-boundary-readiness.js";
import type { Database } from "./db.js";
import { managedProjectScopeId } from "./managed-project-scope.js";
import {
	canonicalRepositoryProjectIdentity,
	normalizeRepositoryWorkspaceIdentity,
	readRepositoryIdentitySnapshot,
	repositoryIdentitiesByWorkspace,
	repositoryIdentityForWorkspace,
	withRepositoryMappingAliasesFromIdentities,
} from "./repository-mapping-aliases.js";
import { resolveProjectScope, type ScopeMapping } from "./scope-resolution.js";
import { SYNC_BOOTSTRAP_CWD_PREFIX } from "./sync-bootstrap-constants.js";
import { buildBaseUrl } from "./sync-http-client.js";
import { canonicalWorkspaceIdentity, type WorkspaceIdentityInput } from "./workspace-identity.js";

/** Local adoption state, supplied by the caller that records adoption or rollback. */
export interface BoundaryReadinessObservation {
	sourceScopeId: string;
	boundaryScopeId: string;
	state: BoundaryReadinessProjectState;
}

export interface BoundaryReadinessInventoryInput {
	coordinatorId: string;
	groupId: string;
	deviceId: string;
	observations?: readonly BoundaryReadinessObservation[];
}

interface ProjectRow {
	cwd: string | null;
	git_remote: string | null;
	git_branch: string | null;
	project: string | null;
	metadata_json: string | null;
	workspace_id?: string | null;
}

interface CountRow extends ProjectRow {
	scope_id: string;
	own_rows: number;
}

interface Inventory {
	groupId: string;
	sourceIds: Set<string>;
	mappings: ScopeMapping[];
	repositories: ReadonlyMap<string, string>;
	ambiguousWorkspaces: Set<string>;
	observations: ReadonlyMap<string, readonly BoundaryReadinessObservation[]>;
	projects: Map<string, BoundaryReadinessProject>;
	boundaryRows: Map<string, number>;
}

const LOCAL_SESSIONS_SQL = `COALESCE(s.user, '') <> 'sync'
	AND COALESCE(s.tool_version, '') <> 'sync_replication'
	AND substr(COALESCE(s.cwd, ''), 1, ?) <> ?`;

function observationsByBoundary(observations: readonly BoundaryReadinessObservation[]) {
	const result = new Map<string, BoundaryReadinessObservation[]>();
	for (const observation of observations) {
		const entries = result.get(observation.boundaryScopeId) ?? [];
		const previous = entries.find((entry) => entry.sourceScopeId === observation.sourceScopeId);
		if (previous && previous.state !== observation.state) {
			throw new Error("boundary_readiness_observation_conflict");
		}
		if (!previous) entries.push(observation);
		result.set(observation.boundaryScopeId, entries);
	}
	return result;
}

function sourceScopeIds(db: Database, input: BoundaryReadinessInventoryInput): Set<string> {
	const rows = db
		.prepare(
			`SELECT scope_id FROM replication_scopes
		 WHERE authority_type = 'coordinator' AND coordinator_id = ? AND group_id = ?
		 AND kind <> 'managed_project'
		 AND scope_id NOT LIKE 'managed-project:%' AND scope_id NOT LIKE 'personal:%'
		 AND scope_id NOT IN ('local-default', 'legacy-shared-review')`,
		)
		.pluck()
		.all(buildBaseUrl(input.coordinatorId), input.groupId) as string[];
	// Archived scopes still describe where local data sits. Admission and commit
	// use current coordinator authorization, not this cached status.
	return new Set(rows);
}

function readInventory(db: Database, input: BoundaryReadinessInventoryInput): Inventory {
	const snapshot = readRepositoryIdentitySnapshot(db);
	// Only recorded evidence is used. An inventory must not probe checkouts or
	// infer an identity from the filesystem changing underneath the stored data.
	const repositories = repositoryIdentitiesByWorkspace(db, {
		repositoryIdentitySnapshot: { ...snapshot, workspaces: [] },
	});
	const mappings = db
		.prepare(
			`SELECT id, workspace_identity, project_pattern, scope_id, priority, source, updated_at
		 FROM project_scope_mappings ORDER BY id`,
		)
		.all() as ScopeMapping[];
	return {
		groupId: input.groupId,
		sourceIds: sourceScopeIds(db, input),
		mappings: withRepositoryMappingAliasesFromIdentities(mappings, repositories),
		repositories,
		ambiguousWorkspaces: new Set(
			[...snapshot.recordedByWorkspace]
				.filter(([, identities]) => identities.size > 1)
				.map(([cwd]) => cwd),
		),
		observations: observationsByBoundary(input.observations ?? []),
		projects: new Map(),
		boundaryRows: new Map(),
	};
}

function projectInput(row: ProjectRow, inventory: Inventory): WorkspaceIdentityInput {
	return {
		repositoryIdentity: repositoryIdentityForWorkspace(inventory.repositories, {
			cwd: row.cwd,
			gitRemote: row.git_remote,
			metadataJson: row.metadata_json,
		}),
		gitRemote: row.git_remote,
		gitBranch: row.git_branch,
		cwd: row.cwd,
		project: row.project,
		workspaceId: row.workspace_id,
	};
}

function projectEntry(inventory: Inventory, identity: string, sourceId: string) {
	const boundaryId = managedProjectScopeId(inventory.groupId, identity);
	const key = JSON.stringify([sourceId, boundaryId]);
	let entry = inventory.projects.get(key);
	if (!entry) {
		entry = {
			source_scope_id: sourceId,
			boundary_scope_id: boundaryId,
			state: "waiting",
			own_rows_in_source: 0,
			own_rows_in_boundary: 0,
		};
		inventory.projects.set(key, entry);
	}
	return entry;
}

function addMappedProject(inventory: Inventory, input: WorkspaceIdentityInput): void {
	const identity = canonicalWorkspaceIdentity(input);
	if (identity.source === "unmapped") return;
	const scopeId = resolveProjectScope({ ...input, mappings: inventory.mappings }).scopeId;
	if (inventory.sourceIds.has(scopeId)) projectEntry(inventory, identity.value, scopeId);
	applyLocalObservations(inventory, identity.value);
}

function applyLocalObservations(inventory: Inventory, identity: string): void {
	const boundaryId = managedProjectScopeId(inventory.groupId, identity);
	for (const observation of inventory.observations.get(boundaryId) ?? []) {
		if (!inventory.sourceIds.has(observation.sourceScopeId)) continue;
		projectEntry(inventory, identity, observation.sourceScopeId).state = observation.state;
	}
}

function collectMappedProjects(db: Database, inventory: Inventory): void {
	const sessions = db
		.prepare(
			`SELECT s.cwd, s.git_remote, s.git_branch, s.project, s.metadata_json
		 FROM sessions s WHERE ${LOCAL_SESSIONS_SQL}`,
		)
		.all(SYNC_BOOTSTRAP_CWD_PREFIX.length, SYNC_BOOTSTRAP_CWD_PREFIX) as ProjectRow[];
	for (const row of sessions) addMappedProject(inventory, projectInput(row, inventory));
	for (const mapping of inventory.mappings) {
		const workspace = mapping.workspace_identity?.trim();
		if (!workspace) continue;
		addMappedProject(inventory, {
			repositoryIdentity: canonicalRepositoryProjectIdentity(inventory.repositories, workspace),
			cwd: workspace.startsWith("/") ? workspace : null,
		});
	}
}

function ownRows(db: Database, deviceId: string): CountRow[] {
	return db
		.prepare(
			`SELECT s.cwd, s.git_remote, s.git_branch, COALESCE(mi.project, s.project) AS project,
		 s.metadata_json, mi.workspace_id, mi.scope_id, COUNT(*) AS own_rows
		 FROM memory_items mi JOIN sessions s ON s.id = mi.session_id
		 WHERE mi.active = 1 AND mi.deleted_at IS NULL AND mi.scope_id IS NOT NULL
		 AND COALESCE(mi.origin_device_id, '') IN ('', 'local', ?)
		 AND ${LOCAL_SESSIONS_SQL}
		 GROUP BY s.id, mi.scope_id, mi.workspace_id, COALESCE(mi.project, s.project)`,
		)
		.all(deviceId, SYNC_BOOTSTRAP_CWD_PREFIX.length, SYNC_BOOTSTRAP_CWD_PREFIX) as CountRow[];
}

function ownRowIdentity(row: CountRow, inventory: Inventory): string | null {
	const identity = canonicalWorkspaceIdentity(projectInput(row, inventory));
	const cwd = normalizeRepositoryWorkspaceIdentity(row.cwd);
	const ambiguous = identity.source === "cwd" && cwd && inventory.ambiguousWorkspaces.has(cwd);
	if (identity.source === "unmapped" || ambiguous) {
		if (inventory.sourceIds.has(row.scope_id)) {
			throw new Error("boundary_readiness_identity_unavailable");
		}
		return null;
	}
	return identity.value;
}

function countOwnRows(db: Database, inventory: Inventory, deviceId: string): void {
	for (const row of ownRows(db, deviceId)) {
		const inSource = inventory.sourceIds.has(row.scope_id);
		if (!inSource && !row.scope_id.startsWith("managed-project:")) continue;
		const identity = ownRowIdentity(row, inventory);
		if (!identity) continue;
		applyLocalObservations(inventory, identity);
		const boundaryId = managedProjectScopeId(inventory.groupId, identity);
		if (inSource)
			projectEntry(inventory, identity, row.scope_id).own_rows_in_source += row.own_rows;
		if (row.scope_id === boundaryId) {
			inventory.boundaryRows.set(
				boundaryId,
				(inventory.boundaryRows.get(boundaryId) ?? 0) + row.own_rows,
			);
		}
	}
}

/**
 * Builds one group's record data from a consistent read snapshot. It changes
 * nothing, creates no identity or schema, and sends no request.
 *
 * Source-row identity failures throw instead of returning a complete-looking
 * list. The future sender must discard its old record on this failure.
 */
export function buildBoundaryReadinessInventory(
	db: Database,
	input: BoundaryReadinessInventoryInput,
): { projects: BoundaryReadinessProject[]; omittedProjects: number } {
	if (!input.coordinatorId.trim() || !input.groupId.trim() || !input.deviceId.trim()) {
		throw new Error("boundary_readiness_inventory_invalid");
	}
	return db
		.transaction(() => {
			const inventory = readInventory(db, input);
			collectMappedProjects(db, inventory);
			countOwnRows(db, inventory, input.deviceId);
			const projects = [...inventory.projects.values()]
				.map((project) => ({
					...project,
					own_rows_in_boundary: inventory.boundaryRows.get(project.boundary_scope_id) ?? 0,
				}))
				.toSorted(
					(left, right) =>
						left.boundary_scope_id.localeCompare(right.boundary_scope_id) ||
						left.source_scope_id.localeCompare(right.source_scope_id),
				);
			return fitBoundaryReadinessProjects(projects);
		})
		.deferred();
}
