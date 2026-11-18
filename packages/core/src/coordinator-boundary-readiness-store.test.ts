import { readdirSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { initializeBaseSchema } from "./better-sqlite-coordinator-store.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	BOUNDARY_READINESS_MIGRATION_NAME,
	BOUNDARY_READINESS_SCHEMA_SQL,
	BOUNDARY_READINESS_STORAGE_PRESENT_SQL,
} from "./coordinator-boundary-readiness.js";
import {
	BOUNDARY_READINESS_CLOCK_MS,
	boundaryReadinessHarness,
	registerBoundaryReadinessContract,
} from "./coordinator-boundary-readiness-test-harness.js";

const normalize = (sql: string) => sql.replace(/\s+/gu, " ").trim();
const TABLES = ["coordinator_boundary_readiness_projects", "coordinator_boundary_readiness"];

it("keeps migration 0050 and the Worker schema aligned with the shared readiness SQL", () => {
	const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
	const migration = readdirSync(new URL("migrations/", worker)).find((name) =>
		name.startsWith("0050_"),
	);
	expect(migration).toBe(BOUNDARY_READINESS_MIGRATION_NAME);

	const files = [
		readFileSync(new URL("schema.sql", worker), "utf8"),
		readFileSync(new URL(`migrations/${migration}`, worker), "utf8"),
	].map(normalize);

	for (const file of files) expect(file).toContain(normalize(BOUNDARY_READINESS_SCHEMA_SQL));
});

describe.each(["SQLite", "D1"] as const)("%s readiness record contract", (backend) => {
	let sequence = 0;
	const test = boundaryReadinessHarness(async (use) => {
		const f = setupStore(backend, { authClock: () => BOUNDARY_READINESS_CLOCK_MS });
		try {
			await use({ store: f.store, prefix: `readiness-${++sequence}` });
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerBoundaryReadinessContract(test);
});

describe.each(["SQLite", "D1"] as const)("%s coordinator without readiness storage", (backend) => {
	function withoutStorage() {
		const f = setupStore(backend);
		for (const table of TABLES) f.db.exec(`DROP TABLE ${table}`);
		return f;
	}
	const device = { groupId: "group-a", deviceId: "device-a" };

	it("answers that readiness records are unavailable", async () => {
		const { store } = withoutStorage();

		const result = await store.putBoundaryReadiness({ ...device, sequence: 1, projects: [] });

		expect(result).toEqual({ kind: "unavailable" });
	});

	it("reads no record and has nothing to discard", async () => {
		const { store } = withoutStorage();

		expect(await store.getBoundaryReadiness(device)).toBeNull();
		expect(await store.discardBoundaryReadiness(device)).toBe(false);
	});
});

describe("readiness storage on the SQLite coordinator", () => {
	const present = (db: Database.Database) =>
		db.prepare(BOUNDARY_READINESS_STORAGE_PRESENT_SQL).pluck().get();

	it("is installed when a database from an earlier release is opened", () => {
		const db = new Database(":memory:");
		initializeBaseSchema(db);
		for (const table of TABLES) db.exec(`DROP TABLE ${table}`);
		expect(present(db)).toBe(0);

		initializeBaseSchema(db);

		expect(present(db)).toBe(1);
		db.close();
	});

	it("is not present while only one of its tables exists", () => {
		const db = new Database(":memory:");
		initializeBaseSchema(db);
		db.exec("DROP TABLE coordinator_boundary_readiness_projects");

		expect(present(db)).toBe(0);
		db.close();
	});
});
