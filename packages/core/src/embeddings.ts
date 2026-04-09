/**
 * Embedding primitives for semantic search.
 *
 * Ports codemem/semantic.py — text chunking, hashing, and embedding via a
 * pluggable client interface.  The default client uses `@xenova/transformers`
 * (same BAAI/bge-small-en-v1.5 model as Python's fastembed).  When the
 * embedding runtime is unavailable the helpers return empty arrays and callers
 * fall back to FTS-only retrieval.
 *
 * Embeddings are always disabled when CODEMEM_EMBEDDING_DISABLED=1.
 */

import { createHash } from "node:crypto";
import { isEmbeddingDisabled } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal interface a concrete embedding backend must satisfy. */
export interface EmbeddingClient {
	readonly model: string;
	readonly dimensions: number;
	embed(texts: string[]): Promise<Float32Array[]>;
}

// ---------------------------------------------------------------------------
// Text helpers (ports of semantic.py)
// ---------------------------------------------------------------------------

/** SHA-256 hex digest of UTF-8 encoded text. */
export function hashText(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Split long text into ≤ `maxChars` chunks, preferring paragraph then
 * sentence boundaries.  Matches Python's `chunk_text()`.
 */
export function chunkText(text: string, maxChars = 1200): string[] {
	const cleaned = text.trim();
	if (!cleaned) return [];
	if (cleaned.length <= maxChars) return [cleaned];

	const paragraphs = cleaned
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter(Boolean);
	const chunks: string[] = [];
	let buffer: string[] = [];
	let bufferLen = 0;

	for (const paragraph of paragraphs) {
		if (bufferLen + paragraph.length + 2 <= maxChars) {
			buffer.push(paragraph);
			bufferLen += paragraph.length + 2;
			continue;
		}
		if (buffer.length > 0) {
			chunks.push(buffer.join("\n\n"));
			buffer = [];
			bufferLen = 0;
		}
		if (paragraph.length <= maxChars) {
			chunks.push(paragraph);
			continue;
		}
		// Split long paragraph by sentence
		const sentences = paragraph
			.split(/(?<=[.!?])\s+/)
			.map((s) => s.trim())
			.filter(Boolean);
		const sentBuf: string[] = [];
		let sentLen = 0;
		for (const sentence of sentences) {
			// Hard-split sentences that exceed maxChars on their own
			if (sentence.length > maxChars) {
				if (sentBuf.length > 0) {
					chunks.push(sentBuf.join(" "));
					sentBuf.length = 0;
					sentLen = 0;
				}
				for (let i = 0; i < sentence.length; i += maxChars) {
					chunks.push(sentence.slice(i, i + maxChars));
				}
				continue;
			}
			if (sentLen + sentence.length + 1 <= maxChars) {
				sentBuf.push(sentence);
				sentLen += sentence.length + 1;
				continue;
			}
			if (sentBuf.length > 0) chunks.push(sentBuf.join(" "));
			sentBuf.length = 0;
			sentBuf.push(sentence);
			sentLen = sentence.length;
		}
		if (sentBuf.length > 0) chunks.push(sentBuf.join(" "));
	}
	if (buffer.length > 0) chunks.push(buffer.join("\n\n"));
	return chunks;
}

// ---------------------------------------------------------------------------
// Lazy singleton client
// ---------------------------------------------------------------------------

let _client: EmbeddingClient | null | undefined;

/** Reset the singleton (for tests). */
export function _resetEmbeddingClient(): void {
	_client = undefined;
}

/** Return the configured embedding model label without loading the client. */
export function resolveEmbeddingModel(): string {
	return process.env.CODEMEM_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5";
}

/**
 * Get the shared embedding client, creating it lazily on first call.
 * Returns null when embeddings are disabled or the runtime is unavailable.
 */
export async function getEmbeddingClient(): Promise<EmbeddingClient | null> {
	if (_client !== undefined) return _client;
	if (isEmbeddingDisabled()) {
		_client = null;
		return null;
	}
	const model = resolveEmbeddingModel();
	try {
		_client = await createTransformersClient(model);
	} catch {
		_client = null;
	}
	return _client;
}

/**
 * Embed texts using the shared client.
 * Returns an empty array when embeddings are unavailable.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
	const client = await getEmbeddingClient();
	if (!client) return [];
	return client.embed(texts);
}

// ---------------------------------------------------------------------------
// @xenova/transformers backend (runtime-detected)
// ---------------------------------------------------------------------------

async function createTransformersClient(model: string): Promise<EmbeddingClient> {
	// Dynamic import so the package is optional at install time
	const { pipeline } = await import("@xenova/transformers");
	const extractor = await pipeline("feature-extraction", model, {
		quantized: false,
	});

	// Infer dimensions from a probe embedding
	const probe = await extractor("probe", { pooling: "mean", normalize: true });
	const dims = probe.dims?.at(-1) ?? 384;

	return {
		model,
		dimensions: dims,
		async embed(texts: string[]): Promise<Float32Array[]> {
			const results: Float32Array[] = [];
			for (const text of texts) {
				const output = await extractor(text, { pooling: "mean", normalize: true });
				// output.data is a Float32Array of shape [1, dims]
				results.push(new Float32Array(output.data));
			}
			return results;
		},
	};
}

// ---------------------------------------------------------------------------
// Serialization helpers (sqlite-vec wire format)
// ---------------------------------------------------------------------------

/** Serialize a Float32Array to a little-endian Buffer for sqlite-vec. */
export function serializeFloat32(vector: Float32Array): Buffer {
	const buf = Buffer.alloc(vector.length * 4);
	for (let i = 0; i < vector.length; i++) {
		buf.writeFloatLE(vector[i] ?? 0, i * 4);
	}
	return buf;
}
