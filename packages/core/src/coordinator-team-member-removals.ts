import type { DeviceRemovalBackend } from "./coordinator-device-removal.js";
import {
	hasReadinessGenerationByAll,
	INVALIDATE_CHANGED_GROUP,
	knownReadinessGeneration,
	readinessInvalidation,
} from "./coordinator-readiness-invalidation.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";

/*
 * Per-Team member removals. An admin device records that a person was removed
 * from one Team, so every admin device of the group can honor it. A removal is
 * permanent for that identity: no route restores, edits or deletes one, and
 * removals are numbered by one coordinator sequence, `removal_seq`.
 *
 * A person comes back only through a new Team invitation, which assigns a new
 * identity that no removal names. The coordinator cannot tell which pending
 * invitation belongs to a removed person, so it does not try: the admin device
 * that removes someone offers to revoke the Team's pending invitations through
 * the existing revoke route. The coordinator grants and revokes nothing because
 * of a removal. Clients read the removals to keep the membership removed.
 */

interface SchemaObject {
	type: "table" | "index" | "trigger";
	name: string;
	table: string;
	/** Exactly as sqlite_master keeps it: no IF NOT EXISTS and no final semicolon. */
	sql: string;
}

const REMOVALS = "coordinator_team_member_removals";

const immutable = (table: string, name: string, error: string): SchemaObject[] =>
	(["UPDATE", "DELETE"] as const).map((verb) => ({
		type: "trigger",
		name: `${name}_no_${verb.toLowerCase()}`,
		table,
		sql: `CREATE TRIGGER ${name}_no_${verb.toLowerCase()}
BEFORE ${verb} ON ${table}
BEGIN
 SELECT RAISE(ABORT, '${error}');
END`,
	}));

const SCHEMA_OBJECTS: readonly SchemaObject[] = [
	{
		type: "table",
		name: REMOVALS,
		table: REMOVALS,
		sql: `CREATE TABLE ${REMOVALS} (
 removal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
 group_id TEXT NOT NULL,
 team_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 removed_by_device_id TEXT,
 removed_at TEXT NOT NULL
)`,
	},
	{
		type: "index",
		name: "idx_coordinator_team_member_removals_member",
		table: REMOVALS,
		sql: `CREATE UNIQUE INDEX idx_coordinator_team_member_removals_member
 ON ${REMOVALS} (group_id, team_id, identity_id)`,
	},
	{
		type: "index",
		name: "idx_coordinator_team_member_removals_group",
		table: REMOVALS,
		sql: `CREATE INDEX idx_coordinator_team_member_removals_group
 ON ${REMOVALS} (group_id, removal_seq)`,
	},
	...immutable(REMOVALS, "coordinator_team_member_removal", "team_member_removal_immutable"),
];

const ifNotExists = (sql: string) =>
	sql.replace(/^CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) /u, "CREATE $1 IF NOT EXISTS ");

/** Migration 0052 and the SQLite startup schema: new objects only, each `IF NOT EXISTS`. */
export const TEAM_MEMBER_REMOVAL_SCHEMA_SQL = `${SCHEMA_OBJECTS.map(
	(object) => `${ifNotExists(object.sql)};`,
).join("\n\n")}\n`;

export const TEAM_MEMBER_REMOVAL_MIGRATION_NAME = "0052_add_team_member_removals.sql";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * `present` is 1 only when every object exists with exactly the expected
 * definition. `IF NOT EXISTS` keeps an object of the same name with another
 * body, so a name check alone could call a wrong guard complete.
 */
export const TEAM_MEMBER_REMOVAL_STORAGE_PRESENT_SQL = `SELECT (COUNT(*) = ${SCHEMA_OBJECTS.length}) AS present
FROM sqlite_master WHERE (type, name, tbl_name, sql) IN (VALUES ${SCHEMA_OBJECTS.map(
	(object) =>
		`(${quote(object.type)}, ${quote(object.name)}, ${quote(object.table)}, ${quote(object.sql)})`,
).join(",\n")})`;

/** Every object 0052 installs, for tests that build older databases. */
export const TEAM_MEMBER_REMOVAL_OBJECTS: readonly Pick<SchemaObject, "type" | "name">[] =
	SCHEMA_OBJECTS.map(({ type, name }) => ({ type, name }));

/** Largest page one list request returns. */
export const TEAM_MEMBER_REMOVAL_PAGE_SIZE = 200;

export interface CoordinatorTeamMemberRemoval {
	/** One coordinator sequence orders every removal. Never reused. */
	removal_seq: number;
	group_id: string;
	team_id: string;
	identity_id: string;
	/** The admin device that reported the removal. Display only. */
	removed_by_device_id: string | null;
	/** Coordinator time of the removal. */
	removed_at: string;
}

export interface CoordinatorRecordTeamMemberRemovalInput {
	groupId: string;
	teamId: string;
	identityId: string;
	removedByDeviceId?: string | null;
}

export type CoordinatorRecordTeamMemberRemovalResult =
	/** A new removal. */
	| { status: "created"; removal: CoordinatorTeamMemberRemoval }
	/** The person was already removed from this Team. The first removal is returned unchanged. */
	| { status: "existing"; removal: CoordinatorTeamMemberRemoval };

export interface CoordinatorListTeamMemberRemovalsInput {
	groupId: string;
	teamId?: string | null;
	/** Returns removals with a higher `removal_seq` only. */
	afterSeq?: number | null;
}

export interface CoordinatorTeamMemberRemovalPage {
	items: CoordinatorTeamMemberRemoval[];
	/** Pass as `afterSeq` to read the next page, or null when this page is the last. */
	next_after_seq: number | null;
}

export interface CoordinatorTeamMemberRemovalStore {
	/**
	 * Records a removal unless the person was already removed from this Team.
	 * Throws `group_not_found` for an unknown group and
	 * `team_member_removal_unavailable` while the storage is missing or differs.
	 */
	recordTeamMemberRemoval(
		input: CoordinatorRecordTeamMemberRemovalInput,
	): Promise<CoordinatorRecordTeamMemberRemovalResult>;
	/** Removals of one group, oldest first. Reads only. */
	listTeamMemberRemovals(
		input: CoordinatorListTeamMemberRemovalsInput,
	): Promise<CoordinatorTeamMemberRemovalPage>;
}

/** Group, Team and identity keys of every removed person, from a complete listing. */
export function removedTeamMembers(items: readonly CoordinatorTeamMemberRemoval[]): Set<string> {
	return new Set(items.map((item) => teamMemberKey(item.group_id, item.team_id, item.identity_id)));
}

/** The key `removedTeamMembers` uses for one group, Team and identity. */
export function teamMemberKey(groupId: string, teamId: string, identityId: string): string {
	return JSON.stringify([groupId, teamId, identityId]);
}

function invalidInput(): never {
	throw new Error("invalid_input");
}

function captureRecord(raw: CoordinatorRecordTeamMemberRemovalInput) {
	if (!raw || typeof raw !== "object") return invalidInput();
	const { groupId, teamId, identityId } = raw;
	const removedByDeviceId = raw.removedByDeviceId ?? null;
	if (
		!isStrictRecipientPolicyId(groupId) ||
		!isStrictRecipientPolicyId(teamId) ||
		!isStrictRecipientPolicyId(identityId) ||
		(removedByDeviceId !== null && !isStrictRecipientPolicyId(removedByDeviceId))
	)
		return invalidInput();
	return { groupId, teamId, identityId, removedByDeviceId };
}

function captureList(raw: CoordinatorListTeamMemberRemovalsInput) {
	if (!raw || typeof raw !== "object") return invalidInput();
	const teamId = raw.teamId ?? null;
	const afterSeq = raw.afterSeq ?? 0;
	if (
		!isStrictRecipientPolicyId(raw.groupId) ||
		(teamId !== null && !isStrictRecipientPolicyId(teamId)) ||
		!Number.isSafeInteger(afterSeq) ||
		afterSeq < 0
	)
		return invalidInput();
	return { groupId: raw.groupId, teamId, afterSeq };
}

const COLUMNS = "removal_seq, group_id, team_id, identity_id, removed_by_device_id, removed_at";

/** The identity's removal from the Team, if any. There is at most one. Bind group, Team and identity. */
const REMOVAL_SQL = `SELECT ${COLUMNS} FROM ${REMOVALS}
 WHERE group_id = ? AND team_id = ? AND identity_id = ?`;

// The group must exist, and the person must not have been removed from this Team already.
const INSERT_SQL = `INSERT INTO ${REMOVALS}
 (group_id, team_id, identity_id, removed_by_device_id, removed_at)
 SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM groups WHERE group_id = ?)
 AND NOT EXISTS (SELECT 1 FROM ${REMOVALS}
  WHERE group_id = ? AND team_id = ? AND identity_id = ?)`;

const GROUP_EXISTS_SQL = "SELECT COUNT(*) AS present FROM groups WHERE group_id = ?";

const LIST_SQL = `SELECT ${COLUMNS} FROM ${REMOVALS}
 WHERE group_id = ? AND (? IS NULL OR team_id = ?) AND removal_seq > ?
 ORDER BY removal_seq LIMIT ?`;

function resultRows<T>(result: unknown): T[] {
	const rows = (result as { results?: unknown } | null)?.results;
	if (!Array.isArray(rows)) throw new Error("team_member_removal_incomplete");
	return rows as T[];
}

function resultChanges(result: unknown): number {
	const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
	if (typeof changes !== "number") throw new Error("team_member_removal_incomplete");
	return changes;
}

const nullableId = (value: unknown) => value === null || isStrictRecipientPolicyId(value);

/** A stored row, checked field by field, so a broken read never reaches a client. */
function storedRemoval(raw: unknown): CoordinatorTeamMemberRemoval {
	const row = (raw ?? {}) as Record<string, unknown>;
	const removedBy = row.removed_by_device_id ?? null;
	if (
		!Number.isSafeInteger(row.removal_seq) ||
		(row.removal_seq as number) < 1 ||
		!isStrictRecipientPolicyId(row.group_id) ||
		!isStrictRecipientPolicyId(row.team_id) ||
		!isStrictRecipientPolicyId(row.identity_id) ||
		!nullableId(removedBy) ||
		typeof row.removed_at !== "string" ||
		row.removed_at.length === 0
	)
		throw new Error("team_member_removal_incomplete");
	return {
		removal_seq: row.removal_seq as number,
		group_id: row.group_id,
		team_id: row.team_id,
		identity_id: row.identity_id,
		removed_by_device_id: removedBy as string | null,
		removed_at: row.removed_at,
	};
}

/** Internal storage capability. The caller authenticates the admin. */
export class TeamMemberRemovalOperations implements CoordinatorTeamMemberRemovalStore {
	constructor(
		private readonly backend: DeviceRemovalBackend,
		private readonly clock: () => number = Date.now,
	) {}

	private async storagePresent(): Promise<boolean> {
		const result = await this.backend.all({
			sql: TEAM_MEMBER_REMOVAL_STORAGE_PRESENT_SQL,
			values: [],
			read: true,
		});
		return resultRows<{ present: number }>(result)[0]?.present === 1;
	}

	/**
	 * Checks every object and definition before `work`, so a partial or altered
	 * installation is neither written to nor read as complete.
	 */
	private async withStorage<T>(work: () => Promise<T>): Promise<T> {
		if (!(await this.storagePresent())) throw new Error("team_member_removal_unavailable");
		return work();
	}

	async recordTeamMemberRemoval(
		raw: CoordinatorRecordTeamMemberRemovalInput,
	): Promise<CoordinatorRecordTeamMemberRemovalResult> {
		const input = captureRecord(raw);
		const key = [input.groupId, input.teamId, input.identityId];
		return this.withStorage(async () => {
			const invalidation = readinessInvalidation(
				knownReadinessGeneration(this.backend) || (await hasReadinessGenerationByAll(this.backend)),
				{
					sql: INVALIDATE_CHANGED_GROUP,
					values: [input.groupId],
				},
			);
			const results = await this.backend.batch([
				{
					sql: INSERT_SQL,
					values: [
						...key,
						input.removedByDeviceId,
						new Date(this.clock()).toISOString(),
						input.groupId,
						...key,
					],
				},
				{ sql: REMOVAL_SQL, values: key, read: true },
				{ sql: GROUP_EXISTS_SQL, values: [input.groupId], read: true },
				...invalidation,
			]);
			if (results.length !== 3 + invalidation.length)
				throw new Error("team_member_removal_incomplete");
			const [row] = resultRows(results[1]);
			if (row === undefined) {
				const present = resultRows<{ present: number }>(results[2])[0]?.present;
				if (present === 0) throw new Error("group_not_found");
				throw new Error("team_member_removal_incomplete");
			}
			const removal = storedRemoval(row);
			return { status: resultChanges(results[0]) === 1 ? "created" : "existing", removal };
		});
	}

	async listTeamMemberRemovals(
		raw: CoordinatorListTeamMemberRemovalsInput,
	): Promise<CoordinatorTeamMemberRemovalPage> {
		const input = captureList(raw);
		return this.withStorage(async () => {
			// One extra row says whether another page follows.
			const rows = resultRows(
				await this.backend.all({
					sql: LIST_SQL,
					values: [
						input.groupId,
						input.teamId,
						input.teamId,
						input.afterSeq,
						TEAM_MEMBER_REMOVAL_PAGE_SIZE + 1,
					],
					read: true,
				}),
			);
			const items = rows.slice(0, TEAM_MEMBER_REMOVAL_PAGE_SIZE).map(storedRemoval);
			if (items.some((item) => item.group_id !== input.groupId))
				throw new Error("team_member_removal_incomplete");
			const last = items.at(-1);
			return {
				items,
				next_after_seq:
					rows.length > TEAM_MEMBER_REMOVAL_PAGE_SIZE && last ? last.removal_seq : null,
			};
		});
	}
}
