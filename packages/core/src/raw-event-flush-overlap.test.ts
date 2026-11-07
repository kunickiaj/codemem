import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import {
	completeRawEventFlush,
	finalizeFailedRawEventFlush,
	readRawEventFlushClaim,
} from "./raw-event-flush-claim.js";
import { MemoryStore } from "./store.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveProject: () => "fixture-project",
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn() }));

const sessionId = "overlap-stream";
const flushOptions = {
	opencodeSessionId: sessionId,
	source: "opencode",
	cwd: "/fixture/project",
	project: "fixture-project",
	startedAt: "2026-01-01T00:00:00.000Z",
};
const observerResponse = {
	raw: "<observation><type>bugfix</type><title>Parser validation fixed</title><narrative>The parser now rejects invalid input before persistence.</narrative><facts><fact>Invalid input is rejected</fact></facts></observation>",
	parsed: null,
	provider: "test",
	model: "test-model",
	usage: { inputTokens: 5, outputTokens: 7 },
};

function ingestOptions(observe = vi.fn().mockResolvedValue(observerResponse)): IngestOptions {
	return {
		observer: {
			observe,
			getStatus: () => ({
				provider: "test",
				model: "test-model",
				runtime: "test",
				auth: { source: "none", type: "none", hasToken: false },
			}),
		},
		storeSummary: false,
	} as unknown as IngestOptions;
}

function batches(store: MemoryStore) {
	return store.db
		.prepare(
			"SELECT start_event_seq, end_event_seq, status FROM raw_event_flush_batches ORDER BY id",
		)
		.all();
}

function createBatch(store: MemoryStore, start = 0, end = 1, version = "raw_events_v1") {
	return store.getOrCreateRawEventFlushBatch(sessionId, "opencode", start, end, version).batchId;
}

function observerUsage(store: MemoryStore) {
	return store.db
		.prepare("SELECT metadata_json FROM usage_events WHERE event = 'observer_call' ORDER BY id")
		.all()
		.map((row) => JSON.parse((row as { metadata_json: string }).metadata_json));
}

it("rolls back inferred content when the persisted range stops being a valid prefix", async () => {
	// Arrange: keep ownership current while corrupting only the stored range during inference.
	const entered = Promise.withResolvers<void>();
	const response = Promise.withResolvers<typeof observerResponse>();
	const observe = vi.fn().mockImplementation(() => {
		entered.resolve();
		return response.promise;
	});
	const pending = Promise.allSettled([
		flushRawEvents(first, ingestOptions(observe), { ...flushOptions, maxEvents: 2 }),
	]);
	await entered.promise;
	second.db.prepare("UPDATE raw_event_flush_batches SET start_event_seq = 1").run();

	// Act: persistence must validate the prefix inside the transaction that writes content.
	response.resolve(observerResponse);
	await pending;

	// Assert: invalid completion cannot leave inferred content or successful usage behind.
	expect(first.rawEventFlushState(sessionId)).toBe(-1);
	expect(first.db.prepare("SELECT id FROM memory_items").all()).toEqual([]);
	expect(batches(first)).not.toContainEqual({
		start_event_seq: 1,
		end_event_seq: 1,
		status: "completed",
	});
	expect(observerUsage(first)).toHaveLength(1);
	expect(observerUsage(first)[0]).toMatchObject({ observation_count: 0, has_summary: false });
});

it("cannot use a historical recovery claim to advance the live cursor", () => {
	// Arrange: historical inference uses a separate extractor on the same persisted stream.
	const id = createBatch(first, 0, 1, "raw_events_auth_recovery_v1");
	first.claimRawEventFlushBatch(id);
	const before = batches(first);

	// Act: reject a historical claim accidentally passed to live completion.
	try {
		first.db
			.transaction(() =>
				completeRawEventFlush(first, {
					claim: readRawEventFlushClaim(first, id),
					source: "opencode",
					streamId: sessionId,
					lastEventSeq: 1,
				}),
			)
			.immediate();
	} catch {
		// Cursor isolation is required regardless of how invalid completion is reported.
	}

	// Assert
	expect(first.rawEventFlushState(sessionId)).toBe(-1);
	expect(batches(first)).toEqual(before);
});

let directory: string;
let first: MemoryStore;
let second: MemoryStore;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-flush-overlap-"));
	const path = join(directory, "test.sqlite");
	first = new MemoryStore(path);
	second = new MemoryStore(path);
	for (let index = 0; index < 3; index++) {
		first.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: `evt-${index}`,
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: `Fix parser validation case ${index}` },
			tsWallMs: 100 + index,
		});
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	second.close();
	first.close();
	rmSync(directory, { recursive: true, force: true });
});

it.each([false, true])(
	"gates exhausted batch finalization with active owner=%s",
	async (activeOwner) => {
		// Arrange: a terminal failure must compete with a different range's active owner.
		vi.stubEnv("CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS", "5");
		const id = createBatch(first, 0, 2);
		first.db
			.prepare(
				"UPDATE raw_event_flush_batches SET status = 'failed', attempt_count = 5 WHERE id = ?",
			)
			.run(id);
		if (activeOwner) first.claimRawEventFlushBatch(createBatch(first));
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act: exercise normal orchestration rather than only the terminal completion helper.
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

		// Assert: exhausted batches advance only after they gain exclusive stream admission.
		expect(result).toEqual({ flushed: 0, updatedState: activeOwner ? 0 : 1 });
		expect(first.rawEventFlushState(sessionId)).toBe(activeOwner ? -1 : 2);
		expect(
			first.db.prepare("SELECT status FROM raw_event_flush_batches WHERE id = ?").get(id),
		).toEqual({ status: activeOwner ? "failed" : "gave_up" });
		expect(observe).not.toHaveBeenCalled();
	},
);

it("allows a second connection to flush the remaining prefix after completion", async () => {
	// Arrange: both connections use a local observer seam and the same synthetic database.
	const observe = vi.fn().mockResolvedValue(observerResponse);
	const options = ingestOptions(observe);

	// Act: complete one prefix before asking the other connection to continue.
	const small = await flushRawEvents(first, options, { ...flushOptions, maxEvents: 2 });
	const large = await flushRawEvents(second, options, { ...flushOptions, maxEvents: 3 });

	// Assert: stream ownership permits progress once the earlier prefix commits.
	expect(small).toEqual({ flushed: 2, updatedState: 1 });
	expect(large).toEqual({ flushed: 1, updatedState: 1 });
	expect(second.rawEventFlushState(sessionId)).toBe(2);
	expect(observe).toHaveBeenCalledTimes(2);
	expect(batches(first)).toEqual([
		{ start_event_seq: 0, end_event_seq: 1, status: "completed" },
		{ start_event_seq: 2, end_event_seq: 2, status: "completed" },
	]);
});

it.each([2, 3])(
	"defers an overlapping range when the first owner has maxEvents=%s",
	async (maxEvents) => {
		// Arrange: different range identities must still compete for one stream owner.
		const entered = Promise.withResolvers<void>();
		const smallResponse = Promise.withResolvers<typeof observerResponse>();
		const largeResponse = Promise.withResolvers<typeof observerResponse>();
		largeResponse.resolve(observerResponse);
		const observe = vi
			.fn()
			.mockImplementationOnce(() => {
				entered.resolve();
				return smallResponse.promise;
			})
			.mockImplementationOnce(() => largeResponse.promise);
		const options = ingestOptions(observe);
		const smallFlush = Promise.allSettled([
			flushRawEvents(first, options, { ...flushOptions, maxEvents }),
		]);
		await entered.promise;
		const cursorBeforeSecond = second.rawEventFlushState(sessionId);

		// Act: finish the competing larger range first if it incorrectly reaches the observer.
		let large: { flushed: number; updatedState: number };
		let cursorAfterSecond: number;
		let batchesAfterSecond: ReturnType<typeof batches>;
		try {
			large = await flushRawEvents(second, options, {
				...flushOptions,
				maxEvents: 5 - maxEvents,
			});
			cursorAfterSecond = second.rawEventFlushState(sessionId);
			batchesAfterSecond = batches(second);
		} finally {
			smallResponse.resolve(observerResponse);
			await smallFlush;
		}

		// Assert: the rejected contender has no inference, batch, or cursor side effects.
		expect(cursorBeforeSecond).toBe(-1);
		expect.soft(large).toEqual({ flushed: 0, updatedState: 0 });
		expect.soft(observe).toHaveBeenCalledOnce();
		expect
			.soft(batchesAfterSecond)
			.toEqual([{ start_event_seq: 0, end_event_seq: maxEvents - 1, status: "claimed" }]);
		expect.soft(cursorAfterSecond).toBe(-1);
		expect.soft(first.rawEventFlushState(sessionId)).toBeGreaterThanOrEqual(cursorAfterSecond);
		expect(first.rawEventFlushState(sessionId)).toBe(maxEvents - 1);
		expect(first.db.prepare("SELECT id FROM memory_items").all()).toHaveLength(1);
		expect
			.soft(first.db.prepare("SELECT id FROM usage_events WHERE event = 'observer_call'").all())
			.toHaveLength(1);
	},
);

it.each([false, true])(
	"repairs a completed batch without rewinding newer progress=%s",
	async (newerProgress) => {
		// Arrange: another connection may advance after this worker reads its old prefix.
		const id = createBatch(first);
		first.updateRawEventFlushBatchStatus(id, "completed");
		const read = first.rawEventsSinceBySeq.bind(first);
		vi.spyOn(first, "rawEventsSinceBySeq").mockImplementationOnce((...args) => {
			const events = read(...args);
			if (newerProgress) second.updateRawEventFlushState(sessionId, 2);
			return events;
		});
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act: repair the old completed range against the latest persisted cursor.
		const result = await flushRawEvents(first, ingestOptions(observe), {
			...flushOptions,
			maxEvents: 2,
		});

		// Assert: repair cannot overwrite newer progress or repeat inference.
		expect(result).toEqual({ flushed: 0, updatedState: newerProgress ? 0 : 1 });
		expect(first.rawEventFlushState(sessionId)).toBe(newerProgress ? 2 : 1);
		expect(observe).not.toHaveBeenCalled();
	},
);

it.each([false, true])("validates stored prefix holes while allowing purged gaps=%s", (purged) => {
	// Arrange: only the stored event before the candidate range distinguishes these cases.
	const id = createBatch(first, 2, 2);
	if (purged) first.db.prepare("DELETE FROM raw_events WHERE event_seq < 2").run();
	first.claimRawEventFlushBatch(id);
	const context = {
		claim: readRawEventFlushClaim(first, id),
		source: "opencode",
		streamId: sessionId,
		lastEventSeq: 2,
	};

	// Act: exercise the same transactional completion used by ingest persistence.
	try {
		first.db.transaction(() => completeRawEventFlush(first, context)).immediate();
	} catch {
		// Rejection may use the existing claim-lost error. Persisted state is the contract.
	}

	// Assert: MAX(end_event_seq) would incorrectly skip the stored prefix in the negative case.
	expect(first.rawEventFlushState(sessionId)).toBe(purged ? 2 : -1);
	expect(batches(first)).toEqual([
		{ start_event_seq: 2, end_event_seq: 2, status: purged ? "completed" : "claimed" },
	]);
});

it.each(["source", "stream", "end"] as const)(
	"rejects completion with mismatched %s context",
	(field) => {
		// Arrange: the claim identifies a persisted range, not arbitrary caller-supplied progress.
		const id = createBatch(first);
		first.claimRawEventFlushBatch(id);
		const context = {
			claim: readRawEventFlushClaim(first, id),
			source: field === "source" ? "claude" : "opencode",
			streamId: field === "stream" ? "different-stream" : sessionId,
			lastEventSeq: field === "end" ? 2 : 1,
		};

		// Act: invalid completion must leave both content and cursor writes uncommitted.
		try {
			first.db.transaction(() => completeRawEventFlush(first, context)).immediate();
		} catch {
			// The rejection's error type is not part of this context-validation contract.
		}

		// Assert
		expect(first.rawEventFlushState(sessionId)).toBe(-1);
		expect(first.rawEventFlushState(context.streamId, context.source)).toBe(-1);
		expect(batches(first)).toEqual([{ start_event_seq: 0, end_event_seq: 1, status: "claimed" }]);
	},
);

it.each([
	{ window: "300000", timestamp: "fresh", admitted: false },
	{ window: "300000", timestamp: "2000-01-01T00:00:00.000Z", admitted: true },
	{ window: "0", timestamp: "2000-01-01T00:00:00.000Z", admitted: false },
	{ window: "-1", timestamp: "2000-01-01T00:00:00.000Z", admitted: false },
	{ window: "300000", timestamp: "2999-01-01T00:00:00.000Z", admitted: false },
])(
	"keeps restart admission consistent for expiry window=$window timestamp=$timestamp",
	async ({ window, timestamp, admitted }) => {
		// Arrange: a new connection must respect ownership retained in SQLite after restart.
		vi.stubEnv("CODEMEM_RAW_EVENTS_STUCK_BATCH_MS", window);
		const id = createBatch(first);
		first.claimRawEventFlushBatch(id);
		if (timestamp !== "fresh") {
			first.db
				.prepare("UPDATE raw_event_flush_batches SET updated_at = ? WHERE id = ?")
				.run(timestamp, id);
		}
		second.close();
		second = new MemoryStore(join(directory, "test.sqlite"));
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act: a different range must not evade an unexpired stream owner.
		const result = await flushRawEvents(second, ingestOptions(observe), {
			...flushOptions,
			maxEvents: 3,
		});

		// Assert: disabled expiry and future timestamps retain the original owner and no loser row.
		expect(result).toEqual(
			admitted ? { flushed: 2, updatedState: 1 } : { flushed: 0, updatedState: 0 },
		);
		expect(observe).toHaveBeenCalledTimes(Number(admitted));
		expect(batches(first)).toEqual([
			{ start_event_seq: 0, end_event_seq: 1, status: admitted ? "completed" : "claimed" },
		]);
		expect(first.rawEventFlushState(sessionId)).toBe(admitted ? 1 : -1);
		if (admitted) {
			const continuation = await flushRawEvents(second, ingestOptions(observe), flushOptions);
			expect(continuation).toEqual({ flushed: 1, updatedState: 1 });
			expect(first.rawEventFlushState(sessionId)).toBe(2);
			expect(observe).toHaveBeenCalledTimes(2);
		}
	},
);

it("reclaims an expired generation and records late worker usage only as superseded", async () => {
	// Arrange: stop the old worker inside the local observer, without timers or network.
	vi.stubEnv("CODEMEM_RAW_EVENTS_STUCK_BATCH_MS", "300000");
	const entered = Promise.withResolvers<void>();
	const response = Promise.withResolvers<typeof observerResponse>();
	const observe = vi
		.fn()
		.mockImplementationOnce(() => {
			entered.resolve();
			return response.promise;
		})
		.mockResolvedValue(observerResponse);
	const options = ingestOptions(observe);
	const oldFlush = Promise.allSettled([
		flushRawEvents(first, options, { ...flushOptions, maxEvents: 2 }),
	]);
	await entered.promise;
	const oldClaim = first.db
		.prepare("SELECT id, claim_generation FROM raw_event_flush_batches")
		.get() as { id: number; claim_generation: number };
	first.db
		.prepare(
			"UPDATE raw_event_flush_batches SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
		)
		.run(oldClaim.id);

	// Act: commit the new generation before releasing the old observer response.
	try {
		await flushRawEvents(second, options, { ...flushOptions, maxEvents: 2 });
	} finally {
		response.resolve(observerResponse);
		await oldFlush;
	}

	// Assert: the late owner cannot persist duplicate content, completion, or progress.
	expect(
		first.db
			.prepare("SELECT claim_generation FROM raw_event_flush_batches WHERE id = ?")
			.get(oldClaim.id),
	).toEqual({ claim_generation: oldClaim.claim_generation + 1 });
	expect(first.rawEventFlushState(sessionId)).toBe(1);
	expect(first.db.prepare("SELECT id FROM memory_items").all()).toHaveLength(1);
	expect(observerUsage(first)).toHaveLength(2);
	expect(observerUsage(first)[0]).toMatchObject({ observation_count: 1 });
	expect(observerUsage(first)[1]).toMatchObject({
		raw_event_flush_outcome: "superseded",
		observation_count: 0,
		has_summary: false,
	});
});

it.each(["claimed", "running"])(
	"excludes historical recovery %s rows from live admission and expiry",
	async (status) => {
		// Arrange: a historical recovery owner belongs to another extractor, even on this stream.
		const id = createBatch(first, 0, 1, "raw_events_auth_recovery_v1");
		first.db
			.prepare(
				"UPDATE raw_event_flush_batches SET status = ?, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
			)
			.run(status, id);
		const before = first.db.prepare("SELECT * FROM raw_event_flush_batches WHERE id = ?").get(id);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act: live processing need not wait for historical auth recovery.
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

		// Assert: neither admission nor expiry changes the historical row.
		expect(result).toEqual({ flushed: 3, updatedState: 1 });
		expect(observe).toHaveBeenCalledOnce();
		expect(first.db.prepare("SELECT * FROM raw_event_flush_batches WHERE id = ?").get(id)).toEqual(
			before,
		);
	},
);

it.each([false, true])(
	"applies the same stream gate to context-only batches with active owner=%s",
	async (activeOwner) => {
		// Arrange: delegated briefs bypass the observer but still need exclusive stream admission.
		const prompt = "Investigate parser validation";
		const capture = {
			version: 1,
			host: "opencode-v1",
			origin: "delegated_brief",
			parent_session_id: "parent",
			child_session_id: sessionId,
			task_call_id: "call",
			message_id: "message",
			requested_agent: "explore",
			current_agent: "explore",
			brief_sha256: createHash("sha256").update(prompt).digest("hex"),
		};
		first.db
			.prepare("UPDATE raw_events SET payload_json = ?, capture_context_json = ?")
			.run(JSON.stringify({ type: "user_prompt", prompt_text: prompt }), JSON.stringify(capture));
		if (activeOwner) first.claimRawEventFlushBatch(createBatch(first));
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

		// Assert: both the admitted and deferred context-only paths avoid inference.
		expect(result).toEqual(
			activeOwner ? { flushed: 0, updatedState: 0 } : { flushed: 3, updatedState: 1 },
		);
		expect(observe).not.toHaveBeenCalled();
		expect(batches(first)).toHaveLength(1);
		expect(first.rawEventFlushState(sessionId)).toBe(activeOwner ? -1 : 2);
	},
);

it.each([false, true])(
	"finalizes gave-up batches only across a valid prefix, purged gap=%s",
	(purged) => {
		// Arrange: abandoning a failed range must not skip earlier stored events either.
		const id = createBatch(first, 2, 2);
		first.updateRawEventFlushBatchStatus(id, "failed");
		if (purged) first.db.prepare("DELETE FROM raw_events WHERE event_seq < 2").run();

		// Act
		const finalized = finalizeFailedRawEventFlush(
			first,
			{
				claim: readRawEventFlushClaim(first, id),
				source: "opencode",
				streamId: sessionId,
				lastEventSeq: 2,
			},
			"gave_up",
		);

		// Assert: terminal failure cannot turn MAX(end_event_seq) into a cursor update.
		expect(finalized).toBe(purged);
		expect(first.rawEventFlushState(sessionId)).toBe(purged ? 2 : -1);
		expect(batches(first)).toEqual([
			{ start_event_seq: 2, end_event_seq: 2, status: purged ? "gave_up" : "failed" },
		]);
	},
);
