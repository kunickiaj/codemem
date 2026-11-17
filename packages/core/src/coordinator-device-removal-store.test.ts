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
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import {
	recipientGuardedD1,
	recipientInvite,
} from "./coordinator-recipient-revocation-test-harness.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

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

describe("D1 first acceptance, statement 3", () => {
	it.each(["recipient", "Project"] as const)(
		"writes no row for a %s invitation when its bound eligibility fails after this batch's insert",
		async (family) => {
			// Arrange: the device is revoked by a trigger the moment statement 2 inserts its enrollment.
			const f = setupStore("D1");
			const fixture = {
				store: f.store,
				input: revocationInput("statement-three"),
				exec: async (sql: string, ...values: unknown[]) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async (table: string) => f.db.prepare(`SELECT * FROM ${table}`).all(),
			};
			const { input, invite } =
				family === "recipient"
					? await recipientInvite(fixture, "team_member")
					: await projectInvite(fixture);
			f.db.exec(`CREATE TRIGGER fixture_revoke_on_enrollment AFTER INSERT ON enrolled_devices
			WHEN NEW.device_id = '${input.deviceId}' BEGIN
			INSERT INTO coordinator_device_revocations(subject_kind, subject_value, revocation_id,
				evidence_group_id, evidence_device_id, evidence_public_key, evidence_fingerprint, created_at)
			VALUES ('device_id', NEW.device_id, 'fixture', NEW.group_id, NEW.device_id, NEW.public_key,
				NEW.fingerprint, 'now'); END`);
			// changes() of the statement before each token or enrollment write of the batch.
			const before: { statement: string; changes: unknown }[] = [];
			const racing = new D1CoordinatorStore(
				sqliteD1(f.db, {
					beforeWrite: (query) => {
						const statement = query.trim().replace(/\s+/gu, " ");
						if (
							!/^(UPDATE coordinator_invites SET token|INSERT INTO enrolled_devices|UPDATE enrolled_devices SET)/u.test(
								statement,
							)
						)
							return;
						before.push({ statement, changes: f.db.prepare("SELECT changes()").pluck().get() });
					},
				}),
			);
			try {
				// Act
				const pending =
					"inviteKind" in input
						? racing.consumeRecipientInvite(input)
						: racing.consumeProjectInvite(input);
				// Assert: statement 2 inserted, statement 3 changed no row, and the batch rolled back.
				await expect(pending).rejects.toThrow("device_ownership_authorization_unavailable");
				expect(before.map((entry) => entry.changes)).toEqual([expect.anything(), 1, 1, 0]);
				expect(before.map((entry) => entry.statement.split(" ").slice(0, 3).join(" "))).toEqual([
					"UPDATE coordinator_invites SET",
					"INSERT INTO enrolled_devices(",
					"UPDATE coordinator_invites SET",
					"UPDATE enrolled_devices SET",
				]);
				expect(
					f.db
						.prepare("SELECT consumed_at FROM coordinator_invites WHERE invite_id = ?")
						.pluck()
						.get(invite.invite_id),
				).toBeNull();
				expect(
					f.db.prepare("SELECT 1 FROM enrolled_devices WHERE device_id = ?").all(input.deviceId),
				).toEqual([]);
			} finally {
				await f.store.close();
				f.db.close();
			}
		},
	);
});

const DROP_REMOVAL_STORAGE_SQL = `DROP TABLE coordinator_device_removals;
	ALTER TABLE enrolled_devices DROP COLUMN key_id;
	ALTER TABLE coordinator_invites DROP COLUMN issued_after_removal_seq;
	ALTER TABLE coordinator_join_requests DROP COLUMN issued_after_removal_seq;`;

/** Recipient and Project acceptance on the earlier schema, for a new and for an enrolled device. */
function registerAcceptanceWithoutStorage(
	setupWithoutRemovalStorage: () => {
		store: CoordinatorStore;
		db: Database.Database;
		cleanup(): void;
	},
) {
	it.each([
		["recipient", "new"],
		["recipient", "enrolled"],
		["Project", "new"],
		["Project", "enrolled"],
	] as const)(
		"accepts a %s invitation for a device that is %s, in rows of the earlier shape",
		async (family, state) => {
			// Arrange
			const f = setupWithoutRemovalStorage();
			const fixture = {
				store: f.store,
				input: revocationInput("no-storage"),
				exec: async (sql: string, ...values: unknown[]) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async (table: string) => f.db.prepare(`SELECT * FROM ${table}`).all(),
			};
			try {
				const { input, invite } =
					family === "recipient"
						? await recipientInvite(fixture, "team_member")
						: await projectInvite(fixture);
				if (state === "enrolled") await f.store.enrollDevice(invite.group_id, input);
				// Act: the insert form for a new device, the update form for an enrolled one.
				const result =
					"inviteKind" in input
						? await f.store.consumeRecipientInvite(input)
						: await f.store.consumeProjectInvite(input);
				// Assert
				expect(result.status).toBe("accepted");
				const rows = f.db
					.prepare("SELECT * FROM enrolled_devices WHERE device_id = ?")
					.all(input.deviceId) as Record<string, unknown>[];
				expect(rows).toMatchObject([{ public_key: input.publicKey, enabled: 1 }]);
				expect(rows.every((row) => row.identity_id !== null && !("key_id" in row))).toBe(true);
				const invites = f.db.prepare("SELECT * FROM coordinator_invites").all() as object[];
				expect(invites.some((row) => "issued_after_removal_seq" in row)).toBe(false);
			} finally {
				await f.store.close();
				f.cleanup();
			}
		},
	);
}

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

		registerAcceptanceWithoutStorage(setupWithoutRemovalStorage);

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
			expect(triggers).toBe(DEVICE_REMOVAL_TRIGGER_NAMES.length);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
