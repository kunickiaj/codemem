import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL } from "../../core/src/coordinator-auth-device-claim-schema.js";

const TABLE = "coordinator_auth_device_claims";
// SQL fixtures exercise storage, not Google verification or device authorization.
const row = {
	coordinator_id: "coordinator-a", claim_id: "claim-a", identity_id: "identity-a",
	group_id: "group-a", device_id: "device-a",
	public_key: "-----BEGIN PUBLIC KEY-----\nfixture-not-a-real-key\n-----END PUBLIC KEY-----\n",
	fingerprint: "a".repeat(64), key_id: "b".repeat(64), attempt_id: "dummy-attempt-a",
	issuer: "https://accounts.google.com", auth_config_revision: "d".repeat(64), created_at_ms: 0,
};
const columns = Object.keys(row);
const insertSql = `INSERT INTO ${TABLE} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
const db = env.COORDINATOR_DB;
const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0032_"));
if (!migration) throw new Error("Missing device claim migration fixture");
const queries = migration.queries;
const definitions = async () => (await db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name = '${TABLE}' AND sql IS NOT NULL ORDER BY type, name`).all()).results;
const rows = async () => (await db.prepare(`SELECT * FROM ${TABLE} ORDER BY claim_id`).all()).results;
const insert = (changes: Record<string, unknown> = {}, sql = insertSql) => {
	const record = { ...row, ...changes } as Record<string, unknown>;
	return db.prepare(sql).bind(...columns.map((column) => record[column])).run();
};

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// This resets only the local Miniflare fixture; immutable DELETE is never bypassed.
	await db.prepare(`DROP TABLE ${TABLE}`).run();
	await db.batch(queries.map((sql) => db.prepare(sql)));
	await db.prepare("PRAGMA recursive_triggers = OFF").run();
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});

it("actual native D1 migration and constant produce identical definitions without reference rows", async () => {
	// Arrange
	const migrated = await definitions();
	// Act: D1 exec cannot parse multi-line triggers; submit complete statements with batch.
	await db.prepare(`DROP TABLE ${TABLE}`).run();
	const statements = COORDINATOR_AUTH_DEVICE_CLAIM_SCHEMA_SQL.match(/CREATE TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/gu);
	expect(statements).toHaveLength(4);
	await db.batch((statements ?? []).map((sql) => db.prepare(sql)));
	await insert();
	// Assert
	expect(await definitions()).toEqual(migrated);
	expect(await rows()).toEqual([row]);
	expect((await db.prepare(`PRAGMA foreign_key_list(${TABLE})`).all()).results).toEqual([]);
});

it("stores independent records and the same unique values in another coordinator namespace", async () => {
	// Arrange
	const second = { claim_id: "claim-b", identity_id: "identity-b", device_id: "device-b", key_id: "c".repeat(64), attempt_id: "dummy-attempt-b" };
	// Act
	await insert();
	await insert(second);
	await insert({ coordinator_id: "coordinator-b", claim_id: "claim-c" });
	// Assert
	expect(await rows()).toEqual([row, { ...row, ...second }, { ...row, coordinator_id: "coordinator-b", claim_id: "claim-c" }]);
});

it("accepts identifier/key/time upper bounds and preserves CRLF bytes", async () => {
	// Arrange
	const maximum = { coordinator_id: "c".repeat(256), claim_id: "l".repeat(256), identity_id: "i".repeat(256), group_id: "g".repeat(256), device_id: "d".repeat(256), attempt_id: "t".repeat(256), public_key: `${"p".repeat(4094)}\r\n`, created_at_ms: Number.MAX_SAFE_INTEGER };
	// Act
	await insert(maximum);
	// Assert
	expect(await rows()).toEqual([{ ...row, ...maximum }]);
});

it.each(["coordinator_id", "claim_id", "identity_id", "group_id", "device_id", "attempt_id", "public_key"])("rejects overlong %s", async (column) => {
	// Arrange
	const value = "x".repeat(column === "public_key" ? 4097 : 257);
	// Act
	const invalid = () => insert({ [column]: value });
	// Assert
	await expect(invalid()).rejects.toThrow(/CHECK constraint failed/);
	expect(await rows()).toEqual([]);
});

it.each(["claim_id", "identity_id", "device_id", "key_id", "attempt_id"])("rejects independent %s INSERT and REPLACE collisions with recursive triggers off", async (field) => {
	// Arrange
	await insert();
	const changes: Record<string, unknown> = { claim_id: "claim-b", identity_id: "identity-b", device_id: "device-b", key_id: "c".repeat(64), attempt_id: "dummy-attempt-b" };
	changes[field] = row[field as keyof typeof row];
	if (field === "claim_id") changes.coordinator_id = "coordinator-b";
	// Act
	const ordinary = () => insert(changes);
	const replace = () => insert(changes, insertSql.replace("INSERT INTO", "INSERT OR REPLACE INTO"));
	// Assert
	expect((await db.prepare("PRAGMA recursive_triggers").first())?.recursive_triggers).toBe(0);
	await expect(ordinary()).rejects.toThrow(/auth_device_claim_collision/);
	await expect(replace()).rejects.toThrow(/auth_device_claim_collision/);
	expect(await rows()).toEqual([row]);
});

it.each([
	`UPDATE ${TABLE} SET public_key = 'changed'`,
	`UPDATE ${TABLE} SET claim_id = claim_id`,
	`DELETE FROM ${TABLE}`,
	`${insertSql} ON CONFLICT DO UPDATE SET public_key = excluded.public_key`,
])("rejects immutable mutation %s", async (sql) => {
	// Arrange
	await insert();
	// Act
	const mutate = () => sql.includes("ON CONFLICT") ? insert({ public_key: "changed" }, sql) : db.prepare(sql).run();
	// Assert
	await expect(mutate()).rejects.toThrow(/auth_device_claim_(immutable|collision)/);
	expect(await rows()).toEqual([row]);
});

describe("native D1 schema checks", () => {
	it.each(columns)("rejects missing/null %s", async (column) => {
		// Arrange
		const present = columns.filter((name) => name !== column);
		const sql = `INSERT INTO ${TABLE} (${present.join(",")}) VALUES (${present.map(() => "?").join(",")})`;
		// Act
		const missing = () => db.prepare(sql).bind(...present.map((name) => row[name as keyof typeof row])).run();
		// Assert
		await expect(missing()).rejects.toThrow(/NOT NULL/);
		await expect(insert({ [column]: null })).rejects.toThrow(/NOT NULL/);
		expect(await rows()).toEqual([]);
	});
	it.each(columns.filter((column) => column !== "created_at_ms"))("rejects blank/NUL/blob %s", async (column) => {
		// Arrange
		const values = ["", "   ", "bad\0value", new Uint8Array([1, 2, 3]).buffer];
		// Act
		const attempts = values.map((value) => () => insert({ [column]: value }));
		// Assert
		for (const attempt of attempts) await expect(attempt()).rejects.toThrow(/CHECK constraint failed/);
		expect(await rows()).toEqual([]);
	});
	it.each([
		{ fingerprint: "G".repeat(64) }, { fingerprint: "a".repeat(63) },
		{ key_id: "B".repeat(64) }, { key_id: "b".repeat(65) },
		{ created_at_ms: -1 }, { created_at_ms: 0.5 }, { created_at_ms: "not-a-time" },
		{ created_at_ms: Number.MAX_SAFE_INTEGER + 1 }, { auth_config_revision: "opaque-config-revision-v1" },
	])("rejects invalid digest/time %j", async (changes) => {
		// Arrange
		const record = { ...changes };
		// Act
		const invalid = () => insert(record);
		// Assert
		await expect(invalid()).rejects.toThrow(/CHECK constraint failed/);
		expect(await rows()).toEqual([]);
	});
});

it("migration replay and rejected writes leave all other coordinator data unchanged", async () => {
	// Arrange
	await db.prepare("INSERT INTO groups (group_id, created_at) VALUES ('claim-fixture-group', '2026-10-01T00:00:00.000Z')").run();
	await insert();
	const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results;
	const snapshot = () => Promise.all(tables.map(async ({ name }) => ({ name, rows: (await db.prepare(`SELECT * FROM "${name}"`).all()).results })));
	const before = await snapshot();
	// Act
	await db.batch(queries.map((sql) => db.prepare(sql)));
	await expect(insert({}, insertSql.replace("INSERT INTO", "INSERT OR REPLACE INTO"))).rejects.toThrow();
	// Assert
	expect(await snapshot()).toEqual(before);
});
