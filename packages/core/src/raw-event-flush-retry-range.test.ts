import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IngestOptions } from "./ingest-pipeline.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";

vi.mock("./project.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./project.js")>()),
	resolveProject: () => "fixture-project",
	resolveGitRepositoryIdentity: () => null,
}));
vi.mock("./vectors.js", () => ({ storeVectors: vi.fn() }));

const sessionId = "partial-retry-stream";
const flushOptions = {
	opencodeSessionId: sessionId,
	source: "opencode",
	cwd: "/fixture/project",
	project: "fixture-project",
	startedAt: "2026-01-01T00:00:00.000Z",
	maxEvents: 100,
};
const observerResponse = {
	raw: "<observation><type>bugfix</type><title>Parser validation fixed</title><narrative>The parser now rejects invalid input before persistence.</narrative><facts><fact>Invalid input is rejected</fact></facts></observation>",
	parsed: null,
	provider: "test",
	model: "test-model",
	usage: { inputTokens: 5, outputTokens: 7 },
};

function ingestOptions(observe: ReturnType<typeof vi.fn>): IngestOptions {
	return {
		observer: {
			observe,
			runtime: "api_key",
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

function appendEvents(store: MemoryStore, start: number, count: number) {
	for (let index = start; index < start + count; index++) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: `evt-${index}`,
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: `Fix parser validation case ${index}` },
			tsWallMs: 100 + index,
		});
	}
}

function batches(store: MemoryStore) {
	return store.db
		.prepare(
			"SELECT id, start_event_seq, end_event_seq, status, attempt_count, claim_generation FROM raw_event_flush_batches ORDER BY id",
		)
		.all();
}

function seedBatch(
	store: MemoryStore,
	{
		start = 0,
		end = 1,
		status = "failed",
		source = "opencode",
		stream = sessionId,
		extractor = "raw_events_v1",
	}: {
		start?: number;
		end?: number;
		status?: string;
		source?: string;
		stream?: string;
		extractor?: string;
	} = {},
) {
	const { batchId } = store.getOrCreateRawEventFlushBatch(stream, source, start, end, extractor);
	store.db
		.prepare("UPDATE raw_event_flush_batches SET status = ?, attempt_count = 1 WHERE id = ?")
		.run(status, batchId);
	return batchId;
}

function setHostGenerationBoundary(store: MemoryStore) {
	store.db.prepare("UPDATE raw_events SET payload_json = ? WHERE event_seq > 0").run(
		JSON.stringify({
			type: "user_prompt",
			prompt_text: "Validate parser after upgrade",
			codemem_host_generation: "v2",
		}),
	);
}

let directory: string;
let first: MemoryStore;
let second: MemoryStore;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-flush-retry-range-"));
	const path = join(directory, "test.sqlite");
	first = new MemoryStore(path);
	second = new MemoryStore(path);
	vi.stubEnv("CODEMEM_RAW_EVENTS_MAX_FLUSH_ATTEMPTS", "5");
	vi.stubEnv("CODEMEM_RAW_EVENTS_STUCK_BATCH_MS", "0");
	appendEvents(first, 0, 3);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	second.close();
	first.close();
	rmSync(directory, { recursive: true, force: true });
});

it("retries the failed partial range before committing newer backlog on another connection", async () => {
	// Arrange: fail a three-event batch with room below the normal 100-event limit.
	const failure = new Error("Synthetic observer failure");
	const observe = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(observerResponse);
	const options = ingestOptions(observe);
	await expect(flushRawEvents(first, options, flushOptions)).rejects.toThrow(failure);
	const failed = batches(first);
	appendEvents(first, 3, 2);

	// Act: retry through another connection, then flush the untouched newer events.
	const retry = await flushRawEvents(second, options, flushOptions);
	const afterRetry = batches(first);
	const retryCursor = first.rawEventFlushState(sessionId);
	const continuation = await flushRawEvents(first, options, flushOptions);

	// Assert: backlog growth cannot replace the failed identity or reset its attempts.
	expect(failed).toEqual([
		expect.objectContaining({
			start_event_seq: 0,
			end_event_seq: 2,
			status: "failed",
			attempt_count: 1,
		}),
	]);
	expect
		.soft(afterRetry)
		.toEqual([{ ...failed[0], status: "completed", attempt_count: 2, claim_generation: 2 }]);
	expect.soft(retry).toEqual({ flushed: 3, updatedState: 1 });
	expect.soft(retryCursor).toBe(2);
	expect.soft(continuation).toEqual({ flushed: 2, updatedState: 1 });
	expect.soft(first.rawEventFlushState(sessionId)).toBe(4);
	expect.soft(observe).toHaveBeenCalledTimes(3);
	expect.soft(batches(first)).toEqual([
		{ ...failed[0], status: "completed", attempt_count: 2, claim_generation: 2 },
		expect.objectContaining({
			start_event_seq: 3,
			end_event_seq: 4,
			status: "completed",
			attempt_count: 1,
		}),
	]);
});

it("exhausts the original five attempts despite appends and preserves newer backlog after giving up", async () => {
	// Arrange: every failed call receives new synthetic events before the next flush.
	const failure = new Error("Synthetic observer failure");
	const observe = vi.fn().mockRejectedValue(failure);
	const options = ingestOptions(observe);
	await expect(flushRawEvents(first, options, flushOptions)).rejects.toThrow(failure);
	const failed = batches(first);

	// Act: consume the remaining original budget, then finalize without another inference.
	for (let attempt = 2; attempt <= 5; attempt++) {
		appendEvents(first, attempt + 1, 1);
		await expect(flushRawEvents(second, options, flushOptions)).rejects.toThrow(failure);
	}
	appendEvents(first, 7, 1);
	const beforeFinalization = batches(first);
	const terminal = await Promise.allSettled([flushRawEvents(second, options, flushOptions)]);
	const afterFinalization = batches(first);
	const terminalCursor = first.rawEventFlushState(sessionId);
	const terminalCalls = observe.mock.calls.length;
	observe.mockResolvedValue(observerResponse);
	const continuation = await flushRawEvents(first, options, flushOptions);

	// Assert: only the failed prefix is abandoned, and later events remain processable.
	expect
		.soft(beforeFinalization)
		.toEqual([{ ...failed[0], attempt_count: 5, claim_generation: 5 }]);
	expect.soft(terminal).toEqual([{ status: "fulfilled", value: { flushed: 0, updatedState: 1 } }]);
	expect
		.soft(afterFinalization)
		.toEqual([{ ...failed[0], status: "gave_up", attempt_count: 5, claim_generation: 5 }]);
	expect.soft(terminalCalls).toBe(5);
	expect.soft(terminalCursor).toBe(2);
	expect.soft(continuation).toEqual({ flushed: 5, updatedState: 1 });
	expect.soft(first.rawEventFlushState(sessionId)).toBe(7);
	expect.soft(batches(first)).toEqual([
		{ ...failed[0], status: "gave_up", attempt_count: 5, claim_generation: 5 },
		expect.objectContaining({
			start_event_seq: 3,
			end_event_seq: 7,
			status: "completed",
			attempt_count: 1,
		}),
	]);
});

it.each([
	{ ceiling: "throughEventSeq", limit: 1, admitted: false },
	{ ceiling: "throughEventSeq", limit: 2, admitted: true },
	{ ceiling: "maxEvents", limit: 2, admitted: false },
	{ ceiling: "maxEvents", limit: 3, admitted: true },
] as const)(
	"honors $ceiling=$limit without splitting a persisted retry",
	async ({ ceiling, limit, admitted }) => {
		// Arrange: an intact retry requires all three events, even if more backlog arrives.
		seedBatch(first, { end: 2 });
		appendEvents(first, 3, 2);
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act: the caller's hard ceiling must apply before claim or inference.
		const result = await flushRawEvents(second, ingestOptions(observe), {
			...flushOptions,
			[ceiling]: limit,
		});

		// Assert: deferral has no batch, attempt, cursor, or observer side effects.
		expect(result).toEqual(
			admitted ? { flushed: 3, updatedState: 1 } : { flushed: 0, updatedState: 0 },
		);
		expect(batches(first)).toEqual(
			admitted
				? [{ ...before[0], status: "completed", attempt_count: 2, claim_generation: 1 }]
				: before,
		);
		expect(first.rawEventFlushState(sessionId)).toBe(admitted ? 2 : -1);
		expect(observe).toHaveBeenCalledTimes(Number(admitted));
	},
);

it.each(["pending", "failed", "started", "error"])(
	"reuses an eligible %s prefix before a later overlapping failure",
	async (status) => {
		// Arrange: insertion order identifies the earlier retry, not a newly enlarged range.
		const original = seedBatch(first, { status });
		seedBatch(first, { end: 2 });
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

		// Assert: the earliest eligible identity completes without touching the overlap.
		expect(result).toEqual({ flushed: 2, updatedState: 1 });
		expect(batches(first)).toEqual([
			{ ...before[0], id: original, status: "completed", attempt_count: 2, claim_generation: 1 },
			before[1],
		]);
		expect(first.rawEventFlushState(sessionId)).toBe(1);
		expect(observe).toHaveBeenCalledOnce();
	},
);

it.each(["source", "stream", "extractor", "behind cursor"])(
	"ignores a failed range with mismatched %s",
	async (boundary) => {
		// Arrange: stale and foreign rows cannot pin the current live prefix.
		seedBatch(first, {
			source: boundary === "source" ? "claude" : "opencode",
			stream: boundary === "stream" ? "other-stream" : sessionId,
			extractor: boundary === "extractor" ? "raw_events_auth_recovery_v1" : "raw_events_v1",
		});
		if (boundary === "behind cursor") first.updateRawEventFlushState(sessionId, 1);
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

		// Assert: unrelated history is unchanged while the live cursor advances normally.
		const start = boundary === "behind cursor" ? 2 : 0;
		expect(result).toEqual({ flushed: 3 - start, updatedState: 1 });
		expect(batches(first)).toEqual([
			before[0],
			expect.objectContaining({ start_event_seq: start, end_event_seq: 2, status: "completed" }),
		]);
		expect(first.rawEventFlushState(sessionId)).toBe(2);
		expect(observe).toHaveBeenCalledOnce();
	},
);

it.each(["start", "end", "both"])(
	"preserves persisted endpoints after purging the %s boundary",
	async (boundary) => {
		// Arrange: retention removes boundary events, but must not manufacture a new identity.
		seedBatch(first, { end: 2 });
		appendEvents(first, 3, 2);
		if (boundary !== "end") first.db.prepare("DELETE FROM raw_events WHERE event_seq = 0").run();
		if (boundary !== "start") first.db.prepare("DELETE FROM raw_events WHERE event_seq = 2").run();
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act: only surviving events are inferred, but completion uses the persisted endpoint.
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);
		const afterRetry = batches(first);
		const cursor = first.rawEventFlushState(sessionId);
		const continuation = await flushRawEvents(first, ingestOptions(observe), flushOptions);

		// Assert
		expect(result).toEqual({ flushed: boundary === "both" ? 1 : 2, updatedState: 1 });
		expect(afterRetry).toEqual([
			{ ...before[0], status: "completed", attempt_count: 2, claim_generation: 1 },
		]);
		expect(cursor).toBe(2);
		expect(continuation).toEqual({ flushed: 2, updatedState: 1 });
		expect(first.rawEventFlushState(sessionId)).toBe(4);
	},
);

it("continues after a fully purged failure without rewriting it or skipping surviving backlog", async () => {
	// Arrange: an empty failed range no longer pins the live stream after retention.
	const id = seedBatch(first, { end: 2 });
	first.db.prepare("DELETE FROM raw_events").run();
	appendEvents(first, 3, 2);
	const before = first.db.prepare("SELECT * FROM raw_event_flush_batches WHERE id = ?").get(id);
	const observe = vi.fn().mockResolvedValue(observerResponse);

	// Act: a one-event ceiling proves the ordinary prefix starts at the first surviving event.
	const result = await flushRawEvents(second, ingestOptions(observe), {
		...flushOptions,
		maxEvents: 1,
	});
	const cursor = first.rawEventFlushState(sessionId);
	const afterFirst = batches(first);
	const continuation = await flushRawEvents(first, ingestOptions(observe), flushOptions);

	// Assert: only successful future inference advances the cursor across the purged gap.
	expect(result).toEqual({ flushed: 1, updatedState: 1 });
	expect(cursor).toBe(3);
	expect(first.db.prepare("SELECT * FROM raw_event_flush_batches WHERE id = ?").get(id)).toEqual(
		before,
	);
	expect(afterFirst).toEqual([
		expect.objectContaining({
			id,
			start_event_seq: 0,
			end_event_seq: 2,
			status: "failed",
			attempt_count: 1,
		}),
		expect.objectContaining({ start_event_seq: 3, end_event_seq: 3, status: "completed" }),
	]);
	expect(continuation).toEqual({ flushed: 1, updatedState: 1 });
	expect(first.rawEventFlushState(sessionId)).toBe(4);
	expect(observe).toHaveBeenCalledTimes(2);
});

it("does not advance the cursor for a fully purged failure with no later events", async () => {
	// Arrange: ignoring an empty failed identity does not itself justify cursor progress.
	seedBatch(first, { end: 2 });
	first.db.prepare("DELETE FROM raw_events").run();
	const before = batches(first);
	const observe = vi.fn().mockResolvedValue(observerResponse);

	// Act
	const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

	// Assert
	expect(result).toEqual({ flushed: 0, updatedState: 0 });
	expect(batches(first)).toEqual(before);
	expect(first.rawEventFlushState(sessionId)).toBe(-1);
	expect(observe).not.toHaveBeenCalled();
});

it.each(["claimed", "running"])(
	"keeps a fully purged %s owner gated until expiry",
	async (status) => {
		// Arrange: retention cannot release an active owner while expiry is disabled.
		seedBatch(first, { end: 2, status });
		first.db.prepare("DELETE FROM raw_events").run();
		appendEvents(first, 3, 2);
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

		// Assert: the existing stream gate remains independent of retry preference.
		expect(result).toEqual({ flushed: 0, updatedState: 0 });
		expect(batches(first)).toEqual(before);
		expect(first.rawEventFlushState(sessionId)).toBe(-1);
		expect(observe).not.toHaveBeenCalled();
	},
);

it("rejects a stale enlarged plan when another connection records a failed prefix before admission", async () => {
	// Arrange: inject the competing failure after event planning, before snapshot admission.
	const read = first.rawEventsSinceBySeq.bind(first);
	vi.spyOn(first, "rawEventsSinceBySeq").mockImplementationOnce((...args) => {
		const events = read(...args);
		seedBatch(second);
		return events;
	});
	const observe = vi.fn().mockResolvedValue(observerResponse);

	// Act: the stale plan must defer, then a fresh invocation can retry the original range.
	const stale = await flushRawEvents(first, ingestOptions(observe), flushOptions);
	const afterStale = batches(first);
	const staleCursor = first.rawEventFlushState(sessionId);
	const staleCalls = observe.mock.calls.length;
	const retry = await flushRawEvents(second, ingestOptions(observe), flushOptions);

	// Assert: the transaction rechecks the pin rather than creating a conflicting identity.
	expect(stale).toEqual({ flushed: 0, updatedState: 0 });
	expect(afterStale).toEqual([
		expect.objectContaining({
			start_event_seq: 0,
			end_event_seq: 1,
			status: "failed",
			attempt_count: 1,
		}),
	]);
	expect(staleCursor).toBe(-1);
	expect(staleCalls).toBe(0);
	expect(retry).toEqual({ flushed: 2, updatedState: 1 });
	expect(batches(first)).toEqual([
		{ ...afterStale[0], status: "completed", attempt_count: 2, claim_generation: 1 },
	]);
});

it.each(["claimed", "running"])(
	"serializes a pinned retry against an existing %s owner",
	async (status) => {
		// Arrange: an active persisted owner must remain the only admitted worker.
		seedBatch(first, { status });
		appendEvents(first, 3, 2);
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act
		const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

		// Assert
		expect(result).toEqual({ flushed: 0, updatedState: 0 });
		expect(batches(first)).toEqual(before);
		expect(first.rawEventFlushState(sessionId)).toBe(-1);
		expect(observe).not.toHaveBeenCalled();
	},
);

it("refunds auth admission without replacing the original identity after backlog growth", async () => {
	// Arrange: auth release refunds an attempt but retains generation ownership history.
	const id = first.getOrCreateRawEventFlushBatch(
		sessionId,
		"opencode",
		0,
		1,
		"raw_events_v1",
	).batchId;
	first.claimRawEventFlushBatch(id);
	const released = first.releaseRawEventFlushBatchAfterAuthError(id, {
		code: "auth_missing",
		provider: null,
		model: null,
		runtime: null,
		authSource: null,
		authType: null,
	});
	appendEvents(first, 3, 2);
	const before = batches(first);
	const observe = vi.fn().mockResolvedValue(observerResponse);

	// Act
	const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

	// Assert: the refunded budget stays at one actual attempt after successful retry.
	expect(released).toBe(true);
	expect(before).toEqual([expect.objectContaining({ attempt_count: 0, claim_generation: 1 })]);
	expect(result).toEqual({ flushed: 2, updatedState: 1 });
	expect(batches(first)).toEqual([
		{ ...before[0], status: "completed", attempt_count: 1, claim_generation: 2 },
	]);
	expect(first.rawEventFlushState(sessionId)).toBe(1);
	expect(observe).toHaveBeenCalledOnce();
});

it.each([false, true])(
	"keeps a legacy 101-event retry intact with background opt-in=%s",
	async (background) => {
		// Arrange: persisted legacy work can exceed the normal live caller's 100-event cap.
		appendEvents(first, 3, 99);
		seedBatch(first, { end: 100 });
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act: only background recovery opts into processing the complete legacy identity.
		const result = await flushRawEvents(second, ingestOptions(observe), {
			...flushOptions,
			...(background ? { allowOversizedRetry: true } : {}),
		});

		// Assert: live callers defer without splitting, while recovery leaves later backlog untouched.
		expect(result).toEqual(
			background ? { flushed: 101, updatedState: 1 } : { flushed: 0, updatedState: 0 },
		);
		expect(batches(first)).toEqual(
			background
				? [{ ...before[0], status: "completed", attempt_count: 2, claim_generation: 1 }]
				: before,
		);
		expect(first.rawEventFlushState(sessionId)).toBe(background ? 100 : -1);
		expect(observe).toHaveBeenCalledTimes(Number(background));
		if (background) {
			const continuation = await flushRawEvents(first, ingestOptions(observe), flushOptions);
			expect(continuation).toEqual({ flushed: 1, updatedState: 1 });
			expect(first.rawEventFlushState(sessionId)).toBe(101);
		}
	},
);

it.each([
	{ through: 1, admitted: false },
	{ through: 2, admitted: true },
])(
	"allows an oversized background retry only within throughEventSeq=$through",
	async ({ through, admitted }) => {
		// Arrange: background recovery may exceed maxEvents, but never the explicit sequence ceiling.
		seedBatch(first, { end: 2 });
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);

		// Act
		const result = await flushRawEvents(second, ingestOptions(observe), {
			...flushOptions,
			maxEvents: 2,
			throughEventSeq: through,
			allowOversizedRetry: true,
		});

		// Assert: only an intact retry within the sequence ceiling can consume another attempt.
		expect(result).toEqual(
			admitted ? { flushed: 3, updatedState: 1 } : { flushed: 0, updatedState: 0 },
		);
		expect(batches(first)).toEqual(
			admitted
				? [{ ...before[0], status: "completed", attempt_count: 2, claim_generation: 1 }]
				: before,
		);
		expect(first.rawEventFlushState(sessionId)).toBe(admitted ? 2 : -1);
		expect(observe).toHaveBeenCalledTimes(Number(admitted));
	},
);

it.each(["fresh", "failed", "manual reset", "background"])(
	"partitions host generations and continues past a legacy mixed range during %s flush",
	async (mode) => {
		// Arrange: mixed legacy identities must not prevent ordinary generation-safe progress.
		setHostGenerationBoundary(first);
		if (mode !== "fresh") {
			const id = seedBatch(first, { end: 2 });
			if (mode === "manual reset") {
				first.db
					.prepare(
						"UPDATE raw_event_flush_batches SET status = 'pending', attempt_count = 0 WHERE id = ?",
					)
					.run(id);
			}
		}
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);
		const options = ingestOptions(observe);
		const request = { ...flushOptions, allowOversizedRetry: mode === "background" };

		// Act: process V1, then V2, then confirm that the legacy identity cannot block again.
		const result = await flushRawEvents(second, options, request);
		const firstCursor = first.rawEventFlushState(sessionId);
		const continuation = await flushRawEvents(first, options, request);
		const idle = await flushRawEvents(second, options, request);

		// Assert: no mixed payload, full-endpoint jump, or rewrite of the legacy failure/reset row.
		expect(result).toEqual({ flushed: 1, updatedState: 1 });
		expect(firstCursor).toBe(0);
		expect(continuation).toEqual({ flushed: 2, updatedState: 1 });
		expect(idle).toEqual({ flushed: 0, updatedState: 0 });
		expect(batches(first)).toEqual([
			...before,
			expect.objectContaining({
				start_event_seq: 0,
				end_event_seq: 0,
				status: "completed",
				attempt_count: 1,
			}),
			expect.objectContaining({
				start_event_seq: 1,
				end_event_seq: 2,
				status: "completed",
				attempt_count: 1,
			}),
		]);
		expect(first.rawEventFlushState(sessionId)).toBe(2);
		expect(observe).toHaveBeenCalledTimes(2);
		const prompts = observe.mock.calls.map((call) => String(call[1]));
		expect(prompts[0]).toContain("Fix parser validation case 0");
		expect(prompts[0]).not.toContain("Validate parser after upgrade");
		expect(prompts[1]).toContain("Validate parser after upgrade");
		expect(prompts[1]).not.toContain("Fix parser validation case 0");
	},
);

it.each(["claimed", "running"])(
	"keeps a mixed %s owner gated until existing expiry",
	async (status) => {
		// Arrange: ignoring mixed retries cannot bypass an active stream owner.
		setHostGenerationBoundary(first);
		const id = seedBatch(first, { end: 2, status });
		const before = batches(first);
		const observe = vi.fn().mockResolvedValue(observerResponse);
		const options = ingestOptions(observe);

		// Act: first defer with expiry disabled, then expire the owner using a persisted old timestamp.
		const deferred = await flushRawEvents(second, options, flushOptions);
		const whileActive = batches(first);
		const callsWhileActive = observe.mock.calls.length;
		first.db
			.prepare(
				"UPDATE raw_event_flush_batches SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
			)
			.run(id);
		vi.stubEnv("CODEMEM_RAW_EVENTS_STUCK_BATCH_MS", "300000");
		const expired = await flushRawEvents(second, options, flushOptions);
		const cursorAfterExpiry = first.rawEventFlushState(sessionId);
		const continuation = await flushRawEvents(first, options, flushOptions);

		// Assert: expiry releases admission, but only generation-safe new batches advance the cursor.
		expect(deferred).toEqual({ flushed: 0, updatedState: 0 });
		expect(whileActive).toEqual(before);
		expect(callsWhileActive).toBe(0);
		expect(expired).toEqual({ flushed: 1, updatedState: 1 });
		expect(cursorAfterExpiry).toBe(0);
		expect(continuation).toEqual({ flushed: 2, updatedState: 1 });
		expect(batches(first)[0]).toEqual({ ...before[0], status: "failed" });
		expect(first.rawEventFlushState(sessionId)).toBe(2);
	},
);

it("pins a partially purged legacy range when its surviving events share one host generation", async () => {
	// Arrange: deleted generation metadata must not disqualify an otherwise valid original retry.
	setHostGenerationBoundary(first);
	seedBatch(first, { end: 2 });
	first.db.prepare("DELETE FROM raw_events WHERE event_seq = 0").run();
	const before = batches(first);
	const observe = vi.fn().mockResolvedValue(observerResponse);

	// Act
	const result = await flushRawEvents(second, ingestOptions(observe), flushOptions);

	// Assert: surviving V2 events retry with the persisted endpoints and accumulated attempts.
	expect(result).toEqual({ flushed: 2, updatedState: 1 });
	expect(batches(first)).toEqual([
		{ ...before[0], status: "completed", attempt_count: 2, claim_generation: 1 },
	]);
	expect(first.rawEventFlushState(sessionId)).toBe(2);
	expect(observe).toHaveBeenCalledOnce();
	expect(String(observe.mock.calls[0]?.[1])).toContain("Validate parser after upgrade");
	expect(String(observe.mock.calls[0]?.[1])).not.toContain("Fix parser validation case 0");
});

it("admits only one connection while a failed partial range is being retried", async () => {
	// Arrange: pause the local observer after retry admission, without global timers.
	seedBatch(first);
	const before = batches(first);
	const entered = Promise.withResolvers<void>();
	const response = Promise.withResolvers<typeof observerResponse>();
	const observe = vi.fn().mockImplementation(() => {
		entered.resolve();
		return response.promise;
	});
	const options = ingestOptions(observe);
	const owner = Promise.allSettled([flushRawEvents(first, options, flushOptions)]);
	await entered.promise;
	appendEvents(second, 3, 2);

	// Act: a contender cannot enlarge the active retry or perform duplicate inference.
	let contender: Awaited<ReturnType<typeof flushRawEvents>>;
	let during: ReturnType<typeof batches>;
	try {
		contender = await flushRawEvents(second, options, flushOptions);
		during = batches(second);
	} finally {
		response.resolve(observerResponse);
		await owner;
	}
	const continuation = await flushRawEvents(second, options, flushOptions);

	// Assert: the contender leaves the current owner intact, then backlog can continue.
	expect(contender).toEqual({ flushed: 0, updatedState: 0 });
	expect(during).toEqual([
		{ ...before[0], status: "claimed", attempt_count: 2, claim_generation: 1 },
	]);
	expect(continuation).toEqual({ flushed: 3, updatedState: 1 });
	expect(observe).toHaveBeenCalledTimes(2);
	expect(first.rawEventFlushState(sessionId)).toBe(4);
});
