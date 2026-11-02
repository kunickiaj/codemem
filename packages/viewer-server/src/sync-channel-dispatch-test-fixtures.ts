import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDirectPeerAuthHeaders,
	connect,
	ensureDeviceIdentity,
	fingerprintPublicKey,
	getSyncResetState,
	initTestSchema,
	LOCAL_SYNC_CAPABILITY,
	loadPublicKey,
	MemoryStore,
	SYNC_CAPABILITY_HEADER,
} from "@codemem/core";
import { vi } from "vitest";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import type { SyncChannelRequest } from "./sync-channel-dispatch.js";

export const ORIGIN = "https://peer.invalid";
export const SCOPE = "channel-scope";
export const TARGET = `/v1/ops?scope_id=${SCOPE}&z=2&x=%2f&z=1`;
export const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));
export const json = (response: { bodyBytes: Uint8Array }): unknown =>
	JSON.parse(new TextDecoder().decode(response.bodyBytes));

export async function channelStore(options: { passiveOnly?: boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "codemem-channel-dispatch-"));
	const keysDir = join(directory, "local-keys");
	const peerKeysDir = join(directory, "peer-keys");
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	const dbPath = join(directory, "local.sqlite");
	const localDb = connect(dbPath);
	initTestSchema(localDb);
	const [localDeviceId] = ensureDeviceIdentity(localDb, { keysDir });
	localDb.close();
	const peerDb = connect(join(directory, "peer.sqlite"));
	initTestSchema(peerDb);
	const [peerDeviceId] = ensureDeviceIdentity(peerDb, { keysDir: peerKeysDir });
	peerDb.close();
	const localPublicKey = loadPublicKey(keysDir);
	const peerPublicKey = loadPublicKey(peerKeysDir);
	if (!localPublicKey || !peerPublicKey) throw new Error("Disposable fixture key missing");
	const store = new MemoryStore(dbPath);
	store.db
		.prepare(
			`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?)`,
		)
		.run(
			peerDeviceId,
			fingerprintPublicKey(peerPublicKey),
			peerPublicKey,
			new Date().toISOString(),
		);
	seedMemberships(store, [localDeviceId, peerDeviceId]);
	if (!options.passiveOnly)
		await refreshTestScopeRows(store.db, {
			[localDeviceId]: localPublicKey,
			[peerDeviceId]: peerPublicKey,
		});
	return {
		store,
		localDeviceId,
		peerDeviceId,
		peerKeysDir,
		localPublicKey,
		peerPublicKey,
		peerPin: peerPublicKey.trim().split(/\s+/).slice(0, 2).join(" "),
		storeFactory: vi.fn(() => store),
		cleanup() {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

function seedMemberships(store: MemoryStore, deviceIds: string[]): void {
	const now = "2026-01-01T00:00:00Z";
	store.db
		.prepare(
			`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at) VALUES (?, ?, 'team', 'coordinator', 'fixture-coordinator', 'fixture-group', 1, 'active', ?, ?)`,
		)
		.run(SCOPE, SCOPE, now, now);
	for (const deviceId of deviceIds)
		store.db
			.prepare(
				`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`,
			)
			.run(SCOPE, deviceId, now);
}

export function signedRequest(
	f: Awaited<ReturnType<typeof channelStore>>,
	options: {
		method?: "GET" | "POST";
		target?: string;
		bodyBytes?: Buffer;
		recipientId?: string;
	} = {},
): SyncChannelRequest {
	const method = options.method ?? "GET";
	let target = options.target ?? TARGET;
	if (method === "GET" && options.target === undefined) {
		const boundary = getSyncResetState(f.store.db, SCOPE);
		target += `&generation=${encodeURIComponent(String(boundary.generation))}&snapshot_id=${encodeURIComponent(boundary.snapshot_id)}`;
		if (boundary.baseline_cursor !== null)
			target += `&baseline_cursor=${encodeURIComponent(boundary.baseline_cursor)}`;
	}
	const bodyBytes = options.bodyBytes ?? Buffer.alloc(0);
	const url = ORIGIN + target;
	return {
		method,
		target,
		url,
		bodyBytes,
		peerPin: f.peerPin,
		signal: new AbortController().signal,
		headers: {
			...buildDirectPeerAuthHeaders({
				deviceId: f.peerDeviceId,
				recipientId: options.recipientId ?? f.localDeviceId,
				method,
				url,
				bodyBytes,
				keysDir: f.peerKeysDir,
			}),
			[SYNC_CAPABILITY_HEADER]: LOCAL_SYNC_CAPABILITY,
			"Content-Type": "application/json",
			Host: "peer.invalid",
			"Content-Length": String(bodyBytes.length),
			Connection: "close",
		},
	};
}

export function nonceCount(f: Awaited<ReturnType<typeof channelStore>>): unknown {
	return f.store.db
		.prepare("SELECT COUNT(*) FROM sync_nonces WHERE device_id = ?")
		.pluck()
		.get(f.peerDeviceId);
}

export function memoryOp(f: Awaited<ReturnType<typeof channelStore>>) {
	const now = "2026-01-01T00:00:00Z";
	return {
		op_id: "channel-op",
		entity_type: "memory_item",
		entity_id: "channel-item",
		op_type: "upsert",
		payload_json: JSON.stringify({
			body_text: "Raw héllo 🌲",
			created_at: now,
			kind: "discovery",
			project: "fixture",
			scope_id: SCOPE,
			title: "Channel memory",
			updated_at: now,
			visibility: "shared",
		}),
		clock_rev: 1,
		clock_updated_at: now,
		clock_device_id: f.peerDeviceId,
		device_id: f.peerDeviceId,
		created_at: now,
		scope_id: SCOPE,
	};
}
