import { applyReplicationOps } from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
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
	expect(result.error).toContain("Trim or delete it on the peer, or exclude its project");
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
