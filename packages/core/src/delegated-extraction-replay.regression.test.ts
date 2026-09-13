import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DELEGATED_BRIEF_LABEL, type DelegatedBriefContext } from "./capture-context.js";
import { ContextOnlyReplayError, replayBatchExtraction } from "./extraction-replay.js";
import type { ObserverClient } from "./observer-client.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { MemoryStore } from "./store.js";

const cleanupPaths: string[] = [];

function provenance(text: string): DelegatedBriefContext {
	return {
		version: 1,
		host: "opencode-v1",
		origin: "delegated_brief",
		parent_session_id: "parent",
		child_session_id: "child",
		task_call_id: "task",
		message_id: "message",
		requested_agent: "explore",
		current_agent: "explore",
		brief_sha256: createHash("sha256").update(text).digest("hex"),
	};
}

function createReplayFixture({ includeFinding }: { includeFinding: boolean }): {
	dbPath: string;
	batchId: number;
	brief: string;
	sidecar: string;
} {
	const directory = mkdtempSync(join(tmpdir(), "codemem-delegated-replay-"));
	cleanupPaths.push(directory);
	const dbPath = join(directory, "test.sqlite");
	const store = new MemoryStore(dbPath);
	const brief = includeFinding
		? `REPLAY_BRIEF_START ${"x".repeat(20_000)} REPLAY_BRIEF_TAIL`
		: "Inspect retry ownership and report observed findings.";
	try {
		const events: Record<string, unknown>[] = [
			{
				event_id: "brief-event",
				event_type: "user_prompt",
				payload: { type: "user_prompt", prompt_text: brief },
				capture_context: provenance(brief),
			},
		];
		if (includeFinding) {
			events.push({
				event_id: "finding-event",
				event_type: "tool.execute.after",
				payload: {
					type: "tool.execute.after",
					tool: "read",
					args: { filePath: "/fixture/src/queue.ts" },
					result: "The pending queue retains retry entries after invalidation.",
				},
			});
		}
		ingestRawEvents(store, {
			source: "opencode",
			session_stream_id: "child",
			events,
		});
		const now = "2026-09-11T12:00:00.000Z";
		const session = store.db
			.prepare(
				`INSERT INTO sessions(started_at, ended_at, cwd, project, user, tool_version, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(now, now, "/fixture", "fixture", "test", "raw_events", "{}");
		const sessionId = Number(session.lastInsertRowid);
		store.db
			.prepare(
				`INSERT INTO opencode_sessions(
					source, stream_id, opencode_session_id, session_id, created_at
				 ) VALUES (?, ?, ?, ?, ?)`,
			)
			.run("opencode", "child", "child", sessionId, now);
		const batchId = includeFinding ? 91_002 : 91_001;
		store.db
			.prepare(
				`INSERT INTO raw_event_flush_batches(
					id, source, stream_id, opencode_session_id, start_event_seq, end_event_seq,
					extractor_version, status, attempt_count, created_at, updated_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				batchId,
				"opencode",
				"child",
				"child",
				0,
				includeFinding ? 1 : 0,
				"raw_events_v1",
				"completed",
				1,
				now,
				now,
			);
		const row = store.db
			.prepare("SELECT capture_context_json FROM raw_events WHERE event_id = ?")
			.get("brief-event") as { capture_context_json: string };
		return { dbPath, batchId, brief, sidecar: row.capture_context_json };
	} finally {
		store.close();
	}
}

function observer(observe: ReturnType<typeof vi.fn>): ObserverClient {
	return {
		observe,
		getStatus: () => ({
			provider: "test",
			model: "fixture",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	} as unknown as ObserverClient;
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("delegated provenance extraction replay", () => {
	it("keeps a delegated brief labeled while replaying mixed evidence", async () => {
		// Arrange
		const fixture = createReplayFixture({ includeFinding: true });
		const observe = vi.fn(async () => ({
			raw: `<summary><request>Report observed queue behavior</request><completed>Reviewed the queue.</completed><learned>The pending queue retains retries.</learned><investigated>Queue ownership.</investigated><next_steps></next_steps><notes></notes></summary>`,
			parsed: null,
			provider: "test",
			model: "fixture",
		}));

		// Act
		const result = await replayBatchExtraction(fixture.dbPath, observer(observe), {
			batchId: fixture.batchId,
			scenarioId: "simple-batch-shape",
		});

		// Assert
		const observerInput = observe.mock.calls[0]?.[1] ?? "";
		expect({
			observerCalls: observe.mock.calls.length,
			boundedBriefs: result.observerContext.delegatedBriefs,
			briefInTranscript: result.observerContext.transcript.includes(fixture.brief),
			labeledBrief: observerInput.includes(DELEGATED_BRIEF_LABEL),
			toolEvidence: observerInput.includes("The pending queue retains retry entries"),
		}).toEqual({
			observerCalls: 1,
			boundedBriefs: [fixture.brief.slice(0, 800)],
			briefInTranscript: false,
			labeledBrief: true,
			toolEvidence: true,
		});
		expect(observerInput).toContain("REPLAY_BRIEF_START");
		expect(observerInput).not.toContain("REPLAY_BRIEF_TAIL");
	});

	it("does not send a proven brief-only replay batch to the observer", async () => {
		// Arrange
		const fixture = createReplayFixture({ includeFinding: false });
		const observe = vi.fn();

		// Act
		const replay = replayBatchExtraction(fixture.dbPath, observer(observe), {
			batchId: fixture.batchId,
			scenarioId: "simple-batch-shape",
		});
		await expect(replay).rejects.toBeInstanceOf(ContextOnlyReplayError);
		const inspected = new MemoryStore(fixture.dbPath);
		const row = inspected.db
			.prepare("SELECT capture_context_json FROM raw_events WHERE event_id = ?")
			.get("brief-event") as { capture_context_json: string };
		inspected.close();

		// Assert
		expect({
			observerCalls: observe.mock.calls.length,
			sidecar: row.capture_context_json,
		}).toEqual({
			observerCalls: 0,
			sidecar: fixture.sidecar,
		});
	});
});
