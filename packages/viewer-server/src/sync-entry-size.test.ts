import { applyReplicationOps } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { recordOpCopy } from "../../core/src/memory-copy-provenance.js";
import { syncScopedChannelOnce } from "../../core/src/sync-channel-pass.js";
import { getSyncChannelProgress } from "../../core/src/sync-channel-progress.js";
import { getReplicationCursor, setReplicationCursor } from "../../core/src/sync-replication.js";
import { createSyncApp } from "./sync-app.js";
import { createSyncChannelDispatcher, type SyncChannelRequest } from "./sync-channel-dispatch.js";
import {
	channelStore,
	json,
	memoryOp,
	SCOPE,
	signedRequest,
} from "./sync-channel-dispatch-test-fixtures.js";
import { passFixture } from "./sync-channel-pass-test-fixtures.js";

// A small limit stands in for the channel's real ceiling, so no test builds a 16 MiB memory.
const LIMIT = 4096;
const INITIAL = "2025-01-01T00:00:00Z|initial";
const OVERSIZED = "x".repeat(LIMIT * 2);
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function pass() {
	const f = await passFixture({ maxEntryBytes: LIMIT });
	cleanups.push(f.cleanup);
	return f;
}

const savedProgress = (f: Awaited<ReturnType<typeof pass>>) =>
	getSyncChannelProgress(f.client.db, f.remote.localDeviceId, SCOPE);
const memoryTitles = (f: Awaited<ReturnType<typeof pass>>) =>
	f.client.db.prepare("SELECT title FROM memory_items ORDER BY title").pluck().all();

it("refuses an oversized snapshot item by name and saves no snapshot progress", async () => {
	const f = await pass();
	f.seed("remote", "small-memory");
	f.seed("remote", "big-memory", OVERSIZED);

	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(false);
	expect(result.error).toMatch(/sync_entry_too_large: memory \S+ is 0\.0 MiB, over the 0\.0 MiB/);
	expect(result.error).toContain(
		"Trim or delete it on the peer, or exclude its Project from this pairing, then sync again.",
	);
	expect(savedProgress(f)).toBeNull();
	expect(getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE)[0]).toBeNull();
	expect(memoryTitles(f)).not.toContain("big-memory");
});

it("refuses an oversized op by name and keeps the inbound cursor where it was", async () => {
	const f = await pass();
	// A saved cursor makes these incremental ops pulls rather than a snapshot.
	setReplicationCursor(f.client.db, f.remote.localDeviceId, { lastApplied: INITIAL }, SCOPE);
	f.seed("remote", "small-memory");
	const first = await syncScopedChannelOnce(f.options);
	const cursor = getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE)[0];
	expect(first.ok).toBe(true);
	expect(cursor).not.toBe(INITIAL);
	// Seeded ops share a timestamp and order by op ID, so this one sorts after the cursor.
	f.seed("remote", "z-big-memory", OVERSIZED);

	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(false);
	expect(result.error).toMatch(/sync_entry_too_large: change z-big-memory-op is/);
	expect(result.error).toContain(
		"Trim or delete the memory on the peer, or exclude its Project from this pairing, then sync again.",
	);
	expect(getReplicationCursor(f.client.db, f.remote.localDeviceId, SCOPE)[0]).toBe(cursor);
	expect(memoryTitles(f)).not.toContain("z-big-memory");
});

it("names the op in a channel's 409 while the plain listener still sends it", async () => {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	// An op the server device authored, which the peer is allowed to pull.
	const op = { ...memoryOp(f), op_id: "big-op", device_id: f.localDeviceId };
	op.clock_device_id = f.localDeviceId;
	op.payload_json = JSON.stringify({ ...JSON.parse(op.payload_json), body_text: OVERSIZED });
	const applied = applyReplicationOps(f.store.db, [op], f.peerDeviceId, f.store.scanner);
	expect(applied.applied).toBe(1);
	// Bind the op to its stored copy, as recording an op on this device does.
	const memoryId = f.store.db
		.prepare("SELECT id FROM memory_items WHERE import_key = ?")
		.pluck()
		.get(op.entity_id) as number;
	recordOpCopy(f.store.db, op.op_id, memoryId);
	const options = { storeFactory: f.storeFactory, maxEntryBytes: LIMIT };
	const plainApp = createSyncApp({ storeFactory: f.storeFactory });
	const plain = async (dto: SyncChannelRequest) => {
		const headers = new Headers(dto.headers);
		for (const name of ["host", "content-length", "connection"]) headers.delete(name);
		const response = await plainApp.fetch(new Request(dto.url, { headers }));
		return { status: response.status, bodyBytes: new Uint8Array(await response.arrayBuffer()) };
	};

	for (const mode of ["relay", "noise-direct"] as const) {
		const dispatch = createSyncChannelDispatcher({ ...options, mode });
		const response = await dispatch({ ...signedRequest(f), peerDeviceId: f.peerDeviceId });
		expect(response.status).toBe(409);
		expect(json(response)).toEqual({
			error: "sync_entry_too_large",
			kind: "op",
			key: "big-op",
			bytes: expect.any(Number),
			limit: LIMIT,
		});
		expect(json(response)).not.toHaveProperty("next_cursor");
	}
	const direct = await plain(signedRequest(f));
	expect(direct.status).toBe(200);
	expect((json(direct) as { ops: { op_id: string }[] }).ops.map((o) => o.op_id)).toEqual([
		"big-op",
	]);
});

/** A peer whose pull reply claims a size refusal but carries its own text. */
function forgeSizeRefusal(f: Awaited<ReturnType<typeof pass>>, path: "/v1/snapshot" | "/v1/ops") {
	const forged = { error: "sync_entry_too_large: arbitrary\n\u001b[31mtext" };
	f.control.afterDispatch = (request, response) =>
		request.method === "GET" && new URL(request.url).pathname === path
			? { status: 409, bodyBytes: Buffer.from(JSON.stringify(forged)) }
			: response;
}

it("keeps a peer's text out of the snapshot failure when its size refusal doesn't check out", async () => {
	const f = await pass();
	f.seed("remote", "small-memory");
	forgeSizeRefusal(f, "/v1/snapshot");

	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(false);
	expect(result.error).toBe("channel pull failed");
	expect(result).not.toHaveProperty("entryTooLarge");
});

it("keeps a peer's text out of the ops failure when its size refusal doesn't check out", async () => {
	const f = await pass();
	setReplicationCursor(f.client.db, f.remote.localDeviceId, { lastApplied: INITIAL }, SCOPE);
	f.seed("remote", "small-memory");
	forgeSizeRefusal(f, "/v1/ops");

	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(false);
	expect(result.error).toBe("channel pull failed");
});

/** A newer revision of a seeded memory on the remote, with a small body, as a trim records it. */
function trimOnRemote(f: Awaited<ReturnType<typeof pass>>, op: ReturnType<typeof f.seed>) {
	const trimmed = {
		...op,
		op_id: `${op.op_id}-trimmed`,
		clock_rev: Number(op.clock_rev ?? 1) + 1,
		created_at: "2026-01-02T00:00:00Z",
		clock_updated_at: "2026-01-02T00:00:00Z",
		payload_json: JSON.stringify({ ...JSON.parse(op.payload_json ?? "{}"), body_text: "Trimmed" }),
	};
	const db = f.remote.store.db;
	const result = applyReplicationOps(db, [trimmed], f.remote.peerDeviceId, f.remote.store.scanner);
	expect(result).toMatchObject({ applied: 1 });
	const memoryId = db
		.prepare("SELECT id FROM memory_items WHERE import_key = ?")
		.pluck()
		.get(op.entity_id) as number;
	recordOpCopy(db, trimmed.op_id, memoryId);
}

it("unblocks an oversized change once the memory is trimmed on the peer", async () => {
	const f = await pass();
	setReplicationCursor(f.client.db, f.remote.localDeviceId, { lastApplied: INITIAL }, SCOPE);
	f.seed("remote", "small-memory");
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(true);
	const big = f.seed("remote", "z-big-memory", OVERSIZED);
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(false);

	trimOnRemote(f, big);
	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(true);
	expect(
		f.client.db
			.prepare("SELECT body_text FROM memory_items WHERE title = 'z-big-memory'")
			.pluck()
			.get(),
	).toBe("Trimmed");
});

it("unblocks an oversized change once the memory is deleted on the peer", async () => {
	const f = await pass();
	setReplicationCursor(f.client.db, f.remote.localDeviceId, { lastApplied: INITIAL }, SCOPE);
	f.seed("remote", "small-memory");
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(true);
	const big = f.seed("remote", "z-big-memory", OVERSIZED);
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(false);

	const db = f.remote.store.db;
	f.remote.store.forget(
		db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(big.entity_id) as number,
	);
	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(true);
	expect(memoryTitles(f)).not.toContain("z-big-memory");
});

it("unblocks an oversized snapshot memory once it is deleted on the peer", async () => {
	const f = await pass();
	f.seed("remote", "small-memory");
	const big = f.seed("remote", "big-memory", OVERSIZED);
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(false);

	const db = f.remote.store.db;
	f.remote.store.forget(
		db
			.prepare("SELECT id FROM memory_items WHERE import_key = ?")
			.pluck()
			.get(big.entity_id) as number,
	);
	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(true);
	expect(memoryTitles(f)).toContain("small-memory");
	expect(
		f.client.db
			.prepare("SELECT body_text FROM memory_items WHERE title = 'big-memory'")
			.pluck()
			.all(),
	).not.toContain(OVERSIZED);
});

it("unblocks an oversized snapshot memory once it is trimmed on the peer", async () => {
	const f = await pass();
	f.seed("remote", "small-memory");
	const big = f.seed("remote", "big-memory", OVERSIZED);
	expect((await syncScopedChannelOnce(f.options)).ok).toBe(false);

	trimOnRemote(f, big);
	const result = await syncScopedChannelOnce(f.options);

	expect(result.ok).toBe(true);
	expect(
		f.client.db
			.prepare("SELECT body_text FROM memory_items WHERE title = 'big-memory'")
			.pluck()
			.get(),
	).toBe("Trimmed");
});
