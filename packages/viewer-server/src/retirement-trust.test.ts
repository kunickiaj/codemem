import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAuthHeaders,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
} from "@codemem/core";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
	revokeUnauthorizedCoordinatorPeerTrust,
	trustCoordinatorPeersWithSharedManagedScopes,
} from "../../core/src/coordinator-runtime.js";
import { getRetirementPeer } from "../../core/src/memory-retirement-trust.js";
import { syncProtocolRoutes } from "./routes/sync.js";

it("retained retirement trust cannot authenticate content reads or writes after final-scope revocation", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codemem-retirement-content-denial-"));
	const dbPath = join(directory, "store.sqlite");
	const keysDir = join(directory, "peer-keys");
	const db = new Database(dbPath);
	const peerDb = new Database(":memory:");
	let store: MemoryStore | undefined;
	try {
		initTestSchema(db);
		initTestSchema(peerDb);
		const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir });
		const publicKey = loadPublicKey(keysDir);
		if (!publicKey) throw new Error("missing test key");
		const now = new Date().toISOString();
		db.prepare(`INSERT INTO replication_scopes
			(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at)
			VALUES ('old', 'Old', 'managed_project', 'coordinator', 'https://coord.example.test', 'group', 1, 'active', ?, ?)`).run(
			now,
			now,
		);
		for (const deviceId of ["local", peerDeviceId]) {
			db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
				VALUES ('old', ?, 'member', 'active', 1, ?)`).run(deviceId, now);
		}
		db.prepare(`INSERT INTO scope_membership_cache_state
			(coordinator_id, group_id, last_refresh_at, last_success_at, last_error, updated_at)
			VALUES ('https://coord.example.test', 'group', ?, ?, NULL, ?)`).run(now, now, now);
		expect(
			trustCoordinatorPeersWithSharedManagedScopes(db, "local", [
				{
					device_id: peerDeviceId,
					public_key: publicKey,
					fingerprint: fingerprintPublicKey(publicKey),
					coordinator_id: "https://coord.example.test",
					groups: ["group"],
				},
			]),
		).toBe(1);
		db.prepare("UPDATE scope_memberships SET status = 'revoked' WHERE device_id = ?").run(
			peerDeviceId,
		);
		expect(revokeUnauthorizedCoordinatorPeerTrust(db, "local")).toBe(1);
		expect(getRetirementPeer(db, { localDeviceId: "local", peerDeviceId })).toEqual({
			deviceId: peerDeviceId,
			publicKey,
		});
		store = new MemoryStore(dbPath);
		const activeStore = store;
		const app = syncProtocolRoutes(() => activeStore);
		for (const [method, path] of [
			["GET", "/v1/ops"],
			["GET", "/v1/snapshot"],
			["POST", "/v1/ops"],
		]) {
			const body = method === "POST" ? Buffer.from('{"ops":[]}') : Buffer.alloc(0);
			const url = `http://localhost${path}`;
			const headers = buildAuthHeaders({
				method,
				url,
				bodyBytes: body,
				keysDir,
				deviceId: peerDeviceId,
			});
			const response = await app.request(url, {
				method,
				headers,
				body: method === "POST" ? body : undefined,
			});
			expect(response.status).toBe(401);
		}
		expect(db.prepare("SELECT * FROM sync_peers").all()).toEqual([]);
	} finally {
		store?.close();
		db.close();
		peerDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
