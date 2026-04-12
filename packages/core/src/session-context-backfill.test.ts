import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { getMaintenanceJob } from "./maintenance-jobs.js";
import {
	hasPendingSessionContextBackfill,
	runSessionContextBackfillPass,
	SESSION_CONTEXT_BACKFILL_JOB,
} from "./session-context-backfill.js";
import { initTestSchema } from "./test-utils.js";

interface SessionContextPayload {
	flusher?: string;
	source?: string;
	streamId?: string;
	opencodeSessionId?: string;
	firstPrompt?: string;
	promptCount?: number;
	toolCount?: number;
	durationMs?: number;
	filesRead?: string[];
	filesModified?: string[];
}

function insertRawEventSession(db: Database, source: string, streamId: string, now: string): void {
	db.prepare(
		`INSERT INTO raw_event_sessions(
			source, stream_id, opencode_session_id, updated_at,
			last_received_event_seq, last_flushed_event_seq
		) VALUES (?, ?, ?, ?, 0, -1)`,
	).run(source, streamId, streamId, now);
}

function insertRawEvent(
	db: Database,
	source: string,
	streamId: string,
	eventSeq: number,
	eventId: string,
	eventType: string,
	payload: Record<string, unknown>,
	tsWallMs: number,
): void {
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO raw_events(
			source, stream_id, opencode_session_id, event_id, event_seq,
			event_type, ts_wall_ms, payload_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		source,
		streamId,
		streamId,
		eventId,
		eventSeq,
		eventType,
		tsWallMs,
		JSON.stringify(payload),
		now,
	);
}

function insertSessionRow(
	db: Database,
	source: string | null,
	streamId: string | null,
	sessionContext: SessionContextPayload | null,
): number {
	const now = new Date().toISOString();
	const metadata = sessionContext == null ? {} : { session_context: sessionContext };
	const info = db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, user, tool_version, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(now, "/tmp/test", "test-project", "test-user", "raw_events", JSON.stringify(metadata));
	const sessionId = Number(info.lastInsertRowid);
	if (source && streamId) {
		db.prepare(
			`INSERT INTO opencode_sessions(source, stream_id, opencode_session_id, session_id, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run(source, streamId, streamId, sessionId, now);
	}
	return sessionId;
}

function readSessionContext(db: Database, sessionId: number): SessionContextPayload {
	const row = db.prepare("SELECT metadata_json FROM sessions WHERE id = ?").get(sessionId) as
		| { metadata_json: string | null }
		| undefined;
	if (!row?.metadata_json) return {};
	const parsed = JSON.parse(row.metadata_json) as { session_context?: SessionContextPayload };
	return parsed.session_context ?? {};
}

describe("session-context backfill maintenance", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
	});

	it("rebuilds session_context for a pre-fix raw-event session", async () => {
		const source = "claude";
		const streamId = "ses-prefix";
		const now = new Date().toISOString();
		insertRawEventSession(db, source, streamId, now);
		insertRawEvent(
			db,
			source,
			streamId,
			1,
			"evt-1",
			"claude.hook",
			{
				type: "claude.hook",
				_adapter: {
					schema_version: "1.0",
					source,
					session_id: streamId,
					event_id: "evt-1",
					event_type: "prompt",
					ts: "2026-03-04T10:00:00Z",
					payload: { text: "Investigate the flush bug" },
				},
			},
			Date.parse("2026-03-04T10:00:00Z"),
		);
		insertRawEvent(
			db,
			source,
			streamId,
			2,
			"evt-2",
			"claude.hook",
			{
				type: "claude.hook",
				_adapter: {
					schema_version: "1.0",
					source,
					session_id: streamId,
					event_id: "evt-2",
					event_type: "tool_result",
					ts: "2026-03-04T10:00:05Z",
					payload: {
						tool_name: "Edit",
						status: "ok",
						tool_input: { file_path: "/tmp/repo/src/flush.ts" },
					},
					meta: { original_event_type: "tool.execute.after" },
				},
			},
			Date.parse("2026-03-04T10:00:05Z"),
		);

		// Seed a pre-fix session: flusher=raw_events but derived fields are empty
		// because buildSessionContext ran on the un-normalized Claude Code envelope.
		const sessionId = insertSessionRow(db, source, streamId, {
			flusher: "raw_events",
			source,
			streamId,
			opencodeSessionId: streamId,
			promptCount: 0,
			toolCount: 0,
			durationMs: 0,
			filesRead: [],
			filesModified: [],
		});

		expect(hasPendingSessionContextBackfill(db)).toBe(true);

		const hasMore = await runSessionContextBackfillPass(db, { batchSize: 10 });
		expect(hasMore).toBe(false);

		const rebuilt = readSessionContext(db, sessionId);
		expect(rebuilt.promptCount).toBe(1);
		expect(rebuilt.toolCount).toBe(1);
		expect(rebuilt.firstPrompt).toBe("Investigate the flush bug");
		expect(rebuilt.filesModified).toEqual(["/tmp/repo/src/flush.ts"]);
		// Preserved identity fields.
		expect(rebuilt.flusher).toBe("raw_events");
		expect(rebuilt.source).toBe(source);
		expect(rebuilt.streamId).toBe(streamId);
		expect(rebuilt.opencodeSessionId).toBe(streamId);

		const job = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
		expect(job).toMatchObject({
			status: "completed",
			progress: { current: 1, total: 1, unit: "items" },
		});
		expect(job?.metadata).toMatchObject({
			rewritten_sessions: 1,
			processed_sessions: 1,
			unchanged_sessions: 0,
		});
	});

	it("is idempotent: second run after a rewrite is a no-op", async () => {
		const source = "opencode";
		const streamId = "ses-idempotent";
		const now = new Date().toISOString();
		insertRawEventSession(db, source, streamId, now);
		insertRawEvent(
			db,
			source,
			streamId,
			1,
			"evt-1",
			"user_prompt",
			{ type: "user_prompt", prompt_text: "Ship the fix" },
			1_700_000_000_000,
		);
		insertRawEvent(
			db,
			source,
			streamId,
			2,
			"evt-2",
			"tool.execute.after",
			{
				type: "tool.execute.after",
				tool: "edit",
				args: { filePath: "/repo/src/a.ts" },
			},
			1_700_000_001_000,
		);

		const sessionId = insertSessionRow(db, source, streamId, {
			flusher: "raw_events",
			source,
			streamId,
			opencodeSessionId: streamId,
			promptCount: 0,
			toolCount: 0,
			filesModified: [],
			filesRead: [],
		});

		await runSessionContextBackfillPass(db, { batchSize: 10 });
		const afterFirst = readSessionContext(db, sessionId);
		expect(afterFirst.promptCount).toBe(1);
		expect(afterFirst.toolCount).toBe(1);

		// Capture metadata_json to detect any write on the second run.
		const metadataBefore = db
			.prepare("SELECT metadata_json FROM sessions WHERE id = ?")
			.get(sessionId) as { metadata_json: string };

		const hasMore = await runSessionContextBackfillPass(db, { batchSize: 10 });
		expect(hasMore).toBe(false);

		const metadataAfter = db
			.prepare("SELECT metadata_json FROM sessions WHERE id = ?")
			.get(sessionId) as { metadata_json: string };
		expect(metadataAfter.metadata_json).toBe(metadataBefore.metadata_json);

		const job = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
		expect(job?.status).toBe("completed");
		expect(job?.metadata).toMatchObject({
			unchanged_sessions: 1,
			rewritten_sessions: 0,
		});
	});

	it("skips a raw-event session that has no raw events and records the skip", async () => {
		const source = "opencode";
		const streamId = "ses-no-events";
		insertSessionRow(db, source, streamId, {
			flusher: "raw_events",
			source,
			streamId,
			opencodeSessionId: streamId,
			promptCount: 0,
			toolCount: 0,
		});

		const hasMore = await runSessionContextBackfillPass(db, { batchSize: 10 });
		expect(hasMore).toBe(false);

		const job = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
		expect(job?.status).toBe("completed");
		expect(job?.metadata).toMatchObject({
			skipped_no_events: 1,
			rewritten_sessions: 0,
			processed_sessions: 1,
		});
	});

	it("skips a raw-event session that is missing its opencode_sessions bridge row", async () => {
		const source = "opencode";
		const streamId = "ses-no-bridge";
		const now = new Date().toISOString();
		insertRawEventSession(db, source, streamId, now);
		insertRawEvent(
			db,
			source,
			streamId,
			1,
			"evt-1",
			"user_prompt",
			{ type: "user_prompt", prompt_text: "Hello" },
			1_700_000_000_000,
		);
		// Session row with raw_events flusher marker but no opencode_sessions row.
		insertSessionRow(db, null, null, {
			flusher: "raw_events",
			source,
			streamId,
			opencodeSessionId: streamId,
		});

		const hasMore = await runSessionContextBackfillPass(db, { batchSize: 10 });
		expect(hasMore).toBe(false);

		const job = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
		expect(job?.status).toBe("completed");
		expect(job?.metadata).toMatchObject({
			skipped_no_bridge: 1,
			rewritten_sessions: 0,
		});
	});

	it("ignores sessions not flushed via raw_events", async () => {
		// Non-raw-events session should not be enqueued at all.
		insertSessionRow(db, null, null, null);
		expect(hasPendingSessionContextBackfill(db)).toBe(false);
		const hasMore = await runSessionContextBackfillPass(db, { batchSize: 10 });
		expect(hasMore).toBe(false);
		expect(getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB)).toBeNull();
	});

	it("processes multiple candidates across batches and reports progress", async () => {
		const source = "opencode";
		for (let i = 1; i <= 3; i++) {
			const streamId = `ses-multi-${i}`;
			const now = new Date().toISOString();
			insertRawEventSession(db, source, streamId, now);
			insertRawEvent(
				db,
				source,
				streamId,
				1,
				`evt-${i}-1`,
				"user_prompt",
				{ type: "user_prompt", prompt_text: `prompt ${i}` },
				1_700_000_000_000 + i * 1000,
			);
			insertSessionRow(db, source, streamId, {
				flusher: "raw_events",
				source,
				streamId,
				opencodeSessionId: streamId,
				promptCount: 0,
				toolCount: 0,
			});
		}

		// First pass processes 2, leaves 1 remaining.
		const firstHasMore = await runSessionContextBackfillPass(db, { batchSize: 2 });
		expect(firstHasMore).toBe(true);
		const runningJob = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
		expect(runningJob?.status).toBe("running");
		expect(runningJob?.metadata).toMatchObject({
			processed_sessions: 2,
			rewritten_sessions: 2,
			total_candidates: 3,
		});

		const secondHasMore = await runSessionContextBackfillPass(db, { batchSize: 2 });
		expect(secondHasMore).toBe(false);
		const completedJob = getMaintenanceJob(db, SESSION_CONTEXT_BACKFILL_JOB);
		expect(completedJob?.status).toBe("completed");
		expect(completedJob?.metadata).toMatchObject({
			processed_sessions: 3,
			rewritten_sessions: 3,
		});
	});
});
