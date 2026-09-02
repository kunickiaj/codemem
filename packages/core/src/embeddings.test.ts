/**
 * Tests for embeddings.ts — text chunking, hashing, serialization.
 *
 * These tests cover the pure-function utilities that don't require an
 * actual embedding model.  Integration tests with a real model belong
 * in a separate test file gated on CODEMEM_EMBEDDING_DISABLED.
 */

import { describe, expect, it, vi } from "vitest";
import {
	chunkText,
	embeddingDataToFloat32,
	embeddingTensorToFloat32Rows,
	embedTextBatches,
	hashText,
	serializeFloat32,
} from "./embeddings.js";

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
