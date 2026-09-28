import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { ObserverAuthError } from "./observer-client.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

let dir: string;
let store: MemoryStore;
let previousMaxAttempts: string | undefined;

beforeEach(() => {
	previousMaxAttempts = process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
	process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = "1";
	dir = mkdtempSync(join(tmpdir(), "codemem-auth-retry-"));
	const path = join(dir, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	store = new MemoryStore(path);
	store.recordRawEvent({
		opencodeSessionId: "auth-retry",
		eventId: "prompt",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Inspect auth recovery" },
		tsWallMs: 100,
	});
	store.recordRawEvent({
		opencodeSessionId: "auth-retry",
		eventId: "tool",
		eventType: "tool.execute.after",
		payload: { type: "tool.execute.after", tool: "read", args: { filePath: "fixture.ts" } },
		tsWallMs: 200,
	});
});

afterEach(() => {
	store.close();
	if (previousMaxAttempts === undefined) delete process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS;
	else process.env.CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS = previousMaxAttempts;
	rmSync(dir, { recursive: true, force: true });
});

function batchState() {
	return store.db
		.prepare(
			"SELECT status, attempt_count FROM raw_event_flush_batches WHERE opencode_session_id = ?",
		)
		.get("auth-retry") as { status: string; attempt_count: number };
}

const opts = { opencodeSessionId: "auth-retry", source: "opencode" };

it("keeps missing-auth events queued without consuming attempts, then processes them", async () => {
	const noAuthObserver = {
		observe: async () => ({ raw: null, parsed: null, provider: "openai", model: "test" }),
		getStatus: () => ({
			provider: "openai",
			model: "test",
			runtime: "api_http",
			auth: { source: "none", type: "none", hasToken: false },
			lastError: { code: "auth_missing", message: "No configured credentials" },
		}),
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		await expect(
			flushRawEvents(store, { observer: noAuthObserver } as unknown as IngestOptions, opts),
		).rejects.toBeInstanceOf(ObserverAuthError);
		expect(batchState()).toEqual({ status: "failed", attempt_count: 0 });
		const code = store.db
			.prepare(
				"SELECT observer_error_code FROM raw_event_flush_batches WHERE opencode_session_id = ?",
			)
			.get("auth-retry") as { observer_error_code: string };
		expect(code.observer_error_code).toBe("auth_missing");
		expect(store.rawEventFlushState("auth-retry")).toBe(-1);
	}
	const workingObserver = {
		...noAuthObserver,
		observe: async () => ({
			raw: "<summary><request>Inspect auth recovery</request><completed>Confirmed retry.</completed></summary>",
			parsed: null,
			provider: "openai",
			model: "test",
		}),
		getStatus: () => ({ ...noAuthObserver.getStatus(), lastError: null }),
	};
	await flushRawEvents(store, { observer: workingObserver } as unknown as IngestOptions, opts);
	expect(batchState()).toEqual({ status: "completed", attempt_count: 1 });
});

it("keeps a rejected credential from exhausting a queued batch", async () => {
	const invalidAuthObserver = {
		observe: async () => {
			throw new ObserverAuthError("Credential expired");
		},
		getStatus: () => ({
			provider: "openai",
			model: "test",
			runtime: "api_http",
			auth: { source: "oauth", type: "codex_consumer", hasToken: true },
		}),
	};
	await expect(
		flushRawEvents(store, { observer: invalidAuthObserver } as unknown as IngestOptions, opts),
	).rejects.toBeInstanceOf(ObserverAuthError);
	expect(batchState()).toEqual({ status: "failed", attempt_count: 0 });
	expect(store.rawEventFlushState("auth-retry")).toBe(-1);
});
