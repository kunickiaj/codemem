import { describe, expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import {
	revocationHarness,
	revocationInput,
} from "./coordinator-device-revocation-test-harness.js";
import {
	registerEnrollmentRevocationContract,
	UNRELATED_PUBLIC_KEY,
} from "./coordinator-enrollment-revocation-test-harness.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

describe.each(["SQLite", "D1"] as const)("%s enrollment revocation", (backend) => {
	const test = revocationHarness(async (use) => {
		const f = setupStore(backend);
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
	registerEnrollmentRevocationContract(test);
});

it("SQLite identity-conflict upsert still refuses a different identity without changing fields", async () => {
	// Arrange
	const f = setupStore("SQLite");
	const input = { ...revocationInput(), identityId: "identity-original" };
	try {
		await f.store.createGroup(input.groupId);
		await f.store.enrollDevice(input.groupId, input);
		const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
		// Act
		const pending = f.store.enrollDevice(input.groupId, {
			...input,
			identityId: "identity-other",
			displayName: "Other",
		});
		// Assert
		await expect(pending).rejects.toThrow(/^invite_identity_conflict$/);
		expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
	} finally {
		await f.store.close();
	}
});

describe("D1 enrollment write interleavings", () => {
	for (const operation of ["enroll", "enable"] as const) {
		it.each(["device_id", "ed25519_key"] as const)(
			`${operation} denies %s revocation injected immediately before its SQL write`,
			async (subject) => {
				// Arrange: retain genuine current-tuple revocation records, then restore at the write.
				const f = setupStore("D1");
				const input = revocationInput();
				try {
					await f.store.createGroup(input.groupId);
					await f.store.enrollDevice(input.groupId, input);
					await f.store.setDeviceEnabled(input.groupId, input.deviceId, false);
					await f.store.createDeviceRevocation(input);
					const tombstones = f.db
						.prepare("SELECT * FROM coordinator_device_revocations")
						.all()
						.filter((row) => (row as Record<string, unknown>).subject_kind === subject) as Record<
						string,
						unknown
					>[];
					f.db.prepare("DELETE FROM coordinator_device_revocations").run();
					const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
					const beforeWrite = vi.fn((sql: string) => {
						if (
							!sql.includes("INSERT INTO enrolled_devices") &&
							!sql.includes("UPDATE enrolled_devices SET enabled")
						)
							return;
						for (const row of tombstones) {
							const columns = Object.keys(row);
							f.db
								.prepare(
									`INSERT INTO coordinator_device_revocations (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
								)
								.run(...Object.values(row));
						}
					});
					const racing = new D1CoordinatorStore(sqliteD1(f.db, { beforeWrite }));
					// Act
					const pending =
						operation === "enroll"
							? racing.enrollDevice(input.groupId, { ...input, displayName: "Must not write" })
							: racing.setDeviceEnabled(input.groupId, input.deviceId, true);
					// Assert
					if (operation === "enroll") await expect(pending).rejects.toThrow(/^device_revoked$/);
					else expect(await pending).toBe(false);
					expect(beforeWrite).toHaveBeenCalled();
					expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
					expect(f.db.prepare("SELECT * FROM coordinator_device_revocations").all()).toEqual(
						tombstones,
					);
				} finally {
					await f.store.close();
					if (f.db.open) f.db.close();
				}
			},
		);
	}
});

describe("D1 public-key capture", () => {
	it("enable cannot write after the stored key rotates between lookup and UPDATE", async () => {
		// Arrange: the target ID is eligible; only the rotated key is revoked.
		const f = setupStore("D1");
		const input = revocationInput();
		try {
			await f.store.createGroup(input.groupId);
			await f.store.enrollDevice(input.groupId, input);
			await f.store.createDeviceRevocation(input);
			const target = { ...input, deviceId: "unrevoked-target", publicKey: UNRELATED_PUBLIC_KEY };
			await f.store.enrollDevice(target.groupId, target);
			await f.store.setDeviceEnabled(target.groupId, target.deviceId, false);
			const beforeWrite = vi.fn((sql: string) => {
				if (!sql.includes("UPDATE enrolled_devices SET enabled")) return;
				f.db
					.prepare("UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?")
					.run(input.publicKey, target.deviceId);
			});
			const racing = new D1CoordinatorStore(sqliteD1(f.db, { beforeWrite }));
			// Act
			const result = await racing.setDeviceEnabled(target.groupId, target.deviceId, true);
			// Assert
			expect(beforeWrite).toHaveBeenCalled();
			expect(result).toBe(false);
			expect(await f.store.getEnrollment(target.groupId, target.deviceId, true)).toMatchObject({
				public_key: input.publicKey,
				enabled: 0,
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	it("enroll captures options before awaiting key derivation so a public-key swap cannot bypass revocation", async () => {
		// Arrange
		const f = setupStore("D1");
		const input = revocationInput();
		try {
			await f.store.createGroup(input.groupId);
			await f.store.enrollDevice(input.groupId, input);
			await f.store.createDeviceRevocation(input);
			const options = {
				...input,
				deviceId: "unrevoked-target",
				publicKey: UNRELATED_PUBLIC_KEY,
			};
			// Act: mutate the caller-owned object in the first asynchronous gap.
			const pending = f.store.enrollDevice(options.groupId, options);
			options.publicKey = input.publicKey;
			await pending;
			// Assert
			expect(await f.store.getEnrollment(input.groupId, options.deviceId)).toMatchObject({
				public_key: UNRELATED_PUBLIC_KEY,
			});
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
	it("revocation after a completed enrollment does not retroactively undo that write", async () => {
		// Arrange
		const f = setupStore("D1");
		const input = revocationInput();
		try {
			await f.store.createGroup(input.groupId);
			// Act
			await f.store.enrollDevice(input.groupId, input);
			const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
			await f.store.createDeviceRevocation(input);
			// Assert: the earlier successful write is a valid linearization point.
			expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
			expect(await f.store.setDeviceEnabled(input.groupId, input.deviceId, true)).toBe(false);
		} finally {
			await f.store.close();
			if (f.db.open) f.db.close();
		}
	});
});

describe("SQLite atomic enrollment guards", () => {
	for (const operation of ["enroll", "enable"] as const) {
		it(`${operation} observes revocation inserted immediately before the guarded statement`, async () => {
			// Arrange: intercept preparation inside the transaction, before SQL evaluates its guard.
			const f = setupStore("SQLite");
			const input = revocationInput();
			try {
				await f.store.createGroup(input.groupId);
				await f.store.enrollDevice(input.groupId, input);
				await f.store.setDeviceEnabled(input.groupId, input.deviceId, false);
				const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
				const prepare = f.db.prepare.bind(f.db);
				const spy = vi.spyOn(f.db, "prepare").mockImplementation((sql) => {
					if (
						sql.includes("INSERT INTO enrolled_devices") ||
						sql.includes("UPDATE enrolled_devices SET enabled = 1")
					) {
						prepare(
							`INSERT INTO coordinator_device_revocations (subject_kind, subject_value, revocation_id, evidence_group_id, evidence_device_id, evidence_public_key, evidence_fingerprint, actor_id, created_at) VALUES ('device_id', ?, 'fixture-action', ?, ?, ?, ?, 'fixture-actor', '2026-10-06')`,
						).run(
							input.deviceId,
							input.groupId,
							input.deviceId,
							input.publicKey,
							input.fingerprint,
						);
					}
					return prepare(sql);
				});
				// Act
				const pending =
					operation === "enroll"
						? f.store.enrollDevice(input.groupId, input)
						: f.store.setDeviceEnabled(input.groupId, input.deviceId, true);
				// Assert: INSERT rejection rolls its transaction back; enable returns no changes.
				if (operation === "enroll") await expect(pending).rejects.toThrow(/^device_revoked$/);
				else expect(await pending).toBe(false);
				expect(spy.mock.calls.some(([sql]) => sql.includes("coordinator_device_revocations"))).toBe(
					true,
				);
				expect(prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
				spy.mockRestore();
			} finally {
				await f.store.close();
			}
		});
	}
});

describe.each(["SQLite", "D1"] as const)("%s admin enrollment boundary", (backend) => {
	for (const scenario of ["ordinary", "revoked", "bad credential"] as const) {
		it(`${scenario} returns a fixed status and respects credential ordering`, async () => {
			// Arrange: a real disposable store exercises error translation without fake store methods.
			const f = setupStore(backend);
			const input = revocationInput();
			input.fingerprint = fingerprintPublicKey(input.publicKey);
			const close = vi.spyOn(f.store, "close").mockResolvedValue();
			const storeFactory = vi.fn(() => f.store);
			const verifier = vi.fn(async () => ({ ok: false, error: "invalid_signature" }) as const);
			const app = createCoordinatorApp({
				storeFactory,
				runtime: {
					adminSecret: () => "disposable-test-credential",
					now: () => "2026-10-06T00:00:00.000Z",
				},
				requestVerifier: verifier,
			});
			try {
				await f.store.createGroup(input.groupId);
				if (scenario !== "ordinary") {
					await f.store.enrollDevice(input.groupId, input);
					await f.store.createDeviceRevocation(input);
				}
				const before = f.db.prepare("SELECT * FROM enrolled_devices").all();
				// Act
				const response = await app.request("/v1/admin/devices", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Codemem-Coordinator-Admin":
							scenario === "bad credential" ? "wrong" : "disposable-test-credential",
					},
					body: JSON.stringify({
						group_id: input.groupId,
						device_id: input.deviceId,
						public_key: input.publicKey,
						fingerprint: input.fingerprint,
					}),
				});
				// Assert
				expect(response.status).toBe(
					{ ordinary: 200, revoked: 403, "bad credential": 401 }[scenario],
				);
				await assertAdminResponse(response, scenario, storeFactory);
				if (scenario !== "ordinary")
					expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(before);
				expect(verifier).not.toHaveBeenCalled();
			} finally {
				close.mockRestore();
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		});
	}
});

async function assertAdminResponse(
	response: Response,
	scenario: "ordinary" | "revoked" | "bad credential",
	storeFactory: ReturnType<typeof vi.fn>,
) {
	if (scenario === "ordinary") expect(await response.json()).toEqual({ ok: true });
	if (scenario === "revoked") expect(await response.json()).toEqual({ error: "device_revoked" });
	if (scenario === "bad credential") expect(storeFactory).not.toHaveBeenCalled();
}
