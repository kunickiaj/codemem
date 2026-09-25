import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_PEER_ADDRESSES } from "./address-utils.js";
import { columnExists, ensureAdditiveSchemaCompatibility } from "./db.js";
import * as syncAuth from "./sync-auth.js";
import { recordPeerSuccess } from "./sync-discovery.js";
import * as syncHttpClient from "./sync-http-client.js";
import * as syncIdentity from "./sync-identity.js";
import { syncOnce } from "./sync-pass.js";
import {
	loadManualPeerAddresses,
	loadPeerAddresses,
	updatePeerAddresses,
} from "./sync-peer-addresses.js";
import { initTestSchema } from "./test-utils.js";

afterEach(() => vi.restoreAllMocks());

it("adds manual address provenance to an already upgraded peer database", () => {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		ensureAdditiveSchemaCompatibility(db);
		db.exec("ALTER TABLE sync_peers DROP COLUMN manual_addresses_json");
		db.exec("ALTER TABLE sync_peers DROP COLUMN last_success_address");
		expect(columnExists(db, "sync_peers", "manual_addresses_json")).toBe(false);
		expect(columnExists(db, "sync_peers", "last_success_address")).toBe(false);

		ensureAdditiveSchemaCompatibility(db);

		expect(columnExists(db, "sync_peers", "manual_addresses_json")).toBe(true);
		expect(columnExists(db, "sync_peers", "last_success_address")).toBe(true);
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

it("keeps one working fallback without growing the manual archive after network churn", () => {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		const manual = Array.from({ length: MAX_PEER_ADDRESSES }, (_, index) => `manual-${index}:7337`);
		updatePeerAddresses(db, "peer-1", manual, { replaceTrust: true });

		for (let index = 0; index < 32; index++) {
			const working = `http://working-${index}:7337`;
			expect(recordPeerSuccess(db, "peer-1", working)[0]).toBe(working);
			expect(loadManualPeerAddresses(db, "peer-1")).toEqual(
				manual.map((address) => `http://${address}`),
			);
		}

		updatePeerAddresses(db, "peer-1", ["fresh:7337"], { coordinatorCandidates: true });
		expect(loadPeerAddresses(db, "peer-1")).toContain("http://working-31:7337");
		expect(loadPeerAddresses(db, "peer-1")).toHaveLength(MAX_PEER_ADDRESSES);
	} finally {
		db.close();
	}
});

it("tries new pairing addresses before a legacy cache already exceeds the dial limit", () => {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		const stale = Array.from(
			{ length: MAX_PEER_ADDRESSES * 3 },
			(_, index) => `stale-${index}.example:7337`,
		);
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, addresses_json, created_at) VALUES (?, ?, ?)",
		).run("peer-1", JSON.stringify(stale), new Date().toISOString());

		const paired = updatePeerAddresses(
			db,
			"peer-1",
			["paired-a.example:7337", "paired-b.example:7337"],
			{ pinnedFingerprint: "fp", replaceTrust: true },
		);

		expect(paired).toHaveLength(MAX_PEER_ADDRESSES);
		expect(paired.slice(0, 2)).toEqual([
			"http://paired-a.example:7337",
			"http://paired-b.example:7337",
		]);
		expect(loadManualPeerAddresses(db, "peer-1")).toEqual([
			...stale.map((address) => `http://${address}`),
			"http://paired-a.example:7337",
			"http://paired-b.example:7337",
		]);
		const refreshed = updatePeerAddresses(db, "peer-1", ["fresh.example:7337"], {
			coordinatorCandidates: true,
		});
		expect(refreshed).toContain("http://paired-a.example:7337");
		expect(refreshed).toContain("http://paired-b.example:7337");
	} finally {
		db.close();
	}
});
