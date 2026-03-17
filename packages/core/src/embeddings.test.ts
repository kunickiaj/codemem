/**
 * Tests for embeddings.ts — text chunking, hashing, serialization.
 *
 * These tests cover the pure-function utilities that don't require an
 * actual embedding model.  Integration tests with a real model belong
 * in a separate test file gated on CODEMEM_EMBEDDING_DISABLED.
 */

import { describe, expect, it } from "vitest";
import { chunkText, hashText, serializeFloat32 } from "./embeddings.js";

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
