import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RankInput, RankOutput, WorkerRequest } from "./semantic-worker-protocol.js";
import { createSemanticWorkerQueue } from "./semantic-worker-queue.js";

type QueueOptions = Parameters<typeof createSemanticWorkerQueue>[0];
type WorkerEvents = Parameters<QueueOptions["createWorker"]>[0];
type RankRequest = Extract<WorkerRequest, { type: "rank" }>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Observe rejection immediately, including when fake time expires several jobs together.
function observe<T>(promise: Promise<T>) {
	return promise.then(
		(value) => ({ value }),
		(error: unknown) => ({ error }),
	);
}

function input(limit = 1): RankInput {
	return {
		generationId: "fixture-generation",
		embedding: new Float32Array([1, 0]),
		embeddingIdentity: "fixture-embedding",
		filters: null,
		automaticContext: undefined,
		proof: { actorId: "fixture-actor", deviceId: "fixture-device", expectedPublicKey: undefined },
		limit,
	};
}

const output: RankOutput = {
	generationId: "fixture-generation",
	revision: 1,
	models: ["fixture-model"],
	candidateVersions: [{ memoryId: 7, model: "fixture-model", version: 1, count: 1 }],
	candidates: [{ id: 7, distance: 0.25, contentIdentity: "content-7" }],
};

function fixture(options: Partial<Omit<QueueOptions, "createWorker">> = {}) {
	let events!: WorkerEvents;
	const terminated = deferred<number>();
	const postMessage = vi.fn<(request: WorkerRequest) => void>();
	const terminate = vi.fn(() => terminated.promise);
	const createWorker = vi.fn((callbacks: WorkerEvents) => {
		events = callbacks;
		return { postMessage, terminate };
	});
	const queue = createSemanticWorkerQueue({ createWorker, ...options });
	return {
		queue,
		createWorker,
		postMessage,
		terminate,
		terminated,
		ready: () => events.message({ type: "ready" }),
		result: (id: number, value: RankOutput | null = output) =>
			events.message({ type: "result", id, output: value }),
		fail: () => events.failure(new Error("fixture worker failure")),
		exit: (code = 0) => events.exit(code),
		ranks: () =>
			postMessage.mock.calls
				.map(([request]) => request)
				.filter((request): request is RankRequest => request.type === "rank"),
	};
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe("semantic worker queue circuit notification", () => {
	it.each(["not_ready", "worker_failed"] as const)(
		"reports the first permanent %s circuit once and preserves job failures",
		async (code) => {
			// Arrange: both jobs are admitted before readiness or the first worker failure.
			const onCircuitOpen = vi.fn();
			const f = fixture({ readinessMs: 25, onCircuitOpen });
			const prepare = vi.fn(async () => input());
			const active = observe(f.queue.run(prepare));
			const queued = observe(f.queue.run(prepare));

			// Act: an error followed by exit and duplicate errors still describes one circuit trip.
			if (code === "not_ready") await vi.advanceTimersByTimeAsync(25);
			else {
				f.ready();
				await flush();
				f.fail();
			}
			f.fail();
			f.exit(1);
			f.fail();
			const later = observe(f.queue.run(prepare));
			f.terminated.resolve(1);
			await f.queue.close();

			// Assert: notification neither replays work nor changes the original typed failure.
			expect(onCircuitOpen).toHaveBeenCalledExactlyOnceWith(code);
			expect(await active).toMatchObject({ error: { code } });
			expect(await queued).toMatchObject({ error: { code } });
			expect(await later).toMatchObject({ error: { code } });
			expect(prepare).toHaveBeenCalledTimes(code === "not_ready" ? 0 : 1);
			expect(f.createWorker).toHaveBeenCalledTimes(1);
			expect(f.terminate).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("contains a throwing circuit callback while settling jobs and joining close", async () => {
		// Arrange: diagnostics must not become part of worker-failure control flow.
		const onCircuitOpen = vi.fn(() => {
			throw new Error("fixture circuit notification failed");
		});
		const f = fixture({ onCircuitOpen });
		const active = observe(f.queue.run(async () => input()));
		const queued = observe(f.queue.run(async () => input()));
		f.ready();
		await flush();

		// Act: capture any escaped diagnostic exception and always finish fake-worker cleanup.
		let escaped: unknown;
		try {
			f.fail();
		} catch (error) {
			escaped = error;
		}
		const closing = observe(f.queue.close());
		f.fail();
		f.terminated.resolve(1);
		f.exit(1);
		await flush();

		// Assert
		expect(escaped).toBeUndefined();
		expect(onCircuitOpen).toHaveBeenCalledExactlyOnceWith("worker_failed");
		expect(await active).toMatchObject({ error: { code: "worker_failed" } });
		expect(await queued).toMatchObject({ error: { code: "worker_failed" } });
		expect(await closing).toEqual({ value: undefined });
		expect(f.createWorker).toHaveBeenCalledTimes(1);
		expect(f.terminate).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("semantic worker queue admission", () => {
	it("releases the active slot when ranking declines an unavailable generation", async () => {
		// Arrange
		const f = fixture();
		const declined = observe(f.queue.run(async () => input()));
		const next = observe(f.queue.run(async () => input(2)));
		f.ready();
		await flush();

		// Act
		f.result(f.ranks()[0].id, null);
		await flush();
		f.result(f.ranks()[1].id);

		// Assert: decline is not a queue failure and cannot retain the active slot.
		expect(await declined).toEqual({ value: null });
		expect(await next).toEqual({ value: output });
		expect(f.ranks()[1].input.limit).toBe(2);
	});
	it("starts lazily, waits for ready before embedding, and skips rank for unavailable embedding", async () => {
		// Arrange: no worker or embedding work is needed until admission.
		const f = fixture();
		const prepare = vi.fn(async () => input());
		expect(f.createWorker).not.toHaveBeenCalled();

		// Act
		const first = observe(f.queue.run(prepare));
		await flush();
		expect(prepare).not.toHaveBeenCalled();
		f.ready();
		await flush();
		const [request] = f.ranks();
		f.result(request.id);
		const unavailable = await f.queue.run(async () => null);

		// Assert: successful dispatch preserves the payload and enqueue deadline.
		expect(await first).toEqual({ value: output });
		expect(request).toMatchObject({ input: input(), deadlineAt: 15_000 });
		expect(unavailable).toBeNull();
		expect(f.ranks()).toHaveLength(1);
		expect(f.createWorker).toHaveBeenCalledTimes(1);
	});

	it("allows one active plus four pending, rejects the sixth before embedding, and dispatches FIFO", async () => {
		// Arrange
		const f = fixture();
		const prepares = Array.from({ length: 6 }, (_, index) => vi.fn(async () => input(index + 1)));

		// Act
		const jobs = prepares.map((prepare) => observe(f.queue.run(prepare)));
		f.ready();
		await flush();
		expect(await jobs[5]).toMatchObject({ error: { code: "overloaded" } });
		expect(prepares.slice(1).map((prepare) => prepare.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
		for (let index = 0; index < 5; index++) {
			const request = f.ranks()[index];
			expect(request.input.limit).toBe(index + 1);
			f.result(request.id);
			await flush();
		}

		// Assert
		expect(await Promise.all(jobs.slice(0, 5))).toEqual(Array(5).fill({ value: output }));
		expect(f.ranks()).toHaveLength(5);
	});

	it("removes an aborted queued job immediately so another caller can enter", async () => {
		// Arrange
		const f = fixture({ maxPending: 1 });
		const active = observe(f.queue.run(async () => input()));
		f.ready();
		await flush();
		const controller = new AbortController();
		const cancelledPrepare = vi.fn(async () => input());
		const cancelled = observe(f.queue.run(cancelledPrepare, { signal: controller.signal }));
		const replacementPrepare = vi.fn(async () => input(2));

		// Act
		controller.abort();
		const replacement = observe(f.queue.run(replacementPrepare));
		f.result(f.ranks()[0].id);
		await flush();
		f.result(f.ranks()[1].id);

		// Assert
		expect(await cancelled).toMatchObject({ error: { code: "aborted" } });
		expect(cancelledPrepare).not.toHaveBeenCalled();
		expect(await active).toEqual({ value: output });
		expect(await replacement).toEqual({ value: output });
	});
});

describe("semantic worker queue cancellation and deadlines", () => {
	it("expires queued work from enqueue time and reclaims capacity without preparing it", async () => {
		// Arrange: active preparation remains unfinished even after its caller expires.
		const f = fixture({ maxPending: 1, requestMs: 100 });
		const preparation = deferred<RankInput | null>();
		const active = observe(f.queue.run(() => preparation.promise));
		f.ready();
		await vi.advanceTimersByTimeAsync(10);
		const queuedPrepare = vi.fn(async () => input());
		const queued = observe(f.queue.run(queuedPrepare));

		// Act
		await vi.advanceTimersByTimeAsync(100);
		const replacementPrepare = vi.fn(async () => null);
		const replacement = observe(f.queue.run(replacementPrepare));
		preparation.resolve(null);
		await flush();

		// Assert
		expect(await active).toMatchObject({ error: { code: "expired" } });
		expect(await queued).toMatchObject({ error: { code: "expired" } });
		expect(queuedPrepare).not.toHaveBeenCalled();
		expect(await replacement).toEqual({ value: null });
		expect(f.ranks()).toHaveLength(0);
	});

	it("retains an expired rank slot until its result, then ignores duplicate and unknown IDs", async () => {
		// Arrange
		const f = fixture({ requestMs: 100 });
		const first = observe(f.queue.run(async () => input()));
		f.ready();
		await vi.advanceTimersByTimeAsync(50);
		const secondPrepare = vi.fn(async () => input(2));
		const settled = vi.fn();
		const second = observe(f.queue.run(secondPrepare)).then((result) => {
			settled(result);
			return result;
		});
		const firstId = f.ranks()[0].id;

		// Act
		await vi.advanceTimersByTimeAsync(50);
		expect(await first).toMatchObject({ error: { code: "expired" } });
		expect(secondPrepare).not.toHaveBeenCalled();
		f.result(firstId);
		await flush();
		const secondId = f.ranks()[1].id;
		f.result(firstId);
		f.result(secondId + 1000);
		await flush();
		expect(settled).not.toHaveBeenCalled();
		f.result(secondId);
		f.result(secondId);

		// Assert
		expect(secondId).not.toBe(firstId);
		expect(await second).toEqual({ value: output });
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it("retains an aborted preparation slot until preparation finishes without dispatching its rank", async () => {
		// Arrange
		const f = fixture();
		const preparation = deferred<RankInput | null>();
		const controller = new AbortController();
		const active = observe(f.queue.run(() => preparation.promise, { signal: controller.signal }));
		f.ready();
		await flush();
		const nextPrepare = vi.fn(async () => null);
		const next = observe(f.queue.run(nextPrepare));

		// Act
		controller.abort();
		await flush();
		expect(nextPrepare).not.toHaveBeenCalled();
		preparation.resolve(input());
		await flush();

		// Assert
		expect(await active).toMatchObject({ error: { code: "aborted" } });
		expect(await next).toEqual({ value: null });
		expect(f.ranks()).toHaveLength(0);
	});
});

describe("semantic worker queue lifecycle", () => {
	it("fails readiness on its own deadline without preparing or accepting late ready", async () => {
		// Arrange
		const f = fixture({ readinessMs: 25 });
		const prepare = vi.fn(async () => input());
		const job = observe(f.queue.run(prepare));

		// Act
		await vi.advanceTimersByTimeAsync(25);
		f.ready();
		await flush();

		// Assert
		expect(await job).toMatchObject({ error: { code: "not_ready" } });
		expect(prepare).not.toHaveBeenCalled();
		expect(f.ranks()).toHaveLength(0);
	});

	it("opens a permanent circuit after worker failure and exit without replay", async () => {
		// Arrange
		const f = fixture();
		const active = observe(f.queue.run(async () => input()));
		f.ready();
		await flush();
		const oldId = f.ranks()[0].id;
		const queuedPrepare = vi.fn(async () => input());
		const queued = observe(f.queue.run(queuedPrepare));

		// Act
		f.fail();
		f.exit(1);
		f.result(oldId);
		const later = observe(f.queue.run(queuedPrepare));

		// Assert
		expect(await active).toMatchObject({ error: { code: "worker_failed" } });
		expect(await queued).toMatchObject({ error: { code: "worker_failed" } });
		expect(await later).toMatchObject({ error: { code: "worker_failed" } });
		expect(queuedPrepare).not.toHaveBeenCalled();
		expect(f.createWorker).toHaveBeenCalledTimes(1);
		expect(f.ranks()).toHaveLength(1);
	});

	it("closes admission, rejects pending work, and drains active work before joining exit", async () => {
		// Arrange
		const f = fixture();
		const active = observe(f.queue.run(async () => input()));
		f.ready();
		await flush();
		const queuedPrepare = vi.fn(async () => input());
		const queued = observe(f.queue.run(queuedPrepare));
		const joined = vi.fn();

		// Act
		const closing = f.queue.close().then(joined);
		const later = observe(f.queue.run(queuedPrepare));
		f.result(f.ranks()[0].id);
		await flush();
		expect(joined).not.toHaveBeenCalled();
		expect(f.postMessage).toHaveBeenLastCalledWith({ type: "close" });
		f.exit();
		await closing;
		await f.queue.close();

		// Assert
		expect(await active).toEqual({ value: output });
		expect(await queued).toMatchObject({ error: { code: "closed" } });
		expect(await later).toMatchObject({ error: { code: "closed" } });
		expect(queuedPrepare).not.toHaveBeenCalled();
		expect(f.terminate).not.toHaveBeenCalled();
	});

	it("waits for confirmed termination after shutdown timeout and terminates only once", async () => {
		// Arrange
		const f = fixture({ shutdownMs: 25 });
		const active = observe(f.queue.run(async () => input()));
		f.ready();
		await flush();
		const joined = vi.fn();

		// Act
		const closing = f.queue.close().then(joined);
		const closingAgain = f.queue.close();
		await vi.advanceTimersByTimeAsync(25);
		expect(f.terminate).toHaveBeenCalledTimes(1);
		expect(joined).not.toHaveBeenCalled();
		f.terminated.resolve(1);
		await Promise.all([closing, closingAgain]);

		// Assert: a timeout is not a claim that native work has already stopped.
		expect(await active).toHaveProperty("error");
		expect(joined).toHaveBeenCalledTimes(1);
		expect(f.terminate).toHaveBeenCalledTimes(1);
	});
});

describe("semantic worker queue shutdown edge cases", () => {
	it("closes before readiness without preparing work and clears timers after confirmed exit", async () => {
		// Arrange
		const f = fixture();
		const prepare = vi.fn(async () => input());
		const active = observe(f.queue.run(prepare));
		const queued = observe(f.queue.run(prepare));

		// Act
		const closing = f.queue.close();
		f.ready();
		await flush();
		f.exit();
		await closing;

		// Assert
		expect(await active).toMatchObject({ error: { code: "closed" } });
		expect(await queued).toMatchObject({ error: { code: "closed" } });
		expect(prepare).not.toHaveBeenCalled();
		expect(f.ranks()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("enforces admission limits even before ready without preparing overloaded work", async () => {
		// Arrange
		const f = fixture({ maxPending: 0 });
		const prepare = vi.fn(async () => input());
		const active = observe(f.queue.run(prepare));

		// Act
		const overloaded = observe(f.queue.run(prepare));
		const closing = f.queue.close();
		f.exit();
		await closing;

		// Assert
		expect(await overloaded).toMatchObject({ error: { code: "overloaded" } });
		expect(await active).toMatchObject({ error: { code: "closed" } });
		expect(prepare).not.toHaveBeenCalled();
		expect(f.createWorker).toHaveBeenCalledTimes(1);
	});

	it("ignores nonnumeric and nonfinite result IDs without settling the current job", async () => {
		// Arrange
		const f = fixture();
		const settled = vi.fn();
		const active = observe(f.queue.run(async () => input())).then((result) => {
			settled(result);
			return result;
		});
		f.ready();
		await flush();
		const id = f.ranks()[0].id;

		// Act
		f.result(Number.NaN);
		f.result(String(id) as unknown as number);
		await flush();
		expect(settled).not.toHaveBeenCalled();
		f.result(id);

		// Assert
		expect(await active).toEqual({ value: output });
		expect(settled).toHaveBeenCalledTimes(1);
	});

	it("rejects close when termination fails instead of claiming exit or leaving callers pending", async () => {
		// Arrange
		const f = fixture({ shutdownMs: 25 });
		const failure = new Error("fixture termination failed");
		f.terminate.mockRejectedValue(failure);
		const active = observe(f.queue.run(async () => input()));
		f.ready();
		await flush();

		// Act
		const closing = observe(f.queue.close());
		await vi.advanceTimersByTimeAsync(25);
		const later = observe(f.queue.run(async () => input()));

		// Assert
		expect(await closing).toEqual({ error: failure });
		expect(await active).toMatchObject({ error: { code: "closed" } });
		expect(await later).toMatchObject({ error: { code: "closed" } });
		expect(f.terminate).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("semantic worker queue synchronous preparation failure", () => {
	it("joins reentrant preparation before closing after a synchronous callback throw", async () => {
		// Arrange: admit both jobs before ready so the first failure pumps the second inline.
		const f = fixture({ shutdownMs: 25 });
		const failure = new Error("fixture synchronous prepare failure");
		const firstPrepare = vi.fn(() => {
			throw failure;
		});
		const preparation = deferred<RankInput | null>();
		const secondPrepare = vi.fn(() => preparation.promise);
		const firstSettled = vi.fn();
		const secondSettled = vi.fn();
		const first = observe(f.queue.run(firstPrepare)).then((result) => {
			firstSettled(result);
			return result;
		});
		const second = observe(f.queue.run(secondPrepare)).then((result) => {
			secondSettled(result);
			return result;
		});
		f.ready();
		await flush();
		expect(secondPrepare).toHaveBeenCalledTimes(1);
		const joined = vi.fn();

		// Act: confirmed worker exit cannot cancel parent-owned embedding preparation.
		const closing = f.queue.close().then(joined);
		await vi.advanceTimersByTimeAsync(25);
		f.terminated.resolve(1);
		f.exit(1);
		await flush();
		const joinsBeforePreparationCompleted = joined.mock.calls.length;
		preparation.resolve(input());
		await closing;
		await flush();

		// Assert: cleanup runs even on RED, and neither job dispatches SQL or settles twice.
		expect(joinsBeforePreparationCompleted).toBe(0);
		expect(await first).toEqual({ error: failure });
		expect(await second).toMatchObject({ error: { code: "closed" } });
		expect(firstPrepare).toHaveBeenCalledTimes(1);
		expect(secondPrepare).toHaveBeenCalledTimes(1);
		expect(firstSettled).toHaveBeenCalledTimes(1);
		expect(secondSettled).toHaveBeenCalledTimes(1);
		expect(joined).toHaveBeenCalledTimes(1);
		expect(f.terminate).toHaveBeenCalledTimes(1);
		expect(f.ranks()).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});
});
