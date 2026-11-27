import type { DeviceRemovalBackend } from "./coordinator-device-removal.js";
import { isStrictRecipientPolicyId } from "./recipient-policy-identifiers.js";

/*
 * Each Team's coordinator group. The first Team invitation minted for a Team
 * ID binds that ID to the minting group, in the same transaction as the
 * invitation. A binding is immutable: a later Team invitation for the same ID
 * from another group is refused, and nothing unbinds. Admin devices read the
 * bindings to learn which group's Team member removals apply to a Team.
 *
 * Migration 0053 backfills the binding of every Team ID whose existing Team
 * invitations all came from one group. A Team ID already seen in more than one
 * group stays unbound, and Team invitations for it are refused until an admin
 * binds it to one group through the admin route. A Team invitation never
 * carries an operation ID, so renewing an operation invitation never mints one.
 */

interface SchemaObject {
	type: "table" | "index" | "trigger";
	name: string;
	table: string;
	/** Exactly as sqlite_master keeps it: no IF NOT EXISTS and no final semicolon. */
	sql: string;
}

const BINDINGS = "coordinator_team_group_bindings";

const immutable = (verb: "UPDATE" | "DELETE"): SchemaObject => ({
	type: "trigger",
	name: `coordinator_team_group_binding_no_${verb.toLowerCase()}`,
	table: BINDINGS,
	sql: `CREATE TRIGGER coordinator_team_group_binding_no_${verb.toLowerCase()}
BEFORE ${verb} ON ${BINDINGS}
BEGIN
 SELECT RAISE(ABORT, 'team_group_binding_immutable');
END`,
});

const SCHEMA_OBJECTS: readonly SchemaObject[] = [
	{
		type: "table",
		name: BINDINGS,
		table: BINDINGS,
		sql: `CREATE TABLE ${BINDINGS} (
 team_id TEXT PRIMARY KEY,
 group_id TEXT NOT NULL,
 bound_at TEXT NOT NULL,
 source TEXT NOT NULL CHECK (source IN ('invitation', 'backfill', 'admin'))
)`,
	},
	{
		type: "index",
		name: "idx_coordinator_team_group_bindings_group",
		table: BINDINGS,
		sql: `CREATE INDEX idx_coordinator_team_group_bindings_group
 ON ${BINDINGS} (group_id, team_id)`,
	},
	immutable("UPDATE"),
	immutable("DELETE"),
];

const ifNotExists = (sql: string) =>
	sql.replace(/^CREATE (TABLE|INDEX|TRIGGER) /u, "CREATE $1 IF NOT EXISTS ");

/** Every Team ID whose Team invitations all came from one group, bound to that group. */
export const TEAM_GROUP_BINDING_BACKFILL_SQL = `INSERT OR IGNORE INTO ${BINDINGS} (team_id, group_id, bound_at, source)
SELECT policy_team_id, MIN(group_id), MIN(created_at), 'backfill' FROM coordinator_invites
 WHERE invite_kind = 'team_member' AND policy_team_id IS NOT NULL
 GROUP BY policy_team_id HAVING COUNT(DISTINCT group_id) = 1`;

/** The SQLite startup schema: new objects only, each `IF NOT EXISTS`. */
export const TEAM_GROUP_BINDING_SCHEMA_SQL = `${SCHEMA_OBJECTS.map(
	(object) => `${ifNotExists(object.sql)};`,
).join("\n\n")}\n`;

/**
 * Fails, through the NOT NULL group, when a Team ID whose Team invitations all
 * came from one group is still unbound after the backfill. Writes nothing
 * otherwise, so Wrangler records 0053 only after a complete backfill.
 */
export const TEAM_GROUP_BINDING_BACKFILL_CHECK_SQL = `INSERT INTO ${BINDINGS} (team_id, group_id, bound_at, source)
SELECT 'team_group_backfill_incomplete', NULL, '', 'backfill' WHERE EXISTS (
 SELECT 1 FROM coordinator_invites AS invite
 WHERE invite.invite_kind = 'team_member' AND invite.policy_team_id IS NOT NULL
 GROUP BY invite.policy_team_id HAVING COUNT(DISTINCT invite.group_id) = 1
 AND NOT EXISTS (SELECT 1 FROM ${BINDINGS} AS binding WHERE binding.team_id = invite.policy_team_id))`;

/** Migration 0053: the objects, the backfill, then the check that the backfill is complete. */
export const TEAM_GROUP_BINDING_MIGRATION_SQL = `${TEAM_GROUP_BINDING_SCHEMA_SQL}\n${TEAM_GROUP_BINDING_BACKFILL_SQL};\n\n${TEAM_GROUP_BINDING_BACKFILL_CHECK_SQL};\n`;

export const TEAM_GROUP_BINDING_MIGRATION_NAME = "0053_add_team_group_bindings.sql";

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** `present` is 1 only when every object exists with exactly the expected definition. */
export const TEAM_GROUP_BINDING_STORAGE_PRESENT_SQL = `SELECT (COUNT(*) = ${SCHEMA_OBJECTS.length}) AS present
FROM sqlite_master WHERE (type, name, tbl_name, sql) IN (VALUES ${SCHEMA_OBJECTS.map(
	(object) =>
		`(${quote(object.type)}, ${quote(object.name)}, ${quote(object.table)}, ${quote(object.sql)})`,
).join(",\n")})`;

/** Every object 0053 installs, for tests that build older databases. */
export const TEAM_GROUP_BINDING_OBJECTS: readonly Pick<SchemaObject, "type" | "name">[] =
	SCHEMA_OBJECTS.map(({ type, name }) => ({ type, name }));

/** Largest number of Team IDs one read answers. */
export const TEAM_GROUP_BINDING_READ_LIMIT = 50;

export type CoordinatorTeamGroupBinding =
	| { team_id: string; state: "bound"; group_id: string }
	| { team_id: string; state: "unbound" }
	/** Unbound, and its Team invitations came from more than one group. */
	| { team_id: string; state: "conflict" };

export type CoordinatorBindTeamGroupResult = {
	status: "created" | "existing";
	binding: { team_id: string; group_id: string };
};

export interface CoordinatorTeamGroupBindingStore {
	/** The binding of each Team ID. Reads only. */
	readTeamGroupBindings(teamIds: readonly string[]): Promise<CoordinatorTeamGroupBinding[]>;
	/**
	 * Binds an unbound Team ID to the group. Throws `group_not_found`,
	 * `team_bound_to_other_group`, or `team_group_binding_unavailable`.
	 */
	bindTeamGroup(input: {
		teamId: string;
		groupId: string;
	}): Promise<CoordinatorBindTeamGroupResult>;
}

const BINDING_SQL = `SELECT team_id, group_id FROM ${BINDINGS} WHERE team_id = ?`;

const GROUP_COUNT_SQL = `SELECT COUNT(DISTINCT group_id) AS groups FROM coordinator_invites
 WHERE invite_kind = 'team_member' AND policy_team_id = ?`;

// The first Team invitation binds: only while unbound, and only when no other
// group has a Team invitation for this ID. Bind team, group, time, team, team, group.
const CLAIM_SQL = `INSERT OR IGNORE INTO ${BINDINGS} (team_id, group_id, bound_at, source)
 SELECT ?, ?, ?, 'invitation'
 WHERE NOT EXISTS (SELECT 1 FROM ${BINDINGS} WHERE team_id = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_invites
  WHERE invite_kind = 'team_member' AND policy_team_id = ? AND group_id <> ?)`;

// Bind team, group, time, group, team.
const ADMIN_BIND_SQL = `INSERT OR IGNORE INTO ${BINDINGS} (team_id, group_id, bound_at, source)
 SELECT ?, ?, ?, 'admin' WHERE EXISTS (SELECT 1 FROM groups WHERE group_id = ?)
 AND NOT EXISTS (SELECT 1 FROM ${BINDINGS} WHERE team_id = ?)`;

const GROUP_EXISTS_SQL = "SELECT COUNT(*) AS present FROM groups WHERE group_id = ?";

/**
 * The invitation insert, made to insert only when the Team ID is bound to the
 * minting group. Append the Team ID and group ID to the insert's values.
 */
export function boundTeamInviteInsertSql(insertSql: string): string {
	const sql = insertSql.trimEnd();
	const at = sql.indexOf(") VALUES (");
	if (at < 0 || !sql.endsWith(")")) throw new Error("team_invite_insert_unrecognized");
	return `${sql.slice(0, at)}) SELECT ${sql.slice(at + ") VALUES (".length, -1)}
 WHERE EXISTS (SELECT 1 FROM ${BINDINGS} WHERE team_id = ? AND group_id = ?)`;
}

function rows<T>(result: unknown): T[] {
	const value = (result as { results?: unknown } | null)?.results;
	if (!Array.isArray(value)) throw new Error("team_group_binding_incomplete");
	return value as T[];
}

function changes(result: unknown): number {
	const value = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
	if (typeof value !== "number") throw new Error("team_group_binding_incomplete");
	return value;
}

/** Internal storage capability. The caller authenticates the admin. */
export class TeamGroupBindingOperations implements CoordinatorTeamGroupBindingStore {
	constructor(
		private readonly backend: DeviceRemovalBackend,
		private readonly clock: () => number = Date.now,
	) {}

	private async withStorage<T>(work: () => Promise<T>): Promise<T> {
		const result = await this.backend.all({
			sql: TEAM_GROUP_BINDING_STORAGE_PRESENT_SQL,
			values: [],
			read: true,
		});
		if (rows<{ present: number }>(result)[0]?.present !== 1)
			throw new Error("team_group_binding_unavailable");
		return work();
	}

	/**
	 * Inserts a Team invitation and, if the Team ID is unbound, binds it to the
	 * group, in one transaction. Throws `team_bound_to_other_group` when another
	 * group holds the ID, and `team_binding_conflict` when it is unbound but
	 * another group already has Team invitations for it.
	 */
	async insertTeamInvite(input: {
		insertSql: string;
		values: Array<string | number | null>;
		teamId: string;
		groupId: string;
	}): Promise<void> {
		const { teamId, groupId } = input;
		if (!isStrictRecipientPolicyId(teamId) || !isStrictRecipientPolicyId(groupId))
			throw new Error("invalid_input");
		await this.withStorage(async () => {
			const now = new Date(this.clock()).toISOString();
			const results = await this.backend.batch([
				{ sql: CLAIM_SQL, values: [teamId, groupId, now, teamId, teamId, groupId] },
				{
					sql: boundTeamInviteInsertSql(input.insertSql),
					values: [...input.values, teamId, groupId],
				},
				{ sql: BINDING_SQL, values: [teamId], read: true },
			]);
			if (results.length !== 3) throw new Error("team_group_binding_incomplete");
			if (changes(results[1]) === 1) return;
			const bound = rows<{ group_id: string }>(results[2])[0];
			if (bound && bound.group_id !== groupId) throw new Error("team_bound_to_other_group");
			if (!bound) throw new Error("team_binding_conflict");
			throw new Error("team_group_binding_incomplete");
		});
	}

	async readTeamGroupBindings(teamIds: readonly string[]): Promise<CoordinatorTeamGroupBinding[]> {
		const ids = [...new Set(teamIds)];
		if (
			ids.length === 0 ||
			ids.length > TEAM_GROUP_BINDING_READ_LIMIT ||
			!ids.every((id) => isStrictRecipientPolicyId(id))
		)
			throw new Error("invalid_input");
		return this.withStorage(async () => {
			const results = await this.backend.batch(
				ids.flatMap((teamId) => [
					{ sql: BINDING_SQL, values: [teamId], read: true },
					{ sql: GROUP_COUNT_SQL, values: [teamId], read: true },
				]),
			);
			return ids.map((teamId, index): CoordinatorTeamGroupBinding => {
				const bound = rows<{ group_id: unknown }>(results[index * 2])[0];
				if (bound) {
					if (!isStrictRecipientPolicyId(bound.group_id))
						throw new Error("team_group_binding_incomplete");
					return { team_id: teamId, state: "bound", group_id: bound.group_id };
				}
				const groups = rows<{ groups: number }>(results[index * 2 + 1])[0]?.groups ?? 0;
				return { team_id: teamId, state: groups > 1 ? "conflict" : "unbound" };
			});
		});
	}

	async bindTeamGroup(input: { teamId: string; groupId: string }) {
		const { teamId, groupId } = input;
		if (!isStrictRecipientPolicyId(teamId) || !isStrictRecipientPolicyId(groupId))
			throw new Error("invalid_input");
		return this.withStorage(async (): Promise<CoordinatorBindTeamGroupResult> => {
			const now = new Date(this.clock()).toISOString();
			const results = await this.backend.batch([
				{ sql: ADMIN_BIND_SQL, values: [teamId, groupId, now, groupId, teamId] },
				{ sql: BINDING_SQL, values: [teamId], read: true },
				{ sql: GROUP_EXISTS_SQL, values: [groupId], read: true },
			]);
			if (results.length !== 3) throw new Error("team_group_binding_incomplete");
			const bound = rows<{ group_id: string }>(results[1])[0];
			if (!bound) {
				if (rows<{ present: number }>(results[2])[0]?.present === 0)
					throw new Error("group_not_found");
				throw new Error("team_group_binding_incomplete");
			}
			if (bound.group_id !== groupId) throw new Error("team_bound_to_other_group");
			return {
				status: changes(results[0]) === 1 ? "created" : "existing",
				binding: { team_id: teamId, group_id: groupId },
			};
		});
	}
}
