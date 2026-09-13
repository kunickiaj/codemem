import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { DelegatedBriefContext } from "./capture-context.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { runSessionContextBackfillPass } from "./session-context-backfill.js";
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

function createStore(): MemoryStore {
	const directory = mkdtempSync(join(tmpdir(), "codemem-delegated-backfill-"));
	cleanupPaths.push(directory);
	return new MemoryStore(join(directory, "test.sqlite"));
}

function linkBackfillCandidate(store: MemoryStore): number {
	const now = "2026-09-11T12:00:00.000Z";
	const metadata = {
		session_context: {
			flusher: "raw_events",
			source: "opencode",
			streamId: "child",
			opencodeSessionId: "child",
			firstPrompt: "stale user classification",
			promptCount: 0,
		},
	};
	const result = store.db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, user, tool_version, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(now, "/fixture", "fixture", "test", "raw_events", JSON.stringify(metadata));
	const sessionId = Number(result.lastInsertRowid);
	store.db
		.prepare(
			`INSERT INTO opencode_sessions(
				source, stream_id, opencode_session_id, session_id, created_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
		.run("opencode", "child", "child", sessionId, now);
	return sessionId;
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("delegated provenance session-context backfill", () => {
	it("keeps the validated sidecar and excludes the brief from derived prompt fields", async () => {
		// Arrange
		const store = createStore();
		const brief = "Inspect retry ownership and report observed findings.";
		try {
			ingestRawEvents(store, {
				source: "opencode",
				session_stream_id: "child",
				event_id: "brief-event",
				event_type: "user_prompt",
				payload: { type: "user_prompt", prompt_text: brief },
				capture_context: provenance(brief),
			});
			const sessionId = linkBackfillCandidate(store);
			const sidecarBefore = store.db
				.prepare("SELECT capture_context_json FROM raw_events WHERE event_id = ?")
				.get("brief-event");

			// Act
			await runSessionContextBackfillPass(store.db, { batchSize: 10 });

			// Assert
			const row = store.db
				.prepare("SELECT metadata_json FROM sessions WHERE id = ?")
				.get(sessionId) as {
				metadata_json: string;
			};
			const metadata = JSON.parse(row.metadata_json) as {
				session_context: Record<string, unknown>;
			};
			const sidecarAfter = store.db
				.prepare("SELECT capture_context_json FROM raw_events WHERE event_id = ?")
				.get("brief-event");
			expect({
				firstPrompt: metadata.session_context.firstPrompt,
				promptCount: metadata.session_context.promptCount,
				sidecarAfter,
			}).toEqual({
				firstPrompt: undefined,
				promptCount: 0,
				sidecarAfter: sidecarBefore,
			});
		} finally {
			store.close();
		}
	});

	it("keeps an ordinary prompt classified as user input", async () => {
		// Arrange
		const store = createStore();
		const prompt = "Implement the approved retry fix.";
		try {
			ingestRawEvents(store, {
				source: "opencode",
				session_stream_id: "child",
				event_id: "ordinary-event",
				event_type: "user_prompt",
				payload: { type: "user_prompt", prompt_text: prompt },
			});
			const sessionId = linkBackfillCandidate(store);

			// Act
			await runSessionContextBackfillPass(store.db, { batchSize: 10 });

			// Assert
			const row = store.db
				.prepare("SELECT metadata_json FROM sessions WHERE id = ?")
				.get(sessionId) as {
				metadata_json: string;
			};
			const metadata = JSON.parse(row.metadata_json) as {
				session_context: Record<string, unknown>;
			};
			expect(metadata.session_context.firstPrompt).toBe(prompt);
		} finally {
			store.close();
		}
	});
});
