import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connect } from "./db.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import type { IngestPayload } from "./ingest-types.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

let dir: string;
let store: MemoryStore;
let sessionId: number;
const occurredAt = "2026-09-21T10:00:00.000Z";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-history-ingest-"));
	const path = join(dir, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
	sessionId = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "history-session",
		source: "opencode",
		cwd: dir,
		project: "codemem",
		metadata: { source: "plugin" },
		startedAt: "2026-09-21T09:00:00.000Z",
		toolVersion: "raw_events",
	});
	store.endSession(sessionId, { original: true });
	store.remember(
		sessionId,
		"session_summary",
		"Newer session recap",
		"Do not supersede this recap",
		0.5,
		[],
		{
			source: "observer_summary",
			visibility: "private",
			workspace_kind: "personal",
		},
	);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function historicalPayload(): IngestPayload {
	return {
		cwd: dir,
		project: "codemem",
		startedAt: "2026-09-21T09:00:00.000Z",
		events: [
			{ type: "user_prompt", prompt_text: "Inspect the prior result" },
			{
				type: "tool.execute.after",
				tool: "read",
				args: { filePath: "fixture.ts" },
				result: "Use the validated callback.",
			},
		],
		sessionContext: {
			flusher: "raw_events",
			opencodeSessionId: "history-session",
			source: "opencode",
			streamId: "history-session",
			flushBatch: {
				batch_id: 42,
				start_event_seq: 3,
				end_event_seq: 4,
				extractor_version: "raw_events_recovery_v1",
			},
		},
	};
}

function observerOptions(): IngestOptions {
	return {
		observer: {
			observe: async () => ({
				raw: `<observation><type>discovery</type><title>Validated callback</title><narrative>Use the validated callback before persisting results.</narrative></observation>`,
				parsed: null,
				provider: "test",
				model: "test",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test",
				runtime: "api_http",
				auth: { source: "test", type: "test", hasToken: true },
			}),
		} as unknown as IngestOptions["observer"],
		historicalRecovery: { sessionId, occurredAt },
	};
}

it("recovers private observations at the original event time without replacing later session state", async () => {
	const before = store.db
		.prepare("SELECT ended_at, metadata_json FROM sessions WHERE id = ?")
		.get(sessionId);
	await ingest(historicalPayload(), store, observerOptions());
	const after = store.db
		.prepare("SELECT ended_at, metadata_json FROM sessions WHERE id = ?")
		.get(sessionId);
	expect(after).toEqual(before);
	const rows = store.db
		.prepare(
			"SELECT id, kind, title, created_at, visibility, workspace_kind FROM memory_items WHERE session_id = ? ORDER BY id",
		)
		.all(sessionId) as Array<{
		id: number;
		kind: string;
		title: string;
		created_at: string;
		visibility: string;
		workspace_kind: string;
	}>;
	expect(rows.find((row) => row.title === "Newer session recap")?.kind).toBe("session_summary");
	expect(rows.find((row) => row.title === "Validated callback")).toMatchObject({
		created_at: occurredAt,
		visibility: "private",
		workspace_kind: "personal",
	});
	expect(rows.filter((row) => row.kind === "session_summary")).toHaveLength(1);
	const recoveredId = rows.find((row) => row.title === "Validated callback")?.id;
	expect(recoveredId).toBeDefined();
	expect(
		store.db
			.prepare("SELECT COUNT(*) AS n FROM replication_ops WHERE entity_id = ?")
			.get(String(recoveredId)),
	).toMatchObject({ n: 0 });
});

it("rejects a mismatched historical session rather than creating or reassigning one", async () => {
	await expect(
		ingest(historicalPayload(), store, {
			...observerOptions(),
			historicalRecovery: { sessionId: sessionId + 1, occurredAt },
		}),
	).rejects.toThrow("historical recovery session mismatch");
	expect(store.db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toMatchObject({ n: 1 });
});
