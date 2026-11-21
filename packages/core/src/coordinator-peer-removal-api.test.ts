import { describe, expect, vi } from "vitest";
import { verifyCloudflareCoordinatorRequest } from "../../cloudflare-coordinator-worker/src/request-verifier.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	checkValueBytes,
	peerRemovalApiHarness,
	registerPeerRemovalApiContract,
} from "./coordinator-peer-removal-api-test-harness.js";
import { expectRemovalProgressListings } from "./coordinator-removal-progress-listing-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

describe.each(["SQLite", "D1"] as const)("%s signed peer removal API", (backend) => {
	let sequence = 0;
	const test = peerRemovalApiHarness(async (use) => {
		const f = setupStore(backend);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		try {
			await use({
				store: f.store,
				verifyRequest: verifyCloudflareCoordinatorRequest,
				valueBound: async (action) => {
					const bytes: number[] = [];
					const original = f.db.prepare.bind(f.db);
					const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
						const statement = original(sql);
						const run = statement.run.bind(statement);
						statement.run = (...values: unknown[]) => {
							checkValueBytes(values, bytes);
							return run(...values);
						};
						return statement;
					});
					try {
						return { response: await action(), bytes };
					} finally {
						spy.mockRestore();
					}
				},
				freshStore: backend === "D1" ? () => new D1CoordinatorStore(sqliteD1(f.db)) : undefined,
				prefix: `peer-route-${backend}-${++sequence}`,
				exec: async (sql, ...values) => {
					f.db.prepare(sql).run(...values);
				},
				rows: async <T>(sql: string, ...values: (string | number | null)[]) =>
					f.db.prepare(sql).all(...values) as T[],
				measure: async (action) => {
					const prepare = vi.spyOn(f.db, "prepare");
					try {
						return { response: await action(), sql: prepare.mock.calls.map(([sql]) => sql) };
					} finally {
						prepare.mockRestore();
					}
				},
			});
		} finally {
			try {
				expect(globalThis.fetch).not.toHaveBeenCalled();
			} finally {
				vi.restoreAllMocks();
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		}
	});
	registerPeerRemovalApiContract(test);
	test("lists advertised removal progress even after presence expires", ({ fixture }) =>
		expectRemovalProgressListings(fixture));
});
