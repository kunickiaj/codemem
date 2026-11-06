import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	_resetEmbeddingRuntimeFactory,
	_setEmbeddingRuntimeFactory,
	DEFAULT_EMBEDDING_REVISION,
	getEmbeddingClient,
	getEmbeddingRuntimeStatus,
	resolveEmbeddingModel,
} from "./embeddings.js";

function runtimeClient() {
	const model = resolveEmbeddingModel();
	return {
		model,
		dimensions: 384,
		embed: vi.fn(async () => []),
		identity: {
			package: "@huggingface/transformers" as const,
			version: "4.2.0",
			model,
			revision: DEFAULT_EMBEDDING_REVISION,
			requestedRevision: DEFAULT_EMBEDDING_REVISION,
			dtype: "fp32" as const,
			device: "cpu" as const,
			pooling: "mean" as const,
			normalization: "l2" as const,
			dimensions: 384,
		},
	};
}

describe("embedding runtime retry after a failed load", () => {
	beforeEach(() => {
		delete process.env.CODEMEM_EMBEDDING_DISABLED;
		delete process.env.CODEMEM_EMBEDDING_MODEL;
		delete process.env.CODEMEM_EMBEDDING_REVISION;
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-11-06T00:00:00Z"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		_resetEmbeddingRuntimeFactory();
	});

	it("retries once the backoff elapses and recovers", async () => {
		const client = runtimeClient();
		const factory = vi
			.fn()
			.mockRejectedValueOnce(new Error("EACCES: permission denied"))
			.mockResolvedValueOnce(client);
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		vi.advanceTimersByTime(29_999);
		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(factory).toHaveBeenCalledOnce();

		vi.advanceTimersByTime(1);
		await expect(getEmbeddingClient()).resolves.toBe(client);
		expect(getEmbeddingRuntimeStatus()).toEqual({ state: "ready" });
		expect(console.warn).toHaveBeenLastCalledWith(
			"Semantic search is available after the embedding runtime loaded.",
		);
		await expect(getEmbeddingClient()).resolves.toBe(client);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("starts a fresh retry schedule when the requested model changes", async () => {
		const factory = vi.fn(async () => {
			throw new Error("model download failed");
		});
		_setEmbeddingRuntimeFactory(factory);
		await getEmbeddingClient();
		for (const delay of [30_000, 60_000, 120_000]) {
			vi.advanceTimersByTime(delay);
			await getEmbeddingClient();
		}
		expect(factory).toHaveBeenCalledTimes(4);

		process.env.CODEMEM_EMBEDDING_REVISION = "0123456789abcdef0123456789abcdef01234567";
		await getEmbeddingClient();
		expect(factory).toHaveBeenCalledTimes(5);
		vi.advanceTimersByTime(30_000);
		await getEmbeddingClient();
		expect(factory).toHaveBeenCalledTimes(6);
	});

	it("doubles the wait after each failure up to ten minutes", async () => {
		const factory = vi.fn(async () => {
			throw new Error("model download failed");
		});
		_setEmbeddingRuntimeFactory(factory);
		await getEmbeddingClient();

		for (const delay of [30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]) {
			vi.advanceTimersByTime(delay - 1);
			await getEmbeddingClient();
			const callsBefore = factory.mock.calls.length;
			vi.advanceTimersByTime(1);
			await getEmbeddingClient();
			expect(factory).toHaveBeenCalledTimes(callsBefore + 1);
		}
	});

	it("shares one retry between concurrent callers", async () => {
		const client = runtimeClient();
		const factory = vi
			.fn()
			.mockRejectedValueOnce(new Error("runtime unavailable"))
			.mockResolvedValueOnce(client);
		_setEmbeddingRuntimeFactory(factory);
		await getEmbeddingClient();
		vi.advanceTimersByTime(30_000);

		const results = await Promise.all([getEmbeddingClient(), getEmbeddingClient()]);

		expect(results).toEqual([client, client]);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("does not retry when the optional runtime package is missing", async () => {
		const missing = Object.assign(new Error("Cannot find package '@codemem/embeddings'"), {
			code: "ERR_MODULE_NOT_FOUND",
		});
		const factory = vi.fn(async () => {
			throw missing;
		});
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		vi.advanceTimersByTime(60 * 60_000);
		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(factory).toHaveBeenCalledOnce();
		expect(getEmbeddingRuntimeStatus()).toEqual({
			state: "unavailable",
			reason: "missing_package",
		});
	});
});
