import { createPrivateKey, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";
import { finished } from "node:stream/promises";
import { applyReplicationOps, fingerprintPublicKey, MemoryStore } from "@codemem/core";
import { vi } from "vitest";
import type { OwnedPeerHttpConnection } from "../../core/src/peer-http-client.js";
import { servePeerHttpConnection } from "../../core/src/peer-http-server.js";
import {
	acceptTraversalNoiseResponder,
	prepareTraversalNoiseInitiator,
} from "../../core/src/peer-traversal-noise.js";
import { TraversalByteStream } from "../../core/src/peer-traversal-stream.js";
import { channelPair } from "../../core/src/peer-traversal-stream-test-fixtures.js";
import { refreshTestScopeRows } from "../../core/src/scope-membership-cache-test-fixtures.js";
import type { ScopedChannelSyncOptions } from "../../core/src/sync-channel-pass.js";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import { loadPrivateKey } from "../../core/src/sync-identity.js";
import {
	getReplicationCursor,
	getSyncResetState,
	pruneReplicationOps,
} from "../../core/src/sync-replication.js";
import {
	createSyncChannelDispatcher,
	type SyncChannelRequest,
	type SyncChannelResponse,
} from "./sync-channel-dispatch.js";
import { channelStore, memoryOp, ORIGIN, SCOPE } from "./sync-channel-dispatch-test-fixtures.js";

function owner(duplex: Duplex, raw: TraversalByteStream): OwnedPeerHttpConnection {
	const completion = Promise.all([
		finished(duplex, { cleanup: true }),
		finished(raw, { cleanup: true }),
		raw.disposed,
	]).then(() => {});
	void completion.catch(() => {});
	return {
		duplex,
		completion,
		async dispose(error) {
			duplex.destroy(error);
			raw.destroy(error);
			await Promise.allSettled([completion, raw.disposed]);
		},
	};
}

type Remote = Awaited<ReturnType<typeof channelStore>> & { serverKeysDir?: string };

function serverKeys(remote: Remote) {
	return remote.serverKeysDir ?? join(dirname(remote.peerKeysDir), "local-keys");
}

async function clientStore(remote: Remote) {
	const directory = dirname(remote.peerKeysDir);
	const client = new MemoryStore(join(directory, "peer.sqlite"));
	client.db
		.prepare(
			"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(
			remote.localDeviceId,
			fingerprintPublicKey(remote.localPublicKey),
			remote.localPublicKey,
			"2026-01-01T00:00:00Z",
		);
	for (const table of ["replication_scopes", "scope_memberships"]) {
		const rows = remote.store.db.prepare(`SELECT * FROM ${table}`).all() as Record<
			string,
			unknown
		>[];
		for (const row of rows) {
			const columns = Object.keys(row);
			client.db
				.prepare(
					`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
				)
				.run(...Object.values(row));
		}
	}
	await refreshTestScopeRows(client.db, {
		[remote.localDeviceId]: remote.localPublicKey,
		[remote.peerDeviceId]: remote.peerPublicKey,
	});
	return client;
}

function key(keysDir: string) {
	const bytes = loadPrivateKey(keysDir);
	if (!bytes) throw new Error("Missing disposable key");
	return createPrivateKey(bytes);
}

async function openNoise(remote: Remote, wrongPin = false) {
	const channels = channelPair({ deferredDelivery: true });
	const deadlineMs = performance.now() + 60000;
	const raw = [
		new TraversalByteStream({ channel: channels[0], side: "source", deadlineMs }),
		new TraversalByteStream({ channel: channels[1], side: "target", deadlineMs }),
	] as const;
	for (const stream of raw) {
		stream.on("error", () => {});
		void stream.disposed.catch(() => {});
	}
	const targetKeys = wrongPin ? remote.peerKeysDir : serverKeys(remote);
	const targetPin = wrongPin ? remote.peerPublicKey : remote.localPublicKey;
	const attempt = prepareTraversalNoiseInitiator({
		localIdentity: { key: key(remote.peerKeysDir), expectedPin: remote.peerPublicKey },
		expectedRemotePin: targetPin,
		deadlineMs,
	});
	const opening = await attempt.opening;
	const inbound = acceptTraversalNoiseResponder({
		stream: raw[1],
		localIdentity: { key: key(targetKeys), expectedPin: targetPin },
		expectedRemotePin: remote.peerPublicKey,
		sessionId: attempt.sessionId,
		verifiedMessageADigest: opening.digest,
		deadlineMs,
	});
	attempt.attachAndRelease(raw[0]);
	const [source, target] = await Promise.all([attempt.authenticated, inbound]);
	for (const stream of [source.duplex, target.duplex]) stream.on("error", () => {});
	const sourceOwner = owner(source.duplex, raw[0]);
	const targetOwner = owner(target.duplex, raw[1]);
	return {
		sourceOwner,
		targetOwner,
		async close() {
			for (const stream of [source.duplex, target.duplex, ...raw]) stream.destroy();
			await Promise.allSettled([sourceOwner.completion, targetOwner.completion]);
		},
	};
}

function channelFactory(remote: Remote) {
	const dispatch = createSyncChannelDispatcher({ storeFactory: remote.storeFactory });
	const requests: SyncChannelRequest[] = [];
	const connections: OwnedPeerHttpConnection[] = [];
	const servings: Promise<unknown>[] = [];
	const closes: (() => Promise<unknown>)[] = [];
	const control: {
		beforeOpen?: () => void;
		beforeDispatch?: (request: SyncChannelRequest) => void;
		wrapOwner?: (connection: OwnedPeerHttpConnection) => OwnedPeerHttpConnection;
		afterDispatch?: (
			request: SyncChannelRequest,
			response: SyncChannelResponse,
		) => Promise<SyncChannelResponse> | SyncChannelResponse;
		wrongPin?: boolean;
	} = {};
	const factory = {
		open: vi.fn(async (_options: { signal: AbortSignal; deadlineMs: number }) => {
			control.beforeOpen?.();
			const { sourceOwner, targetOwner, close } = await openNoise(remote, control.wrongPin);
			connections.push(sourceOwner);
			closes.push(close);
			const serving = servePeerHttpConnection(targetOwner, {
				origin: ORIGIN,
				async dispatch(request) {
					vi.stubEnv("CODEMEM_KEYS_DIR", serverKeys(remote));
					requests.push(request);
					control.beforeDispatch?.(request);
					const response = await dispatch(request);
					return control.afterDispatch?.(request, response) ?? response;
				},
			});
			void serving.catch(() => {});
			servings.push(serving);
			return control.wrapOwner?.(sourceOwner) ?? sourceOwner;
		}),
	};
	return {
		factory,
		control,
		requests,
		connections,
		async cleanup() {
			for (const close of closes.reverse()) await close();
			await Promise.allSettled(servings);
		},
	};
}

function seed(
	remote: Remote,
	client: MemoryStore,
	side: "remote" | "client",
	id: string,
	body = "Shared memory",
) {
	const store = side === "remote" ? remote.store : client;
	const deviceId = side === "remote" ? remote.localDeviceId : remote.peerDeviceId;
	const op = memoryOp(remote);
	op.op_id = `${id}-op`;
	op.entity_id = `memory-source-v1:${Buffer.from(deviceId).toString("base64url")}:${randomUUID()}`;
	op.device_id = deviceId;
	op.clock_device_id = deviceId;
	op.payload_json = JSON.stringify({
		...JSON.parse(op.payload_json),
		title: id,
		body_text: body,
		origin_device_id: deviceId,
	});
	// Seed an authored row through the receive path without its own-device skip.
	const receiver = side === "remote" ? remote.peerDeviceId : remote.localDeviceId;
	const result = applyReplicationOps(store.db, [op], receiver, store.scanner);
	if (result.applied !== 1 || result.errors.length || result.rejected)
		throw new Error(JSON.stringify(result));
	return op;
}

export async function passFixture() {
	const remote = await channelStore();
	const client = await clientStore(remote);
	const harness = channelFactory(remote);
	const options: ScopedChannelSyncOptions = {
		db: client.db,
		peerDeviceId: remote.localDeviceId,
		scopeId: SCOPE,
		logicalOrigin: ORIGIN,
		factory: harness.factory,
		keysDir: remote.peerKeysDir,
		dbPath: join(dirname(remote.peerKeysDir), "peer.sqlite"),
		scanner: client.scanner,
	};
	return {
		remote,
		client,
		...harness,
		options,
		seed(side: "remote" | "client", id: string, body = "Shared memory") {
			return seed(remote, client, side, id, body);
		},
		async cleanup() {
			await harness.cleanup();
			client.close();
			remote.cleanup();
		},
	};
}

async function enrollPassPeer(
	first: Awaited<ReturnType<typeof passFixture>>,
	created: Remote,
	remote: Remote,
) {
	created.store.db.prepare("DELETE FROM sync_peers").run();
	created.store.db
		.prepare(
			"INSERT INTO sync_peers (peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(
			remote.peerDeviceId,
			remote.peerPublicKey,
			fingerprintPublicKey(remote.peerPublicKey),
			"2026-01-01T00:00:00Z",
		);
	created.store.db
		.prepare("UPDATE scope_memberships SET device_id = ? WHERE device_id = ?")
		.run(remote.peerDeviceId, created.peerDeviceId);
	first.client.db
		.prepare(
			"INSERT INTO sync_peers (peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)",
		)
		.run(
			remote.localDeviceId,
			remote.localPublicKey,
			fingerprintPublicKey(remote.localPublicKey),
			"2026-01-01T00:00:00Z",
		);
	first.client.db
		.prepare(
			"INSERT INTO scope_memberships (scope_id, device_id, role, status, membership_epoch, updated_at) SELECT scope_id, ?, role, status, membership_epoch, updated_at FROM scope_memberships WHERE device_id = ?",
		)
		.run(remote.localDeviceId, first.remote.localDeviceId);
	const publicKeys = {
		[first.remote.localDeviceId]: first.remote.localPublicKey,
		[remote.localDeviceId]: remote.localPublicKey,
		[remote.peerDeviceId]: remote.peerPublicKey,
	};
	await refreshTestScopeRows(first.client.db, publicKeys);
	await refreshTestScopeRows(remote.store.db, publicKeys);
}

/** A second real server shares the first fixture's client identity and Space. */
export async function addPassPeer(first: Awaited<ReturnType<typeof passFixture>>) {
	const created = await channelStore();
	const remote: Remote = {
		...created,
		serverKeysDir: serverKeys(created),
		peerDeviceId: first.remote.peerDeviceId,
		peerPublicKey: first.remote.peerPublicKey,
		peerKeysDir: first.remote.peerKeysDir,
	};
	await enrollPassPeer(first, created, remote);
	const harness = channelFactory(remote);
	const options: ScopedChannelSyncOptions = {
		...first.options,
		peerDeviceId: remote.localDeviceId,
		factory: harness.factory,
	};
	return {
		...harness,
		remote,
		options,
		async cleanup() {
			await harness.cleanup();
			created.cleanup();
		},
	};
}

/** Real retention advances only the floor, leaving a completed null-baseline boundary unchanged. */
export async function prepareStaleChannelPull(f: Awaited<ReturnType<typeof passFixture>>) {
	f.seed("client", "already-acked");
	const original = f.seed("remote", "tracked-memory", "Before pruning");
	const initial = await syncScopedChannelOnce(f.options);
	f.seed("remote", "cursor-anchor");
	const incremental = await syncScopedChannelOnce(f.options);
	const previousCursor = getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE)[0];
	if (!initial.ok || !incremental.ok || previousCursor === null)
		throw new Error("Stale-cursor fixture did not establish a completed incremental pull");
	const boundary = getSyncResetState(f.remote.store.db, SCOPE);
	const updatedAt = "2026-01-02T00:00:00Z";
	const update = {
		...original,
		op_id: "tracked-memory-update-op",
		clock_rev: 2,
		clock_updated_at: updatedAt,
		created_at: updatedAt,
		payload_json: JSON.stringify({
			...JSON.parse(original.payload_json),
			body_text: "After pruning",
			updated_at: updatedAt,
		}),
	};
	const applied = applyReplicationOps(
		f.remote.store.db,
		[update],
		f.remote.peerDeviceId,
		f.remote.store.scanner,
	);
	if (applied.applied !== 1)
		throw new Error("Stale-cursor fixture did not update the remote memory");
	// Fix the pruning clock, without changing the pass or Noise monotonic clocks.
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-04T00:00:00Z"));
	let pruned: ReturnType<typeof pruneReplicationOps>;
	try {
		pruned = pruneReplicationOps(f.remote.store.db, { scopeId: SCOPE, maxAgeDays: 1 });
	} finally {
		clock.mockRestore();
	}
	if (
		pruned.deleted < 1 ||
		!pruned.retained_floor_cursor ||
		pruned.retained_floor_cursor <= previousCursor
	)
		throw new Error("Stale-cursor fixture did not prune beyond the receiver cursor");
	f.seed("client", "pending-outbound");
	return { boundary, previousCursor, entityId: original.entity_id };
}
