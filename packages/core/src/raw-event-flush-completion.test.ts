import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveProject: () => "fixture-project",
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn() }));

const sessionId = "completion-stream";
const flushOptions = {
	opencodeSessionId: sessionId,
	source: "opencode",
	cwd: "/fixture/project",
	project: "fixture-project",
	startedAt: "2026-01-01T00:00:00.000Z",
};
const observerResponse = {
	raw: "<observation><type>bugfix</type><title>Parser validation fixed</title><narrative>The parser now rejects invalid input before persistence.</narrative><facts><fact>Invalid input is rejected</fact></facts></observation>" as
		| string
		| null,
	parsed: null,
	provider: "test",
	model: "test-model",
	usage: { inputTokens: 5, outputTokens: 7 },
};

function makeObserver(observe = vi.fn().mockResolvedValue(observerResponse)) {
	return {
		observe,
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	};
}

function persistedOutcome(store: MemoryStore) {
	return {
		memories: store.db.prepare("SELECT id FROM memory_items").all(),
		usage: store.db.prepare("SELECT id FROM usage_events WHERE event = 'observer_call'").all(),
		batch: store.db.prepare("SELECT status, attempt_count FROM raw_event_flush_batches").get(),
		cursor: store.rawEventFlushState(sessionId),
	};
}

function observerCosts(store: MemoryStore) {
	const rows = store.db
		.prepare(
			"SELECT tokens_read, tokens_written, metadata_json FROM usage_events WHERE event = 'observer_call' ORDER BY id",
		)
		.all() as Array<{ tokens_read: number; tokens_written: number; metadata_json: string }>;
	return rows.map((row) => {
		const metadata = JSON.parse(row.metadata_json);
		return {
			tokens_read: row.tokens_read,
			tokens_written: row.tokens_written,
			raw_event_flush_outcome: metadata.raw_event_flush_outcome,
			observation_count: metadata.observation_count,
			has_summary: metadata.has_summary,
		};
	});
}

function claimSnapshot(store: MemoryStore) {
	return store.db
		.prepare("SELECT id, attempt_count, claim_generation, updated_at FROM raw_event_flush_batches")
		.get() as {
		id: number;
		attempt_count: number;
		claim_generation: number;
		updated_at: string;
	};
}

type WorkerClock = "frozen" | "forward" | "backward" | "invalid prior timestamp";
const workerScenarios = (["success", "failure"] as const).flatMap((outcome) => [
	{ outcome, release: "requeue" as const, clock: "frozen" as WorkerClock },
	...(["frozen", "forward", "backward", "invalid prior timestamp"] as const).map((clock) => ({
		outcome,
		release: "auth" as const,
		clock,
	})),
]);

function setReclaimClock(store: MemoryStore, batchId: number, clock: WorkerClock) {
	if (clock === "invalid prior timestamp") {
		store.db
			.prepare("UPDATE raw_event_flush_batches SET updated_at = 'invalid-date' WHERE id = ?")
			.run(batchId);
		return;
	}
	const clocks = {
		frozen: "2026-01-01T00:00:00.000Z",
		forward: "2027-01-01T00:00:00.000Z",
		backward: "2025-01-01T00:00:00.000Z",
	};
	vi.setSystemTime(new Date(clocks[clock]));
}

async function runSupersededWorkers(
	store: MemoryStore,
	{
		outcome,
		release,
		clock,
	}: { outcome: "success" | "failure"; release: "requeue" | "auth"; clock: WorkerClock },
) {
	const oldEntered = Promise.withResolvers<void>();
	const newEntered = Promise.withResolvers<void>();
	const oldResponse = Promise.withResolvers<typeof observerResponse>();
	const newResponse = Promise.withResolvers<typeof observerResponse>();
	const observe = vi
		.fn()
		.mockImplementationOnce(() => {
			oldEntered.resolve();
			return oldResponse.promise;
		})
		.mockImplementationOnce(() => {
			newEntered.resolve();
			return newResponse.promise;
		});
	const options = {
		observer: makeObserver(observe),
		storeSummary: false,
	} as unknown as IngestOptions;
	const oldFlush = Promise.allSettled([flushRawEvents(store, options, flushOptions)]);
	await oldEntered.promise;
	const oldClaim = claimSnapshot(store);
	let released = true;
	if (release === "auth") {
		released = store.releaseRawEventFlushBatchAfterAuthError(oldClaim.id, {
			code: "auth_missing",
			provider: null,
			model: null,
			runtime: null,
			authSource: null,
			authType: null,
		});
	} else store.updateRawEventFlushBatchStatus(oldClaim.id, "pending");
	setReclaimClock(store, oldClaim.id, clock);
	const newFlush = Promise.allSettled([flushRawEvents(store, options, flushOptions)]);
	await newEntered.promise;
	const newClaim = claimSnapshot(store);
	const newerClaim = persistedOutcome(store);
	if (outcome === "success") oldResponse.resolve(observerResponse);
	else {
		// A failed provider response can still report billable token usage.
		const failed = {
			...observerResponse,
			raw: null,
			outcome: {
				status: "failure",
				error: { code: "observer_timeout", message: "Superseded observer failed" },
				authRetry: null,
			},
		};
		oldResponse.resolve(failed);
	}
	await oldFlush;
	const afterOldWorker = persistedOutcome(store);
	const oldCosts = observerCosts(store);
	newResponse.resolve(observerResponse);
	const [newResult] = await newFlush;
	return {
		oldClaim,
		newClaim,
		released,
		newerClaim,
		afterOldWorker,
		oldCosts,
		newResult,
		completed: persistedOutcome(store),
		completedCosts: observerCosts(store),
	};
}

describe("raw-event persistence and completion", () => {
	let directory: string;
	let store: MemoryStore;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "codemem-flush-completion-"));
		const dbPath = join(directory, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-1",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "Fix the parser validation behavior" },
			tsWallMs: 100,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		store.close();
		rmSync(directory, { recursive: true, force: true });
	});

	it("persists and completes once when the same events are flushed again", async () => {
		// Arrange: the fake observer and vector writer never call external services.
		const observer = makeObserver();
		const options = { observer, storeSummary: false } as unknown as IngestOptions;

		// Act: retry a successfully completed batch.
		await flushRawEvents(store, options, flushOptions);
		const committed = persistedOutcome(store);
		const retry = await flushRawEvents(store, options, flushOptions);

		// Assert: the retry does not infer, persist, or bill a second outcome.
		expect(committed.memories).toHaveLength(1);
		expect(committed.usage).toHaveLength(1);
		expect(committed.batch).toEqual({ status: "completed", attempt_count: 1 });
		expect(committed.cursor).toBe(0);
		expect(persistedOutcome(store)).toEqual(committed);
		expect(retry).toEqual({ flushed: 0, updatedState: 0 });
		expect(observer.observe).toHaveBeenCalledOnce();
	});

	it("does not infer or persist again after session completion fails after the commit", async () => {
		// Arrange: fail once after persistIngestPlan commits memories and observer usage.
		const observer = makeObserver();
		const options = { observer, storeSummary: false } as unknown as IngestOptions;
		const endSession = vi.spyOn(store, "endSession").mockImplementationOnce(() => {
			throw new Error("session completion unavailable");
		});

		// Act: retain the first failure for diagnosis, then retry the same raw events.
		const first = await flushRawEvents(store, options, flushOptions).then(
			() => null,
			(error: unknown) => error,
		);
		const committed = persistedOutcome(store);
		await flushRawEvents(store, options, flushOptions);
		const retried = persistedOutcome(store);

		// Assert: post-commit cleanup cannot turn a persisted outcome into new inference.
		expect(endSession).toHaveBeenCalled();
		expect(first).toBeInstanceOf(Error);
		expect(first).toEqual(new Error("session completion unavailable"));
		expect.soft(committed.memories).toHaveLength(1);
		expect.soft(committed.usage).toHaveLength(1);
		expect.soft(retried.memories).toEqual(committed.memories);
		expect.soft(retried.usage).toEqual(committed.usage);
		expect.soft(retried.batch).toEqual({ status: "completed", attempt_count: 1 });
		expect.soft(retried.cursor).toBe(0);
		expect.soft(observer.observe).toHaveBeenCalledOnce();
	});

	it.each(workerScenarios)(
		"does not let a superseded worker's $outcome overwrite the newer claim after $release release with $clock time",
		async ({ outcome, release, clock }) => {
			// Arrange: admission release and reclaim must be safe even within one millisecond.
			vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

			// Act: pause both workers at inference and finish the old worker first.
			const {
				oldClaim,
				newClaim,
				released,
				newerClaim,
				afterOldWorker,
				oldCosts,
				newResult,
				completed,
				completedCosts,
			} = await runSupersededWorkers(store, { outcome, release, clock });

			// Assert: only the current worker may persist, complete, fail, or advance the cursor.
			expect(released).toBe(true);
			if (release === "auth")
				expect(newClaim).toMatchObject({ id: oldClaim.id, attempt_count: oldClaim.attempt_count });
			expect(newClaim.claim_generation).toBeGreaterThan(oldClaim.claim_generation);
			const attempts = release === "auth" ? 1 : 2;
			expect(newerClaim.batch).toEqual({ status: "claimed", attempt_count: attempts });
			expect(newerClaim.cursor).toBe(-1);
			expect
				.soft(afterOldWorker.batch, `Claim snapshots: ${JSON.stringify({ oldClaim, newClaim })}`)
				.toEqual(newerClaim.batch);
			expect.soft(afterOldWorker.cursor).toBe(newerClaim.cursor);
			expect.soft(afterOldWorker.memories).toEqual([]);
			expect.soft(oldCosts).toEqual([
				{
					tokens_read: 5,
					tokens_written: 7,
					raw_event_flush_outcome: "superseded",
					observation_count: 0,
					has_summary: false,
				},
			]);
			expect(newResult?.status).toBe("fulfilled");
			expect(completed.batch).toEqual({ status: "completed", attempt_count: attempts });
			expect(completed.cursor).toBe(0);
			expect(completed.memories).toHaveLength(1);
			expect.soft(completedCosts).toHaveLength(2);
		},
	);
});
