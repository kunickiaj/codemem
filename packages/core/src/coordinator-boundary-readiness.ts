import type { DeviceRemovalBackend } from "./coordinator-device-removal.js";
import {
	bindAcceptedRecord,
	currentBinding,
	type ReadinessBinding,
	type ReadinessPreparation,
	signerCondition,
	validReadinessBinding,
} from "./coordinator-readiness-binding.js";
import type {
	CoordinatorScopeAuthorizationInput,
	CoordinatorScopeAuthorizationResult,
	CoordinatorScopeMembership,
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
 * writes for the same device cannot mix their rows.
 *
 * Three header columns say what the record does not show. `omitted_projects`
 * counts the Projects the device could not fit. `invalid_boundary_entries` counts
 * entries left out for a malformed boundary ID. `unauthorized_source_scope_ids_json`
 * lists the older scopes the record named and the device was not authorized in
 * when it arrived. None has a default, so a writer cannot leave one out and
 * produce a record that looks complete.
 */
export const BOUNDARY_READINESS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_boundary_readiness (
  group_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  record_id TEXT NOT NULL,
  omitted_projects INTEGER NOT NULL,
  invalid_boundary_entries INTEGER NOT NULL,
  unauthorized_source_scope_ids_json TEXT NOT NULL,
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
	/** Entries left out because the boundary ID is malformed. A correct build sends none. */
	invalid_boundary_entries: number;
	/**
	 * Older scopes the record named and the device was not authorized in when it
	 * arrived. If the device is authorized in one of them later, this record no
	 * longer shows everything the device holds there.
	 */
	unauthorized_source_scope_ids: string[];
	/**
	 * False when the record leaves out Projects the device holds: it was cut to
	 * fit, or an entry was malformed. A record that is not complete proves that
	 * the device runs the migration code and nothing about what it holds, so it
	 * must never be read as "the device does not hold the Projects it left out".
	 */
	complete: boolean;
	updated_at: string;
	projects: BoundaryReadinessProject[];
}

export interface PutBoundaryReadinessInput {
	/** Only supplied by the v2 verifier, never copied directly from JSON. */
	binding?: ReadinessBinding;
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
	| { kind: "binding_mismatch" }
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
	getVerifiedBoundaryReadiness(
		input: ReadinessPreparation & { deviceId: string },
	): Promise<VerifiedBoundaryReadiness | null>;
	/** Replaces the device's record for the group when `sequence` is newer than the stored one. */
	putBoundaryReadiness(input: PutBoundaryReadinessInput): Promise<PutBoundaryReadinessResult>;
	getBoundaryReadiness(
		input: BoundaryReadinessDeviceInput,
	): Promise<BoundaryReadinessRecord | null>;
	/** Removes the device's record for the group. Returns whether one was stored. */
	discardBoundaryReadiness(input: BoundaryReadinessDeviceInput): Promise<boolean>;
}

interface StoredBinding {
	record_id: string;
	sequence: number;
	key_id: string;
	filter_evidence: ReadinessBinding["filterEvidence"];
	refresh_revision: number;
}
type VerifiedBoundaryReadiness = BoundaryReadinessRecord &
	Omit<StoredBinding, "record_id"> & { group_generation: string; coordinator_id: string };

/**
 * The scopes, out of `scopeIds`, that the device is an authorized member of in
 * this group right now. It throws when a read could not run, because a read
 * that failed is not a denial.
 */
export type BoundaryReadinessScopeAccess = (input: {
	groupId: string;
	deviceId: string;
	scopeIds: readonly string[];
}) => Promise<Set<string>>;

/** The access read each store builds from its own membership and authorization reads. */
export function boundaryReadinessScopeAccess(store: {
	listDeviceScopeMemberships(deviceId: string): Promise<CoordinatorScopeMembership[]>;
	getScopeAuthorization(
		input: CoordinatorScopeAuthorizationInput,
	): Promise<CoordinatorScopeAuthorizationResult>;
}): BoundaryReadinessScopeAccess {
	return async ({ groupId, deviceId, scopeIds }) => {
		// One read narrows the request to scopes the device has an active membership
		// in, so the scopes a request names cannot multiply the reads below.
		const memberships = await store.listDeviceScopeMemberships(deviceId);
		const memberOf = new Set(memberships.map((membership) => membership.scope_id));
		const authorized = new Set<string>();
		for (const scopeId of scopeIds.filter((candidate) => memberOf.has(candidate))) {
			const authorization = await store.getScopeAuthorization({ groupId, scopeId });
			if (authorization.kind === "rejected") {
				if (authorization.error !== "scope_authorization_unavailable") continue;
				throw new Error("boundary_readiness_authorization_unavailable");
			}
			const isMember = authorization.members.some(
				(member) => member.membership.device_id === deviceId,
			);
			if (isMember) authorized.add(scopeId);
		}
		return authorized;
	};
}

/**
 * The size limit of one record: the UTF-8 bytes of its Projects as compact JSON,
 * in the field order of BoundaryReadinessProject. The limit is on bytes and on
 * the number of older scopes below, so the store and a request agree on what
 * fits. That is about 1,300 Projects with IDs of ordinary length, and fewer
 * with long IDs.
 */
export const BOUNDARY_READINESS_MAX_PROJECTS_BYTES = 256 * 1024;

/**
 * A record names at most this many older scopes. Each one the device is a member
 * of costs an authorization read, and a D1 request can run only so many queries.
 */
export const BOUNDARY_READINESS_MAX_SOURCE_SCOPES = 64;

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
 * counts the rest. A record with a count above zero is not complete: it shows
 * that the device runs the migration code, and the coordinator treats the
 * device as not ready for any older scope it is in.
 */
export function fitBoundaryReadinessProjects(projects: readonly BoundaryReadinessProject[]): {
	projects: BoundaryReadinessProject[];
	omittedProjects: number;
} {
	const fitted: BoundaryReadinessProject[] = [];
	const sourceScopeIds = new Set<string>();
	// "[" and "]" around the entries, and one comma before every entry but the first.
	let bytes = 2;
	for (const project of projects.map(captureProject)) {
		const next = bytes + utf8.encode(JSON.stringify(project)).length + (fitted.length > 0 ? 1 : 0);
		const scopes = new Set(sourceScopeIds).add(project.source_scope_id).size;
		if (next > BOUNDARY_READINESS_MAX_PROJECTS_BYTES) break;
		if (scopes > BOUNDARY_READINESS_MAX_SOURCE_SCOPES) break;
		fitted.push(project);
		sourceScopeIds.add(project.source_scope_id);
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
	const sourceScopes = new Set(projects.map((project) => project.source_scope_id)).size;
	if (
		projectsBytes(projects) > BOUNDARY_READINESS_MAX_PROJECTS_BYTES ||
		sourceScopes > BOUNDARY_READINESS_MAX_SOURCE_SCOPES
	) {
		throw new Error("boundary_readiness_too_large");
	}
	if (raw.binding && !validReadinessBinding(raw.binding)) throw new Error("invalid_input");
	return {
		...device,
		sequence: raw.sequence,
		projects,
		omittedProjects,
		binding: raw.binding ? { ...raw.binding } : undefined,
	};
}

// The header is written only for an enabled enrollment and only by a newer sequence.
function putHeaderSql(condition: string) {
	return `INSERT INTO coordinator_boundary_readiness
	(group_id, device_id, sequence, record_id, omitted_projects,
	 invalid_boundary_entries, unauthorized_source_scope_ids_json, updated_at)
	SELECT ?, ?, ?, ?, ?, ?, ?, ?
	WHERE EXISTS (SELECT 1 FROM enrolled_devices
		WHERE group_id = ? AND device_id = ? AND enabled = 1)
	AND (${condition})
	ON CONFLICT(group_id, device_id) DO UPDATE SET
		sequence = excluded.sequence,
		record_id = excluded.record_id,
		omitted_projects = excluded.omitted_projects,
		invalid_boundary_entries = excluded.invalid_boundary_entries,
		unauthorized_source_scope_ids_json = excluded.unauthorized_source_scope_ids_json,
		updated_at = excluded.updated_at
	WHERE excluded.sequence > coordinator_boundary_readiness.sequence`;
}

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

const READ_HEADER_SQL = `SELECT sequence, record_id, omitted_projects,
		invalid_boundary_entries, unauthorized_source_scope_ids_json, updated_at
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
	invalid_boundary_entries: number;
	unauthorized_source_scope_ids_json: string;
	updated_at: string;
}

/** What the stored header says the record leaves out. A list that cannot be read makes it incomplete. */
function recordGaps(header: HeaderRow) {
	let unauthorized: string[] | null = null;
	try {
		const parsed: unknown = JSON.parse(header.unauthorized_source_scope_ids_json);
		if (Array.isArray(parsed) && parsed.every(isId)) unauthorized = parsed;
	} catch {
		// Left as unreadable.
	}
	return {
		omitted_projects: header.omitted_projects,
		invalid_boundary_entries: header.invalid_boundary_entries,
		unauthorized_source_scope_ids: unauthorized ?? [],
		complete:
			unauthorized !== null &&
			header.omitted_projects === 0 &&
			header.invalid_boundary_entries === 0,
	};
}

function resultRows<T>(result: unknown): T[] {
	const rows = (result as { results?: unknown } | null)?.results;
	return Array.isArray(rows) ? (rows as T[]) : [];
}

function resultChanges(result: unknown): number {
	const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
	return typeof changes === "number" ? changes : 0;
}

function classifyBinding(
	input: PutBoundaryReadinessInput,
	recordId: string,
	result: unknown,
): PutBoundaryReadinessResult | null {
	if (!input.binding) return null;
	const bound = resultRows<StoredBinding>(result)[0];
	if (!bound || bound.key_id !== input.binding.keyId) return { kind: "binding_mismatch" };
	if (bound.record_id === recordId) return null;
	if (bound.sequence >= input.sequence) return { kind: "stale", sequence: bound.sequence };
	return { kind: "binding_mismatch" };
}

type SortedInventory = {
	accepted: BoundaryReadinessProject[];
	rejected: BoundaryReadinessRejection[];
	invalidBoundaryEntries: number;
	unauthorizedSourceScopeIds: string[];
};

function writeStatements(
	input: PutBoundaryReadinessInput,
	sorted: SortedInventory,
	recordId: string,
	timestamp: string,
) {
	const device = [input.groupId, input.deviceId];
	const condition = input.binding
		? signerCondition(input.binding, device, input.sequence)
		: { sql: "1", values: [] };
	const statements = [
		{
			sql: putHeaderSql(condition.sql),
			values: [
				...device,
				input.sequence,
				recordId,
				input.omittedProjects ?? 0,
				sorted.invalidBoundaryEntries,
				JSON.stringify(sorted.unauthorizedSourceScopeIds),
				timestamp,
				...device,
				...condition.values,
			],
		},
		{ sql: CLEAR_PROJECTS_SQL, values: [...device, ...device, recordId] },
		{
			sql: PUT_PROJECTS_SQL,
			values: [...device, JSON.stringify(sorted.accepted), ...device, recordId],
		},
		{ sql: READ_HEADER_SQL, values: device, read: true },
		{ sql: READ_ENROLLED_SQL, values: device, read: true },
	];
	if (input.binding)
		statements.push(
			bindAcceptedRecord(input.binding, device, recordId),
			currentBinding({ ...input.binding, groupId: input.groupId }, input.deviceId),
		);
	return statements;
}

/** Internal storage capability. The caller authenticates the device. */
export class BoundaryReadinessOperations implements CoordinatorBoundaryReadinessStore {
	constructor(
		private readonly backend: DeviceRemovalBackend,
		private readonly authorizedScopeIds: BoundaryReadinessScopeAccess,
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
	 * Malformed entries are set aside first, so they cost no authorization read.
	 */
	private async sortProjects(input: PutBoundaryReadinessInput) {
		const wellFormed = input.projects.filter((project) =>
			MANAGED_PROJECT_SCOPE_ID.test(project.boundary_scope_id),
		);
		const authorized = await this.authorizedScopeIds({
			groupId: input.groupId,
			deviceId: input.deviceId,
			scopeIds: [...new Set(wellFormed.map((project) => project.source_scope_id))],
		});
		const accepted = wellFormed.filter((project) => authorized.has(project.source_scope_id));
		const reject =
			(reason: BoundaryReadinessRejectionReason) => (project: BoundaryReadinessProject) => ({
				source_scope_id: project.source_scope_id,
				boundary_scope_id: project.boundary_scope_id,
				reason,
			});
		const invalid = input.projects.filter((project) => !wellFormed.includes(project));
		const unauthorized = wellFormed.filter((project) => !accepted.includes(project));
		return {
			accepted,
			rejected: [
				...invalid.map(reject("boundary_scope_invalid")),
				...unauthorized.map(reject("source_scope_not_authorized")),
			],
			invalidBoundaryEntries: invalid.length,
			unauthorizedSourceScopeIds: [
				...new Set(unauthorized.map((project) => project.source_scope_id)),
			].toSorted(),
		};
	}

	async putBoundaryReadiness(raw: PutBoundaryReadinessInput): Promise<PutBoundaryReadinessResult> {
		const input = capturePut(raw);
		return this.whenStoragePresent<PutBoundaryReadinessResult>(
			async () => {
				const sorted = await this.sortProjects(input);
				const { accepted, rejected } = sorted;
				const recordId = globalThis.crypto.randomUUID();
				const statements = writeStatements(
					input,
					sorted,
					recordId,
					new Date(this.clock()).toISOString(),
				);
				const results = await this.backend.batch(statements);
				if (results.length !== statements.length) throw new Error("boundary_readiness_incomplete");
				const header = resultRows<HeaderRow>(results[3])[0];
				const denial = classifyBinding(input, recordId, results[6]);
				if (denial) return denial;
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

	async getVerifiedBoundaryReadiness(input: ReadinessPreparation & { deviceId: string }) {
		const { coordinatorId, generation, groupId, deviceId } = input;
		const device = [groupId, deviceId];
		const results = await this.backend.batch([
			currentBinding({ coordinatorId, generation, groupId }, deviceId),
			{ sql: READ_HEADER_SQL, values: device, read: true },
			{ sql: READ_PROJECTS_SQL, values: device, read: true },
		]);
		if (results.length !== 3) throw new Error("boundary_readiness_incomplete");
		const binding = resultRows<StoredBinding>(results[0])[0];
		const header = resultRows<HeaderRow>(results[1])[0];
		if (
			!binding ||
			!header ||
			binding.record_id !== header.record_id ||
			binding.sequence !== header.sequence
		)
			return null;
		return {
			group_id: groupId,
			device_id: deviceId,
			coordinator_id: coordinatorId,
			group_generation: generation,
			sequence: header.sequence,
			key_id: binding.key_id,
			filter_evidence: binding.filter_evidence,
			refresh_revision: binding.refresh_revision,
			...recordGaps(header),
			updated_at: header.updated_at,
			projects: resultRows<BoundaryReadinessProject>(results[2]),
		};
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
				...recordGaps(header),
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
