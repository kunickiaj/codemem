// Device-side helpers. Import this module only after isolateProcess() has run,
// because core modules read their default paths when they load.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "../../../core/src/index.js";
import { refreshScopeMembershipCache } from "../../../core/src/scope-membership-cache.js";
import { createViewerRelayReachability } from "../../../viewer-server/src/relay-reachability.js";
import type { Identity } from "./common.js";

export { core, createViewerRelayReachability };
export type Store = InstanceType<typeof core.MemoryStore>;

export interface PeerAddress {
	readonly deviceId: string;
	readonly publicKey: string;
	readonly address?: string;
}

/** A fresh device database with its identity and pinned peers. */
export function deviceStore(home: string, identity: Identity, peers: readonly PeerAddress[]): Store {
	const keysDir = process.env.CODEMEM_KEYS_DIR ?? "";
	mkdirSync(keysDir, { recursive: true, mode: 0o700 });
	writeFileSync(join(keysDir, "device.key"), identity.privateKey, { mode: 0o600, flag: "wx" });
	writeFileSync(join(keysDir, "device.key.pub"), identity.publicKey, { mode: 0o600, flag: "wx" });
	const path = join(home, "device.sqlite");
	const db = core.connect(path);
	core.initTestSchema(db);
	core.ensureDeviceIdentity(db, { keysDir, deviceId: identity.deviceId });
	db.close();
	const store = new core.MemoryStore(path);
	const insert = store.db.prepare(
		"INSERT INTO sync_peers(peer_device_id,pinned_fingerprint,public_key,addresses_json,created_at) VALUES (?,?,?,?,?)",
	);
	for (const peer of peers)
		insert.run(
			peer.deviceId,
			core.fingerprintPublicKey(peer.publicKey),
			peer.publicKey,
			JSON.stringify(peer.address ? [peer.address] : []),
			new Date().toISOString(),
		);
	return store;
}

/** Authenticated membership refresh against the coordinator, as the daemon does each tick. */
export async function refreshMembership(
	store: Store,
	coordinator: { origin: string; coordinatorId: string },
	groupIds: readonly string[],
): Promise<void> {
	const result = await refreshScopeMembershipCache(store.db, {
		coordinatorId: coordinator.coordinatorId,
		groupIds: [...groupIds],
		remoteUrl: coordinator.origin,
		keysDir: process.env.CODEMEM_KEYS_DIR,
		dbPath: store.dbPath,
	});
	if (result.status !== "refreshed")
		throw new Error(`membership refresh failed: ${JSON.stringify(result)}`);
}

/** Authors one shared memory in a scope, through the normal apply path. */
export function seedMemory(store: Store, author: string, receiver: string, title: string, scope: string) {
	const now = new Date().toISOString();
	const op = {
		op_id: `${title}-op`,
		entity_type: "memory_item",
		entity_id: `memory-source-v1:${Buffer.from(author).toString("base64url")}:${randomUUID()}`,
		op_type: "upsert",
		scope_id: scope,
		device_id: author,
		clock_device_id: author,
		clock_rev: 1,
		clock_updated_at: now,
		created_at: now,
		payload_json: JSON.stringify({
			kind: "discovery",
			title,
			body_text: "Synthetic relay acceptance marker",
			created_at: now,
			updated_at: now,
			scope_id: scope,
			visibility: "shared",
			origin_device_id: author,
		}),
	};
	const result = core.applyReplicationOps(store.db, [op], receiver, store.scanner);
	if (result.applied !== 1 || result.errors.length) throw new Error("synthetic seed failed");
}

export function titles(store: Store, scope: string): string[] {
	return store.db
		.prepare("SELECT title FROM memory_items WHERE scope_id = ? ORDER BY title")
		.pluck()
		.all(scope) as string[];
}

export function allRows(store: Store): { scope_id: string; title: string }[] {
	return store.db.prepare("SELECT scope_id, title FROM memory_items ORDER BY title").all() as {
		scope_id: string;
		title: string;
	}[];
}

/** The device config `codemem serve` reads for relay. */
export function relayConfig(origin: string, groups: readonly string[]) {
	return { sync_coordinator_url: origin, sync_coordinator_groups: [...groups], sync_relay_enabled: true };
}
