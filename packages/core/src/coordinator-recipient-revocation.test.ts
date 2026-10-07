import { describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	type RevocationFixture,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	recipientGuardedD1,
	recipientInvite,
	recipientSnapshot,
	recipientTables,
	registerRecipientRevocationContract,
	registerRecipientWriteGuards,
	revokeRecipient,
} from "./coordinator-recipient-revocation-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

describe.each(["SQLite", "D1"] as const)("%s recipient revocation", (backend) => {
	const databases = new WeakMap<RevocationFixture, ReturnType<typeof setupStore>>();
	const test = revocationHarness(async (use) => {
		const local = setupStore(backend);
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const f: RevocationFixture = {
			store: local.store,
			input: revocationInput(),
			exec: async (sql, ...values) => {
				local.db.prepare(sql).run(...values);
			},
			rows: async (table) => {
				if (!recipientTables.includes(table)) throw new Error("Unknown recipient fixture table");
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
		}
	});
	registerRecipientRevocationContract(test);
	if (backend === "D1")
		registerRecipientWriteGuards(test, (f, hook) => {
			const local = databases.get(f);
			if (!local) throw new Error("Missing recipient fixture database");
			return recipientGuardedD1(sqliteD1(local.db), hook);
		});
	test("captures every recipient field before the first await", async ({ fixture: f }) => {
		// Arrange
		const { input } = await recipientInvite(f, "team_member");
		const original = { ...input };
		// Act
		const pending = f.store.consumeRecipientInvite(input);
		Object.assign(input, {
			token: "invalid",
			inviteKind: "add_device",
			identityId: "wrong",
			deviceId: "wrong",
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
			recipientDisplayName: "Wrong",
			deviceDisplayName: "Wrong",
		});
		const accepted = await pending;
		// Assert
		expect(accepted).toMatchObject({
			status: "accepted",
			invite: {
				bound_device_id: original.deviceId,
				bound_public_key: original.publicKey,
				bound_fingerprint: original.fingerprint,
				recipient_actor_id: original.identityId,
				recipient_display_name: original.recipientDisplayName,
				recipient_device_display_name: original.deviceDisplayName,
			},
		});
	});
});

describe("SQLite direct recipient INSERT gate", () => {
	for (const kind of ["team_member", "add_device"] as const) {
		it(`${kind} cannot bypass revocation inserted immediately before the direct enrollment INSERT`, async () => {
			// Arrange: the first recipient path inserts directly rather than calling enrollDevice.
			const local = setupStore("SQLite");
			const f: RevocationFixture = {
				store: local.store,
				input: revocationInput(),
				exec: async (sql, ...values) => {
					local.db.prepare(sql).run(...values);
				},
				rows: async (table) => local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
			};
			try {
				const { input } = await recipientInvite(f, kind);
				await revokeRecipient(f, input);
				const records = (await f.rows("coordinator_device_revocations")) as Record<
					string,
					unknown
				>[];
				await f.exec("DELETE FROM coordinator_device_revocations");
				const before = await recipientSnapshot(f);
				const prepare = local.db.prepare.bind(local.db);
				let injected = false;
				const spy = vi.spyOn(local.db, "prepare").mockImplementation((sql) => {
					if (!injected && sql.includes("INSERT INTO enrolled_devices")) {
						injected = true;
						for (const row of records) {
							const columns = Object.keys(row);
							prepare(
								`INSERT INTO coordinator_device_revocations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
							).run(...Object.values(row));
						}
					}
					return prepare(sql);
				});
				// Act
				const pending = local.store.consumeRecipientInvite(input);
				// Assert: the SQLite transaction may roll back injected records, unlike native D1 hooks.
				await expect(pending).rejects.toThrow(/^device_revoked$/);
				expect(injected).toBe(true);
				spy.mockRestore();
				expect(await recipientSnapshot(f)).toEqual(before);
			} finally {
				vi.restoreAllMocks();
				await local.store.close();
			}
		});
	}
});

describe("real SQLite recipient API errors", () => {
	for (const kind of ["team_member", "add_device"] as const) {
		it.each(["ordinary", "revoked", "invalid token"] as const)(
			`${kind} %s has a fixed response and validates the invite before revocation`,
			async (scenario) => {
				// Arrange
				const local = setupStore("SQLite");
				const close = vi.spyOn(local.store, "close").mockResolvedValue();
				const f: RevocationFixture = {
					store: local.store,
					input: revocationInput(),
					exec: async (sql, ...values) => {
						local.db.prepare(sql).run(...values);
					},
					rows: async (table) => local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
				};
				try {
					const { input } = await recipientInvite(f, kind);
					if (scenario !== "ordinary") await revokeRecipient(f, input);
					const before = await recipientSnapshot(f);
					const lookup = vi.spyOn(local.store, "listDeviceRevocations");
					const consume = vi.spyOn(local.store, "consumeRecipientInvite");
					const app = createCoordinatorApp({
						storeFactory: () => local.store,
						runtime: { adminSecret: () => "fixture-secret", now: () => input.now },
						requestVerifier: vi.fn(
							async () => ({ ok: false, error: "invalid_signature" }) as const,
						),
					});
					// Act
					const response = await app.request("/v1/join", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							token: scenario === "invalid token" ? "invalid" : input.token,
							invite_kind: kind,
							identity_id: input.identityId,
							device_id: input.deviceId,
							public_key: input.publicKey,
							fingerprint: input.fingerprint,
						}),
					});
					const body = await response.json();
					// Assert
					assertRecipientResponse(response.status, body, scenario);
					if (scenario !== "ordinary") expect(await recipientSnapshot(f)).toEqual(before);
					if (scenario === "invalid token") {
						expect(consume).not.toHaveBeenCalled();
						expect(lookup).not.toHaveBeenCalled();
					}
				} finally {
					close.mockRestore();
					await local.store.close();
				}
			},
		);
	}
});

function assertRecipientResponse(
	status: number,
	body: unknown,
	scenario: "ordinary" | "revoked" | "invalid token",
) {
	expect(status).toBe({ ordinary: 200, revoked: 403, "invalid token": 404 }[scenario]);
	if (scenario === "ordinary") {
		expect(body).toMatchObject({ ok: true, status: "accepted" });
		return;
	}
	expect(body).toEqual({ error: scenario === "revoked" ? "device_revoked" : "invite_invalid" });
}
