import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
	type AuthRead,
	changedRows,
	readSnapshot,
	writeGuarded,
} from "../../core/src/coordinator-auth-read-set.js";
import { createD1AuthLinkBackend } from "../../core/src/d1-coordinator-store.js";

const db = env.COORDINATOR_DB;

it("native D1 commits an unchanged read set and rejects a changed one with nothing written", async () => {
	// Arrange
	await db.batch([
		db.prepare("CREATE TABLE read_set_devices (device_id TEXT, group_id TEXT, identity_id TEXT)"),
		db.prepare("CREATE TABLE read_set_bindings (device_id TEXT PRIMARY KEY, identity_id TEXT)"),
		db.prepare("INSERT INTO read_set_devices VALUES ('d1','g1',NULL),('d1','g2',NULL)"),
	]);
	const backend = createD1AuthLinkBackend(db);
	const reads = {
		devices: {
			sql: "SELECT json_object('group_id',group_id,'identity_id',identity_id) AS row FROM read_set_devices WHERE device_id = ? ORDER BY group_id",
			values: ["d1"],
		},
		bindings: {
			sql: "SELECT json_object('identity_id',identity_id) AS row FROM read_set_bindings WHERE device_id = ?",
			values: ["d1"],
		},
		// A custom guard: the decision survives a group disappearing, but not a new one.
		knownGroups: {
			sql: "SELECT json_quote(group_id) AS row FROM read_set_devices ORDER BY group_id",
			values: [],
			holds: (seenRows) => ({
				sql: "SELECT NOT EXISTS (SELECT group_id FROM read_set_devices EXCEPT SELECT value FROM json_each(?)) AS holds",
				values: [seenRows],
			}),
		},
	} satisfies Record<string, AuthRead>;
	const writes = [
		{ sql: "INSERT INTO read_set_bindings VALUES ('d1','me')", values: [] },
		{
			sql: "UPDATE read_set_devices SET identity_id = 'me' WHERE device_id = 'd1' AND identity_id IS NULL",
			values: [],
		},
		changedRows(2),
	];
	const stale = await readSnapshot(backend, reads);
	const fresh = await readSnapshot(backend, reads);
	// Act
	const unmatched = await writeGuarded(backend, Object.values(fresh.guards), [
		{ sql: "INSERT INTO read_set_bindings VALUES ('d1','me')", values: [] },
		changedRows(2),
	]);
	const afterUnmatched = await db.prepare("SELECT count(*) AS n FROM read_set_bindings").first();
	const race = await Promise.all(
		[stale, fresh].map((snapshot) => writeGuarded(backend, Object.values(snapshot.guards), writes)),
	);
	const fault = writeGuarded(backend, [], [{ sql: "INSERT INTO read_set_missing VALUES (1)", values: [] }]);
	// Assert
	expect(fresh.rows).toEqual({
		devices: [
			{ group_id: "g1", identity_id: null },
			{ group_id: "g2", identity_id: null },
		],
		bindings: [],
		knownGroups: ["g1", "g2"],
	});
	expect(unmatched).toBe("unmatched");
	expect(afterUnmatched).toEqual({ n: 0 });
	expect([...race].sort()).toEqual(["changed", "committed"]);
	await expect(fault).rejects.toThrow(/read_set_missing/);
	expect(await db.prepare("SELECT * FROM read_set_bindings").all()).toMatchObject({
		results: [{ device_id: "d1", identity_id: "me" }],
	});
});
