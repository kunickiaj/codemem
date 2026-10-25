import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { MemoryStore } from "./store.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seededDatabase(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-open-lock-"));
	dirs.push(dir);
	const path = join(dir, "mem.sqlite");
	const store = new MemoryStore(path);
	store.db
		.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, created_at, highest_observed_direct_signature_version)
			 VALUES ('peer-a', 'Peer A', '2026-09-25T00:00:00.000Z', 3)`,
		)
		.run();
	store.close();
	// A second open copies the peer's signature state; after that nothing is pending.
	new MemoryStore(path).close();
	return path;
}

it("still repairs a missing security trigger and copies newer signature state", () => {
	const path = seededDatabase();
	const raw = new Database(path);
	raw.exec("DROP TRIGGER trg_identity_devices_purge_decisions");
	raw
		.prepare(
			"UPDATE sync_peers SET highest_observed_direct_signature_version = 4 WHERE peer_device_id = 'peer-a'",
		)
		.run();
	raw.close();

	const store = new MemoryStore(path);
	try {
		expect(
			store.db
				.prepare(
					"SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_identity_devices_purge_decisions'",
				)
				.pluck()
				.get(),
		).toBe(1);
		expect(
			store.db
				.prepare(
					"SELECT highest_observed_direct_signature_version FROM sync_peer_signature_state WHERE peer_device_id = 'peer-a'",
				)
				.pluck()
				.get(),
		).toBe(4);
	} finally {
		store.close();
	}
});

it("rebuilds the effect-id partial index when its predicate is stale", () => {
	const path = seededDatabase();
	const raw = new Database(path);
	raw.exec(`
		DROP INDEX idx_share_operation_steps_effect_id_nonempty;
		CREATE INDEX idx_share_operation_steps_effect_id_nonempty
			ON share_operation_steps(effect_id) WHERE effect_id IS NOT NULL;
	`);
	raw.close();

	const store = new MemoryStore(path);
	try {
		const sql = store.db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE name = 'idx_share_operation_steps_effect_id_nonempty'",
			)
			.pluck()
			.get() as string;
		expect(sql.replace(/\s+/g, " ")).toContain("WHERE effect_id <> ''");
	} finally {
		store.close();
	}
});

it("opens an up-to-date database while another connection holds the write lock", () => {
	const path = seededDatabase();
	const writer = new Database(path);
	writer.pragma("busy_timeout = 0");
	writer.exec("BEGIN IMMEDIATE");
	const previous = process.env.CODEMEM_SQLITE_BUSY_TIMEOUT_MS;
	try {
		const started = Date.now();
		const store = new MemoryStore(path);
		try {
			expect(store.db.prepare("SELECT COUNT(*) FROM sync_peers").pluck().get()).toBe(1);
		} finally {
			store.close();
		}
		// Must not wait on the lock at all.
		expect(Date.now() - started).toBeLessThan(2_000);
	} finally {
		writer.exec("ROLLBACK");
		writer.close();
		if (previous == null) delete process.env.CODEMEM_SQLITE_BUSY_TIMEOUT_MS;
		else process.env.CODEMEM_SQLITE_BUSY_TIMEOUT_MS = previous;
	}
});
