import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";

const { fetchMock, pipelineMock, transformersEnv } = vi.hoisted(() => ({
	fetchMock: vi.fn(),
	pipelineMock: vi.fn(),
	transformersEnv: {
		remoteHost: "https://huggingface.co/",
		remotePathTemplate: "{model}/resolve/{revision}/",
		allowRemoteModels: true,
		fetch: vi.fn(),
	},
}));
transformersEnv.fetch = fetchMock;
vi.mock("@huggingface/transformers", () => ({ env: transformersEnv, pipeline: pipelineMock }));

import { createEmbeddingRuntime } from "./index.js";

const tensor = (
	rows: number[][],
	dims: number[] | undefined = [rows.length, rows[0]?.length ?? 0],
) => ({ data: new Float64Array(rows.flat()), dims });

const CANONICAL_REVISION = "0123456789abcdef0123456789abcdef01234567";
const HEX_NAMED_MUTABLE_REF = "89abcdef0123456789abcdef0123456789abcdef";

describe("cached default embedding runtime", () => {
	it("loads an explicit built-in pin without a network lookup", async () => {
		const model = "Xenova/bge-small-en-v1.5";
		const revision = "ea104dacec62c0de699686887e3f920caeb4f3e3";
		pipelineMock.mockReset();
		fetchMock.mockReset();
		transformersEnv.allowRemoteModels = true;
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));
		fetchMock.mockRejectedValue(new TypeError("offline"));

		const runtime = await createEmbeddingRuntime({ model, revision });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(pipelineMock).toHaveBeenCalledWith(
			"feature-extraction",
			model,
			expect.objectContaining({ revision }),
		);
		expect(runtime.identity.revision).toBe(revision);
	});
});

describe("createEmbeddingRuntime", () => {
	beforeEach(() => {
		pipelineMock.mockReset();
		fetchMock.mockReset();
		transformersEnv.remoteHost = "https://huggingface.co/";
		transformersEnv.remotePathTemplate = "{model}/resolve/{revision}/";
		transformersEnv.allowRemoteModels = true;
		fetchMock.mockResolvedValue(
			new Response(null, {
				status: 200,
				headers: { "x-repo-commit": CANONICAL_REVISION },
			}),
		);
	});

	afterEach(() => vi.unstubAllEnvs());

	it("pins the default model and exposes its runtime identity", async () => {
		const extractor = vi.fn().mockResolvedValue(tensor([[1, 2, 3]]));
		pipelineMock.mockResolvedValue(extractor);
		const model = "Xenova/bge-small-en-v1.5";
		const revision = "ea104dacec62c0de699686887e3f920caeb4f3e3";
		const runtime = await createEmbeddingRuntime({ model });

		expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", model, {
			revision,
			device: "cpu",
			dtype: "fp32",
		});
		expect(runtime.identity).toEqual({
			package: "@huggingface/transformers",
			version: packageJson.dependencies["@huggingface/transformers"],
			model,
			revision,
			requestedRevision: revision,
			dtype: "fp32",
			device: "cpu",
			dimensions: 3,
		});
		expect(extractor).toHaveBeenCalledWith(["probe"], {
			pooling: "mean",
			normalize: true,
		});
	});

	it("requires a revision for a custom model", async () => {
		await expect(createEmbeddingRuntime({ model: "test/model" })).rejects.toThrow(
			"A revision is required when creating a runtime for a custom model",
		);
		expect(pipelineMock).not.toHaveBeenCalled();
	});

	it("uses the requested custom model revision", async () => {
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));
		const runtime = await createEmbeddingRuntime({ model: "test/model", revision: "release" });

		expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", "test/model", {
			revision: CANONICAL_REVISION,
			device: "cpu",
			dtype: "fp32",
		});
		expect(runtime.identity.revision).toBe(CANONICAL_REVISION);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://huggingface.co/test/model/resolve/release/config.json",
			expect.objectContaining({ method: "HEAD", redirect: "follow" }),
		);
	});

	it("honors an explicit revision for the default model", async () => {
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));
		const model = "Xenova/bge-small-en-v1.5";
		const revision = "release-override";

		const runtime = await createEmbeddingRuntime({ model, revision });

		expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", model, {
			revision: CANONICAL_REVISION,
			device: "cpu",
			dtype: "fp32",
		});
		expect(runtime.identity.revision).toBe(CANONICAL_REVISION);
	});

	it("resolves a hex-named mutable ref before publishing runtime identity", async () => {
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));

		const runtime = await createEmbeddingRuntime({ model: "test/model", revision: "deadbee" });

		expect(runtime.identity.revision).toBe(CANONICAL_REVISION);
		expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", "test/model", {
			revision: CANONICAL_REVISION,
			device: "cpu",
			dtype: "fp32",
		});
	});

	it("rejects a revision response without a canonical commit", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await expect(
			createEmbeddingRuntime({ model: "test/model", revision: "release" }),
		).rejects.toThrow("canonical commit");
		expect(pipelineMock).not.toHaveBeenCalled();
	});

	it("rejects a failed revision lookup before loading the pipeline", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

		await expect(
			createEmbeddingRuntime({ model: "test/model", revision: "missing" }),
		).rejects.toThrow("HTTP 404");
		expect(pipelineMock).not.toHaveBeenCalled();
	});

	it("uses the Transformers.js hub host, fetch implementation, and Hugging Face token", async () => {
		vi.stubEnv("HF_TOKEN", "test-token");
		transformersEnv.remoteHost = "https://hf.co/base/";
		transformersEnv.remotePathTemplate = "models/{model}/at/{revision}";
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));

		await createEmbeddingRuntime({ model: "test/model", revision: "release" });

		expect(fetchMock).toHaveBeenCalledWith(
			"https://hf.co/base/models/test/model/at/release/config.json",
			expect.objectContaining({
				headers: expect.objectContaining({}),
				signal: expect.any(AbortSignal),
			}),
		);
		const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit;
		expect(new Headers(init.headers).get("Authorization")).toBe("Bearer test-token");
	});

	it("preserves a hub mirror path when the host has no trailing slash", async () => {
		transformersEnv.remoteHost = "https://hf.co/base";
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));

		await createEmbeddingRuntime({ model: "test/model", revision: "release" });

		expect(fetchMock).toHaveBeenCalledWith(
			"https://hf.co/base/test/model/resolve/release/config.json",
			expect.any(Object),
		);
	});

	it("resolves a lowercase 40-character hex ref before publishing runtime identity", async () => {
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));

		const runtime = await createEmbeddingRuntime({
			model: "test/model",
			revision: HEX_NAMED_MUTABLE_REF,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			`https://huggingface.co/test/model/resolve/${HEX_NAMED_MUTABLE_REF}/config.json`,
			expect.objectContaining({ method: "HEAD", redirect: "follow" }),
		);
		expect(pipelineMock).toHaveBeenCalledWith(
			"feature-extraction",
			"test/model",
			expect.objectContaining({ revision: CANONICAL_REVISION }),
		);
		expect(runtime.identity).toMatchObject({
			revision: CANONICAL_REVISION,
			requestedRevision: HEX_NAMED_MUTABLE_REF,
		});
	});

	it("canonicalizes an explicit custom-model commit when remote access is enabled", async () => {
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));

		const runtime = await createEmbeddingRuntime({
			model: "test/model",
			revision: CANONICAL_REVISION,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			`https://huggingface.co/test/model/resolve/${CANONICAL_REVISION}/config.json`,
			expect.objectContaining({ method: "HEAD", redirect: "follow" }),
		);
		expect(runtime.identity).toMatchObject({
			revision: CANONICAL_REVISION,
			requestedRevision: CANONICAL_REVISION,
		});
		expect(pipelineMock).toHaveBeenCalledWith(
			"feature-extraction",
			"test/model",
			expect.objectContaining({ revision: CANONICAL_REVISION }),
		);
	});

	it("rejects mutable revisions when remote models are disabled", async () => {
		transformersEnv.allowRemoteModels = false;

		await expect(
			createEmbeddingRuntime({ model: "test/model", revision: "release" }),
		).rejects.toThrow("remote models are disabled");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(pipelineMock).not.toHaveBeenCalled();
	});

	it("accepts a 40-character revision identity when remote models are disabled", async () => {
		transformersEnv.allowRemoteModels = false;
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));

		const runtime = await createEmbeddingRuntime({
			model: "test/model",
			revision: CANONICAL_REVISION,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(runtime.identity.revision).toBe(CANONICAL_REVISION);
		expect(pipelineMock).toHaveBeenCalledWith(
			"feature-extraction",
			"test/model",
			expect.objectContaining({ revision: CANONICAL_REVISION }),
		);
	});

	it("accepts a canonical identity for a local model without a network lookup", async () => {
		transformersEnv.allowRemoteModels = false;
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(tensor([[1, 2]])));

		await createEmbeddingRuntime({ model: "./models/test", revision: CANONICAL_REVISION });

		expect(fetchMock).not.toHaveBeenCalled();
		expect(pipelineMock).toHaveBeenCalledWith(
			"feature-extraction",
			"./models/test",
			expect.objectContaining({ revision: CANONICAL_REVISION }),
		);
	});

	it("batches at 32 while preserving order and returning owned fp32 rows", async () => {
		const calls: string[][] = [];
		const outputs: Float64Array[] = [];
		const extractor = vi.fn(async (texts: string[]) => {
			calls.push(texts);
			const output =
				texts[0] === "probe"
					? tensor([[0, 0]])
					: tensor(texts.map((text) => [Number(text), Number(text) + 0.5]));
			outputs.push(output.data);
			return output;
		});
		pipelineMock.mockResolvedValue(extractor);
		const runtime = await createEmbeddingRuntime({
			model: "test/model",
			revision: "test-revision",
		});
		const vectors = await runtime.embed(Array.from({ length: 65 }, (_, index) => String(index)));

		expect(calls.slice(1).map((call) => call.length)).toEqual([32, 32, 1]);
		expect(vectors.map((row) => [...row])).toEqual(
			Array.from({ length: 65 }, (_, index) => [index, index + 0.5]),
		);
		const firstBuffer = vectors[0]?.buffer;
		expect(vectors.every((row, index) => index === 0 || row.buffer !== firstBuffer)).toBe(true);
		expect(vectors.every((row) => outputs.every((output) => row.buffer !== output.buffer))).toBe(
			true,
		);
	});

	it("does not invoke inference for empty input", async () => {
		const extractor = vi.fn().mockResolvedValue(tensor([[0, 0]]));
		pipelineMock.mockResolvedValue(extractor);
		const runtime = await createEmbeddingRuntime({
			model: "test/model",
			revision: "test-revision",
		});
		extractor.mockClear();

		await expect(runtime.embed([])).resolves.toEqual([]);
		expect(extractor).not.toHaveBeenCalled();
	});

	it.each([
		{ data: new Float32Array([1, 2]), dims: [2, 1] },
		{ data: new Float32Array([1]), dims: [1, 2] },
		{ data: new Float32Array(384), dims: undefined },
		{ data: new Float32Array([1, Number.NaN]), dims: [1, 2] },
	])("rejects malformed tensors", async (probe) => {
		pipelineMock.mockResolvedValue(vi.fn().mockResolvedValue(probe));
		await expect(
			createEmbeddingRuntime({ model: "bad/model", revision: "test-revision" }),
		).rejects.toThrow(TypeError);
	});

	it.each([
		{ data: new Float32Array([1]), dims: [1, 1] },
		{ data: new Float32Array([1, 2]), dims: undefined },
		{ data: new Float32Array([1, Number.NaN]), dims: [1, 2] },
	])("rejects malformed inference tensors", async (output) => {
		const extractor = vi
			.fn()
			.mockResolvedValueOnce(tensor([[0, 0]]))
			.mockResolvedValueOnce(output);
		pipelineMock.mockResolvedValue(extractor);
		const runtime = await createEmbeddingRuntime({
			model: "bad/model",
			revision: "test-revision",
		});

		await expect(runtime.embed(["text"])).rejects.toThrow(TypeError);
	});
});
