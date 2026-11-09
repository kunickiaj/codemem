import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptPackTimingEvent } from "../prompt-pack-timing.js";
import type {
	RankInput,
	RankOutput,
	WorkerReply,
	WorkerRequest,
} from "./semantic-worker-protocol.js";
import { createSemanticWorkerQueue } from "./semantic-worker-queue.js";
import { deferred, useSemanticWorkerFixture } from "./semantic-worker-test-fixtures.js";

type QueueOptions = Parameters<typeof createSemanticWorkerQueue>[0];
const input: RankInput = {
	generationId: "fixture-generation",
	embedding: new Float32Array([1, 0]),
	embeddingIdentity: "fixture-embedding",
	filters: null,
	automaticContext: undefined,
	proof: { actorId: "fixture-actor", deviceId: "fixture-device", expectedPublicKey: undefined },
	limit: 1,
};
const output: RankOutput = {
	generationId: "fixture-generation",
	revision: 1,
	models: [],
	candidateVersions: [],
	candidates: [],
};
function fixture(options: Partial<Omit<QueueOptions, "createWorker">> = {}) {
	let events!: Parameters<QueueOptions["createWorker"]>[0];
	const postMessage = vi.fn<(message: WorkerRequest) => void>();
	const queue = createSemanticWorkerQueue({
		createWorker: (callbacks) => {
			events = callbacks;
			return { postMessage, terminate: async () => 0 };
		},
		...options,
	});
	return {
		queue,
		postMessage,
		ready: () => events.message({ type: "ready" }),
		reply: (reply: WorkerReply) => events.message(reply),
		fail: () => events.failure(new Error("worker failed")),
		ranks: () =>
			postMessage.mock.calls
				.map(([message]) => message)
				.filter((message) => message.type === "rank"),
		async close() {
			const closing = queue.close();
			events.exit(0);
			await closing;
		},
	};
}
const flush = () => vi.advanceTimersByTimeAsync(0);
const observe = <T>(promise: Promise<T>) =>
	promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
function ends(events: PromptPackTimingEvent[]) {
	return events.filter((event) => event.state === "end");
}

describe("request-local semantic queue timings", () => {
	beforeEach(() =>
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] }),
	);
	afterEach(() => vi.useRealTimers());

	it("separates overlapping readiness, FIFO wait, transport, and worker-local rank", async () => {
		// Arrange
		const f = fixture();
		const firstEvents: PromptPackTimingEvent[] = [];
		const secondEvents: PromptPackTimingEvent[] = [];
		const options = Object.freeze({
			onTiming: (event: PromptPackTimingEvent) => {
				firstEvents.push(event);
			},
		});
		const first = f.queue.run(async () => input, options);
		await vi.advanceTimersByTimeAsync(5);
		const second = f.queue.run(async () => input, {
			onTiming: (event) => {
				secondEvents.push(event);
			},
		});
		// Act
		await vi.advanceTimersByTimeAsync(5);
		f.ready();
		await flush();
		await vi.advanceTimersByTimeAsync(20);
		f.reply({ type: "result", id: f.ranks()[0].id, output, rankElapsedMs: 1.23456 });
		await flush();
		f.reply({ type: "result", id: f.ranks()[1].id, output });
		// Assert: worker-local work excludes the deliberately delayed message delivery.
		expect(await first).toEqual(output);
		expect(await second).toEqual(output);
		expect(ends(firstEvents)).toEqual([
			{ stage: "semantic_worker_readiness", state: "end", elapsed_ms: 10 },
			{ stage: "semantic_queue_wait", state: "end", elapsed_ms: 10 },
			{ stage: "semantic_worker_roundtrip", state: "end", elapsed_ms: 20 },
			{ stage: "semantic_worker_rank", state: "end", elapsed_ms: 1.235 },
		]);
		expect(ends(secondEvents)).toEqual([
			{ stage: "semantic_worker_readiness", state: "end", elapsed_ms: 5 },
			{ stage: "semantic_queue_wait", state: "end", elapsed_ms: 25 },
			{ stage: "semantic_worker_roundtrip", state: "end", elapsed_ms: 0 },
		]);
		expect(f.ranks()[0].collectTiming).toBe(true);
		expect(structuredClone(f.ranks()[0])).toEqual(f.ranks()[0]);
		expect(Object.keys(options)).toEqual(["onTiming"]);
		await f.close();
	});

	it("ignores invalid diagnostic durations without rejecting valid ranking", async () => {
		// Arrange
		const f = fixture();
		const events: PromptPackTimingEvent[] = [];
		// Act
		for (const rankElapsedMs of [NaN, Infinity, -1]) {
			const pending = f.queue.run(async () => input, {
				onTiming: (event) => {
					events.push(event);
				},
			});
			f.ready();
			await flush();
			const ranks = f.ranks();
			f.reply({ type: "result", id: ranks[ranks.length - 1].id, output, rankElapsedMs });
			expect(await pending).toEqual(output);
		}
		// Assert
		expect(events.some((event) => event.stage === "semantic_worker_rank")).toBe(false);
		expect(
			ends(events).filter((event) => event.stage === "semantic_worker_roundtrip"),
		).toHaveLength(3);
		await f.close();
	});

	it.each(["aborted", "expired"] as const)(
		"stops callbacks after %s but retains native ownership",
		async (code) => {
			// Arrange
			const f = fixture({ requestMs: 50 });
			const controller = new AbortController();
			const observer = vi.fn();
			const first = observe(
				f.queue.run(async () => input, { signal: controller.signal, onTiming: observer }),
			);
			f.ready();
			await flush();
			// Act
			if (code === "aborted") controller.abort();
			else await vi.advanceTimersByTimeAsync(50);
			const callsAtSettlement = observer.mock.calls.length;
			const prepareNext = vi.fn(async () => input);
			const next = f.queue.run(prepareNext);
			await flush();
			// Assert: another caller cannot use the slot until the abandoned native job replies.
			expect(await first).toMatchObject({ error: { code } });
			expect(prepareNext).not.toHaveBeenCalled();
			f.reply({ type: "result", id: f.ranks()[0].id, output, rankElapsedMs: 3 });
			await flush();
			expect(observer).toHaveBeenCalledTimes(callsAtSettlement);
			expect(prepareNext).toHaveBeenCalledTimes(1);
			f.reply({ type: "result", id: f.ranks()[1].id, output });
			expect(await next).toEqual(output);
			expect(f.ranks()[1]).not.toHaveProperty("collectTiming");
			await f.close();
		},
	);

	it("isolates throwing diagnostics while preserving FIFO and terminal worker errors", async () => {
		// Arrange
		const f = fixture();
		const onTiming = vi.fn(() => {
			throw new Error("diagnostic failed");
		});
		const prepared = deferred<RankInput>();
		const first = observe(f.queue.run(() => prepared.promise, { onTiming }));
		const prepareNext = vi.fn(async () => input);
		const second = observe(f.queue.run(prepareNext, { onTiming }));
		f.ready();
		await flush();
		// Act
		prepared.resolve(input);
		await flush();
		f.reply({ type: "result", id: f.ranks()[0].id, output });
		await flush();
		f.fail();
		const callsAtFailure = onTiming.mock.calls.length;
		f.reply({ type: "result", id: f.ranks()[1].id, output, rankElapsedMs: 2 });
		// Assert
		expect(await first).toEqual({ value: output });
		expect(await second).toMatchObject({ error: { code: "worker_failed" } });
		expect(prepareNext).toHaveBeenCalledTimes(1);
		expect(onTiming).toHaveBeenCalledTimes(callsAtFailure);
		await f.close();
	});
});

describe("pack timing and delivery accounting", () => {
	const f = useSemanticWorkerFixture();
	it("separates client acquisition from inference and omits inference without a client", async () => {
		// Arrange: control the monotonic clock and both embedding barriers, never load a model.
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const acquired = deferred<void>();
		const releaseClient = deferred<typeof f.client | null>();
		const inference = deferred<void>();
		const releaseEmbedding = deferred<Float32Array[]>();
		vi.spyOn(f.client, "embed").mockImplementation(async () => {
			inference.resolve();
			return releaseEmbedding.promise;
		});
		const dispatched = deferred<void>();
		const getClient = vi.fn(async () => {
			acquired.resolve();
			return releaseClient.promise;
		});
		let events!: Parameters<QueueOptions["createWorker"]>[0];
		let rankId = 0;
		const executor = f.openExecutor({
			getClient,
			createWorker: (callbacks) => {
				events = callbacks;
				return {
					terminate: async () => 0,
					postMessage: (message) => {
						if (message.type === "close") events.exit(0);
						else {
							rankId = message.id;
							dispatched.resolve();
						}
					},
				};
			},
		});
		const timings: PromptPackTimingEvent[] = [];
		// Act
		const pending = executor.search(
			{ query: "worker sentinel", limit: 10, filters: null, automaticContext: undefined },
			{
				onTiming: (event) => {
					timings.push(event);
				},
			},
		);
		events.message({ type: "ready" });
		await acquired.promise;
		now = 7;
		releaseClient.resolve(f.client);
		await inference.promise;
		now = 18;
		releaseEmbedding.resolve([new Float32Array(384).fill(1)]);
		await dispatched.promise;
		events.message({ type: "result", id: rankId, output: null });
		await pending;
		getClient.mockResolvedValueOnce(null);
		const declined = await executor.search(
			{ query: "worker sentinel", limit: 10, filters: null, automaticContext: undefined },
			{
				onTiming: (event) => {
					timings.push(event);
				},
			},
		);
		// Assert
		expect(await pending).toEqual([]);
		expect(declined).toEqual([]);
		expect(ends(timings).filter((event) => event.stage.startsWith("embedding_"))).toEqual([
			{ stage: "embedding_client_init", state: "end", elapsed_ms: 7 },
			{ stage: "embedding_inference", state: "end", elapsed_ms: 11 },
			{ stage: "embedding_client_init", state: "end", elapsed_ms: 0 },
		]);
	});
	const wrappers = [
		"buildMemoryPackAsync",
		"buildMemoryPackWithTraceAsync",
		"buildMemoryPackTraceAsync",
	] as const;
	it.each(wrappers)(
		"%s reports assembly before usage without changing delivery counts",
		async (wrapper) => {
			// Arrange: semantic retrieval is irrelevant to accounting and cannot start a worker here.
			vi.spyOn(f.store, "semanticSearchAsync").mockResolvedValue([]);
			const observer = vi.fn();
			const usage = () =>
				f.store.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
			const before = usage().n;
			// Act
			await f.store[wrapper]("worker sentinel", 10, null, null, undefined, undefined, {
				onTiming: observer,
			});
			// Assert
			const events = observer.mock.calls.map(([event]) => event);
			const stages = events.map((event) => `${event.stage}:${event.state}`);
			expect(stages).toEqual(
				wrapper === "buildMemoryPackTraceAsync"
					? ["pack_assembly:start", "pack_assembly:end"]
					: ["pack_assembly:start", "pack_assembly:end", "usage_write:start", "usage_write:end"],
			);
			expect(usage().n - before).toBe(wrapper === "buildMemoryPackTraceAsync" ? 0 : 1);
			for (const event of events)
				expect(Object.keys(event).sort()).toEqual(
					event.state === "start" ? ["stage", "state"] : ["elapsed_ms", "stage", "state"],
				);
		},
	);

	it.each(wrappers)("%s omits assembly and usage for pre-aborted delivery", async (wrapper) => {
		// Arrange
		const controller = new AbortController();
		controller.abort();
		const observer = vi.fn();
		const semantic = vi.spyOn(f.store, "semanticSearchAsync").mockResolvedValue([]);
		// Act
		const result = observe(
			f.store[wrapper]("worker sentinel", 10, null, null, undefined, undefined, {
				signal: controller.signal,
				onTiming: observer,
			}),
		);
		// Assert
		expect(await result).toHaveProperty("error");
		expect(observer).not.toHaveBeenCalled();
		expect(semantic).not.toHaveBeenCalled();
	});
});
