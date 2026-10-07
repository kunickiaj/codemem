import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { review, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	authorizationFixture,
	authorizationNowMs,
	bootstrapParticipant,
	registerBootstrapAuthorizationContract,
	registerBootstrapAuthorizationD1,
} from "./coordinator-bootstrap-authorization-test-harness.js";
import { bootstrapRevocationTables } from "./coordinator-bootstrap-revocation-test-harness.js";
import * as keyParser from "./coordinator-ed25519-key-id-compat.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import { contractHarness } from "./coordinator-identity-group-grant-test-harness.js";

describe.each(["SQLite", "D1"] as const)("%s current bootstrap authorization", (backend) => {
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
			expect(f.db.inTransaction).toBe(false);
		} finally {
			fetch.mockRestore();
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	registerBootstrapAuthorizationContract(test);
	if (backend === "D1")
		registerBootstrapAuthorizationD1(
			test,
			(f) => {
				const db = databases.get(f.store);
				if (!db) throw new Error("Fixture database unavailable");
				return db;
			},
			(query) => /END AS status/.test(query) && /coordinator_bootstrap_grants/.test(query),
		);
});

describe("SQLite synchronous bootstrap hash guard", () => {
	it.each(["seed", "worker"] as const)(
		"pins %s key revocation even if its row disappears during hashing",
		async (who) => {
			// Arrange: an in-connection hook tests the actual synchronous guard, not an async transaction.
			const local = setupStore("SQLite");
			const f = { store: local.store, review: review() };
			const grant = await authorizationFixture(f);
			const parse = keyParser.parseSshEd25519PublicKeyForRevocation;
			const key = who === "seed" ? CANONICAL_PUBLIC_KEY : UNRELATED_PUBLIC_KEY;
			let called = false;
			const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
			const hook = vi
				.spyOn(keyParser, "parseSshEd25519PublicKeyForRevocation")
				.mockImplementation((publicKey) => {
					const parsed = parse(publicKey);
					if (called || publicKey !== key) return parsed;
					called = true;
					expect(local.db.inTransaction).toBe(true);
					if (parsed.kind !== "ed25519") throw new Error("Expected public fixture key");
					local.db
						.prepare(
							`INSERT INTO coordinator_device_revocations(subject_kind, subject_value, revocation_id, evidence_group_id, evidence_device_id, evidence_public_key, evidence_fingerprint, created_at) VALUES ('ed25519_key', ?, ?, ?, ?, ?, ?, ?)`,
						)
						.run(
							createHash("sha256").update(parsed.blob).digest("hex"),
							"fixture-key-revocation",
							f.review.groupId,
							bootstrapParticipant(f, who),
							key,
							f.review.fingerprint,
							"2026-10-07T00:00:00Z",
						);
					local.db
						.prepare("DELETE FROM enrolled_devices WHERE group_id = ? AND device_id = ?")
						.run(f.review.groupId, bootstrapParticipant(f, who));
					return parsed;
				});
			try {
				// Act
				const pending = f.store.getBootstrapGrantAuthorization({
					grantId: grant.grant_id,
					nowMs: authorizationNowMs,
				});
				// Assert: no transaction remains open while the returned promise is awaited.
				expect(local.db.inTransaction).toBe(false);
				expect(await pending).toEqual({ kind: "rejected", error: "device_revoked" });
				expect(called).toBe(true);
				expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual(grant);
				expect(fetch).not.toHaveBeenCalled();
			} finally {
				hook.mockRestore();
				fetch.mockRestore();
				await f.store.close();
			}
		},
	);
});
