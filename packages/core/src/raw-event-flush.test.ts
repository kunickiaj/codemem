import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRawEventEnvelopeFromHook } from "./claude-hooks.js";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

describe("flushRawEvents max retry", () => {
	let tmpDir: string;
	let store: MemoryStore;
	let prevMaxAttempts: string | undefined;

	beforeEach(() => {
		prevMaxAttempts = process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-flush-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		if (prevMaxAttempts === undefined) delete process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
		else process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = prevMaxAttempts;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function seedEvents(sessionId: string) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-1",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "Hello" },
			tsWallMs: 100,
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-2",
			eventType: "tool.execute.after",
			payload: { type: "tool.execute.after", tool: "read", args: { filePath: "/tmp/x.ts" } },
			tsWallMs: 200,
		});
	}

	const nullObserver = {
		observe: async () => ({
			raw: null as string | null,
			parsed: null,
			provider: "test",
			model: "test-model",
		}),
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	};

	const summaryObserver = {
		observe: async () => ({
			raw: `<summary>
				<request>Investigate auth timeout</request>
				<investigated>Session handling code</investigated>
				<learned>Race condition in handler</learned>
				<completed>Added callback validation</completed>
				<next_steps>Add regression test</next_steps>
				<notes></notes>
			</summary>`,
			parsed: null,
			provider: "test",
			model: "test-model",
		}),
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	};

	it("gives up after max attempts and advances flush cursor", async () => {
		process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = "3";
		const sessionId = "ses_max_retry_test";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail 3 times — each attempt claims the batch and increments attempt_count
		for (let i = 0; i < 3; i++) {
			await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
				"observer failed during raw-event flush",
			);
		}

		// 4th attempt should give up instead of retrying
		const result = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(result.updatedState).toBe(1);
		expect(result.flushed).toBe(0);

		// Batch should be marked gave_up
		const batch = store.db
			.prepare(
				"SELECT status, attempt_count FROM raw_event_flush_batches WHERE opencode_session_id = ?",
			)
			.get(sessionId) as { status: string; attempt_count: number };
		expect(batch.status).toBe("gave_up");
		expect(batch.attempt_count).toBe(3);

		// Flush state should be advanced so the session isn't retried
		const flushState = store.rawEventFlushState(sessionId, "opencode");
		expect(flushState).toBeGreaterThanOrEqual(0);
	});

	it("does not give up when under the max attempts", async () => {
		process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = "5";
		const sessionId = "ses_under_max";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail twice — still under the limit
		for (let i = 0; i < 2; i++) {
			await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
				"observer failed during raw-event flush",
			);
		}

		// 3rd attempt should still try (and fail), not give up
		await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
			"observer failed during raw-event flush",
		);

		const batch = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(batch.status).toBe("failed");
	});

	it("uses default max of 5 when env var is not set", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
		const sessionId = "ses_default_max";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail 5 times
		for (let i = 0; i < 5; i++) {
			await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow(
				"observer failed during raw-event flush",
			);
		}

		// 6th attempt should give up
		const result = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(result.updatedState).toBe(1);

		const batch = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(batch.status).toBe("gave_up");
	});

	it("gave_up batches are not resurrected by retryRawEventFailures", async () => {
		process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = "1";
		const sessionId = "ses_no_resurrect";
		seedEvents(sessionId);

		const ingestOpts = { observer: nullObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: null,
			maxEvents: null,
		};

		// Fail once, then give up
		await expect(flushRawEvents(store, ingestOpts, flushOpts)).rejects.toThrow();
		await flushRawEvents(store, ingestOpts, flushOpts);

		// Verify gave_up
		const before = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(before.status).toBe("gave_up");

		// retryRawEventFailures should not touch it
		const { retryRawEventFailures } = await import("./maintenance.js");
		const retried = retryRawEventFailures(store.dbPath);
		expect(retried.retried).toBe(0);

		// Still gave_up
		const after = store.db
			.prepare("SELECT status FROM raw_event_flush_batches WHERE opencode_session_id = ?")
			.get(sessionId) as { status: string };
		expect(after.status).toBe("gave_up");
	});

	it("reuses one local session per stable raw-event session id", async () => {
		const sessionId = "ses_bridge_reuse";
		seedEvents(sessionId);

		const ingestOpts = { observer: summaryObserver } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: null,
			project: null,
			startedAt: "2026-03-01T10:00:00Z",
			maxEvents: null,
		};

		const first = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(first.updatedState).toBe(1);

		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-3",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "Added validation." },
			tsWallMs: 300,
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-4",
			eventType: "tool.execute.after",
			payload: {
				type: "tool.execute.after",
				tool: "edit",
				args: { filePath: "/tmp/y.ts" },
			},
			tsWallMs: 400,
		});

		const second = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(second.updatedState).toBe(1);

		const opencodeBridge = store.db
			.prepare(
				"SELECT session_id FROM opencode_sessions WHERE source = 'opencode' AND stream_id = ?",
			)
			.get(sessionId) as { session_id: number } | undefined;
		expect(opencodeBridge?.session_id).toBeDefined();

		const localSessionCount = store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as {
			count: number;
		};
		expect(localSessionCount.count).toBe(1);

		const memorySessionCounts = store.db
			.prepare(
				"SELECT COUNT(DISTINCT session_id) AS count FROM memory_items WHERE active = 1 AND json_extract(metadata_json, '$.source') = 'observer_summary'",
			)
			.get() as { count: number };
		expect(memorySessionCounts.count).toBe(1);
	});

	it("populates session context fields from Claude Code adapter-enveloped raw events", async () => {
		const sessionId = "sess-claude-ctx";

		// Seed Claude Code hook events via the same envelope path the viewer/CLI
		// use. These produce `claude.hook` raw events with an `_adapter` payload.
		const hookEvents: Record<string, unknown>[] = [
			{
				hook_event_name: "UserPromptSubmit",
				session_id: sessionId,
				prompt: "Investigate the flush bug",
				cwd: "/tmp/repo",
				ts: "2026-03-04T10:00:00Z",
			},
			{
				hook_event_name: "PostToolUse",
				session_id: sessionId,
				tool_use_id: "toolu_1",
				tool_name: "Read",
				tool_input: { file_path: "/tmp/repo/src/flush.ts" },
				tool_response: "file contents",
				cwd: "/tmp/repo",
				ts: "2026-03-04T10:00:05Z",
			},
			{
				hook_event_name: "PostToolUse",
				session_id: sessionId,
				tool_use_id: "toolu_2",
				tool_name: "Edit",
				tool_input: { file_path: "/tmp/repo/src/flush.ts" },
				tool_response: "edited",
				cwd: "/tmp/repo",
				ts: "2026-03-04T10:00:10Z",
			},
		];

		for (const hook of hookEvents) {
			const envelope = buildRawEventEnvelopeFromHook(hook);
			expect(envelope).not.toBeNull();
			if (envelope == null) throw new Error("envelope");
			store.recordRawEvent({
				opencodeSessionId: envelope.opencode_session_id,
				source: envelope.source,
				eventId: envelope.event_id,
				eventType: envelope.event_type,
				payload: envelope.payload,
				tsWallMs: envelope.ts_wall_ms,
			});
		}

		const summaryResponder = {
			observe: async () => ({
				raw: `<summary>
					<request>Investigate the flush bug</request>
					<investigated>raw-event-flush.ts session context builder</investigated>
					<learned>Claude Code events need normalization before scanning</learned>
					<completed>Added normalization step</completed>
					<next_steps>Add regression test</next_steps>
					<notes></notes>
				</summary>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const ingestOpts = { observer: summaryResponder } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "claude",
			cwd: "/tmp/repo",
			project: "repo",
			startedAt: "2026-03-04T10:00:00Z",
			maxEvents: null,
		};

		const result = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(result.flushed).toBeGreaterThan(0);
		expect(result.updatedState).toBe(1);

		// The persisted session metadata is the authoritative regression check:
		// before the fix these fields were all absent because Claude Code raw
		// events (type="claude.hook") never populated buildSessionContext's
		// counts or path lists.
		const row = store.db
			.prepare(
				"SELECT metadata_json FROM sessions WHERE id = (SELECT session_id FROM opencode_sessions WHERE stream_id = ?)",
			)
			.get(sessionId) as { metadata_json: string } | undefined;
		expect(row).toBeDefined();
		const meta = JSON.parse(row?.metadata_json ?? "{}") as {
			session_context?: {
				promptCount?: number;
				toolCount?: number;
				firstPrompt?: string;
				filesRead?: string[];
				filesModified?: string[];
			};
		};
		expect(meta.session_context?.promptCount).toBe(1);
		expect(meta.session_context?.toolCount).toBe(2);
		expect(meta.session_context?.firstPrompt).toBe("Investigate the flush bug");
		expect(meta.session_context?.filesRead).toEqual(["/tmp/repo/src/flush.ts"]);
		expect(meta.session_context?.filesModified).toEqual(["/tmp/repo/src/flush.ts"]);
	});

	it("populates filesModified from OpenCode apply_patch adapter events end-to-end", async () => {
		const sessionId = "ses_opencode_apply_patch";
		const patchText = [
			"*** Begin Patch",
			"*** Add File: /repo/src/new.ts",
			"+export const created = 1;",
			"*** Update File: /repo/src/existing.ts",
			"@@ -1 +1 @@",
			"-export const value = 1;",
			"+export const value = 2;",
			"*** End Patch",
		].join("\n");

		// Seed a PURE adapter-enveloped tool_result event — this is the shape
		// OpenCode actually emits for apply_patch. No outer `tool` / `args` /
		// `type: "tool.execute.after"` fields; the adapter envelope is the only
		// thing that carries the tool name and patchText. This forces the flush
		// path through `normalizeEventsForSessionContext` +
		// `projectAdapterToolEvent` and proves the adapter projection populates
		// `filesModified` via the `apply_patch` branch of `buildSessionContext`.
		const adapterEvent = {
			schema_version: "1.0",
			source: "opencode",
			session_id: sessionId,
			event_id: "oc:apply_patch:1",
			event_type: "tool_result",
			ts: "2026-04-11T12:00:05Z",
			ordering_confidence: "low",
			payload: {
				tool_name: "apply_patch",
				status: "ok",
				tool_input: { patchText },
				tool_output:
					"Success. Updated the following files:\nA /repo/src/new.ts\nU /repo/src/existing.ts",
				error: null,
			},
			meta: { original_event_type: "tool.execute.after" },
		};

		store.recordRawEvent({
			opencodeSessionId: sessionId,
			source: "opencode",
			eventId: "evt-prompt",
			eventType: "user_prompt",
			payload: {
				type: "user_prompt",
				prompt_text: "Ship the apply_patch fix",
				timestamp: "2026-04-11T12:00:00Z",
			},
			tsWallMs: Date.parse("2026-04-11T12:00:00Z"),
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			source: "opencode",
			eventId: adapterEvent.event_id,
			eventType: "tool.execute.after",
			payload: { _adapter: adapterEvent },
			tsWallMs: Date.parse(adapterEvent.ts),
		});

		const summaryResponder = {
			observe: async () => ({
				raw: `<summary>
					<request>Ship the apply_patch fix</request>
					<investigated>raw-event-flush session context</investigated>
					<learned>apply_patch needs explicit handling</learned>
					<completed>Added handling</completed>
					<next_steps></next_steps>
					<notes></notes>
				</summary>`,
				parsed: null,
				provider: "test",
				model: "test-model",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		};

		const ingestOpts = { observer: summaryResponder } as unknown as IngestOptions;
		const flushOpts = {
			opencodeSessionId: sessionId,
			source: "opencode",
			cwd: "/repo",
			project: "repo",
			startedAt: "2026-04-11T12:00:00Z",
			maxEvents: null,
		};

		const result = await flushRawEvents(store, ingestOpts, flushOpts);
		expect(result.flushed).toBeGreaterThan(0);

		const row = store.db
			.prepare(
				"SELECT metadata_json FROM sessions WHERE id = (SELECT session_id FROM opencode_sessions WHERE stream_id = ?)",
			)
			.get(sessionId) as { metadata_json: string } | undefined;
		expect(row).toBeDefined();
		const meta = JSON.parse(row?.metadata_json ?? "{}") as {
			session_context?: {
				filesModified?: string[];
				toolCount?: number;
			};
		};
		expect(meta.session_context?.filesModified).toEqual([
			"/repo/src/existing.ts",
			"/repo/src/new.ts",
		]);
		expect(meta.session_context?.toolCount).toBe(1);
	});
});
