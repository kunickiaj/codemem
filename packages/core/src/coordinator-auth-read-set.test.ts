import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	type AuthRead,
	changedRows,
	readSnapshot,
	writeGuarded,
} from "./coordinator-auth-read-set.js";

const open: Database.Database[] = [];
afterEach(() => {
	for (const db of open.splice(0)) db.close();
});

type Reader = "sequential reads" | "one read batch";

function fixture(reader: Reader) {
	const db = new Database(":memory:");
	open.push(db);
	db.exec(`CREATE TABLE devices (device_id TEXT, group_id TEXT, identity_id TEXT, enabled INTEGER, note TEXT);
 CREATE TABLE bindings (device_id TEXT PRIMARY KEY, identity_id TEXT);
 CREATE TABLE revocations (subject TEXT PRIMARY KEY);
 INSERT INTO devices VALUES ('d1','g1',NULL,1,'a'),('d1','g2',NULL,1,'b'),('d2','g1','other',1,'c');`);
	const run = (s: AuthLinkStatement) => db.prepare(s.sql).run(...s.values).changes;
	const backend: AuthLinkBackend = {
		first: async <T>(s: AuthLinkStatement) =>
			(db.prepare(s.sql).get(...s.values) as T | undefined) ?? null,
		run: async (s) => run(s),
		batch: async (statements) => {
			db.transaction(() => {
				for (const s of statements) run(s);
			}).immediate();
		},
	};
	if (reader === "one read batch")
		backend.readBatch = async <T>(statements: AuthLinkStatement[]) =>
			statements.map((s) => db.prepare(s.sql).all(...s.values) as T[]);
	const reads = {
		devices: {
			sql: "SELECT json_object('group_id',group_id,'identity_id',identity_id,'enabled',enabled) AS row FROM devices WHERE device_id = ? ORDER BY group_id",
			values: ["d1"],
		},
		bindings: {
			sql: "SELECT json_object('identity_id',identity_id) AS row FROM bindings WHERE device_id = ?",
			values: ["d1"],
		},
		revocations: {
			sql: "SELECT json_object('subject',subject) AS row FROM revocations WHERE subject = ?",
			values: ["d1"],
		},
	} satisfies Record<string, AuthRead>;
	const writes: AuthLinkStatement[] = [
		{ sql: "INSERT INTO bindings VALUES ('d1','me')", values: [] },
		{
			sql: "UPDATE devices SET identity_id = 'me' WHERE device_id = 'd1' AND identity_id IS NULL",
			values: [],
		},
		changedRows(2),
	];
	const snapshot = () => readSnapshot(backend, reads);
	const write = (
		taken: Awaited<ReturnType<typeof snapshot>>,
		statements: AuthLinkStatement[] = writes,
	) => writeGuarded(backend, Object.values(taken.guards), statements);
	const bindings = () => db.prepare("SELECT * FROM bindings").all();
	return { db, backend, writes, snapshot, write, bindings };
}

describe.each(["sequential reads", "one read batch"] as const)("read set with %s", (reader) => {
	it("returns typed rows, including NULL and an empty set, and commits an unchanged snapshot", async () => {
		// Arrange
		const f = fixture(reader);
		// Act
		const snapshot = await f.snapshot();
		const result = await f.write(snapshot);
		// Assert
		expect(snapshot.rows).toEqual({
			devices: [
				{ group_id: "g1", identity_id: null, enabled: 1 },
				{ group_id: "g2", identity_id: null, enabled: 1 },
			],
			bindings: [],
			revocations: [],
		});
		expect(result).toBe("committed");
		expect(f.bindings()).toEqual([{ device_id: "d1", identity_id: "me" }]);
	});

	it("rejects the whole batch when a row it read changed", async () => {
		// Arrange
		const f = fixture(reader);
		const snapshot = await f.snapshot();
		f.db.exec("INSERT INTO revocations VALUES ('d1')");
		// Act
		const result = await f.write(snapshot);
		// Assert
		expect(result).toBe("changed");
		expect(f.bindings()).toEqual([]);
		expect(f.db.prepare("SELECT count(*) n FROM devices WHERE identity_id='me'").get()).toEqual({
			n: 0,
		});
	});

	it("still commits when only rows and columns it did not read changed", async () => {
		// Arrange
		const f = fixture(reader);
		const snapshot = await f.snapshot();
		f.db.exec(
			"UPDATE devices SET note='other row' WHERE device_id='d2'; UPDATE devices SET note='unread column' WHERE device_id='d1'",
		);
		// Act
		const result = await f.write(snapshot);
		// Assert
		expect(result).toBe("committed");
	});

	it("rejects a replay of a snapshot after its own write", async () => {
		// Arrange
		const f = fixture(reader);
		const snapshot = await f.snapshot();
		expect(await f.write(snapshot)).toBe("committed");
		// Act
		const replay = await f.write(snapshot, [
			{ sql: "UPDATE bindings SET identity_id='again'", values: [] },
		]);
		// Assert
		expect(replay).toBe("changed");
		expect(f.bindings()).toEqual([{ device_id: "d1", identity_id: "me" }]);
	});

	it("commits exactly one of two writers that decided from the same snapshot", async () => {
		// Arrange
		const f = fixture(reader);
		const snapshots = [await f.snapshot(), await f.snapshot()];
		// Act
		const results = await Promise.all(snapshots.map((snapshot) => f.write(snapshot)));
		// Assert
		expect(results.sort()).toEqual(["changed", "committed"]);
		expect(f.bindings()).toEqual([{ device_id: "d1", identity_id: "me" }]);
	});

	it("reports a write that changed the wrong number of rows and writes nothing", async () => {
		// Arrange
		const f = fixture(reader);
		const snapshot = await f.snapshot();
		// Act
		const result = await f.write(snapshot, [
			{ sql: "INSERT INTO bindings VALUES ('d1','me')", values: [] },
			{ sql: "UPDATE devices SET identity_id='me' WHERE device_id='absent'", values: [] },
			changedRows(1),
		]);
		// Assert
		expect(result).toBe("unmatched");
		expect(f.bindings()).toEqual([]);
	});

	it("propagates unrelated errors instead of reporting a refusal", async () => {
		// Arrange
		const f = fixture(reader);
		const snapshot = await f.snapshot();
		// Act
		const result = f.write(snapshot, [{ sql: "INSERT INTO missing_table VALUES (1)", values: [] }]);
		// Assert
		await expect(result).rejects.toThrow(/missing_table/);
	});

	it("reads nothing and guards nothing for an empty read set", async () => {
		// Arrange
		const f = fixture(reader);
		// Act
		const snapshot = await readSnapshot(f.backend, {});
		// Assert
		expect(snapshot).toEqual({ rows: {}, guards: {} });
	});

	describe("with a custom guard that only forbids new rows", () => {
		// The decision reads which enrollments exist and survives any of them disappearing.
		const known: AuthRead = {
			sql: "SELECT json_quote(device_id || '/' || group_id) AS row FROM devices ORDER BY 1",
			values: [],
			holds: (seenRows) => ({
				sql: "SELECT NOT EXISTS (SELECT device_id || '/' || group_id FROM devices EXCEPT SELECT value FROM json_each(?)) AS holds",
				values: [seenRows],
			}),
		};

		it("still commits after a row it read is removed", async () => {
			// Arrange
			const f = fixture(reader);
			const snapshot = await readSnapshot(f.backend, { known });
			f.db.exec("DELETE FROM devices WHERE device_id='d2'");
			// Act
			const result = await writeGuarded(f.backend, [snapshot.guards.known], f.writes);
			// Assert
			expect(snapshot.rows.known).toEqual(["d1/g1", "d1/g2", "d2/g1"]);
			expect(result).toBe("committed");
		});

		it("rejects the batch after a new row appears", async () => {
			// Arrange
			const f = fixture(reader);
			const snapshot = await readSnapshot(f.backend, { known });
			f.db.exec("INSERT INTO devices VALUES ('d3','g1',NULL,1,'new')");
			// Act
			const result = await writeGuarded(f.backend, [snapshot.guards.known], f.writes);
			// Assert
			expect(result).toBe("changed");
			expect(f.bindings()).toEqual([]);
		});
	});
});
