import { beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMock = vi.hoisted(() => vi.fn());
vi.mock("@xenova/transformers", () => ({ pipeline: pipelineMock }));

import { createEmbeddingRuntime } from "./index.js";

const tensor = (
	rows: number[][],
	dims: number[] | undefined = [rows.length, rows[0]?.length ?? 0],
) => ({ data: new Float64Array(rows.flat()), dims });

describe("createEmbeddingRuntime", () => {
	beforeEach(() => pipelineMock.mockReset());

	it("uses full-precision feature extraction and probes dimensions", async () => {
		const extractor = vi.fn().mockResolvedValue(tensor([[1, 2, 3]]));
		pipelineMock.mockResolvedValueOnce(extractor);
		const runtime = await createEmbeddingRuntime({ model: "test/model" });
		expect(runtime.dimensions).toBe(3);
		expect(extractor).toHaveBeenCalledWith(["probe"], {
			pooling: "mean",
			normalize: true,
		});
		expect(pipelineMock).toHaveBeenCalledWith("feature-extraction", "test/model", {
			quantized: false,
		});
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
		const runtime = await createEmbeddingRuntime({ model: "test/model" });
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
		const runtime = await createEmbeddingRuntime({ model: "test/model" });
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
		await expect(createEmbeddingRuntime({ model: "bad/model" })).rejects.toThrow(TypeError);
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
		const runtime = await createEmbeddingRuntime({ model: "bad/model" });

		await expect(runtime.embed(["text"])).rejects.toThrow(TypeError);
	});
});
