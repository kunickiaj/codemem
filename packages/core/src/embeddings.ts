/**
 * Embedding primitives for semantic search.
 *
 * Ports codemem/semantic.py — text chunking, hashing, and embedding via a
 * pluggable client interface. The default factory lazily loads the optional
 * `@codemem/embeddings` runtime. When it is unavailable the helpers return
 * empty arrays and callers fall back to FTS-only retrieval.
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

export interface EmbeddingRuntimeRequest {
	model: string;
}

export type EmbeddingRuntimeFactory = (
	request: EmbeddingRuntimeRequest,
) => Promise<EmbeddingClient | null>;

export type EmbeddingRuntimeStatus =
	| { state: "uninitialized" | "ready" | "disabled" }
	| { state: "unavailable"; reason: "missing_package" | "initialization_failed" | "no_client" };

interface EmbeddingTensor {
	data: ArrayLike<number | bigint>;
	dims?: number[];
}

type FeatureExtractor = (
	texts: string[],
	options: { pooling: "mean"; normalize: true },
) => Promise<EmbeddingTensor>;

const EMBEDDING_BATCH_SIZE = 32;

/** Copy validated embedding model data into owned Float32 storage. */
export function embeddingDataToFloat32(data: ArrayLike<number | bigint>): Float32Array {
	const vector = new Float32Array(data.length);
	for (let index = 0; index < data.length; index++) {
		const value = data[index];
		const float32Value = typeof value === "number" ? Math.fround(value) : Number.NaN;
		if (!Number.isFinite(float32Value)) {
			throw new TypeError(
				`Embedding model returned non-finite, non-numeric, or unrepresentable tensor data at index ${index}`,
			);
		}
		vector[index] = float32Value;
	}
	return vector;
}

/** Split one validated row-major tensor into independently owned vectors. */
export function embeddingTensorToFloat32Rows(
	output: EmbeddingTensor,
	expectedRows: number,
	dimensions: number,
): Float32Array[] {
	if (
		!Number.isInteger(expectedRows) ||
		expectedRows <= 0 ||
		!Number.isInteger(dimensions) ||
		dimensions <= 0
	) {
		throw new TypeError("Embedding tensor shape expectations must be positive integers");
	}
	if (
		output.dims?.length !== 2 ||
		output.dims[0] !== expectedRows ||
		output.dims[1] !== dimensions
	) {
		throw new TypeError(
			`Embedding model returned shape [${output.dims?.join(", ") ?? "unknown"}], expected [${expectedRows}, ${dimensions}]`,
		);
	}
	if (output.data.length !== expectedRows * dimensions) {
		throw new TypeError(
			`Embedding model returned ${output.data.length} values, expected ${expectedRows * dimensions}`,
		);
	}

	const rows = Array.from({ length: expectedRows }, () => new Float32Array(dimensions));
	for (let flatIndex = 0; flatIndex < output.data.length; flatIndex++) {
		const value = output.data[flatIndex];
		const float32Value = typeof value === "number" ? Math.fround(value) : Number.NaN;
		if (!Number.isFinite(float32Value)) {
			throw new TypeError(
				`Embedding model returned non-finite, non-numeric, or unrepresentable tensor data at index ${flatIndex}`,
			);
		}
		const row = rows[Math.floor(flatIndex / dimensions)];
		if (!row) throw new TypeError("Embedding tensor row calculation failed");
		row[flatIndex % dimensions] = float32Value;
	}
	return rows;
}

/** Run array inference in bounded batches while preserving input order. */
export async function embedTextBatches(
	extractor: FeatureExtractor,
	texts: string[],
	dimensions: number,
	batchSize = EMBEDDING_BATCH_SIZE,
): Promise<Float32Array[]> {
	if (texts.length === 0) return [];
	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new TypeError("Embedding batch size must be a positive integer");
	}

	const vectors: Float32Array[] = [];
	for (let offset = 0; offset < texts.length; offset += batchSize) {
		const batch = texts.slice(offset, offset + batchSize);
		const output = await extractor(batch, { pooling: "mean", normalize: true });
		vectors.push(...embeddingTensorToFloat32Rows(output, batch.length, dimensions));
	}
	return vectors;
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
let _clientPromise: Promise<EmbeddingClient | null> | undefined;
let _clientGeneration = 0;
let _runtimeWarningEmitted = false;
let _runtimeStatus: EmbeddingRuntimeStatus = { state: "uninitialized" };

const defaultEmbeddingRuntimeFactory: EmbeddingRuntimeFactory = async (request) => {
	const { createEmbeddingRuntime } = await import("@codemem/embeddings");
	return createEmbeddingRuntime(request);
};
let embeddingRuntimeFactory = defaultEmbeddingRuntimeFactory;

/** Reset the singleton (for tests). */
export function _resetEmbeddingClient(): void {
	_client = undefined;
	_clientPromise = undefined;
	_clientGeneration++;
	_runtimeStatus = { state: "uninitialized" };
}

/** Override the embedding runtime factory (for tests). */
export function _setEmbeddingRuntimeFactory(factory: EmbeddingRuntimeFactory): void {
	embeddingRuntimeFactory = factory;
	_resetEmbeddingClient();
}

/** Restore the default embedding runtime factory (for tests). */
export function _resetEmbeddingRuntimeFactory(): void {
	embeddingRuntimeFactory = defaultEmbeddingRuntimeFactory;
	_runtimeWarningEmitted = false;
	_resetEmbeddingClient();
}

function warnEmbeddingRuntimeUnavailable(error: unknown): void {
	if (_runtimeWarningEmitted) return;
	_runtimeWarningEmitted = true;
	if (isMissingEmbeddingRuntimePackage(error)) {
		console.warn(
			"Semantic search is unavailable. Install @codemem/embeddings and restart Codemem to enable it.",
		);
		return;
	}
	const cause = error instanceof Error ? error.message : String(error);
	console.warn(`Semantic search is unavailable because the embedding runtime failed: ${cause}`);
}

function isMissingEmbeddingRuntimePackage(error: unknown): boolean {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (typeof current === "object" && current !== null && !seen.has(current)) {
		seen.add(current);
		if (
			"code" in current &&
			current.code === "ERR_MODULE_NOT_FOUND" &&
			current instanceof Error &&
			current.message.includes("@codemem/embeddings")
		) {
			return true;
		}
		current = "cause" in current ? current.cause : undefined;
	}
	return false;
}

/** Return process-local runtime state without loading the embedding model. */
export function getEmbeddingRuntimeStatus(): EmbeddingRuntimeStatus {
	return _runtimeStatus;
}

function recordEmbeddingRuntimeClient(client: EmbeddingClient | null): void {
	_client = client;
	if (client) {
		_runtimeStatus = { state: "ready" };
		return;
	}
	_runtimeStatus = { state: "unavailable", reason: "no_client" };
	warnEmbeddingRuntimeUnavailable("embedding runtime returned no client");
}

async function createEmbeddingClient(
	model: string,
	generation: number,
): Promise<EmbeddingClient | null> {
	try {
		const client = await embeddingRuntimeFactory({ model });
		// A reset while creation was in flight makes this client stale. Resolve
		// waiters through the live generation so model labels and dimensions agree.
		if (generation !== _clientGeneration) return getEmbeddingClient();
		recordEmbeddingRuntimeClient(client);
		return client;
	} catch (error) {
		// A stale creation failure must not force current-generation waiters to null.
		if (generation !== _clientGeneration) return getEmbeddingClient();
		_client = null;
		_runtimeStatus = {
			state: "unavailable",
			reason: isMissingEmbeddingRuntimePackage(error) ? "missing_package" : "initialization_failed",
		};
		warnEmbeddingRuntimeUnavailable(error);
		return null;
	} finally {
		if (generation === _clientGeneration) _clientPromise = undefined;
	}
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
	if (_clientPromise) return _clientPromise;
	if (isEmbeddingDisabled()) {
		_client = null;
		_runtimeStatus = { state: "disabled" };
		return null;
	}
	const model = resolveEmbeddingModel();
	const generation = _clientGeneration;
	_clientPromise = createEmbeddingClient(model, generation);
	return _clientPromise;
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
