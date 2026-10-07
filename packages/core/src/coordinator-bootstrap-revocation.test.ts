import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { review, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	bootstrapRevocationTables,
	guardedBootstrapD1,
	registerBootstrapReceiptFailures,
	registerBootstrapRevocationContract,
	registerBootstrapStatementGuards,
} from "./coordinator-bootstrap-revocation-test-harness.js";
import { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s raw bootstrap grant revocation", (backend) => {
	const databases = new WeakMap<object, ReturnType<typeof sqliteD1>>();
	const test = contractHarness(async (use) => {
		const f = setupStore(backend);
		databases.set(f.store, sqliteD1(f.db));
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: f.store,
				review: review(),
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async (table) => {
					if (!bootstrapRevocationTables.includes(table)) throw new Error("Unknown fixture table");
					return f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
				},
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			fetch.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerBootstrapRevocationContract(test);
	if (backend === "D1") {
		registerBootstrapReceiptFailures(test, (f) => {
			const db = databases.get(f.store);
			if (!db) throw new Error("Fixture database unavailable");
			return db;
		});
		registerBootstrapStatementGuards(test, (f, hook) => {
			const db = databases.get(f.store);
			if (!db) throw new Error("Fixture database unavailable");
			return guardedBootstrapD1(db, hook);
		});
	}
});

describe("SQLite raw bootstrap transaction rollback", () => {
	beforeEach(() => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	});
	afterEach(() => {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
	it.each(["BEFORE", "AFTER"] as const)(
		"%s INSERT in-connection revocation rolls back grant and synthetic subject",
		async (stage) => {
			// Arrange: a synthetic trigger is not an external writer interleaving in an immediate transaction.
			const f = setupStore("SQLite");
			try {
				f.db.exec(`CREATE TRIGGER fixture_revoke ${stage} INSERT ON coordinator_bootstrap_grants BEGIN
				INSERT INTO coordinator_device_revocations(subject_kind, subject_value, revocation_id, evidence_group_id, evidence_device_id, evidence_public_key, evidence_fingerprint, created_at)
				VALUES ('device_id', NEW.seed_device_id, 'fixture-revocation', NEW.group_id, NEW.seed_device_id, 'opaque-fixture', 'fixture-fingerprint', '2026-10-03T00:00:00Z'); END`);
				// Act
				const result = f.store.createBootstrapGrant({
					groupId: "fixture-group",
					seedDeviceId: "fixture-seed",
					workerDeviceId: "fixture-worker",
					expiresAt: "2099-01-01",
				});
				// Assert
				await expect(result).rejects.toThrow(/^device_revoked$/);
				expect(f.db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).toEqual([]);
				expect(f.db.prepare("SELECT * FROM coordinator_device_revocations").all()).toEqual([]);
				expect(f.db.inTransaction).toBe(false);
			} finally {
				await f.store.close();
			}
		},
	);
	it("SQL failure is masked and rolls back raw grant writes", async () => {
		// Arrange
		const f = setupStore("SQLite");
		try {
			f.db.exec(
				"CREATE TRIGGER fixture_abort AFTER INSERT ON coordinator_bootstrap_grants BEGIN SELECT RAISE(ABORT, 'private SQL diagnostic'); END",
			);
			// Act
			const result = f.store.createBootstrapGrant({
				groupId: "fixture-group",
				seedDeviceId: "fixture-seed",
				workerDeviceId: "fixture-worker",
				expiresAt: "2099-01-01",
			});
			// Assert
			await expect(result).rejects.toThrow(/^bootstrap_grant_write_incomplete$/);
			expect(await f.store.listBootstrapGrants("fixture-group")).toEqual([]);
			expect(f.db.inTransaction).toBe(false);
		} finally {
			await f.store.close();
		}
	});
});
