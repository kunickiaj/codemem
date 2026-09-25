import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_PEER_ADDRESSES } from "./address-utils.js";
import { columnExists, ensureAdditiveSchemaCompatibility } from "./db.js";
import * as syncAuth from "./sync-auth.js";
import * as syncHttpClient from "./sync-http-client.js";
import * as syncIdentity from "./sync-identity.js";
import { syncOnce } from "./sync-pass.js";
import { initTestSchema } from "./test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("adds manual address provenance to an already upgraded peer database", () => {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		db.exec("ALTER TABLE sync_peers DROP COLUMN manual_addresses_json");
		expect(columnExists(db, "sync_peers", "manual_addresses_json")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "sync_peers", "manual_addresses_json")).toBe(true);
	} finally {
		db.close();
	}
});

it("bounds serial dial attempts for legacy bloated address caches", async () => {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		db.prepare(
			"INSERT INTO sync_peers (peer_device_id, pinned_fingerprint, created_at) VALUES (?, ?, ?)",
		).run("peer-1", "abc123", new Date().toISOString());
		vi.spyOn(syncIdentity, "ensureDeviceIdentity").mockReturnValue([
			"local-device-id",
			"ed25519 AAAA",
		]);
		vi.spyOn(syncAuth, "buildAuthHeaders").mockReturnValue({});
		const request = vi
			.spyOn(syncHttpClient, "requestJson")
			.mockRejectedValue(new Error("network is unreachable"));
		const addresses = Array.from(
			{ length: MAX_PEER_ADDRESSES * 20 },
			(_, index) => `http://192.0.2.${index + 1}:7337`,
		);

		const result = await syncOnce(db, "peer-1", addresses);

		expect(result.ok).toBe(false);
		expect(result.addressErrors).toHaveLength(MAX_PEER_ADDRESSES);
		expect(request).toHaveBeenCalledTimes(MAX_PEER_ADDRESSES);
	} finally {
		db.close();
	}
});
