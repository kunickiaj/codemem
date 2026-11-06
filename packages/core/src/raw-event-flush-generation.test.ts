import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { columnExists, connect, ensureAdditiveSchemaCompatibility, SCHEMA_VERSION } from "./db.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

const frozenTime = "2026-01-01T00:00:00.000Z";
const admissionFailure = {
	code: "auth_missing",
	provider: null,
	model: null,
	runtime: null,
	authSource: null,
	authType: null,
};

function batchSnapshot(store: MemoryStore) {
	return store.db
		.prepare(
			"SELECT status, attempt_count, claim_generation, updated_at FROM raw_event_flush_batches",
		)
		.get() as {
		status: string;
		attempt_count: number;
		claim_generation: number;
		updated_at: string;
	};
}

let directory: string;
let store: MemoryStore;
let batchId: number;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-flush-generation-"));
	store = new MemoryStore(join(directory, "test.sqlite"));
	store.recordRawEvent({
		opencodeSessionId: "generation-stream",
		eventId: "evt-1",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Retain capture data across upgrades" },
		tsWallMs: 100,
	});
	batchId = store.getOrCreateRawEventFlushBatch(
		"generation-stream",
		"opencode",
		0,
		0,
		"raw_events_v1",
	).batchId;
});
afterEach(() => {
	vi.useRealTimers();
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

describe("raw-event flush generation schema compatibility", () => {
	it("bootstraps the non-null generation column with a zero default", () => {
		// Arrange: bootstrap directly without the store's additive compatibility pass.
		const db = connect(join(directory, "bootstrap.sqlite"));
		try {
			// Act
			initTestSchema(db);
			const column = db
				.prepare("PRAGMA table_info(raw_event_flush_batches)")
				.all()
				.find((row) => (row as { name: string }).name === "claim_generation");
			// Assert: new databases need no later repair before creating batches.
			expect(column).toMatchObject({
				name: "claim_generation",
				type: "INTEGER",
				notnull: 1,
				dflt_value: "0",
			});
			expect(batchSnapshot(store).claim_generation).toBe(0);
		} finally {
			db.close();
		}
	});

	it.each(["current", "legacy"] as const)(
		"upgrades a %s-marker database without losing rows and is idempotent",
		(marker) => {
			// Arrange: represent an existing database that predates this additive column.
			if (columnExists(store.db, "raw_event_flush_batches", "claim_generation"))
				store.db.exec("ALTER TABLE raw_event_flush_batches DROP COLUMN claim_generation");
			const version = marker === "current" ? SCHEMA_VERSION : 6;
			store.db.pragma(`user_version = ${version}`);
			store.db
				.prepare("UPDATE schema_compat_state SET applied_schema_version = ? WHERE id = 1")
				.run(version);
			store.db
				.prepare(
					"UPDATE raw_event_flush_batches SET status = 'failed', attempt_count = 4, error_type = 'legacy_failure', error_message = 'retry later' WHERE id = ?",
				)
				.run(batchId);
			const before = store.db.prepare("SELECT * FROM raw_event_flush_batches").get();
			const events = store.db.prepare("SELECT * FROM raw_events").all();
			const sessions = store.db.prepare("SELECT * FROM raw_event_sessions").all();

			// Act: exercise both the version-gated and always-run compatibility paths twice.
			ensureAdditiveSchemaCompatibility(store.db);
			ensureAdditiveSchemaCompatibility(store.db);

			// Assert: migration adds a neutral generation without changing prior capture state.
			expect(store.db.prepare("SELECT * FROM raw_event_flush_batches").get()).toEqual({
				...(before as object),
				claim_generation: 0,
			});
			expect(store.db.prepare("SELECT * FROM raw_events").all()).toEqual(events);
			expect(store.db.prepare("SELECT * FROM raw_event_sessions").all()).toEqual(sessions);
			expect(store.claimRawEventFlushBatch(batchId)).toBe(true);
			expect(batchSnapshot(store)).toMatchObject({ claim_generation: 1, attempt_count: 5 });
			ensureAdditiveSchemaCompatibility(store.db);
			expect(batchSnapshot(store)).toMatchObject({ claim_generation: 1, attempt_count: 5 });
		},
	);
});

describe("raw-event flush generation counters", () => {
	it.each([true, false])(
		"increments generation on each successful claim with countAttempt=%s",
		(countAttempt) => {
			// Arrange
			const options = { countAttempt };
			// Act
			const first = store.claimRawEventFlushBatch(batchId, options);
			const claimed = batchSnapshot(store);
			const blocked = store.claimRawEventFlushBatch(batchId, options);
			const unchanged = batchSnapshot(store);
			store.updateRawEventFlushBatchStatus(batchId, "pending");
			const second = store.claimRawEventFlushBatch(batchId, options);
			// Assert: ownership progresses independently of the billable attempt counter.
			expect(first).toBe(true);
			expect(claimed).toMatchObject({ claim_generation: 1, attempt_count: Number(countAttempt) });
			expect(blocked).toBe(false);
			expect(unchanged).toEqual(claimed);
			expect(second).toBe(true);
			expect(batchSnapshot(store)).toMatchObject({
				claim_generation: 2,
				attempt_count: 2 * Number(countAttempt),
			});
		},
	);

	it.each(["completed", "gave_up"])("does not claim a %s batch or an absent batch", (status) => {
		// Arrange
		store.updateRawEventFlushBatchStatus(batchId, status);
		const before = batchSnapshot(store);
		// Act
		const terminal = store.claimRawEventFlushBatch(batchId);
		const missing = store.claimRawEventFlushBatch(batchId + 1);
		// Assert: rejected claims do not mint generations.
		expect(terminal).toBe(false);
		expect(missing).toBe(false);
		expect(batchSnapshot(store)).toEqual(before);
	});

	it("never debits generation when admission release or maintenance resets attempts", () => {
		// Arrange
		store.claimRawEventFlushBatch(batchId);
		// Act
		const released = store.releaseRawEventFlushBatchAfterAuthError(batchId, admissionFailure);
		const afterRelease = batchSnapshot(store);
		const duplicateRelease = store.releaseRawEventFlushBatchAfterAuthError(
			batchId,
			admissionFailure,
		);
		const afterDuplicate = batchSnapshot(store);
		const reclaimed = store.claimRawEventFlushBatch(batchId, { countAttempt: false });
		const afterReclaim = batchSnapshot(store);
		store.updateRawEventFlushBatchStatus(batchId, "pending", { resetAttempts: true });
		store.claimRawEventFlushBatch(batchId);
		store.updateRawEventFlushBatchStatus(batchId, "pending", { resetAttempts: true });
		const afterReset = batchSnapshot(store);
		store.close();
		store = new MemoryStore(join(directory, "test.sqlite"));
		// Assert: release can undo an attempt, never an issued ownership generation.
		expect(released).toBe(true);
		expect(afterRelease).toMatchObject({ status: "failed", attempt_count: 0, claim_generation: 1 });
		expect(duplicateRelease).toBe(false);
		expect(afterDuplicate).toEqual(afterRelease);
		expect(reclaimed).toBe(true);
		expect(afterReclaim).toMatchObject({ attempt_count: 0, claim_generation: 2 });
		expect(afterReset).toMatchObject({ status: "pending", attempt_count: 0, claim_generation: 3 });
		expect(batchSnapshot(store)).toEqual(afterReset);
	});
});

describe("raw-event flush generation when connecting", () => {
	it("does not alter an unrelated database with a coincidentally named batch table", () => {
		// Arrange: raw SQLite creates a database with no recognizable Codemem schema.
		const path = join(directory, "unrelated.sqlite");
		const fixture = new BetterSqlite3(path);
		fixture.exec(`
			PRAGMA user_version = 7;
			CREATE TABLE sentinel (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
			INSERT INTO sentinel VALUES (1, 'preserve unrelated data');
			CREATE TABLE raw_event_flush_batches (id INTEGER PRIMARY KEY, status TEXT, updated_at TEXT);
			INSERT INTO raw_event_flush_batches VALUES (1, 'unrelated', 'not-a-timestamp');
		`);
		const schema = fixture
			.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
			.all();
		const batches = fixture.prepare("SELECT * FROM raw_event_flush_batches").all();
		const sentinel = fixture.prepare("SELECT * FROM sentinel").all();
		fixture.close();

		// Act: connect must retain its conservative early return for unknown databases.
		const db = connect(path);
		try {
			// Assert: neither the coincidental table name nor the marker authorizes migration.
			expect(columnExists(db, "raw_event_flush_batches", "claim_generation")).toBe(false);
			expect(db.pragma("user_version", { simple: true })).toBe(7);
			expect(
				db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
			).toEqual(schema);
			expect(db.prepare("SELECT * FROM raw_event_flush_batches").all()).toEqual(batches);
			expect(db.prepare("SELECT * FROM sentinel").all()).toEqual(sentinel);
		} finally {
			db.close();
		}
	});

	it("upgrades a recognizable current-marker database on connect without losing capture rows", () => {
		// Arrange: the current compatibility marker does not imply this additive column exists.
		store.db.exec("ALTER TABLE raw_event_flush_batches DROP COLUMN claim_generation");
		store.db.pragma(`user_version = ${SCHEMA_VERSION}`);
		store.db
			.prepare("UPDATE schema_compat_state SET applied_schema_version = ? WHERE id = 1")
			.run(SCHEMA_VERSION);
		store.db
			.prepare(
				"UPDATE raw_event_flush_batches SET status = 'failed', attempt_count = 4, error_message = 'retry later' WHERE id = ?",
			)
			.run(batchId);
		const before = store.db.prepare("SELECT * FROM raw_event_flush_batches").get();
		const events = store.db.prepare("SELECT * FROM raw_events").all();
		const sessions = store.db.prepare("SELECT * FROM raw_event_sessions").all();
		store.close();

		// Act: exercise connect itself, without an explicit additive compatibility call.
		const db = connect(join(directory, "test.sqlite"));
		try {
			// Assert: recognizing the full schema permits only the additive upgrade.
			expect(db.prepare("SELECT * FROM raw_event_flush_batches").get()).toEqual({
				...(before as object),
				claim_generation: 0,
			});
			expect(db.prepare("SELECT * FROM raw_events").all()).toEqual(events);
			expect(db.prepare("SELECT * FROM raw_event_sessions").all()).toEqual(sessions);
			expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
		} finally {
			db.close();
		}
	});
});

describe("raw-event flush generation exhaustion", () => {
	it.each([true, false])(
		"rejects exhausted generations without changing the batch with countAttempt=%s",
		(countAttempt) => {
			// Arrange: the last representable generation remains available exactly once.
			store.db
				.prepare("UPDATE raw_event_flush_batches SET claim_generation = ? WHERE id = ?")
				.run(Number.MAX_SAFE_INTEGER - 1, batchId);
			// Act
			const last = store.claimRawEventFlushBatch(batchId, { countAttempt });
			const lastClaim = batchSnapshot(store);
			store.updateRawEventFlushBatchStatus(batchId, "pending");
			const before = batchSnapshot(store);
			const exhausted = store.claimRawEventFlushBatch(batchId, { countAttempt });
			// Assert: no wrap, rounding, status change, attempt debit, or timestamp change occurs.
			expect(last).toBe(true);
			expect(lastClaim).toMatchObject({
				claim_generation: Number.MAX_SAFE_INTEGER,
				attempt_count: Number(countAttempt),
			});
			expect(exhausted).toBe(false);
			expect(batchSnapshot(store)).toEqual(before);
		},
	);
});

describe("raw-event flush generation and wall clocks", () => {
	it.each([
		{ clock: "frozen", now: frozenTime },
		{ clock: "forward", now: "2027-01-01T00:00:00.000Z" },
		{ clock: "backward", now: "2025-01-01T00:00:00.000Z" },
		{ clock: "invalid prior timestamp", now: frozenTime },
	])("issues a new generation with a $clock clock", ({ clock, now }) => {
		// Arrange: release refunds the attempt, recreating the old attempt count on reclaim.
		vi.setSystemTime(new Date(frozenTime));
		store.claimRawEventFlushBatch(batchId);
		const first = batchSnapshot(store);
		store.releaseRawEventFlushBatchAfterAuthError(batchId, admissionFailure);
		if (clock === "invalid prior timestamp")
			store.db
				.prepare("UPDATE raw_event_flush_batches SET updated_at = 'invalid-date' WHERE id = ?")
				.run(batchId);
		vi.setSystemTime(new Date(now));
		// Act: a legacy timestamp string is not parsed to derive ownership.
		const reclaimed = store.claimRawEventFlushBatch(batchId);
		const second = batchSnapshot(store);
		// Assert: generation changes even when the attempt and wall clock repeat or move backward.
		expect(reclaimed).toBe(true);
		expect(second).toMatchObject({
			status: "claimed",
			attempt_count: first.attempt_count,
			claim_generation: first.claim_generation + 1,
			updated_at: now,
		});
	});
});
