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
	ENROLLMENT_REMOVAL_TRIGGERS_SQL,
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

		it("keeps every enrollment and invitation writer working and reports removal as unavailable", async () => {
			// Arrange
			const f = setupWithoutRemovalStorage();
			const first = await removalDeviceKey("no-storage-first");
			const second = await removalDeviceKey("no-storage-second");
			const enrollment = (key: typeof first) => ({
				deviceId: "d1",
				publicKey: key.publicKey,
				fingerprint: key.fingerprint,
			});
			try {
				// Act: insert, update, invitation, join request, and approval of an enrolled device.
				await f.store.createGroup("g1");
				await f.store.enrollDevice("g1", enrollment(first));
				await f.store.enrollDevice("g1", enrollment(second));
				const invite = await f.store.createInvite({
					groupId: "g1",
					policy: "approval_required",
					expiresAt: "2099-01-01T00:00:00.000Z",
				});
				const request = await f.store.createJoinRequest({
					groupId: "g1",
					...enrollment(first),
					token: invite.token,
				});
				const joiner = await f.store.createJoinRequest({
					groupId: "g1",
					...enrollment(first),
					deviceId: "d2",
					token: invite.token,
				});
				const reviews = [
					await f.store.reviewJoinRequest({ requestId: request.request_id, approved: true }),
					await f.store.reviewJoinRequest({ requestId: joiner.request_id, approved: true }),
				];
				const removal = f.store.removeEnrollment({ groupId: "g1", deviceId: "d1" });
				const fill = f.store.fillEnrollmentKeyIds();
				// Assert
				expect(reviews.map((review) => review?.status)).toEqual(["approved", "approved"]);
				expect(
					f.db
						.prepare("SELECT device_id, public_key FROM enrolled_devices ORDER BY device_id")
						.all(),
				).toEqual([
					{ device_id: "d1", public_key: first.publicKey },
					{ device_id: "d2", public_key: first.publicKey },
				]);
				await expect(removal).rejects.toThrow("device_removal_unavailable");
				await expect(fill).rejects.toThrow("device_removal_unavailable");
				expect(await f.store.removeDevice("g1", "d2")).toBe(true);
			} finally {
				await f.store.close();
				f.cleanup();
			}
		});

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

describe("SQLite schema initialization", () => {
	it("A13 fills the key ID of enrollments that an earlier release wrote, when the file is opened", async () => {
		// Arrange: a coordinator file whose rows predate the key ID column's writers.
		const directory = mkdtempSync(join(tmpdir(), "codemem-removal-"));
		const path = join(directory, "coordinator.sqlite");
		const key = await removalDeviceKey("earlier-release");
		try {
			const first = new BetterSqliteCoordinatorStore(path);
			await first.createGroup("g1");
			const insert = first.db.prepare(
				`INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, enabled, created_at)
				VALUES ('g1', ?, ?, 'fp', 1, '2026-01-01T00:00:00.000Z')`,
			);
			insert.run("ed25519-device", key.publicKey);
			insert.run("opaque-device", "pk1");
			await first.close();
			// Act
			const reopened = new BetterSqliteCoordinatorStore(path);
			const rows = reopened.db
				.prepare("SELECT device_id, key_id FROM enrolled_devices ORDER BY device_id")
				.all();
			await reopened.close();
			// Assert
			expect(rows).toEqual([
				{ device_id: "ed25519-device", key_id: key.keyId },
				{ device_id: "opaque-device", key_id: "" },
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("adds removal storage to a coordinator file from an earlier release without changing its rows", () => {
		// Arrange: the three tables as earlier releases created them, with one row each.
		const directory = mkdtempSync(join(tmpdir(), "codemem-removal-"));
		const path = join(directory, "coordinator.sqlite");
		try {
			const old = new Database(path);
			old.exec(`CREATE TABLE enrolled_devices (group_id TEXT NOT NULL, device_id TEXT NOT NULL,
				public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, display_name TEXT,
				enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
				PRIMARY KEY (group_id, device_id));
				CREATE TABLE coordinator_invites (invite_id TEXT PRIMARY KEY, group_id TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL, created_by TEXT, team_name_snapshot TEXT, revoked_at TEXT);
				INSERT INTO enrolled_devices VALUES ('g1', 'd1', 'pk1', 'fp1', NULL, 1, 'then');
				INSERT INTO coordinator_invites VALUES ('i1', 'g1', 't1', 'auto_admit', 'later', 'then', NULL, NULL, NULL);`);
			old.close();
			// Act
			const store = new BetterSqliteCoordinatorStore(path);
			const enrollment = store.db.prepare("SELECT device_id, key_id FROM enrolled_devices").all();
			const invite = store.db
				.prepare("SELECT invite_id, issued_after_removal_seq FROM coordinator_invites")
				.all();
			const triggers = store.db
				.prepare(
					`SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger'
					AND tbl_name = 'coordinator_device_removals'`,
				)
				.pluck()
				.get();
			store.db.close();
			// Assert
			expect(enrollment).toEqual([{ device_id: "d1", key_id: "" }]);
			expect(invite).toEqual([{ invite_id: "i1", issued_after_removal_seq: null }]);
			expect(triggers).toBe(3);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
