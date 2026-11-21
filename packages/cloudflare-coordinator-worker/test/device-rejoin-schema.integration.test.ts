import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import {
	checkFinalizedRejoinStorage,
	checkRejoinAttemptStorage,
	storeFinalizedRejoinFixture,
} from "../../core/src/coordinator-device-rejoin-schema-test-harness.js";
import {
	DEVICE_REJOIN_MIGRATION_NAME,
	DEVICE_REJOIN_STORAGE_PRESENT_SQL,
} from "../../core/src/coordinator-device-rejoin-schema.js";

const fixture = () => {
	const db = env.COORDINATOR_DB;
	return {
		db,
		run: async (sql: string, ...values: (string | number)[]) => db.prepare(sql).bind(...values).run(),
		rows: async (sql: string) => (await db.prepare(sql).all()).results,
	};
};

it("installs rejoin storage through the numbered D1 chain", async () => {
	await checkRejoinAttemptStorage(fixture());
});

it("upgrades native D1 without changing prior records and keeps the finalized receipt", async () => {
	const f = fixture();
	await f.run("DROP TABLE coordinator_device_rejoin_audit_log");
	await f.run("DROP TABLE coordinator_device_rejoin_attempts");
	await f.run("INSERT INTO groups(group_id, created_at) VALUES ('prior-group', 'fixture-time')");
	await f.run(`INSERT INTO coordinator_device_removals(removal_id, group_id, device_id, public_key, fingerprint, removed_at)
		VALUES ('prior-removal', 'prior-group', 'prior-device', 'prior-key', 'prior-fingerprint', 'fixture-time')`);
	const priorRows = async () => ({
		groups: await f.rows("SELECT * FROM groups ORDER BY group_id"),
		removals: await f.rows("SELECT * FROM coordinator_device_removals ORDER BY removal_seq"),
	});
	const before = await priorRows();
	expect(await f.rows(DEVICE_REJOIN_STORAGE_PRESENT_SQL)).toEqual([{ present: 0 }]);
	expect(await priorRows()).toEqual(before);
	const migration = env.TEST_MIGRATIONS.find(({ name }) => name === DEVICE_REJOIN_MIGRATION_NAME);
	if (!migration) throw new Error("Missing rejoin migration");
	const apply = () => f.db.batch(migration.queries.map((sql) => f.db.prepare(sql)));
	await apply();
	expect(await f.rows(DEVICE_REJOIN_STORAGE_PRESENT_SQL)).toEqual([{ present: 1 }]);
	await storeFinalizedRejoinFixture(f);
	await apply();
	await checkFinalizedRejoinStorage(f);
	expect(await priorRows()).toEqual(before);
});
