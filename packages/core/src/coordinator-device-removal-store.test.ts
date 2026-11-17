import { readdirSync, readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	DEVICE_REMOVAL_COLUMNS,
	DEVICE_REMOVAL_SCHEMA_SQL,
	DEVICE_REMOVAL_TRIGGER_NAMES,
	ENROLLMENT_REMOVAL_TRIGGERS_SQL,
	hasDeviceRemovalSchema,
} from "./coordinator-device-removal.js";
import {
	REMOVAL_CLOCK_MS,
	registerDeviceRemovalContract,
	removalHarness,
} from "./coordinator-device-removal-test-harness.js";

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
		try {
			await use({
				store: f.store,
				prefix: `removal-${++sequence}`,
				exec: async (sql, ...values) => {
					prepare(sql).run(...values);
				},
				rows: async <T>(sql: string, ...values: unknown[]) => prepare(sql).all(...values) as T[],
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerDeviceRemovalContract(test);
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
