import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { RawEventSweeper } from "./raw-event-sweeper.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

const activeSessionObservation = async () => ({
	raw: `<observation>
		<type>discovery</type><title>Active events drained</title>
		<narrative>The periodic worker processed accepted events while the session remained active.</narrative>
	</observation>`,
	parsed: null,
	provider: "test",
	model: "test",
});

function seedActiveSession(
	store: MemoryStore,
	tmpDir: string,
	sessionId: string,
	eventCount: number,
) {
	const now = Date.now();
	for (let index = 0; index < eventCount; index += 1) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: `evt-${index}`,
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: `Active prompt ${index}` },
			tsWallMs: now + index,
		});
	}
	store.updateRawEventSessionMeta({
		opencodeSessionId: sessionId,
		cwd: tmpDir,
		project: "codemem",
		startedAt: "2026-01-01T00:00:00Z",
		lastSeenTsWallMs: now + eventCount - 1,
	});
}

function createSweeper(store: MemoryStore, observe: ReturnType<typeof vi.fn>) {
	return new RawEventSweeper(store, {
		observer: {
			observe,
			getStatus: () => ({
				provider: "test",
				model: "test",
				runtime: "api_http",
				auth: { source: "test", type: "api_direct", hasToken: true },
			}),
		} as never,
	} satisfies IngestOptions);
}

describe("RawEventSweeper active session draining", () => {
	let tmpDir: string;
	let store: MemoryStore;
	let previousAutoFlush: string | undefined;
	let previousWorkerMaxEvents: string | undefined;

	beforeEach(() => {
		previousAutoFlush = process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		previousWorkerMaxEvents = process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS;
		delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-active-sweeper-test-"));
		const dbPath = join(tmpDir, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		if (previousAutoFlush == null) delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		else process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = previousAutoFlush;
		if (previousWorkerMaxEvents == null) delete process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS;
		else process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS = previousWorkerMaxEvents;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("drains a recently active session when auto flush is disabled", async () => {
		seedActiveSession(store, tmpDir, "sess-active-periodic", 2);
		const observe = vi.fn(activeSessionObservation);
		const sweeper = createSweeper(store, observe);

		await sweeper.tick();

		expect(observe).toHaveBeenCalledTimes(1);
		expect(store.rawEventFlushState("sess-active-periodic")).toBe(1);
	});

	it("drains a backlog in capped non-overlapping periodic batches", async () => {
		process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS = "2";
		seedActiveSession(store, tmpDir, "sess-active-backlog", 5);
		const observe = vi.fn(activeSessionObservation);
		const sweeper = createSweeper(store, observe);

		for (const expectedCursor of [1, 3, 4]) {
			await sweeper.tick();
			expect(store.rawEventFlushState("sess-active-backlog")).toBe(expectedCursor);
		}
		await sweeper.tick();

		expect(observe).toHaveBeenCalledTimes(3);
	});
});
