import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AUTH_LIFECYCLE_PREDECESSOR_PREDICATE_SQL } from "../../core/src/coordinator-auth-lifecycle-recognition.js";

const db = env.COORDINATOR_DB;
const recognize = () => db.prepare(`SELECT (${AUTH_LIFECYCLE_PREDECESSOR_PREDICATE_SQL}) AS recognized`).first();
beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Reset only local Miniflare fixtures; no actual coordinator database is used.
	await db.prepare("DROP INDEX IF EXISTS lifecycle_test_extra_index").run();
	await db.prepare("DROP VIEW IF EXISTS lifecycle_test_external_view").run();
});
afterEach(() => {
	try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
	finally { vi.restoreAllMocks(); }
});

it("accepts the actual native D1 predecessor without altering its definitions", async () => {
	// Arrange
	const definitions = () => db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
	const before = (await definitions()).results;
	// Act
	const recognized = await recognize();
	// Assert
	expect(recognized).toEqual({ recognized: 1 });
	expect((await definitions()).results).toEqual(before);
});

it.each([
	"CREATE INDEX lifecycle_test_extra_index ON coordinator_auth_account_links(subject)",
	"CREATE VIEW lifecycle_test_external_view AS SELECT * FROM coordinator_auth_account_links",
])("rejects native D1 unknown dependency: %s", async (damage) => {
	// Arrange
	expect(await recognize()).toEqual({ recognized: 1 });
	await db.prepare(damage).run();
	// Act
	const recognized = await recognize();
	// Assert
	expect(recognized).toEqual({ recognized: 0 });
});

it("rejects a merged type token that removes NOT NULL in native D1", async () => {
	// Arrange: only this isolated, empty predecessor fixture is rebuilt.
	expect(await recognize()).toEqual({ recognized: 1 });
	const table = "coordinator_auth_account_links";
	const original = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>();
	if (!original) throw new Error("Missing predecessor link fixture");
	try {
		await db.prepare(`DROP TABLE ${table}`).run();
		await db.prepare(original.sql.replace("coordinator_id TEXT NOT NULL", "coordinator_id TEXTNOTNULL")).run();
		expect(await db.prepare("SELECT type, [notnull] FROM pragma_table_info(?) WHERE name = ?").bind(table, "coordinator_id").first()).toEqual({ type: "TEXTNOTNULL", notnull: 0 });
		// Act
		const recognized = await recognize();
		// Assert
		expect(recognized).toEqual({ recognized: 0 });
	} finally {
		await db.prepare(`DROP TABLE ${table}`).run();
		await db.prepare(original.sql).run();
	}
});

it("rejects a native D1 trigger whose name is already an expected table name", async () => {
	// Arrange: do not remove or rename the existing expected table.
	const name = "coordinator_auth_account_links";
	expect(await recognize()).toEqual({ recognized: 1 });
	await db.prepare(`CREATE TRIGGER ${name} AFTER UPDATE ON ${name} BEGIN SELECT 1; END;`).run();
	try {
		expect((await db.prepare("SELECT type FROM sqlite_master WHERE name = ? ORDER BY type").bind(name).all()).results).toEqual([{ type: "table" }, { type: "trigger" }]);
		// Act
		const recognized = await recognize();
		// Assert
		expect(recognized).toEqual({ recognized: 0 });
	} finally {
		await db.prepare(`DROP TRIGGER ${name}`).run();
	}
});
