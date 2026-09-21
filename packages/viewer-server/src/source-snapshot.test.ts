import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDirectPeerAuthHeaders,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	initTestSchema,
	insertTestSession,
	loadPublicKey,
	MemoryStore,
	SYNC_CAPABILITY_HEADER,
	setSyncResetState,
} from "@codemem/core";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { syncProtocolRoutes } from "./routes/sync.js";

it("serves only its own qualified snapshot rows and rejects requests to assert another source", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codemem-source-snapshot-"));
	const dbPath = join(directory, "store.sqlite");
	const keysDir = join(directory, "peer-keys");
	const localKeys = join(directory, "local-keys");
	const oldKeys = process.env.CODEMEM_KEYS_DIR;
	process.env.CODEMEM_KEYS_DIR = localKeys;
	const db = new Database(dbPath);
	const peerDb = new Database(":memory:");
	let store: MemoryStore | undefined;
	try {
		initTestSchema(db);
		initTestSchema(peerDb);
		const [localId] = ensureDeviceIdentity(db, { keysDir: localKeys });
		const [peerId] = ensureDeviceIdentity(peerDb, { keysDir });
		const publicKey = loadPublicKey(keysDir);
		if (!publicKey) throw new Error("fixture_key_missing");
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO sync_peers(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
		).run(peerId, publicKey, fingerprintPublicKey(publicKey), now);
		db.prepare(`INSERT INTO replication_scopes(scope_id,label,kind,authority_type,membership_epoch,status,created_at,updated_at)
			VALUES ('work','Work','user','coordinator',1,'active',?,?)`).run(now, now);
		for (const id of [localId, peerId])
			db.prepare(`INSERT INTO scope_memberships(scope_id,device_id,role,status,membership_epoch,updated_at)
			VALUES ('work',?,'member','active',1,?)`).run(id, now);
		const session = insertTestSession(db);
		const qualified = (id: string) =>
			`memory-source-v1:${Buffer.from(id).toString("base64url")}:00000000-0000-4000-8000-000000000001`;
		for (const id of [localId, peerId, "third"])
			db.prepare(`INSERT INTO memory_items(session_id,kind,title,body_text,created_at,updated_at,import_key,rev,active,visibility,scope_id,metadata_json)
			VALUES (?,'discovery','Title','Body',?,?,?,1,1,'shared','work','{}')`).run(
				session,
				now,
				now,
				qualified(id),
			);
		setSyncResetState(
			db,
			{ generation: 2, snapshot_id: "snapshot", baseline_cursor: null },
			"work",
		);
		store = new MemoryStore(dbPath);
		const activeStore = store;
		const app = syncProtocolRoutes(() => activeStore);
		for (const source of [localId, peerId]) {
			const url = `http://localhost/v1/snapshot?scope_id=work&generation=2&snapshot_id=snapshot&source_device_id=${encodeURIComponent(source)}`;
			const headers = buildDirectPeerAuthHeaders({
				deviceId: peerId,
				recipientId: localId,
				method: "GET",
				url,
				bodyBytes: Buffer.alloc(0),
				keysDir,
			});
			headers[SYNC_CAPABILITY_HEADER] = "scoped";
			const response = await app.request(url, { headers });
			if (source !== localId) {
				expect(response.status).toBe(400);
				continue;
			}
			expect(response.status).toBe(200);
			const body = (await response.json()) as {
				source_device_id: string;
				items: { entity_id: string }[];
			};
			expect(body.source_device_id).toBe(localId);
			expect(body.items.map((item) => item.entity_id)).toEqual([qualified(localId)]);
		}
	} finally {
		store?.close();
		db.close();
		peerDb.close();
		if (oldKeys === undefined) delete process.env.CODEMEM_KEYS_DIR;
		else process.env.CODEMEM_KEYS_DIR = oldKeys;
		rmSync(directory, { recursive: true, force: true });
	}
});
