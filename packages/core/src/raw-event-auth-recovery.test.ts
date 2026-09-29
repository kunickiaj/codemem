import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { ObserverAuthError } from "./observer-client.js";
import { recoverOneMissingAuthWindow } from "./raw-event-auth-recovery.js";
import { RawEventSweeper } from "./raw-event-sweeper.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

let dir: string;
let store: MemoryStore;
let sessionId: number;
const eventTime = Date.parse("2026-09-21T10:00:00.000Z");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-auth-recovery-"));
	const path = join(dir, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
	sessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "missed-session",
		source: "opencode",
		cwd: dir,
		project: "codemem",
		metadata: { source: "plugin" },
		startedAt: "2026-09-21T09:00:00.000Z",
		toolVersion: "raw_events",
	});
	store.endSession(sessionId, { original: true });
	store.recordRawEvent({
		opencodeSessionId: "missed-session",
		eventId: "prompt",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Investigate validated callback" },
		tsWallMs: eventTime - 1000,
	});
	store.recordRawEvent({
		opencodeSessionId: "missed-session",
		eventId: "tool",
		eventType: "tool.execute.after",
		payload: {
			type: "tool.execute.after",
			tool: "read",
			args: { filePath: "fixture.ts" },
			result: "Use validated callback.",
		},
		tsWallMs: eventTime,
	});
	const batch = store.getOrCreateRawEventFlushBatch(
		"missed-session",
		"opencode",
		0,
		1,
		"raw_events_v1",
	);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='gave_up', observer_error_code='auth_missing', attempt_count=5 WHERE id=?",
		)
		.run(batch.batchId);
	store.updateRawEventFlushState("missed-session", 1);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function options(): { settings: IngestOptions; observe: ReturnType<typeof vi.fn> } {
	const observe = vi.fn(async () => ({
		raw: "<observation><type>discovery</type><title>Validated callback</title><narrative>Use the validated callback before saving.</narrative></observation>",
		parsed: null,
		provider: "test",
		model: "test",
	}));
	return {
		observe,
		settings: {
			observer: {
				observe,
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "test", hasToken: true },
				}),
			} as unknown as IngestOptions["observer"],
		},
	};
}

it("recovers stranded events once without rewinding the cursor or publishing the old observation", async () => {
	const { settings, observe } = options();
	const before = store.db
		.prepare("SELECT ended_at, metadata_json FROM sessions WHERE id=?")
		.get(sessionId);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).toHaveBeenCalledTimes(1);
	expect(
		store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_v1'")
			.get(),
	).toMatchObject({ status: "recovered" });
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(
		store.db.prepare("SELECT ended_at, metadata_json FROM sessions WHERE id=?").get(sessionId),
	).toEqual(before);
	const rows = store.db
		.prepare(
			"SELECT id, created_at, visibility, workspace_kind FROM memory_items WHERE session_id=?",
		)
		.all(sessionId) as Array<{
		id: number;
		created_at: string;
		visibility: string;
		workspace_kind: string;
	}>;
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		created_at: new Date(eventTime).toISOString(),
		visibility: "private",
		workspace_kind: "personal",
	});
	expect(
		store.db
			.prepare("SELECT COUNT(*) AS n FROM replication_ops WHERE entity_id=?")
			.get(String(rows[0]?.id)),
	).toMatchObject({ n: 0 });
	expect(
		store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1' AND status='completed'",
			)
			.get(),
	).toMatchObject({ n: 1 });
});

it("completes a usage-only auth gap without an observer call or cursor rewind", async () => {
	for (const eventId of ["prompt", "tool"]) {
		store.db
			.prepare(
				"UPDATE raw_events SET event_type='assistant_usage', payload_json=? WHERE event_id=?",
			)
			.run(JSON.stringify({ type: "assistant_usage", usage: { input_tokens: 12 } }), eventId);
	}
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode','missed-session','missed-session',0,1,'raw_events_auth_recovery_v1','failed',datetime('now'),datetime('now','-1 hour'),3)",
		)
		.run();
	for (let i = 0; i < 4; i++) {
		store.db
			.prepare(
				"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode',?, ?, ?, ?,'raw_events_auth_recovery_v1','completed',datetime('now'),?,1)",
			)
			.run(`previous-${i}`, `previous-${i}`, i, i, new Date().toISOString());
	}
	store.recordRawEvent({
		opencodeSessionId: "earlier-content",
		eventId: "earlier-prompt",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Retain this prompt" },
		tsWallMs: eventTime,
	});
	store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "earlier-content",
		source: "opencode",
		cwd: dir,
		project: "codemem",
		metadata: { source: "plugin" },
		startedAt: "2026-09-21T09:00:00.000Z",
		toolVersion: "raw_events",
	});
	const earlier = store.getOrCreateRawEventFlushBatch(
		"earlier-content",
		"opencode",
		0,
		0,
		"raw_events_v1",
	);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='gave_up', observer_error_code='auth_missing', created_at=datetime('now','-1 day') WHERE id=?",
		)
		.run(earlier.batchId);
	store.updateRawEventFlushState("earlier-content", 0);
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(store.rawEventsSinceBySeq("missed-session")).toHaveLength(2);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 0 });
	expect(
		store.db
			.prepare(
				"SELECT status, attempt_count FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ status: "completed", attempt_count: 0 });
	expect(
		store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_v1'")
			.get(),
	).toMatchObject({ status: "recovered" });
});

it("keeps exhausted content-bearing auth gaps blocked", async () => {
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode','missed-session','missed-session',0,1,'raw_events_auth_recovery_v1','failed',datetime('now'),datetime('now','-1 hour'),3)",
		)
		.run();
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
});

it("does not complete a usage-only gap with a missing event timestamp", async () => {
	for (const eventId of ["prompt", "tool"]) {
		store.db
			.prepare(
				"UPDATE raw_events SET event_type='assistant_usage', payload_json=? WHERE event_id=?",
			)
			.run(JSON.stringify({ type: "assistant_usage", usage: { input_tokens: 12 } }), eventId);
	}
	store.db.prepare("UPDATE raw_events SET ts_wall_ms=NULL WHERE event_id='tool'").run();
	const { settings, observe } = options();
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow(
		"event time is unavailable",
	);
	expect(observe).not.toHaveBeenCalled();
	expect(
		store.db
			.prepare(
				"SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ status: "failed" });
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET attempt_count=3, updated_at=datetime('now','-1 hour') WHERE extractor_version='raw_events_auth_recovery_v1'",
		)
		.run();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(
		store.db
			.prepare(
				"SELECT attempt_count FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ attempt_count: 3 });
});

it("still infers when an auth gap mixes usage with processable content", async () => {
	store.db
		.prepare(
			"UPDATE raw_events SET event_type='assistant_usage', payload_json=? WHERE event_id='prompt'",
		)
		.run(JSON.stringify({ type: "assistant_usage", usage: { input_tokens: 12 } }));
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(1);
});

it("never infers over a completed event range", async () => {
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode','missed-session','missed-session',0,1,'raw_events_completed_v1','completed',datetime('now'),datetime('now'),1)",
		)
		.run();
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
	expect(
		store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_v1'")
			.get(),
	).toMatchObject({ status: "recovered" });
});

it("coalesces overlapping failed and exhausted ranges into one inference", async () => {
	store.db
		.prepare(
			"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count,observer_error_code) VALUES ('opencode','missed-session','missed-session',0,0,'raw_events_overlap_v1','failed',datetime('now'),datetime('now'),2,'auth_missing')",
		)
		.run();
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).toHaveBeenCalledTimes(1);
});

it("does not rerun inference after a crash following committed observations", async () => {
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='error', attempt_count=1 WHERE extractor_version='raw_events_auth_recovery_v1'",
		)
		.run();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(1);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 1 });
});

it("does not rerun a memoryless successful recovery after a crash", async () => {
	const { settings, observe } = options();
	observe.mockResolvedValue({
		raw: '<skip_summary reason="low-signal"/>',
		parsed: null,
		provider: "test",
		model: "test",
	});
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 0 });
	store.db
		.prepare(
			"UPDATE raw_event_flush_batches SET status='error', attempt_count=1 WHERE extractor_version='raw_events_auth_recovery_v1'",
		)
		.run();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(1);
});

it("does not treat failure usage as a completed memoryless recovery", async () => {
	const { settings, observe } = options();
	observe.mockResolvedValue({ raw: null, parsed: null, provider: "test", model: "test" });
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow();
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow();
	expect(observe).toHaveBeenCalledTimes(2);
	expect(
		store.db
			.prepare(
				"SELECT status FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get(),
	).toMatchObject({ status: "failed" });
});

it("does not treat failed persistence telemetry as a successful recovery", async () => {
	const { settings, observe } = options();
	const remember = vi.spyOn(store, "remember").mockImplementation(() => {
		throw new Error("storage busy");
	});
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow("storage busy");
	remember.mockRestore();
	expect(
		store.db
			.prepare(
				"SELECT COUNT(*) AS n FROM usage_events WHERE json_extract(metadata_json, '$.historical_recovery_batch_id') IS NOT NULL",
			)
			.get(),
	).toMatchObject({ n: 0 });
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(true);
	expect(observe).toHaveBeenCalledTimes(2);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 1 });
});

it("leaves missing event timestamps unprocessed rather than inventing a timeline", async () => {
	store.db.prepare("UPDATE raw_events SET ts_wall_ms=NULL WHERE event_id='tool'").run();
	const { settings, observe } = options();
	await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toThrow(
		"event time is unavailable",
	);
	expect(observe).not.toHaveBeenCalled();
	expect(store.rawEventFlushState("missed-session")).toBe(1);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 0 });
});

it("keeps authentication failures retryable without spending recovery attempts", async () => {
	const { settings, observe } = options();
	observe.mockImplementation(async () => {
		throw new ObserverAuthError("Credential expired");
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		await expect(recoverOneMissingAuthWindow(store, settings)).rejects.toBeInstanceOf(
			ObserverAuthError,
		);
		const row = store.db
			.prepare(
				"SELECT status, attempt_count, observer_error_code FROM raw_event_flush_batches WHERE extractor_version='raw_events_auth_recovery_v1'",
			)
			.get();
		expect(row).toMatchObject({
			status: "failed",
			attempt_count: 0,
			observer_error_code: "auth_failed",
		});
	}
	expect(store.rawEventFlushState("missed-session")).toBe(1);
});

it("pauses once the per-hour recovery budget is spent", async () => {
	for (let i = 0; i < 4; i++) {
		store.db
			.prepare(
				"INSERT INTO raw_event_flush_batches(source,stream_id,opencode_session_id,start_event_seq,end_event_seq,extractor_version,status,created_at,updated_at,attempt_count) VALUES ('opencode',?, ?, ?, ?,'raw_events_auth_recovery_v1','completed',datetime('now'),?,1)",
			)
			.run(`previous-${i}`, `previous-${i}`, i, i, new Date().toISOString());
	}
	const { settings, observe } = options();
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	expect(observe).not.toHaveBeenCalled();
});

it("reserves the same window for only one concurrent worker", async () => {
	const { settings, observe } = options();
	let resolve: (() => void) | undefined;
	const pending = new Promise<void>((done) => {
		resolve = done;
	});
	const firstResponse = await observe();
	observe.mockImplementation(async () => {
		await pending;
		return firstResponse;
	});
	const first = recoverOneMissingAuthWindow(store, settings);
	await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));
	expect(await recoverOneMissingAuthWindow(store, settings)).toBe(false);
	resolve?.();
	expect(await first).toBe(true);
	expect(
		store.db.prepare("SELECT COUNT(*) AS n FROM memory_items WHERE session_id=?").get(sessionId),
	).toMatchObject({ n: 1 });
});

it("automatically schedules an old auth gap during a normal sweep", async () => {
	const prior = process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED;
	process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED = "1";
	try {
		const { settings, observe } = options();
		const sweeper = new RawEventSweeper(store, settings);
		await sweeper.tick();
		expect(observe).toHaveBeenCalledTimes(1);
		expect(store.rawEventFlushState("missed-session")).toBe(1);
	} finally {
		if (prior === undefined) delete process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED;
		else process.env.CODEMEM_RAW_EVENTS_RECOVERY_ENABLED = prior;
	}
});
