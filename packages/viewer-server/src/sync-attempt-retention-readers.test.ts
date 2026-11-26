import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	consecutiveConnectivityFailures,
	MemoryStore,
	runSyncAttemptRetentionPass,
	shouldSkipOfflinePeer,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readPeerSyncHealth } from "./application/sync-health.js";
import { latestFailedPeerIds } from "./application/sync-status.js";
import { createApp } from "./index.js";

const DAY = 86_400_000;
const PAIRED = "paired-peer";
const BUSY = "busy-peer";
const REMOVED = "removed-peer";

let dir: string;
let store: MemoryStore;

/**
 * A store whose readers depend on attempts older than the retention window: the paired
 * peer's latest success and its trust refusal are weeks old and it has failed to connect
 * since; a busy peer fills the attempt list with old rows; a removed peer left history.
 */
function seed(target: MemoryStore): void {
	const now = Date.now();
	const insert = target.db.prepare(
		`INSERT INTO sync_attempts(
			peer_device_id, started_at, finished_at, ok, ops_in, ops_out, error, failure_category, transport
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const attempt = (
		peer: string,
		daysAgo: number,
		outcome: { ok: boolean; category?: string; error?: string; transport?: string },
	) => {
		const at = new Date(now - daysAgo * DAY).toISOString();
		insert.run(
			peer,
			at,
			at,
			outcome.ok ? 1 : 0,
			outcome.ok ? 3 : 0,
			outcome.ok ? 2 : 0,
			outcome.ok ? null : (outcome.error ?? "connection refused"),
			outcome.ok ? null : (outcome.category ?? "connectivity"),
			outcome.transport ?? null,
		);
	};
	for (const peer of [PAIRED, BUSY]) {
		target.db
			.prepare(
				`INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, public_key, created_at)
				 VALUES (?, ?, 'fixture-fingerprint', 'fixture-key', ?)`,
			)
			.run(peer, peer, new Date(now - 90 * DAY).toISOString());
	}
	attempt(PAIRED, 40, { ok: true, transport: "direct" });
	for (let index = 0; index < 15; index++) attempt(PAIRED, 35 - index * 0.5, { ok: false });
	attempt(PAIRED, 20, { ok: false, category: "trust", error: "peer identity changed" });
	for (let index = 0; index < 12; index++) attempt(PAIRED, 19 - index, { ok: false });
	for (let index = 0; index < 700; index++)
		attempt(BUSY, 7.9 - index * 0.001, { ok: index % 50 !== 0, transport: "relay" });
	for (let index = 0; index < 20; index++) attempt(BUSY, 2 - index * 0.05, { ok: true });
	attempt(BUSY, 0.001, { ok: false });
	for (let index = 0; index < 14; index++) attempt(REMOVED, 60 - index, { ok: index !== 13 });
}

async function readers(app: ReturnType<typeof createApp>) {
	const json = async (path: string) => {
		const response = await app.request(path);
		expect(response.status).toBe(200);
		return response.json();
	};
	const status = (await json("/api/sync/status?includeDiagnostics=1")) as Record<string, unknown>;
	const peerIds = [PAIRED, BUSY, REMOVED];
	return {
		statusPeers: status.peers,
		statusAttempts: status.attempts,
		statusSyncHealth: status.sync_health,
		attemptList: await json("/api/sync/attempts?limit=500&includeDiagnostics=1"),
		peerHealth: Object.fromEntries(readPeerSyncHealth(store, peerIds)),
		recentFailures: [...latestFailedPeerIds(store, new Set(peerIds), () => true)],
		connectivityFailures: peerIds.map((id) => consecutiveConnectivityFailures(store.db, id)),
		skipsOffline: peerIds.map((id) => shouldSkipOfflinePeer(store.db, id)),
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-sync-attempt-readers-"));
	store = new MemoryStore(join(dir, "mem.sqlite"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

it("leaves every sync attempt reader's output unchanged after old attempts are removed", async () => {
	// Arrange
	seed(store);
	const app = createApp({ storeFactory: () => store });
	const before = await readers(app);
	const count = () => store.db.prepare("SELECT count(*) FROM sync_attempts").pluck().get();
	const rowsBefore = count();

	// Act
	const result = await runSyncAttemptRetentionPass(store.db);

	// Assert: rows were removed, and nothing a reader shows or uses changed.
	expect(result.complete).toBe(true);
	expect(result.syncAttemptsPurged).toBeGreaterThan(200);
	expect(count()).toBe(Number(rowsBefore) - result.syncAttemptsPurged);
	expect(await readers(app)).toEqual(before);
	expect(before.connectivityFailures[0]).toBe(10);
	expect(
		store.db
			.prepare("SELECT count(*) FROM sync_attempts WHERE peer_device_id = ?")
			.pluck()
			.get(REMOVED),
	).toBe(10);
});
