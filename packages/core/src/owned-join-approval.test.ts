import { describe, expect, vi } from "vitest";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	type RevocationFixture,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import { JOIN_NOW } from "./coordinator-join-revocation-test-harness.js";
import {
	ownedJoinTables,
	registerOwnedJoinContract,
	registerOwnedJoinD1Guards,
} from "./shared-owned-join-approval-test-harness.js";

describe.each(["SQLite", "D1"] as const)(
	"%s owned join approval (raw ledger, not verified proof)",
	(backend) => {
		const databases = new WeakMap<RevocationFixture, ReturnType<typeof setupStore>>();
		const test = revocationHarness(async (use) => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date(JOIN_NOW));
			const local = setupStore(backend);
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
			const f: RevocationFixture = {
				store: local.store,
				input: revocationInput(),
				exec: async (sql, ...values) => {
					local.db.prepare(sql).run(...values);
				},
				rows: async (table) => {
					if (!ownedJoinTables.includes(table)) throw new Error("Unknown join fixture table");
					return local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
				},
			};
			databases.set(f, local);
			try {
				await use(f);
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				fetch.mockRestore();
				await local.store.close();
				if (local.db.open) local.db.close();
				vi.useRealTimers();
			}
		});
		registerOwnedJoinContract(test);
		if (backend === "D1")
			registerOwnedJoinD1Guards(test, (f) => {
				const local = databases.get(f);
				if (!local) throw new Error("Missing join fixture database");
				return sqliteD1(local.db);
			});
	},
);
