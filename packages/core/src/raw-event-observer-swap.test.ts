import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { RawEventSweeper } from "./raw-event-sweeper.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

function addSession(store: MemoryStore, sessionId: string): void {
	store.recordRawEvent({
		opencodeSessionId: sessionId,
		eventId: "prompt",
		eventType: "user_prompt",
		payload: { type: "user_prompt", prompt_text: "Inspect the callback" },
		tsWallMs: 100,
	});
	store.recordRawEvent({
		opencodeSessionId: sessionId,
		eventId: "tool",
		eventType: "tool.execute.after",
		payload: {
			type: "tool.execute.after",
			tool: "read",
			args: { filePath: "fixture.ts" },
			result: "Validated callback required",
		},
		tsWallMs: 200,
	});
	store.updateRawEventSessionMeta({
		opencodeSessionId: sessionId,
		cwd: "fixture",
		project: "codemem",
		startedAt: "2026-01-01T00:00:00Z",
		lastSeenTsWallMs: 200,
	});
}

function observer(observe: ReturnType<typeof vi.fn>): IngestOptions["observer"] {
	return {
		observe,
		getStatus: () => ({
			provider: "test",
			model: "test",
			runtime: "api_http",
			auth: { source: "test", type: "test", hasToken: true },
		}),
	} as unknown as IngestOptions["observer"];
}

const validOutput = {
	raw: "<summary><request>Inspect callback</request><completed>Validated callback.</completed></summary>",
	parsed: null,
	provider: "test",
	model: "test",
};

it("drains an active observer before swapping and keeps newly queued work off the old provider", async () => {
	const dir = mkdtempSync(join(tmpdir(), "codemem-observer-swap-"));
	const path = join(dir, "test.sqlite");
	const db = connect(path);
	initTestSchema(db);
	db.close();
	const store = new MemoryStore(path);
	let releaseOld: (() => void) | undefined;
	const oldPending = new Promise<void>((resolve) => {
		releaseOld = resolve;
	});
	const oldObserve = vi.fn(async () => {
		await oldPending;
		return validOutput;
	});
	const newObserve = vi.fn(async () => validOutput);
	const sweeper = new RawEventSweeper(store, { observer: observer(oldObserve) });
	try {
		addSession(store, "old-session");
		expect(store.rawEventSessionsPendingFlush(25)).toHaveLength(1);
		sweeper.start();
		const running = sweeper.flushBoundary("old-session");
		await vi.waitFor(() => expect(oldObserve).toHaveBeenCalledTimes(1));
		const createNext = vi.fn(() => observer(newObserve));
		const changing = sweeper.reconfigureObserver(createNext);
		addSession(store, "new-session");
		await sweeper.flushBoundary("new-session");
		expect(oldObserve).toHaveBeenCalledTimes(1);
		expect(newObserve).not.toHaveBeenCalled();
		expect(createNext).not.toHaveBeenCalled();
		releaseOld?.();
		await running;
		expect(await changing).not.toBeNull();
		expect(createNext).toHaveBeenCalledTimes(1);
		await sweeper.flushBoundary("new-session");
		await vi.waitFor(() => expect(newObserve).toHaveBeenCalledTimes(1));
		expect(oldObserve).toHaveBeenCalledTimes(1);
	} finally {
		releaseOld?.();
		await sweeper.stop();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
