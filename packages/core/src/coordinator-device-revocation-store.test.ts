import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	DEVICE_REVOCATION_SCHEMA_SQL,
	DeviceRevocationOperations,
} from "./coordinator-device-revocation.js";
import {
	enrollRevocation,
	nonceInput,
	registerDeviceRevocationContract,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

function restoreTombstones(db: ReturnType<typeof setupStore>["db"], rows: unknown[]) {
	for (const row of rows as Record<string, unknown>[]) {
		const columns = Object.keys(row);
		db.prepare(
			`INSERT INTO coordinator_device_revocations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		).run(...Object.values(row));
	}
}

it("aligns the global table across the module, Worker schema and migration 0027 with no namespace or FK", () => {
	// Arrange
	const worker = new URL("../../cloudflare-coordinator-worker/", import.meta.url);
	const migration = readdirSync(new URL("migrations/", worker)).find((name) =>
		name.startsWith("0027_"),
	);
	expect(migration).toBeTypeOf("string");
	const definitions = [
		DEVICE_REVOCATION_SCHEMA_SQL,
		readFileSync(new URL("schema.sql", worker), "utf8"),
		readFileSync(new URL(`migrations/${migration}`, worker), "utf8"),
	];
	// Act
	const tables = definitions.map((sql) =>
		sql
			.match(/CREATE TABLE IF NOT EXISTS coordinator_device_revocations\s*\([\s\S]*?\);/u)?.[0]
			.replace(/\s+/gu, " ")
			.trim(),
	);
	// Assert
	expect(tables[0]).toBeTypeOf("string");
	expect(tables[1]).toBe(tables[0]);
	expect(tables[2]).toBe(tables[0]);
	expect(tables[0]).not.toMatch(/coordinator_id|FOREIGN KEY|REFERENCES/iu);
});

describe.each(["SQLite", "D1"] as const)("%s device revocation contract", (backend) => {
	const test = revocationHarness(async (use) => {
		let clockTick = 0;
		const f = setupStore(backend, { authClock: () => 1791244800000 + clockTick++ });
		try {
			await use({
				store: f.store,
				input: revocationInput(),
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async (table) => f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerDeviceRevocationContract(test);
	test("does not claim admission when an ignored nonce INSERT is followed by an eligible-device read", async ({
		fixture: f,
	}) => {
		// Arrange: the final read is deliberately eligible while the insertion writes zero rows.
		await enrollRevocation(f);
		await f.exec(
			`CREATE TEMP TRIGGER ignore_nonce BEFORE INSERT ON request_nonces BEGIN SELECT RAISE(IGNORE); END;`,
		);
		// Act
		const result = await f.store.recordAuthorizedNonce(nonceInput(f));
		// Assert
		expect(result).toBe("nonce_replay");
		expect(await f.rows("request_nonces")).toEqual([]);
	});
	test("rolls back both subjects if the second insertion fails", async ({ fixture: f }) => {
		// Arrange
		await enrollRevocation(f);
		await f.exec(`CREATE TEMP TRIGGER fail_key_revocation BEFORE INSERT ON coordinator_device_revocations
			WHEN NEW.subject_kind = 'ed25519_key' BEGIN SELECT RAISE(ABORT, 'test revocation insertion failure'); END;`);
		// Act
		const pending = f.store.createDeviceRevocation(f.input);
		// Assert
		await expect(pending).rejects.toThrow("device_revocation_incomplete");
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
	test("propagates nonce insertion failure without claiming admission", async ({ fixture: f }) => {
		// Arrange
		await enrollRevocation(f);
		await f.exec(`CREATE TEMP TRIGGER fail_nonce BEFORE INSERT ON request_nonces
			BEGIN SELECT RAISE(ABORT, 'test nonce insertion failure'); END;`);
		// Act
		const pending = f.store.recordAuthorizedNonce(nonceInput(f));
		// Assert
		await expect(pending).rejects.toThrow("device_revocation_incomplete");
		expect(await f.rows("request_nonces")).toEqual([]);
	});
});

describe("D1 nonce write races", () => {
	it("rolls back on a classification read failure and admits a subsequent clean retry", async () => {
		// Arrange
		const f = setupStore("D1");
		const input = { ...revocationInput(), nonce: "read-failure-nonce", createdAt: "2026-10-06" };
		try {
			await f.store.createGroup(input.groupId);
			await f.store.enrollDevice(input.groupId, input);
			const beforeRead = (sql: string) => {
				if (sql.includes("SELECT CASE")) throw new Error("test read failure");
			};
			const faulting = new D1CoordinatorStore(sqliteD1(f.db, { beforeRead }));
			// Act
			const pending = faulting.recordAuthorizedNonce(input);
			// Assert
			await expect(pending).rejects.toThrow("device_revocation_incomplete");
			expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
			expect(await f.store.recordAuthorizedNonce(input)).toBe("recorded");
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	for (const change of ["revoked", "changed key", "disabled", "archived"] as const) {
		it(`denies ${change} injected immediately before nonce INSERT`, async () => {
			// Arrange: mutate only disposable metadata before the guarded SQL executes.
			const f = setupStore("D1");
			const input = revocationInput();
			try {
				await f.store.createGroup(input.groupId);
				await f.store.enrollDevice(input.groupId, input);
				if (change === "revoked") await f.store.createDeviceRevocation(input);
				const tombstones = f.db.prepare("SELECT * FROM coordinator_device_revocations").all();
				f.db.prepare("DELETE FROM coordinator_device_revocations").run();
				const mutations = {
					revoked: () => restoreTombstones(f.db, tombstones),
					"changed key": () =>
						f.db.prepare("UPDATE enrolled_devices SET public_key = 'new-key'").run(),
					disabled: () => f.db.prepare("UPDATE enrolled_devices SET enabled = 0").run(),
					archived: () => f.db.prepare("UPDATE groups SET archived_at = '2026-10-06'").run(),
				};
				const beforeWrite = vi.fn((sql: string) => {
					if (!sql.includes("INSERT INTO request_nonces")) return;
					mutations[change]();
				});
				const racing = new D1CoordinatorStore(sqliteD1(f.db, { beforeWrite }));
				// Act
				const result = await racing.recordAuthorizedNonce({
					...input,
					nonce: "racing-nonce",
					createdAt: "2026-10-06",
				});
				// Assert
				expect(
					beforeWrite.mock.calls.some(([sql]) => sql.includes("INSERT INTO request_nonces")),
				).toBe(true);
				expect(result).toBe(
					{
						revoked: "device_revoked",
						"changed key": "unknown_device",
						disabled: "device_disabled",
						archived: "group_archived",
					}[change],
				);
				expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
			} finally {
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		});
	}
});

describe("nonce result metadata fails closed", () => {
	const input = { ...revocationInput(), nonce: "nonce", createdAt: "2026-10-06" };
	it("accepts exactly one confirmed insertion even if the later read observes revocation", async () => {
		// Arrange
		const backend = {
			batch: vi.fn(async () => [
				{ meta: { changes: 1 } },
				{ results: [{ status: "device_revoked" }] },
			]),
			all: vi.fn(),
		};
		const operations = new DeviceRevocationOperations(backend);
		// Act
		const result = await operations.recordAuthorizedNonce(input);
		// Assert
		expect(result).toBe("recorded");
	});
	it("never promotes zero insertions to recorded when a subsequent read sees an eligible device", async () => {
		// Arrange
		const operations = new DeviceRevocationOperations({
			batch: async () => [{ meta: { changes: 0 } }, { results: [{ status: "nonce_replay" }] }],
			all: vi.fn(),
		});
		// Act
		const result = await operations.recordAuthorizedNonce(input);
		// Assert
		expect(result).toBe("nonce_replay");
	});
	for (const results of [
		[],
		[{}, { results: [{ status: "nonce_replay" }] }],
		[{ meta: { changes: 0 } }, { results: [] }],
		[{ meta: { changes: 0 } }, { results: [{ status: "recorded" }] }],
		[{ meta: { changes: 2 } }, { results: [{ status: "nonce_replay" }] }],
		[{ meta: { changes: 1 } }, {}],
	]) {
		it(`rejects ambiguous batch result ${JSON.stringify(results)}`, async () => {
			// Arrange
			const operations = new DeviceRevocationOperations({
				batch: async () => results,
				all: vi.fn(),
			});
			// Act
			const pending = operations.recordAuthorizedNonce(input);
			// Assert
			await expect(pending).rejects.toThrow("device_revocation_incomplete");
		});
	}
});
