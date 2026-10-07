import { describe, expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	type RevocationFixture,
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	projectGuardedD1,
	projectInvite,
	registerProjectRevocationContract,
	registerProjectWriteGuards,
	revokeProjectReceiver,
} from "./coordinator-project-revocation-test-harness.js";
import {
	recipientSnapshot,
	recipientTables,
} from "./coordinator-recipient-revocation-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

describe.each(["SQLite", "D1"] as const)("%s project revocation", (backend) => {
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
				if (!recipientTables.includes(table)) throw new Error("Unknown project fixture table");
				return local.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
			},
		};
		databases.set(f, local);
		try {
			await use(f);
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			await local.store.close();
			if (local.db.open) local.db.close();
		}
	});
	registerProjectRevocationContract(test);
	if (backend === "D1")
		registerProjectWriteGuards(test, (f, hook, afterBatch) => {
			const local = databases.get(f);
			if (!local) throw new Error("Missing project fixture database");
			return projectGuardedD1(sqliteD1(local.db), hook, afterBatch);
		});
	test("pins every caller field before the first await", async ({ fixture: f }) => {
		// Arrange
		const { input } = await projectInvite(f);
		const original = { ...input };
		// Act
		const pending = f.store.consumeProjectInvite(input);
		Object.assign(input, {
			token: "invalid",
			operationId: "wrong",
			deviceId: "wrong",
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: fingerprintPublicKey(UNRELATED_PUBLIC_KEY),
			recipientActorId: "wrong",
			recipientDisplayName: "Wrong",
			deviceDisplayName: "Wrong",
			now: "2100-01-01T00:00:00Z",
		});
		const accepted = await pending;
		// Assert
		expect(accepted).toMatchObject({
			status: "accepted",
			invite: {
				operation_id: original.operationId,
				bound_device_id: original.deviceId,
				bound_public_key: original.publicKey,
				bound_fingerprint: original.fingerprint,
				recipient_actor_id: original.recipientActorId,
				recipient_display_name: original.recipientDisplayName,
				recipient_device_display_name: original.deviceDisplayName,
				consumed_at: original.now,
			},
		});
	});
	test("caller mutation cannot replace a pinned revoked receiver with clean subjects", async ({
		fixture: f,
	}) => {
		// Arrange
		const { input } = await projectInvite(f);
		await revokeProjectReceiver(f, input);
		const before = await recipientSnapshot(f);
		// Act
		const pending = f.store.consumeProjectInvite(input);
		input.deviceId += "-clean";
		input.publicKey = UNRELATED_PUBLIC_KEY;
		input.fingerprint = fingerprintPublicKey(input.publicKey);
		// Assert
		await expect(pending).rejects.toThrow(/^device_revoked$/);
		expect(await recipientSnapshot(f)).toEqual(before);
	});
	if (backend === "SQLite") {
		test("rolls back first binding when revocation arrives at direct enrollment INSERT", async ({
			fixture: f,
		}) => {
			// Arrange: inject real tombstones inside the same SQLite transaction.
			const local = databases.get(f);
			if (!local) throw new Error("Missing project fixture database");
			const { input } = await projectInvite(f);
			await revokeProjectReceiver(f, input);
			const records = (await f.rows("coordinator_device_revocations")) as Record<string, unknown>[];
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
			const pending = f.store.consumeProjectInvite(input);
			// Assert
			await expect(pending).rejects.toThrow(/^device_revoked$/);
			expect(injected).toBe(true);
			spy.mockRestore();
			expect(await recipientSnapshot(f)).toEqual(before);
		});
		registerProjectApi(test);
	}
});

function registerProjectApi(test: ReturnType<typeof revocationHarness>) {
	for (const scenario of ["ordinary", "revoked", "invalid token"] as const) {
		test(`real project join route maps ${scenario} without mocking acceptance`, async ({
			fixture: f,
		}) => {
			// Arrange: valid project operation, stored intent, digest, and recipient identity.
			const { input } = await projectInvite(f);
			if (scenario !== "ordinary") await revokeProjectReceiver(f, input);
			const before = await recipientSnapshot(f);
			vi.spyOn(f.store, "close").mockResolvedValue();
			const app = createCoordinatorApp({
				storeFactory: () => f.store,
				runtime: { adminSecret: () => "fixture-secret", now: () => input.now },
				requestVerifier: vi.fn(async () => ({ ok: false, error: "invalid_signature" }) as const),
			});
			// Act
			const response = await app.request("/v1/join", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					token: scenario === "invalid token" ? "invalid" : input.token,
					operation_id: input.operationId,
					device_id: input.deviceId,
					public_key: input.publicKey,
					fingerprint: input.fingerprint,
					recipient_actor_id: input.recipientActorId,
					recipient_display_name: input.recipientDisplayName,
					device_display_name: input.deviceDisplayName,
				}),
			});
			const body = await response.json();
			// Assert
			expect(response.status).toBe({ ordinary: 200, revoked: 403, "invalid token": 404 }[scenario]);
			assertProjectBody(body, scenario, input.operationId);
			if (scenario !== "ordinary") {
				expect(await recipientSnapshot(f)).toEqual(before);
			}
		});
	}
}

function assertProjectBody(
	body: unknown,
	scenario: "ordinary" | "revoked" | "invalid token",
	operationId: string,
) {
	if (scenario === "ordinary") {
		expect(body).toMatchObject({ ok: true, status: "pending_setup", operation_id: operationId });
		return;
	}
	expect(body).toEqual({ error: scenario === "revoked" ? "device_revoked" : "invite_invalid" });
}
