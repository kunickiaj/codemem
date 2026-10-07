import { describe, expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	type RevocationFixture,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	recipientInvite,
	recipientSnapshot,
} from "./coordinator-recipient-revocation-test-harness.js";
import { OWNED_DENIAL, OWNED_UNAVAILABLE } from "./shared-owned-device-enrollment-test-harness.js";
import {
	bindRecipient,
	ownedRecipientSnapshot,
	ownedRecipientTables,
	registerOwnedRecipientContract,
} from "./shared-owned-recipient-invites-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

describe("SQLite owned recipient invites (retained bindings, never verified owner fixtures)", () => {
	const databases = new WeakMap<RevocationFixture, ReturnType<typeof setupStore>>();
	const test = revocationHarness(async (use) => {
		const local = setupStore("SQLite");
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
	registerOwnedRecipientContract(test);
	test("binding appears while asynchronous acceptance hashes and prevents all recipient effects", async ({
		fixture: f,
	}) => {
		// Arrange
		const { input } = await recipientInvite(f, "team_member");
		const before = await recipientSnapshot(f);
		// Act: raw fixture insertion starts synchronously while acceptance awaits hashing.
		const pending = f.store.consumeRecipientInvite(input);
		await bindRecipient(f, input);
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		expect(await recipientSnapshot(f)).toEqual(before);
		expect(await f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
	});
	test("captures owned recipient before caller mutation cannot replace it with a clean tuple", async ({
		fixture: f,
	}) => {
		// Arrange
		const { input } = await recipientInvite(f, "team_member");
		await bindRecipient(f, input);
		const before = await ownedRecipientSnapshot(f);
		// Act
		const pending = f.store.consumeRecipientInvite(input);
		Object.assign(input, {
			deviceId: "clean-device",
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
		});
		// Assert
		await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
		expect(await ownedRecipientSnapshot(f)).toEqual(before);
	});
	for (const subject of ["ID", "key"] as const) {
		for (const stage of ["recipient INSERT", "bootstrap claim", "bootstrap INSERT"] as const) {
			test(`actual synchronous ${stage} denies ${subject} bound after capture`, async ({
				fixture: f,
			}) => {
				// Arrange: inject retained recipient authority inside the real immediate transaction.
				const { input } = await recipientInvite(
					f,
					stage === "recipient INSERT" ? "team_member" : "add_device",
				);
				const gate = {
					"recipient INSERT": "INSERT INTO enrolled_devices",
					"bootstrap claim": "UPDATE coordinator_invites SET bootstrap_grant_id",
					"bootstrap INSERT": "INSERT INTO coordinator_bootstrap_grants",
				}[stage];
				const local = databases.get(f);
				if (!local) throw new Error("Missing recipient fixture database");
				const db = local.db;
				const prepare = db.prepare.bind(db);
				const before = await ownedRecipientSnapshot(f);
				let injected = false;
				const boundDevice = { ID: input.deviceId, key: "retained-other-device" }[subject];
				const boundKey = {
					ID: "b".repeat(64),
					key: "6db5e9b8a1bace1cdd9a7c6adb9e9396acc5073465d9fe8e3a0ef6d9c60d6d4f",
				}[subject];
				const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
					if (!injected && sql.includes(gate)) {
						injected = true;
						prepare(
							"INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at) VALUES (?,?,?,?,?,?,?,?)",
						).run(
							boundDevice,
							boundKey,
							input.identityId,
							"coordinator-a",
							"binding-a",
							"owner_enrollment",
							"fixture-reference",
							input.now,
						);
					}
					return prepare(sql);
				});
				try {
					// Act
					const pending = f.store.consumeRecipientInvite(input);
					// Assert: real transaction rolls back the injected ledger as well.
					await expect(pending).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
					expect(injected).toBe(true);
					spy.mockRestore();
					expect(await ownedRecipientSnapshot(f)).toEqual(before);
				} finally {
					spy.mockRestore();
				}
			});
		}
	}
	registerHttp(test);
});
type Test = ReturnType<typeof revocationHarness>;
function registerHttp(test: Test) {
	for (const kind of ["team_member", "add_device"] as const) {
		for (const scenario of [
			"unbound",
			"owned",
			"unavailable",
			"missing",
			"expired",
			"wrong fingerprint",
		] as const) {
			test(`${kind} HTTP ${scenario} preserves fixed private result and pre-ownership validation`, async ({
				fixture: f,
			}) => {
				// Arrange: public recipient route retains existing token/key validation.
				const { input } = await recipientInvite(f, kind);
				await prepareHttpState(f, input, scenario);
				Object.assign(
					input,
					{
						unbound: {},
						owned: {},
						unavailable: {},
						missing: { token: "missing-token" },
						expired: { now: "2100-01-01T00:00:00.000Z" },
						"wrong fingerprint": { fingerprint: "f".repeat(64) },
					}[scenario],
				);
				const before = await recipientSnapshot(f);
				const consume = vi.spyOn(f.store, "consumeRecipientInvite");
				const close = vi.spyOn(f.store, "close").mockResolvedValue();
				const verifier = vi.fn(async () => ({ ok: false, error: "invalid_signature" }) as const);
				const app = createCoordinatorApp({
					storeFactory: () => f.store,
					requestVerifier: verifier,
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
					// Assert
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
					const expectedBody = {
						unbound: { ok: true, status: "accepted" },
						owned: { error: OWNED_DENIAL },
						unavailable: { error: OWNED_UNAVAILABLE },
						missing: { error: "invite_invalid" },
						expired: { error: "invite_expired" },
						"wrong fingerprint": { error: "fingerprint_mismatch" },
					}[scenario];
					assertHttpBody({ body, expectedBody, accepted: scenario === "unbound" });
					if (scenario !== "unbound") expect(await recipientSnapshot(f)).toEqual(before);
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
function assertHttpBody(options: { body: unknown; expectedBody: unknown; accepted: boolean }) {
	if (options.accepted) expect(options.body).toMatchObject(options.expectedBody);
	else expect(options.body).toEqual(options.expectedBody);
}
async function prepareHttpState(
	f: RevocationFixture,
	input: Parameters<typeof bindRecipient>[1],
	scenario: string,
) {
	if (scenario !== "unbound") await bindRecipient(f, input);
	if (scenario === "unavailable") await f.exec("DROP TABLE coordinator_device_ownership_bindings");
}
