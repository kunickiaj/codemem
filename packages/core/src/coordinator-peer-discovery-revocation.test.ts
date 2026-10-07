import { describe, expect, it, vi } from "vitest";
import { review, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { EXPECTED_KEY_ID } from "./coordinator-ed25519-key-id-test-fixtures.js";
import type { GrantFixture } from "./coordinator-identity-group-grant-test-harness.js";
import { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";
import {
	guardedPeerD1,
	hashGuard,
	peerDiscoveryTables,
	peerId,
	registerPeerDiscoveryContract,
	registerPeerDiscoveryFailures,
	registerPeerDiscoveryRaces,
	seedPeers,
} from "./coordinator-peer-discovery-revocation-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

function sqliteDrift(
	prepare: ReturnType<typeof setupStore>["db"]["prepare"],
	fixture: GrantFixture,
	field: string,
) {
	const args = [fixture.review.groupId, peerId(fixture, "target")];
	if (field === "remove") {
		prepare("DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?").run(...args);
		return;
	}
	if (field.startsWith("revoke")) {
		prepare(
			"INSERT INTO coordinator_device_revocations(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)",
		).run(
			field === "revoke ID" ? "device_id" : "ed25519_key",
			field === "revoke ID" ? args[1] : EXPECTED_KEY_ID,
			"fixture-revoke",
			args[0],
			args[1],
			"fixture-evidence",
			"fixture-fp",
			"2026-01-01",
		);
		return;
	}
	if (field === "group_id")
		prepare("INSERT INTO groups(group_id,created_at) VALUES('drift-group','2026-01-01')").run();
	prepare(`UPDATE enrolled_devices SET ${field} = ? WHERE group_id = ? AND device_id = ?`).run(
		field === "enabled" ? 0 : "drift-group",
		...args,
	);
}

describe.each(["SQLite", "D1"] as const)("%s peer discovery revocation", (backend) => {
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
					if (!peerDiscoveryTables.includes(table)) throw new Error("Unknown fixture table");
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
	registerPeerDiscoveryContract(test);
	if (backend === "D1") {
		const db = (f: { store: object }) => {
			const result = databases.get(f.store);
			if (!result) throw new Error("Missing fixture database");
			return result;
		};
		registerPeerDiscoveryRaces(
			test,
			(f, hook) => ({
				store: new D1CoordinatorStore(guardedPeerD1(db(f), hook)),
				restore: () => {},
			}),
			"final atomic SELECT",
		);
		registerPeerDiscoveryRaces(test, hashGuard, "first hash await");
		registerPeerDiscoveryFailures(test, db);
		test("mutating returned capture row objects during hashing cannot refresh authorization tuples", async ({
			fixture: f,
		}) => {
			// Arrange: retain references to adapter rows, then change every candidate before its hash.
			await seedPeers(f);
			const base = db(f);
			let captured: Record<string, unknown>[] = [];
			const wrapped: typeof base = {
				...base,
				prepare(sql) {
					const statement = base.prepare(sql);
					const wrap = (s: typeof statement): typeof statement => ({
						...s,
						bind: (...values) => wrap(s.bind(...values)),
						async all<T>() {
							const result = await s.all<T>();
							if (/FROM enrolled_devices/i.test(sql) && !/json_each/i.test(sql))
								captured = result.results as Record<string, unknown>[];
							return result;
						},
					});
					return wrap(statement);
				},
			};
			const store = new D1CoordinatorStore(wrapped);
			const guard = hashGuard({ ...f, store }, async () => {
				for (const row of captured) {
					if (row.device_id !== peerId(f, "target")) continue;
					row.fingerprint = "mutated-reference";
					await f.exec(
						"UPDATE enrolled_devices SET fingerprint = ? WHERE group_id = ? AND device_id = ?",
						row.fingerprint,
						f.review.groupId,
						row.device_id,
					);
				}
			});
			try {
				// Act
				const peers = await store.listGroupPeers(f.review.groupId, peerId(f, "requester"));
				// Assert
				expect(captured.length).toBeGreaterThan(0);
				expect(peers.map((p) => p.device_id)).toEqual([peerId(f, "healthy")]);
			} finally {
				guard.restore();
			}
		});
	}
});

describe("SQLite immediate peer snapshot", () => {
	it.each(["throw", "malformed"])(
		"final SQLite read %s fails closed with fixed error",
		async (mode) => {
			// Arrange
			const f = setupStore("SQLite");
			await f.store.createGroup("fixture-group");
			await f.store.enrollDevice("fixture-group", {
				deviceId: "target",
				publicKey: "opaque-key",
				fingerprint: "fixture-fp",
			});
			const original = f.db.prepare.bind(f.db);
			const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
				const statement = original(sql);
				if (/json_each/i.test(sql) && /enrolled_devices/i.test(sql)) {
					if (mode === "throw") throw new Error("private SQLite diagnostic");
					vi.spyOn(statement, "all").mockReturnValue([null]);
				}
				return statement;
			});
			try {
				// Act
				const result = f.store.listGroupPeers("fixture-group", "requester");
				// Assert
				await expect(result).rejects.toThrow(/^peer_discovery_unavailable$/);
				expect(f.db.inTransaction).toBe(false);
			} finally {
				spy.mockRestore();
				await f.store.close();
			}
		},
	);
	it.each([
		"public_key",
		"fingerprint",
		"identity_id",
		"enabled",
		"group_id",
		"remove",
		"revoke ID",
		"revoke key",
	])("final SELECT omits %s drift within its immediate transaction", async (field) => {
		// Arrange: synchronous connection instrumentation, not an impossible concurrent SQLite writer.
		const f = setupStore("SQLite");
		const original = f.db.prepare.bind(f.db);
		const fixture = {
			store: f.store,
			review: review(),
			exec: async (sql: string, ...values: unknown[]) => {
				original(sql).run(...values);
			},
			rows: async (table: string) => original(`SELECT * FROM ${table}`).all(),
		};
		await seedPeers(fixture);
		let fired = false;
		const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
			if (!fired && /json_each/i.test(sql) && /enrolled_devices/i.test(sql)) {
				fired = true;
				expect(f.db.inTransaction).toBe(true);
				sqliteDrift(original, fixture, field);
			}
			return original(sql);
		});
		try {
			// Act
			const peers = await f.store.listGroupPeers(
				fixture.review.groupId,
				peerId(fixture, "requester"),
			);
			// Assert
			expect(fired).toBe(true);
			expect(peers.map((p) => p.device_id)).toEqual([peerId(fixture, "healthy")]);
			expect(f.db.inTransaction).toBe(false);
		} finally {
			spy.mockRestore();
			await f.store.close();
		}
	});
});
