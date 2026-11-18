import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import {
	BetterSqliteCoordinatorStore,
	initializeBaseSchema,
} from "./better-sqlite-coordinator-store.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	DEVICE_REMOVAL_COLUMNS,
	DEVICE_REMOVAL_SCHEMA_SQL,
	DEVICE_REMOVAL_TRIGGER_NAMES,
	ENROLLMENT_REMOVAL_TRIGGERS_SQL,
	hasDeviceRemovalSchema,
} from "./coordinator-device-removal.js";
import {
	type RawStatement,
	REMOVAL_CLOCK_MS,
	registerDeviceRemovalContract,
	removalDeviceKey,
	removalHarness,
} from "./coordinator-device-removal-test-harness.js";
import { registerEnrollmentWriterContract } from "./coordinator-device-removal-writer-test-harness.js";
import { recipientGuardedD1 } from "./coordinator-recipient-revocation-test-harness.js";

const normalize = (sql: string) => sql.replace(/\s+/gu, " ").trim();

it("keeps migration 0048 and the Worker schema aligned with the shared removal SQL", () => {
	// Arrange
	const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
	const migration = readdirSync(new URL("migrations/", worker)).find((name) =>
		name.startsWith("0048_"),
	);
	expect(migration).toBe("0048_add_device_removals.sql");
	const files = [
		readFileSync(new URL("schema.sql", worker), "utf8"),
		readFileSync(new URL(`migrations/${migration}`, worker), "utf8"),
	].map(normalize);
	// Assert: both carry every shared statement; only the migration alters existing tables.
	for (const file of files) expect(file).toContain(normalize(DEVICE_REMOVAL_SCHEMA_SQL));
	for (const { sql, column } of DEVICE_REMOVAL_COLUMNS) {
		expect(files[1]).toContain(`${sql};`);
		expect(files[0]).toContain(column);
	}
});

describe.each(["SQLite", "D1"] as const)("%s device removal contract", (backend) => {
	let sequence = 0;
	const test = removalHarness(async (use) => {
		const f = setupStore(backend, { authClock: () => REMOVAL_CLOCK_MS });
		f.db.exec(ENROLLMENT_REMOVAL_TRIGGERS_SQL);
		const prepare = f.db.prepare.bind(f.db);
		const runOnce = (before: readonly string[], change: readonly RawStatement[]) => {
			let done = false;
			return (queries: readonly string[]) => {
				if (done || !queries.some((query) => before.some((text) => query.includes(text)))) return;
				done = true;
				for (const { sql, values } of change) prepare(sql).run(...values);
			};
		};
		try {
			await use({
				store: f.store,
				prefix: `removal-${++sequence}`,
				exec: async (sql, ...values) => {
					prepare(sql).run(...values);
				},
				rows: async <T>(sql: string, ...values: unknown[]) => prepare(sql).all(...values) as T[],
				interleave: (before, change) => {
					const run = runOnce(before, change);
					if (backend === "D1")
						return recipientGuardedD1(sqliteD1(f.db), async (writes) =>
							run(writes.map(({ query }) => query)),
						);
					// One connection: the change runs inside the store's own immediate transaction.
					vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
						run([sql]);
						return prepare(sql);
					});
					return f.store;
				},
			});
		} finally {
			vi.restoreAllMocks();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerDeviceRemovalContract(test);
	registerEnrollmentWriterContract(test);
});

it.todo("schema initialization and a numbered migration install the enrollment triggers");

describe("device removal storage readiness", () => {
	const ready = (db: Database.Database) =>
		hasDeviceRemovalSchema({
			first: async <T>({ sql }: { sql: string }) => db.prepare(sql).get() as T,
		});

	it("requires each object by name and ignores objects a later release adds next to them", async () => {
		// Arrange
		const { store, db } = setupStore("SQLite");
		try {
			expect(await ready(db)).toBe(true);
			// Act: a further trigger with the same name prefix, as a later release may add.
			db.exec(`CREATE TRIGGER coordinator_device_removals_later AFTER UPDATE ON coordinator_device_removals
				BEGIN SELECT 1; END`);
			const withFurtherTrigger = await ready(db);
			const missing = [];
			for (const name of DEVICE_REMOVAL_TRIGGER_NAMES) {
				const definition = db
					.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
					.pluck()
					.get(name) as string;
				db.exec(`DROP TRIGGER ${name}`);
				missing.push(await ready(db));
				db.exec(definition);
			}
			// Assert
			expect(withFurtherTrigger).toBe(true);
			expect(missing).toEqual(DEVICE_REMOVAL_TRIGGER_NAMES.map(() => false));
			expect(await ready(db)).toBe(true);
		} finally {
			await store.close();
		}
	});
});

const DROP_REMOVAL_STORAGE_SQL = `DROP TABLE coordinator_device_removals;
	ALTER TABLE enrolled_devices DROP COLUMN key_id;
	ALTER TABLE coordinator_invites DROP COLUMN issued_after_removal_seq;
	ALTER TABLE coordinator_join_requests DROP COLUMN issued_after_removal_seq;`;

describe.each(["SQLite", "D1"] as const)(
	"%s coordinator without device removal storage",
	(backend) => {
		/** The schema as it was before migration 0048, or before SQLite initialization added it. */
		function setupWithoutRemovalStorage() {
			if (backend === "D1") {
				const f = setupStore("D1");
				f.db.exec(DROP_REMOVAL_STORAGE_SQL);
				return { ...f, cleanup: () => f.db.close() };
			}
			const directory = mkdtempSync(join(tmpdir(), "codemem-removal-"));
			const path = join(directory, "coordinator.sqlite");
			const created = new Database(path);
			initializeBaseSchema(created);
			created.exec(DROP_REMOVAL_STORAGE_SQL);
			created.close();
			const store = new BetterSqliteCoordinatorStore(path, { existingOnly: true });
			return {
				store,
				db: store.db,
				cleanup: () => {
					if (store.db.open) store.db.close();
					rmSync(directory, { recursive: true, force: true });
				},
			};
		}

		it("stores the key ID from the same store as soon as the storage exists", async () => {
			// Arrange: the store's first write found no storage and wrote without a key ID.
			const f = setupWithoutRemovalStorage();
			const key = await removalDeviceKey("storage-appears");
			const enrollment = (deviceId: string) => ({
				deviceId,
				publicKey: key.publicKey,
				fingerprint: key.fingerprint,
			});
			try {
				await f.store.createGroup("g1");
				await f.store.enrollDevice("g1", enrollment("before"));
				// Act: the migration runs while the store stays open.
				for (const { sql } of DEVICE_REMOVAL_COLUMNS) f.db.exec(sql);
				f.db.exec(DEVICE_REMOVAL_SCHEMA_SQL);
				await f.store.enrollDevice("g1", enrollment("after"));
				await f.store.enrollDevice("g1", enrollment("before"));
				const invite = await f.store.createInvite({
					groupId: "g1",
					policy: "auto_admit",
					expiresAt: "2099-01-01T00:00:00.000Z",
				});
				// Assert: no write after the migration takes the form without the columns.
				expect(
					f.db.prepare("SELECT device_id, key_id FROM enrolled_devices ORDER BY device_id").all(),
				).toEqual([
					{ device_id: "after", key_id: key.keyId },
					{ device_id: "before", key_id: key.keyId },
				]);
				expect(
					f.db
						.prepare("SELECT issued_after_removal_seq FROM coordinator_invites WHERE invite_id = ?")
						.pluck()
						.get(invite.invite_id),
				).toBe(0);
			} finally {
				await f.store.close();
				f.cleanup();
			}
		});
	},
);
