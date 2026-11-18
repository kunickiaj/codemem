import type { DeviceRemovalBackend } from "./coordinator-device-removal.js";
import type {
	CoordinatorScopeAuthorizationInput,
	CoordinatorScopeAuthorizationResult,
} from "./coordinator-store-contract.js";

/*
 * Readiness records for moving each shared Project to its own boundary. A device
 * that runs the migration code keeps one record per group at the coordinator:
 * the Projects it holds under an older scope, and the boundary each one needs.
 * The coordinator keeps the last record a device sent. A later change reads the
 * records to decide whether every device of an older scope is ready before it
 * creates a boundary. A record grants nothing by itself.
 */

/**
 * `record_id` names the write that stored the header. The project rows of one
 * write are only replaced while the header still carries that write's ID, so two
 * writes for the same device cannot mix their rows. `omitted_projects` counts the
 * Projects a device could not fit into its record.
 */
export const BOUNDARY_READINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_boundary_readiness (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  omitted_projects INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (group_id, device_id)
);

CREATE TABLE IF NOT EXISTS coordinator_boundary_readiness_projects (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  boundary_scope_id TEXT NOT NULL,
  source_scope_id TEXT NOT NULL,
  state TEXT NOT NULL,
  own_rows_in_source INTEGER NOT NULL,
  own_rows_in_boundary INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id, boundary_scope_id, source_scope_id)
);

CREATE INDEX IF NOT EXISTS idx_coordinator_boundary_readiness_projects_boundary
  ON coordinator_boundary_readiness_projects(group_id, boundary_scope_id);
`;

export const BOUNDARY_READINESS_MIGRATION_NAME = "0050_add_boundary_readiness.sql";

/** `present` is 1 when migration 0050, or SQLite initialization, has installed the storage. */
export const BOUNDARY_READINESS_STORAGE_PRESENT_SQL = `SELECT (
	EXISTS (SELECT 1 FROM sqlite_master
		WHERE type = 'table' AND name = 'coordinator_boundary_readiness')
	AND EXISTS (SELECT 1 FROM sqlite_master
		WHERE type = 'table' AND name = 'coordinator_boundary_readiness_projects')
	AND EXISTS (SELECT 1 FROM sqlite_master
		WHERE type = 'index' AND name = 'idx_coordinator_boundary_readiness_projects_boundary')) AS present`;

export type BoundaryReadinessProjectState = "waiting" | "adopted" | "rolled_back";

const PROJECT_STATES: readonly BoundaryReadinessProjectState[] = [
	"waiting",
	"adopted",
	"rolled_back",
];

/** One Project of a readiness record. The boundary ID stands in for the Project, so no name is stored. */
export interface BoundaryReadinessProject {
	source_scope_id: string;
	boundary_scope_id: string;
	state: BoundaryReadinessProjectState;
	own_rows_in_source: number;
	own_rows_in_boundary: number;
}

export interface BoundaryReadinessRecord {
	group_id: string;
	device_id: string;
	sequence: number;
	/** Projects the device holds under an older scope and could not fit into this record. */
	omitted_projects: number;
	updated_at: string;
	projects: BoundaryReadinessProject[];
}

export interface PutBoundaryReadinessInput {
	groupId: string;
	deviceId: string;
	/** Rises with every change the device makes to its record. An older or equal one is not stored. */
	sequence: number;
	projects: readonly BoundaryReadinessProject[];
	/** How many more Projects the device has than `projects` lists. Defaults to none. */
	omittedProjects?: number;
}

export type BoundaryReadinessRejectionReason =
	| "boundary_scope_invalid"
	| "source_scope_not_authorized";

export interface BoundaryReadinessRejection {
	source_scope_id: string;
	boundary_scope_id: string;
	reason: BoundaryReadinessRejectionReason;
}

export type PutBoundaryReadinessResult =
	/** Stored with the entries the coordinator accepts. `rejected` lists the ones it left out. */
	| { kind: "stored"; sequence: number; rejected: BoundaryReadinessRejection[] }
	/** The stored record is as new or newer. `sequence` is the stored one. */
	| { kind: "stale"; sequence: number }
	/** The device has no enabled enrollment in the group. */
	| { kind: "not_enrolled" }
	/** The coordinator's database has no readiness storage yet. */
	| { kind: "unavailable" };

export interface BoundaryReadinessDeviceInput {
	groupId: string;
	deviceId: string;
}

export interface CoordinatorBoundaryReadinessStore {
	/** Replaces the device's record for the group when `sequence` is newer than the stored one. */
	putBoundaryReadiness(input: PutBoundaryReadinessInput): Promise<PutBoundaryReadinessResult>;
	getBoundaryReadiness(
		input: BoundaryReadinessDeviceInput,
	): Promise<BoundaryReadinessRecord | null>;
	/** Removes the device's record for the group. Returns whether one was stored. */
	discardBoundaryReadiness(input: BoundaryReadinessDeviceInput): Promise<boolean>;
}

/** Whether the device is an authorized member of the scope in this group right now. */
export type BoundaryReadinessScopeCheck = (input: {
	groupId: string;
	scopeId: string;
	deviceId: string;
}) => Promise<boolean>;

/** The check each store builds from its own scope authorization read. */
export function boundaryReadinessScopeCheck(store: {
	getScopeAuthorization(
		input: CoordinatorScopeAuthorizationInput,
	): Promise<CoordinatorScopeAuthorizationResult>;
}): BoundaryReadinessScopeCheck {
	return async ({ groupId, scopeId, deviceId }) => {
		const authorization = await store.getScopeAuthorization({ groupId, scopeId });
		return (
			authorization.kind === "authorized" &&
			authorization.members.some((member) => member.membership.device_id === deviceId)
		);
	};
}

/**
 * The size limit of one record: the UTF-8 bytes of its Projects as compact JSON,
 * in the field order of BoundaryReadinessProject. The limit is on bytes and on
 * nothing else, so the store and a request agree on what fits. That is about
 * 1,300 Projects with IDs of ordinary length.
 */
export const BOUNDARY_READINESS_MAX_PROJECTS_BYTES = 256 * 1024;

/**
 * The body limit of a request that carries one record: the Projects, and room
 * for the group ID, the sequence and the omitted count around them.
 */
export const BOUNDARY_READINESS_MAX_BODY_BYTES = BOUNDARY_READINESS_MAX_PROJECTS_BYTES + 4 * 1024;

const utf8 = new TextEncoder();
const projectsBytes = (projects: readonly BoundaryReadinessProject[]) =>
	utf8.encode(JSON.stringify(projects)).length;
const MANAGED_PROJECT_SCOPE_ID = /^managed-project:[0-9a-f]{64}$/u;

function isId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function captureProject(raw: BoundaryReadinessProject): BoundaryReadinessProject {
	if (
		!isId(raw?.source_scope_id) ||
		!isId(raw.boundary_scope_id) ||
		!PROJECT_STATES.includes(raw.state) ||
		!isCount(raw.own_rows_in_source) ||
		!isCount(raw.own_rows_in_boundary)
	) {
		throw new Error("invalid_input");
	}
	return {
		source_scope_id: raw.source_scope_id,
		boundary_scope_id: raw.boundary_scope_id,
		state: raw.state,
		own_rows_in_source: raw.own_rows_in_source,
		own_rows_in_boundary: raw.own_rows_in_boundary,
	};
}

/**
 * Cuts a device's Projects to the longest leading run that fits one record, and
 * counts the rest. A device lists the Projects that still wait first, so the
 * ones it leaves out reach a later record as the listed ones move.
 */
export function fitBoundaryReadinessProjects(projects: readonly BoundaryReadinessProject[]): {
	projects: BoundaryReadinessProject[];
	omittedProjects: number;
} {
	const fitted: BoundaryReadinessProject[] = [];
	// "[" and "]" around the entries, and one comma before every entry but the first.
	let bytes = 2;
	for (const project of projects.map(captureProject)) {
		const next = bytes + utf8.encode(JSON.stringify(project)).length + (fitted.length > 0 ? 1 : 0);
		if (next > BOUNDARY_READINESS_MAX_PROJECTS_BYTES) break;
		fitted.push(project);
		bytes = next;
	}
	return { projects: fitted, omittedProjects: projects.length - fitted.length };
}

const projectKey = (project: { boundary_scope_id: string; source_scope_id: string }) =>
	JSON.stringify([project.boundary_scope_id, project.source_scope_id]);

function captureDevice(raw: BoundaryReadinessDeviceInput): BoundaryReadinessDeviceInput {
	if (!isId(raw?.groupId) || !isId(raw.deviceId)) throw new Error("invalid_input");
	return { groupId: raw.groupId, deviceId: raw.deviceId };
}

function capturePut(raw: PutBoundaryReadinessInput): PutBoundaryReadinessInput {
	const device = captureDevice(raw);
	const omittedProjects = raw.omittedProjects ?? 0;
	if (
		!Number.isSafeInteger(raw.sequence) ||
		raw.sequence < 1 ||
		!isCount(omittedProjects) ||
		!Array.isArray(raw.projects)
	) {
		throw new Error("invalid_input");
	}
	const projects = raw.projects.map(captureProject);
	// One entry per Project and older scope. A repeat would make the stored record ambiguous.
	if (new Set(projects.map(projectKey)).size !== projects.length) throw new Error("invalid_input");
	if (projectsBytes(projects) > BOUNDARY_READINESS_MAX_PROJECTS_BYTES) {
		throw new Error("boundary_readiness_too_large");
	}
	return { ...device, sequence: raw.sequence, projects, omittedProjects };
}

// The header is written only for an enabled enrollment and only by a newer sequence.
const PUT_HEADER_SQL = `INSERT INTO coordinator_boundary_readiness
	(group_id, device_id, sequence, record_id, omitted_projects, updated_at)
	SELECT ?, ?, ?, ?, ?, ?
	WHERE EXISTS (SELECT 1 FROM enrolled_devices
		WHERE group_id = ? AND device_id = ? AND enabled = 1)
	ON CONFLICT(group_id, device_id) DO UPDATE SET
		sequence = excluded.sequence,
		record_id = excluded.record_id,
		omitted_projects = excluded.omitted_projects,
		updated_at = excluded.updated_at
	WHERE excluded.sequence > coordinator_boundary_readiness.sequence`;

const HEADER_HAS_RECORD_ID_SQL = `EXISTS (SELECT 1 FROM coordinator_boundary_readiness
	WHERE group_id = ? AND device_id = ? AND record_id = ?)`;

const CLEAR_PROJECTS_SQL = `DELETE FROM coordinator_boundary_readiness_projects
	WHERE group_id = ? AND device_id = ? AND ${HEADER_HAS_RECORD_ID_SQL}`;

const PUT_PROJECTS_SQL = `INSERT INTO coordinator_boundary_readiness_projects
	(group_id, device_id, boundary_scope_id, source_scope_id, state,
	 own_rows_in_source, own_rows_in_boundary)
	SELECT ?, ?,
		json_extract(entry.value, '$.boundary_scope_id'),
		json_extract(entry.value, '$.source_scope_id'),
		json_extract(entry.value, '$.state'),
		json_extract(entry.value, '$.own_rows_in_source'),
		json_extract(entry.value, '$.own_rows_in_boundary')
	FROM json_each(?) AS entry
	WHERE ${HEADER_HAS_RECORD_ID_SQL}`;

const READ_HEADER_SQL = `SELECT sequence, record_id, omitted_projects, updated_at
	FROM coordinator_boundary_readiness WHERE group_id = ? AND device_id = ?`;

const READ_ENROLLED_SQL = `SELECT COUNT(*) AS enrolled FROM enrolled_devices
	WHERE group_id = ? AND device_id = ? AND enabled = 1`;

const READ_PROJECTS_SQL = `SELECT source_scope_id, boundary_scope_id, state,
		own_rows_in_source, own_rows_in_boundary
	FROM coordinator_boundary_readiness_projects
	WHERE group_id = ? AND device_id = ?
	ORDER BY boundary_scope_id, source_scope_id`;

const DISCARD_PROJECTS_SQL = `DELETE FROM coordinator_boundary_readiness_projects
	WHERE group_id = ? AND device_id = ?`;

const DISCARD_HEADER_SQL = `DELETE FROM coordinator_boundary_readiness
	WHERE group_id = ? AND device_id = ?`;

interface HeaderRow {
	sequence: number;
	record_id: string;
	omitted_projects: number;
	updated_at: string;
}

function resultRows<T>(result: unknown): T[] {
	const rows = (result as { results?: unknown } | null)?.results;
	return Array.isArray(rows) ? (rows as T[]) : [];
}

function resultChanges(result: unknown): number {
	const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
	return typeof changes === "number" ? changes : 0;
}

/** Internal storage capability. The caller authenticates the device. */
export class BoundaryReadinessOperations implements CoordinatorBoundaryReadinessStore {
	constructor(
		private readonly backend: DeviceRemovalBackend,
		private readonly isAuthorizedInScope: BoundaryReadinessScopeCheck,
		private readonly clock: () => number = Date.now,
	) {}

	private async storagePresent(): Promise<boolean> {
		const result = await this.backend.all({
			sql: BOUNDARY_READINESS_STORAGE_PRESENT_SQL,
			values: [],
			read: true,
		});
		return resultRows<{ present: number }>(result)[0]?.present === 1;
	}

	/** Runs `work`, and returns `missing` when it failed because the storage is not installed. */
	private async whenStoragePresent<T>(work: () => Promise<T>, missing: T): Promise<T> {
		try {
			return await work();
		} catch (error) {
			if (await this.storagePresent()) throw error;
			return missing;
		}
	}

	/**
	 * Splits a record's entries into the ones the coordinator stores and the ones
	 * it leaves out. An entry is stored only for a boundary ID of the managed
	 * Project form and an older scope the device is authorized in right now.
	 */
	private async sortProjects(input: PutBoundaryReadinessInput) {
		const sourceScopeIds = [...new Set(input.projects.map((project) => project.source_scope_id))];
		const checks = await Promise.all(
			sourceScopeIds.map(async (scopeId) => ({
				scopeId,
				authorized: await this.isAuthorizedInScope({
					groupId: input.groupId,
					scopeId,
					deviceId: input.deviceId,
				}),
			})),
		);
		const authorizedScopeIds = new Set(
			checks.filter((check) => check.authorized).map((check) => check.scopeId),
		);
		const accepted: BoundaryReadinessProject[] = [];
		const rejected: BoundaryReadinessRejection[] = [];
		for (const project of input.projects) {
			let reason: BoundaryReadinessRejectionReason | null = null;
			if (!MANAGED_PROJECT_SCOPE_ID.test(project.boundary_scope_id)) {
				reason = "boundary_scope_invalid";
			} else if (!authorizedScopeIds.has(project.source_scope_id)) {
				reason = "source_scope_not_authorized";
			}
			if (!reason) accepted.push(project);
			else rejected.push({ ...projectScopeIds(project), reason });
		}
		return { accepted, rejected };
	}

	async putBoundaryReadiness(raw: PutBoundaryReadinessInput): Promise<PutBoundaryReadinessResult> {
		const input = capturePut(raw);
		return this.whenStoragePresent<PutBoundaryReadinessResult>(
			async () => {
				const { accepted, rejected } = await this.sortProjects(input);
				const recordId = globalThis.crypto.randomUUID();
				const device = [input.groupId, input.deviceId];
				const results = await this.backend.batch([
					{
						sql: PUT_HEADER_SQL,
						values: [
							...device,
							input.sequence,
							recordId,
							input.omittedProjects ?? 0,
							new Date(this.clock()).toISOString(),
							...device,
						],
					},
					{ sql: CLEAR_PROJECTS_SQL, values: [...device, ...device, recordId] },
					{
						sql: PUT_PROJECTS_SQL,
						values: [...device, JSON.stringify(accepted), ...device, recordId],
					},
					{ sql: READ_HEADER_SQL, values: device, read: true },
					{ sql: READ_ENROLLED_SQL, values: device, read: true },
				]);
				if (results.length !== 5) throw new Error("boundary_readiness_incomplete");
				const header = resultRows<HeaderRow>(results[3])[0];
				if (header?.record_id === recordId) {
					if (resultChanges(results[2]) !== accepted.length) {
						throw new Error("boundary_readiness_incomplete");
					}
					return { kind: "stored", sequence: header.sequence, rejected };
				}
				const enrolled = resultRows<{ enrolled: number }>(results[4])[0]?.enrolled ?? 0;
				if (enrolled === 0) return { kind: "not_enrolled" };
				if (!header) throw new Error("boundary_readiness_incomplete");
				return { kind: "stale", sequence: header.sequence };
			},
			{ kind: "unavailable" },
		);
	}

	async getBoundaryReadiness(
		raw: BoundaryReadinessDeviceInput,
	): Promise<BoundaryReadinessRecord | null> {
		const input = captureDevice(raw);
		const device = [input.groupId, input.deviceId];
		return this.whenStoragePresent(async () => {
			const results = await this.backend.batch([
				{ sql: READ_HEADER_SQL, values: device, read: true },
				{ sql: READ_PROJECTS_SQL, values: device, read: true },
			]);
			const header = resultRows<HeaderRow>(results[0])[0];
			if (!header) return null;
			return {
				group_id: input.groupId,
				device_id: input.deviceId,
				sequence: header.sequence,
				omitted_projects: header.omitted_projects,
				updated_at: header.updated_at,
				projects: resultRows<BoundaryReadinessProject>(results[1]),
			};
		}, null);
	}

	async discardBoundaryReadiness(raw: BoundaryReadinessDeviceInput): Promise<boolean> {
		const input = captureDevice(raw);
		const device = [input.groupId, input.deviceId];
		return this.whenStoragePresent(async () => {
			const results = await this.backend.batch([
				{ sql: DISCARD_PROJECTS_SQL, values: device },
				{ sql: DISCARD_HEADER_SQL, values: device },
			]);
			if (results.length !== 2) throw new Error("boundary_readiness_incomplete");
			return resultChanges(results[1]) > 0;
		}, false);
	}
}

function projectScopeIds(project: BoundaryReadinessProject) {
	return {
		source_scope_id: project.source_scope_id,
		boundary_scope_id: project.boundary_scope_id,
	};
}
