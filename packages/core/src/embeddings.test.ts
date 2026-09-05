/**
 * Tests for embeddings.ts — text chunking, hashing, serialization.
 *
 * These tests cover the pure-function utilities that don't require an
 * actual embedding model.  Integration tests with a real model belong
 * in a separate test file gated on CODEMEM_EMBEDDING_DISABLED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createEmbeddingRuntimeMock } = vi.hoisted(() => ({
	createEmbeddingRuntimeMock: vi.fn(),
}));

vi.mock("@codemem/embeddings", () => ({
	createEmbeddingRuntime: createEmbeddingRuntimeMock,
}));

import {
	_resetEmbeddingRuntimeFactory,
	_setEmbeddingRuntimeFactory,
	chunkText,
	DEFAULT_EMBEDDING_REVISION,
	DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL,
	embeddingDataToFloat32,
	embeddingTensorToFloat32Rows,
	embedTextBatches,
	getEmbeddingClient,
	getEmbeddingRuntimeStatus,
	hashText,
	resolveEmbeddingClientVectorIdentityLabel,
	resolveEmbeddingModel,
	resolveEmbeddingRevision,
	resolveEmbeddingVectorIdentityLabel,
	serializeFloat32,
	tryResolveEmbeddingRevision,
	tryResolveEmbeddingVectorIdentityLabel,
} from "./embeddings.js";

function fakeClient(model = "Xenova/bge-small-en-v1.5") {
	return { model, dimensions: 384, embed: vi.fn(async () => []) };
}

function runtimeClient(
	model = resolveEmbeddingModel(),
	revision = resolveEmbeddingRevision(model),
	version = "4.2.0",
	requestedRevision = revision,
) {
	return {
		...fakeClient(model),
		identity: {
			package: "@huggingface/transformers" as const,
			version,
			model,
			revision,
			requestedRevision,
			dtype: "fp32" as const,
			device: "cpu" as const,
			pooling: "mean" as const,
			normalization: "l2" as const,
			dimensions: 384,
		},
	};
}

describe("embedding runtime factory", () => {
	const originalEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	const originalEmbeddingModel = process.env.CODEMEM_EMBEDDING_MODEL;
	const originalEmbeddingRevision = process.env.CODEMEM_EMBEDDING_REVISION;

	beforeEach(() => {
		delete process.env.CODEMEM_EMBEDDING_DISABLED;
		delete process.env.CODEMEM_EMBEDDING_MODEL;
		delete process.env.CODEMEM_EMBEDDING_REVISION;
		createEmbeddingRuntimeMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		_resetEmbeddingRuntimeFactory();
		if (originalEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
		else process.env.CODEMEM_EMBEDDING_DISABLED = originalEmbeddingDisabled;
		if (originalEmbeddingModel === undefined) delete process.env.CODEMEM_EMBEDDING_MODEL;
		else process.env.CODEMEM_EMBEDDING_MODEL = originalEmbeddingModel;
		if (originalEmbeddingRevision === undefined) delete process.env.CODEMEM_EMBEDDING_REVISION;
		else process.env.CODEMEM_EMBEDDING_REVISION = originalEmbeddingRevision;
	});

	it("delegates the resolved model request to the optional runtime without loading a model", async () => {
		const client = runtimeClient();
		createEmbeddingRuntimeMock.mockResolvedValue(client);

		await expect(getEmbeddingClient()).resolves.toBe(client);
		expect(createEmbeddingRuntimeMock).toHaveBeenCalledWith({
			model: resolveEmbeddingModel(),
			revision: DEFAULT_EMBEDDING_REVISION,
		});
		expect(client.embed).not.toHaveBeenCalled();
	});

	it("accepts a 40-hex ref only when the runtime resolves it to a canonical commit", async () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		const requestedRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		process.env.CODEMEM_EMBEDDING_REVISION = requestedRevision;
		const canonicalRevision = "0123456789abcdef0123456789abcdef01234567";
		const client = runtimeClient("custom/model", canonicalRevision, "4.2.0", requestedRevision);
		createEmbeddingRuntimeMock.mockResolvedValue(client);

		await expect(getEmbeddingClient()).resolves.toBe(client);
		expect(createEmbeddingRuntimeMock).toHaveBeenCalledWith({
			model: "custom/model",
			revision: requestedRevision,
		});
		expect(resolveEmbeddingClientVectorIdentityLabel(client)).toContain(
			`revision=${canonicalRevision}`,
		);
		expect(tryResolveEmbeddingVectorIdentityLabel()).toBe(
			resolveEmbeddingClientVectorIdentityLabel(client),
		);
	});

	it("requires identity from the installed optional runtime", async () => {
		createEmbeddingRuntimeMock.mockResolvedValue(fakeClient(resolveEmbeddingModel()));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"Upgrade codemem and @codemem/embeddings together, then restart Codemem",
			),
		);
	});

	it("receives the resolved model request", async () => {
		const client = runtimeClient(resolveEmbeddingModel());
		const factory = vi.fn(async () => client);
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBe(client);
		expect(factory).toHaveBeenCalledWith({
			model: resolveEmbeddingModel(),
			revision: DEFAULT_EMBEDDING_REVISION,
		});
	});

	it("rejects an injected runtime without identity before caching it", async () => {
		const factory = vi.fn(async () => fakeClient(resolveEmbeddingModel()));
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(factory).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Embedding runtime identity is required"),
		);
	});

	it("rejects a runtime identity mismatch before caching the client", async () => {
		const client = {
			...fakeClient(resolveEmbeddingModel()),
			identity: {
				package: "@huggingface/transformers" as const,
				version: "4.2.0" as const,
				model: resolveEmbeddingModel(),
				revision: "wrong-revision",
				dtype: "fp32" as const,
				device: "cpu" as const,
				pooling: "mean" as const,
				normalization: "l2" as const,
				dimensions: 384,
			},
		};
		const factory = vi.fn(async () => client);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("revision is not a canonical commit SHA"),
		);
		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("rejects a runtime resolved for a different requested revision", async () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		process.env.CODEMEM_EMBEDDING_REVISION = "release";
		const client = runtimeClient(
			"custom/model",
			"0123456789abcdef0123456789abcdef01234567",
			"4.2.0",
			"main",
		);
		const factory = vi.fn(async () => client);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("requestedRevision mismatch"));
	});

	it("recreates the shared client when the configured request changes", async () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		process.env.CODEMEM_EMBEDDING_REVISION = "release-one";
		const first = runtimeClient(
			"custom/model",
			"0123456789abcdef0123456789abcdef01234567",
			"4.2.0",
			"release-one",
		);
		const second = runtimeClient(
			"custom/model",
			"89abcdef0123456789abcdef0123456789abcdef",
			"4.2.0",
			"release-two",
		);
		const factory = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBe(first);
		process.env.CODEMEM_EMBEDDING_REVISION = "release-two";
		await expect(getEmbeddingClient()).resolves.toBe(second);
		expect(factory).toHaveBeenCalledTimes(2);
	});

	it("accepts an informational runtime version from an injected factory", async () => {
		const client = runtimeClient(resolveEmbeddingModel(), DEFAULT_EMBEDDING_REVISION, "4.3.0");
		_setEmbeddingRuntimeFactory(vi.fn(async () => client));

		await expect(getEmbeddingClient()).resolves.toBe(client);
	});

	it("reports client dimension mismatches with expected and received values", async () => {
		const client = { ...runtimeClient(), dimensions: 768 };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		_setEmbeddingRuntimeFactory(vi.fn(async () => client));

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Embedding client dimensions mismatch: expected 384, received 768"),
		);
	});

	it("reports client model mismatches separately", async () => {
		const client = { ...runtimeClient(), model: "wrong/model" };
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		_setEmbeddingRuntimeFactory(vi.fn(async () => client));

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"Embedding client model mismatch: expected Xenova/bge-small-en-v1.5, received wrong/model",
			),
		);
	});

	it("reuses the singleton client", async () => {
		const client = runtimeClient();
		const factory = vi.fn(async () => client);
		_setEmbeddingRuntimeFactory(factory);

		expect(await getEmbeddingClient()).toBe(client);
		expect(await getEmbeddingClient()).toBe(client);
		expect(factory).toHaveBeenCalledTimes(1);
	});

	it("resolves in-flight waiters through the current client after a factory swap", async () => {
		let resolveFirst: ((client: ReturnType<typeof runtimeClient>) => void) | undefined;
		const firstFactory = vi.fn(
			() =>
				new Promise<ReturnType<typeof runtimeClient>>((resolve) => {
					resolveFirst = resolve;
				}),
		);
		_setEmbeddingRuntimeFactory(firstFactory);
		const first = getEmbeddingClient();
		const shared = getEmbeddingClient();
		expect(firstFactory).toHaveBeenCalledTimes(1);

		// Use the resolved default identity so the v4 runtime-identity assertion
		// accepts the replacement client.
		const replacementClient = runtimeClient(resolveEmbeddingModel());
		_setEmbeddingRuntimeFactory(vi.fn(async () => replacementClient));
		expect(await getEmbeddingClient()).toBe(replacementClient);
		// The stale creation completing must not hand its now-superseded client
		// to earlier waiters; they resolve through the current generation.
		resolveFirst?.(runtimeClient());
		await expect(first).resolves.toBe(replacementClient);
		await expect(shared).resolves.toBe(replacementClient);
		await expect(getEmbeddingClient()).resolves.toBe(replacementClient);
	});

	it("resolves stale waiters through the current client when a swapped-out creation fails", async () => {
		let rejectFirst: ((error: Error) => void) | undefined;
		_setEmbeddingRuntimeFactory(
			vi.fn(
				() =>
					new Promise<ReturnType<typeof runtimeClient>>((_resolve, reject) => {
						rejectFirst = reject;
					}),
			),
		);
		const first = getEmbeddingClient();

		// Use the resolved default identity so the upstack v4 runtime-identity
		// assertion accepts the replacement client after this branch merges.
		const replacementClient = runtimeClient(resolveEmbeddingModel());
		_setEmbeddingRuntimeFactory(vi.fn(async () => replacementClient));
		expect(await getEmbeddingClient()).toBe(replacementClient);
		rejectFirst?.(new Error("stale runtime unavailable"));
		await expect(first).resolves.toBe(replacementClient);
	});

	it("returns null when the factory fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const factory = vi.fn(async () => {
			throw new Error("runtime unavailable");
		});
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(getEmbeddingRuntimeStatus()).toEqual({
			state: "unavailable",
			reason: "initialization_failed",
		});
		expect(factory).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(
			"Semantic search is unavailable because the embedding runtime failed: runtime unavailable",
		);
	});

	it("returns cached null and warns once when a custom model has no revision", async () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		delete process.env.CODEMEM_EMBEDDING_REVISION;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const factory = vi.fn(async () => fakeClient("custom/model"));
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(factory).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(
			"Semantic search is unavailable because the embedding runtime failed: CODEMEM_EMBEDDING_REVISION is required when CODEMEM_EMBEDDING_MODEL selects a custom model",
		);
	});

	it("does not call the factory when embeddings are disabled", async () => {
		process.env.CODEMEM_EMBEDDING_DISABLED = "1";
		const factory = vi.fn(async () => fakeClient());
		_setEmbeddingRuntimeFactory(factory);

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(getEmbeddingRuntimeStatus()).toEqual({ state: "disabled" });
		expect(factory).not.toHaveBeenCalled();
	});

	it("records an empty factory result as unavailable", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		_setEmbeddingRuntimeFactory(vi.fn(async () => null));

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(getEmbeddingRuntimeStatus()).toEqual({ state: "unavailable", reason: "no_client" });
	});

	it("clears the cached client when the runtime factory resets", async () => {
		const first = runtimeClient();
		_setEmbeddingRuntimeFactory(vi.fn(async () => first));
		expect(await getEmbeddingClient()).toBe(first);

		_resetEmbeddingRuntimeFactory();
		expect(getEmbeddingRuntimeStatus()).toEqual({ state: "uninitialized" });
		const second = runtimeClient();
		const replacement = vi.fn(async () => second);
		_setEmbeddingRuntimeFactory(replacement);

		expect(await getEmbeddingClient()).toBe(second);
		expect(replacement).toHaveBeenCalledTimes(1);
	});
});

describe("embedding runtime requested identity validation", () => {
	const originalEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	const originalEmbeddingModel = process.env.CODEMEM_EMBEDDING_MODEL;
	const originalEmbeddingRevision = process.env.CODEMEM_EMBEDDING_REVISION;

	beforeEach(() => {
		_resetEmbeddingRuntimeFactory();
		delete process.env.CODEMEM_EMBEDDING_DISABLED;
		delete process.env.CODEMEM_EMBEDDING_MODEL;
		delete process.env.CODEMEM_EMBEDDING_REVISION;
		createEmbeddingRuntimeMock.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		_resetEmbeddingRuntimeFactory();
		if (originalEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
		else process.env.CODEMEM_EMBEDDING_DISABLED = originalEmbeddingDisabled;
		if (originalEmbeddingModel === undefined) delete process.env.CODEMEM_EMBEDDING_MODEL;
		else process.env.CODEMEM_EMBEDDING_MODEL = originalEmbeddingModel;
		if (originalEmbeddingRevision === undefined) delete process.env.CODEMEM_EMBEDDING_REVISION;
		else process.env.CODEMEM_EMBEDDING_REVISION = originalEmbeddingRevision;
	});

	it("rejects a runtime identity for a different requested model", async () => {
		const client = runtimeClient("other/model", DEFAULT_EMBEDDING_REVISION);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		_setEmbeddingRuntimeFactory(vi.fn(async () => client));

		await expect(getEmbeddingClient()).resolves.toBeNull();
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"Embedding runtime identity mismatch for model: expected Xenova/bge-small-en-v1.5, received other/model",
			),
		);
	});
});

describe("embedding vector identity", () => {
	const originalEmbeddingModel = process.env.CODEMEM_EMBEDDING_MODEL;
	const originalEmbeddingRevision = process.env.CODEMEM_EMBEDDING_REVISION;

	afterEach(() => {
		if (originalEmbeddingModel === undefined) delete process.env.CODEMEM_EMBEDDING_MODEL;
		else process.env.CODEMEM_EMBEDDING_MODEL = originalEmbeddingModel;
		if (originalEmbeddingRevision === undefined) delete process.env.CODEMEM_EMBEDDING_REVISION;
		else process.env.CODEMEM_EMBEDDING_REVISION = originalEmbeddingRevision;
	});

	it("uses the pinned revision for the default model", () => {
		delete process.env.CODEMEM_EMBEDDING_MODEL;
		delete process.env.CODEMEM_EMBEDDING_REVISION;

		expect(resolveEmbeddingRevision()).toBe(DEFAULT_EMBEDDING_REVISION);
		expect(tryResolveEmbeddingRevision()).toBe(DEFAULT_EMBEDDING_REVISION);
		expect(resolveEmbeddingVectorIdentityLabel()).toBe(
			`transformers-v4:model=Xenova%2Fbge-small-en-v1.5:revision=${DEFAULT_EMBEDDING_REVISION}:dtype=fp32:pooling=mean:normalization=l2:dimensions=384`,
		);
		expect(tryResolveEmbeddingVectorIdentityLabel()).toBe(DEFAULT_EMBEDDING_VECTOR_IDENTITY_LABEL);
	});

	it("requires an explicit revision for a custom model", () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		delete process.env.CODEMEM_EMBEDDING_REVISION;

		expect(() => resolveEmbeddingRevision()).toThrow(
			"CODEMEM_EMBEDDING_REVISION is required when CODEMEM_EMBEDDING_MODEL selects a custom model",
		);
		expect(() => resolveEmbeddingVectorIdentityLabel()).toThrow(
			"CODEMEM_EMBEDDING_REVISION is required",
		);
		expect(tryResolveEmbeddingRevision()).toBeNull();
	});

	it("passes an explicit revision to the runtime without treating its spelling as identity", () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		process.env.CODEMEM_EMBEDDING_REVISION = "abc1234";

		expect(resolveEmbeddingRevision()).toBe("abc1234");
		expect(tryResolveEmbeddingRevision()).toBe("abc1234");
		expect(() => resolveEmbeddingVectorIdentityLabel("custom/model", "abc1234")).toThrow(
			"canonical commit SHA",
		);
	});

	it("does not treat a configured 40-hex ref as a resolved identity", () => {
		process.env.CODEMEM_EMBEDDING_REVISION = "0123456789abcdef0123456789abcdef01234567";

		expect(resolveEmbeddingRevision()).toBe("0123456789abcdef0123456789abcdef01234567");
		expect(() => resolveEmbeddingVectorIdentityLabel()).toThrow(
			"canonical commit SHA returned by the runtime",
		);
		expect(tryResolveEmbeddingVectorIdentityLabel()).toBeNull();
	});

	it("passes a mutable branch revision to the runtime for canonical resolution", () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		process.env.CODEMEM_EMBEDDING_REVISION = "main";

		expect(tryResolveEmbeddingRevision()).toBe("main");
		expect(resolveEmbeddingRevision()).toBe("main");
		expect(() => resolveEmbeddingVectorIdentityLabel("custom/model", "main")).toThrow(
			"canonical commit SHA",
		);
	});

	it("passes a mutable revision override for the default model to the runtime", () => {
		delete process.env.CODEMEM_EMBEDDING_MODEL;
		process.env.CODEMEM_EMBEDDING_REVISION = "release/2026-09";

		expect(tryResolveEmbeddingRevision()).toBe("release/2026-09");
		expect(resolveEmbeddingRevision()).toBe("release/2026-09");
	});

	it("uses a persisted canonical target only for the matching configured request", () => {
		process.env.CODEMEM_EMBEDDING_MODEL = "custom/model";
		process.env.CODEMEM_EMBEDDING_REVISION = "release";
		const targetModel =
			"transformers-v4:model=custom%2Fmodel:revision=0123456789abcdef0123456789abcdef01234567:dtype=fp32:pooling=mean:normalization=l2:dimensions=384";

		expect(
			tryResolveEmbeddingVectorIdentityLabel({
				targetModel,
				requestedModel: "custom/model",
				requestedRevision: "release",
			}),
		).toBe(targetModel);
		expect(
			tryResolveEmbeddingVectorIdentityLabel({
				targetModel,
				requestedModel: "custom/model",
				requestedRevision: "main",
			}),
		).toBeNull();
	});

	it("waits for runtime resolution when the default revision is explicitly configured", () => {
		process.env.CODEMEM_EMBEDDING_REVISION = DEFAULT_EMBEDDING_REVISION;

		expect(tryResolveEmbeddingVectorIdentityLabel()).toBeNull();
	});
});

describe("hashText", () => {
	it("returns a 64-char hex SHA-256 digest", () => {
		const h = hashText("hello world");
		expect(h).toHaveLength(64);
		expect(h).toMatch(/^[a-f0-9]{64}$/);
	});

	it("produces identical hashes for identical inputs", () => {
		expect(hashText("abc")).toBe(hashText("abc"));
	});

	it("produces different hashes for different inputs", () => {
		expect(hashText("abc")).not.toBe(hashText("def"));
	});
});

describe("chunkText", () => {
	it("returns empty array for empty/whitespace input", () => {
		expect(chunkText("")).toEqual([]);
		expect(chunkText("   ")).toEqual([]);
	});

	it("returns single chunk for short text", () => {
		const chunks = chunkText("Short text.", 100);
		expect(chunks).toEqual(["Short text."]);
	});

	it("splits on paragraph boundaries", () => {
		const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
		const chunks = chunkText(text, 25);
		expect(chunks.length).toBeGreaterThanOrEqual(2);
		expect(chunks[0]).toBe("Paragraph one.");
	});

	it("splits long paragraphs on sentence boundaries", () => {
		const sentences = Array.from({ length: 20 }, (_, i) => `Sentence ${i}.`);
		const text = sentences.join(" ");
		const chunks = chunkText(text, 60);
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(60);
		}
	});

	it("handles text with no natural break points", () => {
		const text = "a".repeat(200);
		// No sentence/paragraph breaks — should still produce chunks
		const chunks = chunkText(text, 100);
		expect(chunks.length).toBeGreaterThanOrEqual(1);
	});
});

describe("embeddingDataToFloat32", () => {
	it("converts numeric typed arrays to Float32Array", () => {
		const vector = embeddingDataToFloat32(new Float64Array([1.5, -2.25, 3]));

		expect(vector).toEqual(new Float32Array([1.5, -2.25, 3]));
	});

	it("copies source storage", () => {
		const source = new Float32Array([1, 2, 3]);
		const vector = embeddingDataToFloat32(source);

		source[0] = 99;
		expect(vector[0]).toBe(1);
		expect(vector.buffer).not.toBe(source.buffer);
	});

	it("rejects bigint data", () => {
		expect(() => embeddingDataToFloat32(new BigInt64Array([1n]))).toThrow(TypeError);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_VALUE])(
		"rejects non-finite or unrepresentable data: %s",
		(value) => {
			expect(() => embeddingDataToFloat32([value])).toThrow(TypeError);
		},
	);
});

describe("bounded embedding batches", () => {
	it("runs stable array inference batches and returns owned rows", async () => {
		const outputs: Float32Array[] = [];
		const extractor = vi.fn(async (texts: string[]) => {
			const data = new Float32Array(texts.flatMap((text) => [Number(text), Number(text) + 0.5]));
			outputs.push(data);
			return { data, dims: [texts.length, 2] };
		});

		const vectors = await embedTextBatches(extractor, ["1", "2", "3", "4", "5"], 2, 2);

		expect(extractor.mock.calls.map(([texts]) => texts)).toEqual([["1", "2"], ["3", "4"], ["5"]]);
		expect(vectors).toEqual([
			new Float32Array([1, 1.5]),
			new Float32Array([2, 2.5]),
			new Float32Array([3, 3.5]),
			new Float32Array([4, 4.5]),
			new Float32Array([5, 5.5]),
		]);
		expect(
			vectors.every((vector) => outputs.every((output) => vector.buffer !== output.buffer)),
		).toBe(true);
		expect(new Set(vectors.map((vector) => vector.buffer)).size).toBe(vectors.length);
	});

	it("does not invoke the extractor for empty input", async () => {
		const extractor = vi.fn();

		await expect(embedTextBatches(extractor, [], 384)).resolves.toEqual([]);
		expect(extractor).not.toHaveBeenCalled();
	});

	it.each([
		[{ data: new Float32Array(4), dims: [1, 2] }, "shape"],
		[{ data: new Float32Array(3), dims: [2, 2] }, "values"],
		[{ data: new Float32Array([1, 2, Number.NaN, 4]), dims: [2, 2] }, "non-finite"],
	])("rejects invalid batched tensor %s", (output, expectedMessage) => {
		expect(() => embeddingTensorToFloat32Rows(output, 2, 2)).toThrow(expectedMessage);
	});
});

describe("serializeFloat32", () => {
	it("produces a Buffer of 4 bytes per element", () => {
		const vec = new Float32Array([1.0, 2.0, 3.0]);
		const buf = serializeFloat32(vec);
		expect(buf).toBeInstanceOf(Buffer);
		expect(buf.length).toBe(12);
	});

	it("round-trips through DataView", () => {
		const vec = new Float32Array([1.5, -2.5, 0.0]);
		const buf = serializeFloat32(vec);
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		expect(view.getFloat32(0, true)).toBeCloseTo(1.5);
		expect(view.getFloat32(4, true)).toBeCloseTo(-2.5);
		expect(view.getFloat32(8, true)).toBeCloseTo(0.0);
	});

	it("handles empty vector", () => {
		const buf = serializeFloat32(new Float32Array(0));
		expect(buf.length).toBe(0);
	});
});
