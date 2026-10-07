import { describe, expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	type RevocationFixture,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import {
	recipientInvite,
	recipientSnapshot,
} from "./coordinator-recipient-revocation-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";
import { registerOwnedRecipientD1 } from "./owned-recipient-d1-test-harness.js";
import { OWNED_DENIAL, OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";
import {
	bindRecipient,
	ownedRecipientSnapshot,
	ownedRecipientTables,
	registerOwnedRecipientContract,
} from "./shared-owned-recipient-invites-test-harness.js";

describe("D1 owned recipient invites (retained bindings, never verified owner fixtures)", () => {
	const databases = new WeakMap<RevocationFixture, ReturnType<typeof setupStore>>();
	const test = revocationHarness(async (use) => {
		const local = setupStore("D1");
		const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
		const f: RevocationFixture = {
			store: local.store,
			input: revocationInput(),
			exec: async (sql, ...values) => {
				local.db.prepare(sql).run(...values);
			},
			rows: async (table) => {
				if (!ownedRecipientTables.includes(table))
					throw new Error("Unknown recipient fixture table");
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
	function localDatabase(f: RevocationFixture) {
		const local = databases.get(f);
		if (!local) throw new Error("Missing recipient fixture database");
		return local;
	}
	registerOwnedRecipientContract(test);
	registerOwnedRecipientD1(test, (f) => sqliteD1(localDatabase(f).db));
	for (const fault of ["read", "write"] as const) {
		test(`D1 private ${fault} diagnostic becomes fixed unavailable without effects`, async ({
			fixture: f,
		}) => {
			// Arrange
			const { input } = await recipientInvite(f, "team_member");
			const fail = () => {
				throw new Error("private database diagnostic");
			};
			const store = new D1CoordinatorStore(
				sqliteD1(localDatabase(f).db, {
					beforeRead: (sql) => {
						if (fault === "read" && sql.includes("coordinator_device_ownership_bindings")) fail();
					},
					beforeBatch: () => {
						if (fault === "write") fail();
					},
				}),
			);
			const before = await ownedRecipientSnapshot(f);
			// Act
			const pending = store.consumeRecipientInvite(input);
			// Assert
			await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_UNAVAILABLE}$`));
			expect(await ownedRecipientSnapshot(f)).toEqual(before);
		});
	}
	registerHttp(test);
});
async function prepareHttp(
	f: RevocationFixture,
	input: Parameters<typeof bindRecipient>[1],
	scenario: string,
) {
	if (scenario !== "unbound") await bindRecipient(f, input);
	if (scenario === "unavailable") await f.exec("DROP TABLE coordinator_device_ownership_bindings");
	Object.assign(
		input,
		{
			missing: { token: "missing-token" },
			expired: { now: "2100-01-01T00:00:00.000Z" },
			"wrong fingerprint": { fingerprint: "f".repeat(64) },
		}[scenario],
	);
}
function registerHttp(test: ReturnType<typeof revocationHarness>) {
	for (const kind of ["team_member", "add_device"] as const) {
		for (const scenario of [
			"unbound",
			"owned",
			"unavailable",
			"missing",
			"expired",
			"wrong fingerprint",
		] as const) {
			test(`${kind} HTTP ${scenario} preserves private result and pre-ownership validation`, async ({
				fixture: f,
			}) => {
				// Arrange: the existing public token route does not gain owner proof from hints.
				const { input } = await recipientInvite(f, kind);
				await prepareHttp(f, input, scenario);
				const before = await recipientSnapshot(f);
				const consume = vi.spyOn(f.store, "consumeRecipientInvite");
				const close = vi.spyOn(f.store, "close").mockResolvedValue();
				const app = createCoordinatorApp({
					storeFactory: () => f.store,
					requestVerifier: vi.fn(async () => ({ ok: false, error: "invalid_signature" }) as const),
					runtime: { adminSecret: () => "fixture-secret", now: () => input.now },
				});
				try {
					// Act
					const response = await app.request("/v1/join", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							token: input.token,
							invite_kind: kind,
							identity_id: input.identityId,
							device_id: input.deviceId,
							public_key: input.publicKey,
							fingerprint: input.fingerprint,
						}),
					});
					const body = await response.json();
					// Assert: exact error bodies cannot reveal database diagnostics.
					expect(response.status).toBe(
						{
							unbound: 200,
							owned: 403,
							unavailable: 503,
							missing: 404,
							expired: 410,
							"wrong fingerprint": 400,
						}[scenario],
					);
					if (scenario === "unbound") expect(body).toMatchObject({ ok: true, status: "accepted" });
					else {
						expect(body).toEqual({
							error: {
								owned: OWNED_DENIAL,
								unavailable: OWNED_UNAVAILABLE,
								missing: "invite_invalid",
								expired: "invite_expired",
								"wrong fingerprint": "fingerprint_mismatch",
							}[scenario],
						});
						expect(await recipientSnapshot(f)).toEqual(before);
					}
					if (["missing", "expired", "wrong fingerprint"].includes(scenario))
						expect(consume).not.toHaveBeenCalled();
				} finally {
					consume.mockRestore();
					close.mockRestore();
				}
			});
		}
	}
}
