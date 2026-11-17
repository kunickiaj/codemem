import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBetterSqliteCoordinatorApp } from "./better-sqlite-coordinator-runtime.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { fetchRevokedPinnedPeers } from "./coordinator-peer-revocation.js";
import { removeCoordinatorRevokedPeers } from "./coordinator-runtime.js";
import { readCoordinatorSyncConfig } from "./coordinator-sync-config.js";
import { getRetirementPeer } from "./memory-retirement-trust.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import { initTestSchema } from "./test-utils.js";

const COORDINATOR = "https://coordinator.example.test";

interface DeviceKeys {
	deviceId: string;
	fingerprint: string;
	publicKey: string;
}

function createDevice(root: string, name: string): DeviceKeys {
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		const keysDir = join(root, `${name}-keys`);
		const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
		const publicKey = loadPublicKey(keysDir);
		if (!publicKey) throw new Error(`missing ${name} public key`);
		return { deviceId, fingerprint, publicKey };
	} finally {
		db.close();
	}
}

let root: string;
let coordinatorDbPath: string;
let localDb: Database.Database;
let localKeysDir: string;
let localDeviceId: string;
let retired: DeviceKeys;
let active: DeviceKeys;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "codemem-peer-revocation-"));
	coordinatorDbPath = join(root, "coordinator.sqlite");
	localKeysDir = join(root, "local-keys");
	localDb = new Database(":memory:");
	initTestSchema(localDb);
	const [deviceId, localFingerprint] = ensureDeviceIdentity(localDb, { keysDir: localKeysDir });
	localDeviceId = deviceId;
	const localPublicKey = loadPublicKey(localKeysDir) ?? "";
	retired = createDevice(root, "retired");
	active = createDevice(root, "active");

	const coordinator = new BetterSqliteCoordinatorStore(coordinatorDbPath);
	try {
		await coordinator.createGroup("group-a");
		const local = {
			deviceId: localDeviceId,
			fingerprint: localFingerprint,
			publicKey: localPublicKey,
		};
		for (const device of [local, retired, active])
			await coordinator.enrollDevice("group-a", device);
	} finally {
		await coordinator.close();
	}
	// Same-person pairings that coordinator membership refreshes never delete.
	const pair = localDb.prepare(
		`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, actor_id, created_at)
		 VALUES (?, ?, ?, 'identity-self', ?)`,
	);
	for (const device of [retired, active])
		pair.run(device.deviceId, device.fingerprint, device.publicKey, new Date().toISOString());
	const now = new Date().toISOString();
	localDb
		.prepare(
			"INSERT INTO replication_cursors(peer_device_id, last_applied_cursor, updated_at) VALUES (?, 'c1', ?)",
		)
		.run(retired.deviceId, now);
	localDb
		.prepare(
			`INSERT INTO replication_cursors_v2(peer_device_id, scope_id, last_applied_cursor, updated_at)
			 VALUES (?, 'scope-a', 'c1', ?)`,
		)
		.run(retired.deviceId, now);
});

afterEach(() => {
	vi.unstubAllGlobals();
	localDb.close();
	rmSync(root, { recursive: true, force: true });
});

async function revoke(device: DeviceKeys) {
	const coordinator = new BetterSqliteCoordinatorStore(coordinatorDbPath);
	try {
		const result = await coordinator.createDeviceRevocation({ groupId: "group-a", ...device });
		expect(result.kind).toBe("revoked");
	} finally {
		await coordinator.close();
	}
}

function routeFetchTo(app: { request: (url: string, init?: RequestInit) => Promise<Response> }) {
	vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) =>
		app.request(String(input), init),
	);
}

function pairedPeerIds(): string[] {
	return (
		localDb
			.prepare("SELECT peer_device_id FROM sync_peers ORDER BY peer_device_id")
			.all() as Array<{
			peer_device_id: string;
		}>
	).map((row) => row.peer_device_id);
}

function refresh() {
	return removeCoordinatorRevokedPeers(
		{ db: localDb, dbPath: ":memory:" },
		readCoordinatorSyncConfig({
			sync_coordinator_url: COORDINATOR,
			sync_coordinator_groups: ["group-a"],
		}),
		{ keysDir: localKeysDir },
	);
}

describe("coordinator peer revocation refresh", () => {
	it("removes a directly paired device that the coordinator revoked", async () => {
		await revoke(retired);
		routeFetchTo(createBetterSqliteCoordinatorApp({ dbPath: coordinatorDbPath }));

		const result = await refresh();

		expect(result.revoked).toBe(1);
		expect(pairedPeerIds()).toEqual([active.deviceId]);
		expect(getRetirementPeer(localDb, { localDeviceId, peerDeviceId: retired.deviceId })).toEqual({
			deviceId: retired.deviceId,
			publicKey: retired.publicKey,
		});
		for (const table of ["replication_cursors", "replication_cursors_v2"])
			expect(
				localDb
					.prepare(`SELECT COUNT(*) FROM ${table} WHERE peer_device_id = ?`)
					.pluck()
					.get(retired.deviceId),
			).toBe(0);
	});

	it("keeps every pairing when the coordinator can't answer the check", async () => {
		await revoke(retired);
		const app = createBetterSqliteCoordinatorApp({ dbPath: coordinatorDbPath });
		// An older coordinator has no revocation check route.
		routeFetchTo({
			request: (url, init) =>
				url.includes("/v1/peers/revocations")
					? Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }))
					: app.request(url, init),
		});

		const result = await refresh();

		expect(result.revoked).toBe(0);
		expect(pairedPeerIds()).toEqual([active.deviceId, retired.deviceId].toSorted());
	});

	it("uses the next configured group when this device isn't enrolled in the first", async () => {
		await revoke(retired);
		routeFetchTo(createBetterSqliteCoordinatorApp({ dbPath: coordinatorDbPath }));
		const config = readCoordinatorSyncConfig({
			sync_coordinator_url: COORDINATOR,
			sync_coordinator_groups: ["group-unenrolled", "group-a"],
		});

		// The full refresh also looks up peers per group, so exercise the revocation check alone.
		const result = await fetchRevokedPinnedPeers({ db: localDb, dbPath: ":memory:" }, config, {
			localDeviceId,
			keysDir: localKeysDir,
		});

		expect(result).toEqual({ status: "checked", revoked: [retired.deviceId] });
	});

	it("reports a failed check when no configured group authorizes it", async () => {
		const app = createBetterSqliteCoordinatorApp({ dbPath: coordinatorDbPath });
		routeFetchTo({
			request: (url, init) =>
				url.includes("/v1/peers/revocations")
					? Promise.resolve(Response.json({ error: "device_disabled" }, { status: 401 }))
					: app.request(url, init),
		});

		const result = await refresh();

		expect(result.status).toBe("failed");
		expect(pairedPeerIds()).toEqual([active.deviceId, retired.deviceId].toSorted());
	});

	it("marks revoked enrollments in the admin device list", async () => {
		await revoke(retired);
		const app = createBetterSqliteCoordinatorApp({
			dbPath: coordinatorDbPath,
			runtime: { adminSecret: () => "admin", now: () => new Date().toISOString() },
		});

		const response = await app.request(`${COORDINATOR}/v1/admin/devices?group_id=group-a`, {
			headers: { "X-Codemem-Coordinator-Admin": "admin" },
		});

		const body = (await response.json()) as { items: Array<Record<string, unknown>> };
		const marks = Object.fromEntries(
			body.items.map((item) => [item.device_id, item.revoked ?? false]),
		);
		expect(marks).toEqual({
			[localDeviceId]: false,
			[retired.deviceId]: true,
			[active.deviceId]: false,
		});
	});

	it("ignores revoked IDs the device didn't ask about", async () => {
		const app = createBetterSqliteCoordinatorApp({ dbPath: coordinatorDbPath });
		routeFetchTo({
			request: (url, init) =>
				url.includes("/v1/peers/revocations")
					? Promise.resolve(Response.json({ version: 1, revoked: ["someone-else"] }))
					: app.request(url, init),
		});

		await refresh();

		expect(pairedPeerIds()).toEqual([active.deviceId, retired.deviceId].toSorted());
	});
});
