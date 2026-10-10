import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { ObserverAuthError } from "./observer-client.js";
import { recoverOneMissingAuthWindow } from "./raw-event-auth-recovery.js";
import { refreshScopeMembershipCache } from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import { ScopeWriteAuthorityError } from "./scope-write-authority-error.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("./vectors.js", () => ({ storeVectors: vi.fn() }));

const version = "raw_events_auth_recovery_v1";
const clockPrefix = "observer_recovery_call_clock:";
const output =
	"<observation><type>discovery</type><title>Retained callback</title><narrative>Validate the callback before saving.</narrative></observation>";
let dir: string;
let store: MemoryStore;
let observe: ReturnType<typeof vi.fn>;
let settings: IngestOptions;

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(cacheTime));
	dir = mkdtempSync(join(tmpdir(), "codemem-budget-time-"));
	const path = join(dir, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
	const deviceId = store.deviceId;
	store.close();
	store = new MemoryStore(path, {
		runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
	});
	await refresh(3);
	store.db
		.prepare(
			"INSERT INTO project_scope_mappings(project_pattern, scope_id, priority, source, created_at, updated_at) VALUES (?, 'scope-a', 100, 'user', ?, ?)",
		)
		.run(dir, cacheTime, cacheTime);
	observe = vi.fn(async () => ({ raw: output, parsed: null, provider: "test", model: "test" }));
	settings = {
		observer: {
			observe,
			getStatus: () => ({
				provider: "test",
				model: "test",
				runtime: "api_http",
				auth: { source: "test", type: "test", hasToken: true },
			}),
		} as unknown as IngestOptions["observer"],
	};
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

async function refresh(epoch: number) {
	const scope = cacheScope({ kind: "managed_project", membership_epoch: epoch });
	const snapshot = cacheWireSnapshot(scope, [cacheMember(scope, store.deviceId)]);
	await refreshScopeMembershipCache(store.db, {
		coordinatorId: "server-a",
		groupIds: ["group-a"],
		now: new Date(cacheTime),
		fetchers: {
			listScopes: async () => ({ version: 1, items: [scope] }),
			getScopeSnapshot: async () => snapshot,
		},
	});
}

function addStream(id: string, { managed = false }: { managed?: boolean } = {}) {
	store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: id,
		source: "opencode",
		cwd: managed ? dir : join(dir, "unmanaged"),
		project: "fixture",
		metadata: {},
		startedAt: cacheTime,
		toolVersion: "raw_events",
	});
	store.recordRawEvent({
		opencodeSessionId: id,
		eventId: `${id}-prompt`,
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Recover retained history" },
		tsWallMs: Date.parse(cacheTime),
	});
	const batch = store.getOrCreateRawEventFlushBatch(id, "opencode", 0, 0, "raw_events_v1");
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='gave_up', observer_error_code='auth_missing', created_at=? WHERE id=?",
		)
		.run(new Date(Date.now() + 1000).toISOString(), batch.batchId);
	store.updateRawEventFlushState(id, 0);
}

function batch(id: string) {
	return store.db
		.prepare(
			"SELECT id, status, attempt_count, updated_at, error_type FROM raw_event_flush_batches WHERE stream_id=? AND extractor_version=?",
		)
		.get(id, version) as {
		id: number;
		status: string;
		attempt_count: number;
		updated_at: string;
		error_type: string | null;
	};
}

function clock(id: string) {
	return store.db
		.prepare("SELECT created_at FROM usage_events WHERE event=?")
		.get(`${clockPrefix}${batch(id).id}`);
}

async function failedCall(id: string, { managed = false }: { managed?: boolean } = {}) {
	addStream(id, { managed });
	store.db
		.prepare("UPDATE raw_event_flush_batches SET created_at=? WHERE stream_id=?")
		.run(
			new Date(Date.parse("2000-01-01T00:00:00Z") - observe.mock.calls.length * 1000).toISOString(),
			id,
		);
	observe.mockRejectedValueOnce(new Error("provider unavailable"));
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow(
		"provider unavailable",
	);
}

it.each([false, true])(
	"does not refresh four old calls after repeated pre-inference denials (legacy: %s)",
	async (legacy) => {
		// Arrange: four genuine failed calls are older than the hourly cutoff.
		for (let i = 0; i < 4; i++) await failedCall(`denied-${i}`, { managed: true });
		const oldTime = new Date().toISOString();
		if (legacy)
			store.db.prepare("DELETE FROM usage_events WHERE event LIKE ?").run(`${clockPrefix}%`);
		vi.setSystemTime(Date.now() + 3_600_001);
		store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
		observe.mockClear();

		// Act: each sweep retries all denied streams, then reaches newer authorized history.
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
			ScopeWriteAuthorityError,
		);
		expect(observe).not.toHaveBeenCalled();
		for (let tick = 0; tick < 4; tick++) {
			vi.setSystemTime(Date.now() + 30_000);
			addStream(`healthy-${tick}`);
			expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
			// Assert: retry time changes, but the retained real-call clock does not.
			expect(observe).toHaveBeenCalledTimes(tick + 1);
			for (let i = 0; i < 4; i++) {
				expect(batch(`denied-${i}`)).toMatchObject({
					status: "failed",
					attempt_count: 1,
					updated_at: new Date().toISOString(),
					error_type: "ScopeWriteAuthorityError",
				});
				expect(clock(`denied-${i}`)).toEqual({ created_at: oldTime });
			}
			// Restart: accounting must come from SQLite, not process-local state.
			const deviceId = store.deviceId;
			store.close();
			store = new MemoryStore(join(dir, "test.sqlite"), {
				runtimeSigningKey: { deviceId, publicKey: CANONICAL_PUBLIC_KEY },
			});
		}
		addStream("fifth");
		expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
		expect(observe).toHaveBeenCalledTimes(4);
	},
);

it("preserves current-hour legacy calls while releasing a global authentication failure", async () => {
	// Arrange: an old failed call and a recent failed call both lack clock markers.
	await failedCall("old");
	const oldTime = new Date().toISOString();
	vi.setSystemTime(Date.now() + 3_600_001);
	// Temporarily exhaust the old range so the new stream is selected.
	store.db
		.prepare("UPDATE raw_event_flush_batches SET attempt_count=3 WHERE extractor_version=?")
		.run(version);
	await failedCall("recent");
	const recentTime = new Date().toISOString();
	store.db
		.prepare("UPDATE raw_event_flush_batches SET attempt_count=1 WHERE extractor_version=?")
		.run(version);
	store.db.prepare("DELETE FROM usage_events WHERE event LIKE ?").run(`${clockPrefix}%`);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET created_at='1999-01-01T00:00:00.000Z' WHERE stream_id='old'",
		)
		.run();
	observe.mockRejectedValueOnce(new ObserverAuthError("Credential expired"));

	// Act
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
		ObserverAuthError,
	);

	// Assert: the old call stays old; the recent call remains a real hourly debit.
	expect(clock("old")).toEqual({ created_at: oldTime });
	expect(batch("old")).toMatchObject({ attempt_count: 1, updated_at: recentTime });
	store.db
		.prepare("UPDATE raw_event_flush_batches SET status='completed' WHERE extractor_version=?")
		.run(version);
	for (let i = 0; i < 3; i++) {
		addStream(`healthy-${i}`);
		expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	}
	addStream("fifth");
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
});

it("restores the old clock after a returned denial and resumes at exactly 15000ms", async () => {
	// Arrange: one old provider attempt precedes three new successful calls.
	await failedCall("denied", { managed: true });
	const oldTime = new Date().toISOString();
	vi.setSystemTime(Date.now() + 3_600_001);
	store.db
		.prepare("UPDATE raw_event_flush_batches SET attempt_count=3 WHERE extractor_version=?")
		.run(version);
	for (let i = 0; i < 3; i++) {
		addStream(`healthy-${i}`);
		expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	}
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET attempt_count=1 WHERE stream_id='denied' AND extractor_version=?",
		)
		.run(version);
	const start = Date.now();
	observe.mockImplementationOnce(async () => {
		store.db.prepare("UPDATE scope_memberships SET status='revoked'").run();
		vi.setSystemTime(start + 30_000);
		return { raw: output, parsed: null, provider: "test", model: "test" };
	});

	// Act
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
		ScopeWriteAuthorityError,
	);

	// Assert: only the returned fourth call is freshly charged, not the retained old attempt.
	expect(clock("denied")).toEqual({ created_at: oldTime });
	expect(batch("denied")).toMatchObject({ attempt_count: 1, updated_at: new Date().toISOString() });
	expect(
		store.db
			.prepare("SELECT created_at FROM usage_events WHERE event='observer_recovery_scope_denial'")
			.all(),
	).toEqual([{ created_at: new Date(start).toISOString() }]);
	addStream("fifth");
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	// Remove only the three earlier calls by advancing past their hour; denial is still in cooldown.
	store.db
		.prepare("UPDATE raw_event_flush_batches SET status='completed' WHERE stream_id='fifth'")
		.run();
	vi.setSystemTime(start + 3_600_001);
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
		ScopeWriteAuthorityError,
	);
	const releaseTime = Date.now();
	await refresh(4);
	vi.setSystemTime(releaseTime + 14_999);
	// The same range cannot resume early even after authority is restored.
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(batch("denied").status).toBe("failed");
	vi.setSystemTime(releaseTime + 15_000);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(batch("denied")).toMatchObject({ status: "completed", attempt_count: 2 });
	expect(clock("denied")).toEqual({ created_at: new Date().toISOString() });
});

it("does not restore an obsolete clock or release a replacement worker claim", async () => {
	// Arrange: emulate the database changes from another worker taking an expired claim.
	await failedCall("replaced");
	vi.setSystemTime(Date.now() + 3_600_001);
	let replacement: ReturnType<typeof batch> | undefined;
	let replacementClock: unknown;
	observe.mockImplementationOnce(async () => {
		vi.setSystemTime(Date.now() + 30_000);
		const id = batch("replaced").id;
		store.db.prepare("UPDATE raw_event_flush_batches SET status='failed' WHERE id=?").run(id);
		expect(store.claimRawEventFlushBatch(id)).toBe(true);
		store.db
			.prepare("UPDATE usage_events SET created_at=? WHERE event=?")
			.run(new Date().toISOString(), `${clockPrefix}${id}`);
		replacement = batch("replaced");
		replacementClock = clock("replaced");
		throw new ScopeWriteAuthorityError();
	});

	// Act
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
		ScopeWriteAuthorityError,
	);

	// Assert: the newer owner's counter, claim time, and call clock survive unchanged.
	expect(batch("replaced")).toEqual(replacement);
	expect(clock("replaced")).toEqual(replacementClock);
	expect(
		store.db
			.prepare("SELECT * FROM usage_events WHERE event='observer_recovery_scope_denial'")
			.all(),
	).toEqual([]);
});

it.each([undefined, null, "", "fixture", "unrelated"])(
	"excludes private call clocks without hiding real or unknown public events (project: %s)",
	(project) => {
		// Arrange: clocks cannot become public telemetry, even with token/provenance fields.
		addStream("public");
		const linked = store.db
			.prepare("SELECT session_id FROM opencode_sessions WHERE stream_id='public'")
			.get() as { session_id: number };
		for (const event of [
			"observer_call",
			"legacy_unknown",
			"observerXrecoveryXcallXclock:1",
			`${clockPrefix}1`,
		]) {
			store.db
				.prepare(
					"INSERT INTO usage_events(event, session_id, created_at, tokens_read, metadata_json) VALUES (?, ?, ?, 10, ?)",
				)
				.run(
					event,
					linked.session_id,
					new Date().toISOString(),
					'{"token_usage":{"source":"provider"}}',
				);
		}
		store.db
			.prepare("INSERT INTO usage_events(event, created_at) VALUES (?, ?)")
			.run(`${clockPrefix}2`, new Date().toISOString());

		// Act
		const usage = store.usageAggregate(project);
		const classified = store.classifiedUsageAggregate(project);
		const stats = store.stats().usage;

		// Assert: only the exact internal prefix is private; unknown events retain compatibility.
		const expected =
			project === "unrelated"
				? []
				: ["legacy_unknown", "observerXrecoveryXcallXclock:1", "observer_call"];
		expect(usage.map((row) => row.event).sort()).toEqual(expected);
		expect(classified.map((row) => row.event).sort()).toEqual(expected);
		expect(usage.reduce((sum, row) => sum + row.tokens_read, 0)).toBe(expected.length * 10);
		expect(stats.events.reduce((sum, row) => sum + row.count, 0)).toBe(3);
		expect(stats.totals.tokens_read).toBe(30);
	},
);

it("keeps clock-only storage private without deleting persisted call times", () => {
	// Arrange
	store.db
		.prepare("INSERT INTO usage_events(event, created_at) VALUES (?, ?)")
		.run(`${clockPrefix}1`, new Date().toISOString());

	// Act
	const usage = store.usageAggregate();
	const classified = store.classifiedUsageAggregate();
	const stats = store.stats().usage;

	// Assert
	expect(usage).toEqual([]);
	expect(classified).toEqual([]);
	expect(stats.events).toEqual([]);
	expect(stats.provenance.totals.legacy_unclassified_count).toBe(0);
	expect(stats.totals).toMatchObject({ tokens_read: 0, tokens_written: 0, tokens_saved: 0 });
	expect(
		store.db
			.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE event=?")
			.get(`${clockPrefix}1`),
	).toEqual({ count: 1 });
});
