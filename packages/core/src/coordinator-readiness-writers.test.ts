import { expect, it, vi } from "vitest";
import {
	BetterSqliteCoordinatorStore,
	initializeBaseSchema,
} from "./better-sqlite-coordinator-store.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import {
	enrollmentDml,
	registerReadinessWriterTests,
} from "./coordinator-readiness-writers-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const withSqliteWriter: Parameters<typeof registerReadinessWriterTests>[0] = async (use) => {
	const f = setupStore("SQLite");
	const counts: number[] = [];
	const prepare = f.db.prepare.bind(f.db);
	const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
		const statement = prepare(sql);
		if (enrollmentDml.test(sql)) {
			const run = statement.run.bind(statement);
			statement.run = (...values) => {
				const result = run(...values);
				counts.push(result.changes);
				return result;
			};
		}
		return statement;
	});
	const input = revocationInput();
	try {
		await use({
			store: f.store,
			input: { ...input, fingerprint: fingerprintPublicKey(input.publicKey) },
			counts,
			backend: "SQLite",
			exec: async (sql, ...values) => {
				prepare(sql).run(...values);
			},
			rows: async (table) => prepare(`SELECT * FROM ${table}`).all(),
		});
	} finally {
		spy.mockRestore();
		await f.store.close();
	}
};
registerReadinessWriterTests(withSqliteWriter);

it("SQLite startup fills one key and preserves its one-row receipt", () =>
	withSqliteWriter(async (f) => {
		const { groupId, deviceId, publicKey, fingerprint } = f.input;
		await f.store.createGroup(groupId);
		await f.exec(
			"INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,created_at) VALUES(?,?,?,?, 'then')",
			groupId,
			deviceId,
			publicKey,
			fingerprint,
		);
		await f.exec("UPDATE groups SET readiness_generation='prepared' WHERE group_id=?", groupId);
		if (!(f.store instanceof BetterSqliteCoordinatorStore)) throw new Error("expected SQLite");
		initializeBaseSchema(f.store.db);
		expect(f.counts).toEqual([1]);
		expect(await f.rows("groups")).toContainEqual(
			expect.objectContaining({ group_id: groupId, readiness_generation: null }),
		);
	}));
