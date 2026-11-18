import { createHash } from "node:crypto";
import {
	DEVICE_REMOVAL_SCHEMA_SQL,
	ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS,
	enrollmentKeyIdColumn,
} from "./coordinator-device-removal.js";
import { parseSshEd25519PublicKeyForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

/**
 * Test-only arrangement of `enrolled_devices` rows that the enrollment triggers
 * would refuse as plain SQL. Each helper has one implementation, a plan of
 * statements, and runs on a better-sqlite3 database or through an async
 * function that takes SQL and values: a fixture's `exec`, or `d1EnrollmentExec`
 * for a D1 database, native or the SQLite adapter. A helper drops a trigger
 * only when the database has it and then creates it again from its current
 * definition, so a database without the enrollment triggers stays without them.
 */
export interface EnrollmentTestStatement {
	sql: string;
	values: unknown[];
}

/** An async statement runner. It rejects when the statement fails. */
export type EnrollmentTestExec = (sql: string, ...values: never[]) => Promise<unknown>;

/** The part of a better-sqlite3 database that the helpers use. */
export interface EnrollmentTestSqlite {
	prepare(sql: string): { run(...values: unknown[]): unknown };
}

type Target = EnrollmentTestSqlite | EnrollmentTestExec;
/** A promise for the async runner. The better-sqlite3 path has finished when it returns. */
type Result<T extends Target> = T extends EnrollmentTestExec ? Promise<void> : undefined;

interface Plan {
	/** Triggers to drop first when present, and to create again after the writes. */
	triggers: { name: string; create: string }[];
	writes: (EnrollmentTestStatement & {
		/** Skips the write on a schema where it fails with this error. */
		unlessError?: RegExp;
		/** Runs in place of the skipped write. */
		otherwise?: EnrollmentTestStatement;
	})[];
}

const errorMatches = (error: unknown, pattern: RegExp | undefined) =>
	pattern !== undefined && error instanceof Error && pattern.test(error.message);

const NO_SUCH_TRIGGER = /no such trigger/u;

/** What runs in place of a write that failed, if anything. Any other failure is thrown again. */
function replacement(
	write: Plan["writes"][number],
	error: unknown,
): EnrollmentTestStatement | undefined {
	if (!errorMatches(error, write.unlessError)) throw error;
	return write.otherwise;
}

function runPlanSync(db: EnrollmentTestSqlite, plan: Plan): void {
	const run = (sql: string, values: unknown[] = []) => {
		db.prepare(sql).run(...values);
	};
	const dropped: string[] = [];
	for (const { name, create } of plan.triggers) {
		try {
			run(`DROP TRIGGER ${name}`);
			dropped.push(create);
		} catch (error) {
			if (!errorMatches(error, NO_SUCH_TRIGGER)) throw error;
		}
	}
	try {
		for (const write of plan.writes) {
			try {
				run(write.sql, write.values);
			} catch (error) {
				const otherwise = replacement(write, error);
				if (otherwise) run(otherwise.sql, otherwise.values);
			}
		}
	} finally {
		for (const create of dropped) run(create);
	}
}

async function runPlanAsync(exec: EnrollmentTestExec, plan: Plan): Promise<void> {
	const run = (sql: string, values: unknown[] = []) => exec(sql, ...(values as never[]));
	const dropped: string[] = [];
	for (const { name, create } of plan.triggers) {
		try {
			await run(`DROP TRIGGER ${name}`);
			dropped.push(create);
		} catch (error) {
			if (!errorMatches(error, NO_SUCH_TRIGGER)) throw error;
		}
	}
	try {
		for (const write of plan.writes) {
			try {
				await run(write.sql, write.values);
			} catch (error) {
				const otherwise = replacement(write, error);
				if (otherwise) await run(otherwise.sql, otherwise.values);
			}
		}
	} finally {
		for (const create of dropped) await run(create);
	}
}

function runPlan<T extends Target>(target: T, plan: Plan): Result<T> {
	if (typeof target === "function") return runPlanAsync(target, plan) as Result<T>;
	runPlanSync(target, plan);
	return undefined as Result<T>;
}

/** The statement runner of a D1 database, native or the SQLite adapter. */
export function d1EnrollmentExec<Statement extends { run(): Promise<unknown> }>(db: {
	prepare(sql: string): { bind(...values: never[]): Statement };
}): EnrollmentTestExec {
	return (sql, ...values) =>
		db
			.prepare(sql)
			.bind(...values)
			.run();
}

/**
 * The statement runner of a test database that binds a value array by number.
 * Each `?` of a helper's statement becomes `?1` to `?n`, in order.
 */
export function numberedEnrollmentExec(
	run: (sql: string, values: never[]) => Promise<unknown>,
): EnrollmentTestExec {
	return (sql, ...values) => {
		let position = 0;
		return run(
			sql.replace(/\?/gu, () => `?${++position}`),
			values,
		);
	};
}

function createTrigger(source: readonly string[], name: string): string {
	const marker = `CREATE TRIGGER IF NOT EXISTS ${name}\n`;
	const statement = source.find((sql) => sql.includes(marker));
	if (!statement) throw new Error(`Missing trigger definition: ${name}`);
	return statement.slice(statement.indexOf(marker));
}

const ENROLLMENT_DELETE_TRIGGER = {
	name: "enrolled_devices_removal_delete",
	create: createTrigger(ENROLLMENT_REMOVAL_TRIGGER_STATEMENTS, "enrolled_devices_removal_delete"),
};
const TOMBSTONE_DELETE_TRIGGER = {
	name: "coordinator_device_removals_delete",
	create: createTrigger(
		DEVICE_REMOVAL_SCHEMA_SQL.split(/(?<=\bEND;)/u),
		"coordinator_device_removals_delete",
	),
};

const whereSql = (where: string) => (where ? ` WHERE ${where}` : "");

/**
 * Creates the state that a removal before 0.50 left: the enrollment is gone and
 * no tombstone records it. Every coordinator that an earlier release removed a
 * device from is in that state, so tests keep arranging it, and they arrange it
 * only here. Only the delete trigger is dropped and re-created around the
 * delete. `where` is the condition after WHERE, and no condition deletes every
 * enrollment.
 */
export function deleteEnrollmentWithoutTombstone<T extends Target>(
	target: T,
	where = "",
	...values: unknown[]
): Result<T> {
	return runPlan(target, {
		triggers: [ENROLLMENT_DELETE_TRIGGER],
		writes: [{ sql: `DELETE FROM enrolled_devices${whereSql(where)}`, values }],
	});
}

/**
 * What `removeDevice` did before 0.50: it deletes the presence row, the
 * reciprocal approvals and the enrollment of one device in one group, and no
 * tombstone records it. A test whose subject is not the removal itself arranges
 * "was enrolled and is not any more" this way, so that the enrollment it makes
 * next is not refused as that of a removed device.
 */
export function removeDeviceWithoutTombstone<T extends Target>(
	target: T,
	groupId: string,
	deviceId: string,
): Result<T> {
	return runPlan(target, {
		triggers: [ENROLLMENT_DELETE_TRIGGER],
		writes: [
			{
				sql: "DELETE FROM presence_records WHERE group_id = ? AND device_id = ?",
				values: [groupId, deviceId],
			},
			{
				sql: `DELETE FROM coordinator_reciprocal_approvals WHERE group_id = ?
					AND (requesting_device_id = ? OR requested_device_id = ?)`,
				values: [groupId, deviceId, deviceId],
			},
			{
				sql: "DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?",
				values: [groupId, deviceId],
			},
		],
	});
}

/**
 * Clears enrollments and every removal tombstone between tests that share one
 * database. Tombstones are immutable by trigger and would refuse the next
 * test's enrollments, so both delete triggers are dropped and re-created around
 * the cleanup. `where` limits the enrollments, never the tombstones. A database
 * from before the tombstone table only has its enrollments cleared.
 */
export function clearEnrollmentsAndRemovals<T extends Target>(
	target: T,
	where = "",
	...values: unknown[]
): Result<T> {
	return runPlan(target, {
		triggers: [ENROLLMENT_DELETE_TRIGGER, TOMBSTONE_DELETE_TRIGGER],
		writes: [
			{ sql: `DELETE FROM enrolled_devices${whereSql(where)}`, values },
			{
				sql: "DELETE FROM coordinator_device_removals",
				values: [],
				unlessError: /no such table: coordinator_device_removals/u,
			},
		],
	});
}

/** The `key_id` an enrollment writer stores for this key text. */
export function enrollmentTestKeyId(publicKey: string): string {
	const parsed = parseSshEd25519PublicKeyForRevocation(publicKey);
	if (parsed.kind !== "ed25519") return enrollmentKeyIdColumn(null);
	return createHash("sha256").update(parsed.blob).digest("hex");
}

export interface EnrollmentKeyChange {
	publicKey: string;
	/** Defaults to the fingerprint of the new key text. Null keeps the stored one. */
	fingerprint?: string | null;
}

function keyChangeStatements(
	key: EnrollmentKeyChange,
	where: string,
	values: unknown[],
): EnrollmentTestStatement[] {
	return [
		{
			sql: `UPDATE enrolled_devices SET key_id = 'changing by the test'${whereSql(where)}`,
			values,
		},
		{
			sql: `UPDATE enrolled_devices SET public_key = ?, fingerprint = COALESCE(?, fingerprint),
				key_id = ?${whereSql(where)}`,
			values: [
				key.publicKey,
				key.fingerprint === undefined ? fingerprintPublicKey(key.publicKey) : key.fingerprint,
				enrollmentTestKeyId(key.publicKey),
				...values,
			],
		},
	];
}

/**
 * A raw key change that passes the enrollment triggers, as a writer's does: one
 * UPDATE sets `public_key`, `fingerprint` and `key_id` together. The UPDATE
 * before it moves `key_id` off its value, because the stale-key trigger cannot
 * tell a restated key ID from one that was left alone. No trigger is dropped.
 * On a test schema without the key ID column only the key text and fingerprint
 * are written.
 * The fingerprint defaults to that of the new key text. A null fingerprint keeps
 * the stored one, for a test that must change the key text and nothing else:
 * one that pins the key against drift apart from the fingerprint, or whose
 * fixture fingerprint is evidence on its own. `where` is the condition after
 * WHERE and must not read `key_id`.
 */
export function changeEnrollmentKey<T extends Target>(
	target: T,
	key: EnrollmentKeyChange,
	where = "",
	...values: unknown[]
): Result<T> {
	const [restate, change] = keyChangeStatements(key, where, values) as [
		EnrollmentTestStatement,
		EnrollmentTestStatement,
	];
	// A test schema from before the key ID column has no key ID to restate.
	const unlessError = /no such column: key_id/u;
	const otherwise = {
		sql: `UPDATE enrolled_devices SET public_key = ?, fingerprint = COALESCE(?, fingerprint)${whereSql(where)}`,
		values: [change.values[0], change.values[1], ...values],
	};
	return runPlan(target, {
		triggers: [],
		writes: [
			{ ...restate, unlessError },
			{ ...change, unlessError, otherwise },
		],
	});
}

/**
 * `public_key || suffix` for the enrollments that `where` selects: each stored
 * key text gains the suffix, which for an SSH key is another text form of the
 * same key. The fingerprint stays. It reads the rows first, so it takes a
 * better-sqlite3 database only.
 */
export function appendToEnrollmentKey(
	db: {
		prepare(sql: string): {
			run(...values: unknown[]): unknown;
			all(...values: unknown[]): unknown[];
		};
	},
	suffix: string,
	where = "",
	...values: unknown[]
): void {
	const rows = db
		.prepare(`SELECT rowid AS row_id, public_key FROM enrolled_devices${whereSql(where)}`)
		.all(...values) as { row_id: number; public_key: string }[];
	for (const row of rows)
		changeEnrollmentKey(
			db,
			{ publicKey: `${row.public_key}${suffix}`, fingerprint: null },
			"rowid = ?",
			row.row_id,
		);
}

const sqlLiteral = (value: unknown) =>
	value === null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;

/**
 * The same key change as SQL text, for a table of SQL strings that a test runs
 * with `exec`. `where` is written out in full, and the key values become literals.
 */
export function changeEnrollmentKeySql(key: EnrollmentKeyChange, where = ""): string {
	return keyChangeStatements(key, where, [])
		.map(({ sql, values }) => {
			const literals = values.map(sqlLiteral);
			return `${sql.replace(/\?/gu, () => literals.shift() ?? "?")};`;
		})
		.join("\n");
}

export interface EnrollmentSeed {
	groupId: string;
	deviceId: string;
	publicKey: string;
	/** Defaults to the fingerprint of the key text. */
	fingerprint?: string;
	identityId?: string | null;
	displayName?: string | null;
	/** Defaults to true. */
	enabled?: boolean;
	createdAt?: string;
}

function seedStatement(seed: EnrollmentSeed): EnrollmentTestStatement {
	return {
		sql: `INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint,
			identity_id, display_name, enabled, created_at, key_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		values: [
			seed.groupId,
			seed.deviceId,
			seed.publicKey,
			seed.fingerprint ?? fingerprintPublicKey(seed.publicKey),
			seed.identityId ?? null,
			seed.displayName ?? null,
			seed.enabled === false ? 0 : 1,
			seed.createdAt ?? "2026-01-01T00:00:00.000Z",
			enrollmentTestKeyId(seed.publicKey),
		],
	};
}

/**
 * A raw enrollment seed with the key ID a writer would store. An enrollment
 * without a key ID is refused once any tombstone exists, so a seed that may run
 * after a removal goes through here.
 */
export function seedEnrollment<T extends Target>(target: T, seed: EnrollmentSeed): Result<T> {
	return runPlan(target, { triggers: [], writes: [seedStatement(seed)] });
}

/**
 * What a raw `INSERT OR REPLACE` seed did: the enrollment of that group and
 * device, if any, gives way to the seed. The collision triggers refuse the
 * REPLACE form, so this deletes without a tombstone and then inserts.
 */
export function replaceEnrollment<T extends Target>(target: T, seed: EnrollmentSeed): Result<T> {
	return runPlan(target, {
		triggers: [ENROLLMENT_DELETE_TRIGGER],
		writes: [
			{
				sql: "DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?",
				values: [seed.groupId, seed.deviceId],
			},
			seedStatement(seed),
		],
	});
}
