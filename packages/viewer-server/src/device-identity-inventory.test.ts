import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	MemoryStore,
} from "@codemem/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";

function testStore(): { store: MemoryStore; cleanup: () => void } {
	const directory = mkdtempSync(join(tmpdir(), "codemem-device-inventory-test-"));
	const dbPath = join(directory, "test.sqlite");
	const keysDir = join(directory, "keys");
	const db = new Database(dbPath);
	initTestSchema(db);
	ensureDeviceIdentity(db, { deviceId: "local-device", keysDir });
	db.close();
	const store = new MemoryStore(dbPath);
	return {
		store,
		cleanup: () => {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

describe("GET /api/sync/recipient-policy/v1/device-inventory", () => {
	it("returns injected coordinator evidence without materializing identity bindings", async () => {
		const fixture = testStore();
		try {
			const before = fixture.store.db.prepare("SELECT * FROM identity_devices").all();
			const app = createApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => ({
					availability: "available",
					safeErrorCode: null,
					enrollments: [
						{
							group_id: "group-a",
							device_id: "legacy-device",
							public_key: "legacy-key",
							fingerprint: fingerprintPublicKey("legacy-key"),
							identity_id: "unreviewed-identity",
							display_name: "Legacy laptop",
							enabled: 1,
							created_at: "2026-08-18T12:00:00.000Z",
						},
					],
				}),
			});

			const response = await app.request("/api/sync/recipient-policy/v1/device-inventory");
			const body = (await response.json()) as Record<string, unknown>;

			expect(response.status).toBe(200);
			expect(body).toMatchObject({
				version: 1,
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			});
			expect(body.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						deviceId: "legacy-device",
						state: "pairing_required",
						identityId: null,
					}),
				]),
			);
			expect(fixture.store.db.prepare("SELECT * FROM identity_devices").all()).toEqual(before);
		} finally {
			fixture.cleanup();
		}
	});

	it("keeps the local inventory available when coordinator evidence fails", async () => {
		const fixture = testStore();
		try {
			const app = createApp({
				storeFactory: () => fixture.store,
				loadDeviceIdentityCoordinatorEvidence: async () => {
					throw new Error("sensitive coordinator failure");
				},
			});

			const response = await app.request("/api/sync/recipient-policy/v1/device-inventory");
			const body = (await response.json()) as {
				coordinatorEvidence: Record<string, unknown>;
				items: Array<Record<string, unknown>>;
			};
			const serialized = JSON.stringify(body);

			expect(response.status).toBe(200);
			expect(body.coordinatorEvidence).toEqual({
				availability: "unavailable",
				safeErrorCode: "coordinator_unavailable",
			});
			expect(serialized).not.toContain("sensitive coordinator failure");
			expect(body.items).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ deviceId: "local-device", state: "setup_required" }),
				]),
			);
		} finally {
			fixture.cleanup();
		}
	});
});
