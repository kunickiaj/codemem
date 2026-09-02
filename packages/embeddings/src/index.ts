export interface EmbeddingRuntimeRequest {
	model: string;
}

export interface EmbeddingClient {
	readonly model: string;
	readonly dimensions: number;
	embed(texts: string[]): Promise<Float32Array[]>;
}

export type EmbeddingRuntimeFactory = (
	request: EmbeddingRuntimeRequest,
) => Promise<EmbeddingClient | null>;

interface Tensor {
	data: ArrayLike<number | bigint>;
	dims?: number[];
}

type Extractor = (
	texts: string[],
	options: { pooling: "mean"; normalize: true },
) => Promise<Tensor>;

function rows(output: Tensor, count: number, dimensions: number): Float32Array[] {
	if (
		output.dims?.length !== 2 ||
		(output.dims?.length === 2 && (output.dims[0] !== count || output.dims[1] !== dimensions)) ||
		output.data.length !== count * dimensions
	) {
		throw new TypeError("Embedding model returned an invalid tensor shape or value count");
	}
	const result = Array.from({ length: count }, () => new Float32Array(dimensions));
	for (let index = 0; index < output.data.length; index++) {
		const value = output.data[index];
		const number = typeof value === "number" ? Math.fround(value) : Number.NaN;
		if (!Number.isFinite(number)) {
			throw new TypeError(`Embedding model returned non-finite data at index ${index}`);
		}
		const row = result[Math.floor(index / dimensions)];
		if (!row) throw new TypeError("Embedding model returned an invalid tensor row");
		row[index % dimensions] = number;
	}
	return result;
}

export async function createEmbeddingRuntime({
	model,
}: EmbeddingRuntimeRequest): Promise<EmbeddingClient> {
	const { pipeline } = await import("@xenova/transformers");
	// Runtime validation below guards the structural boundary hidden by upstream's broad pipeline type.
	const extractor = (await pipeline("feature-extraction", model, {
		quantized: false,
	})) as unknown as Extractor;
	const options = { pooling: "mean", normalize: true } as const;
	const probe = await extractor(["probe"], options);
	const dimensions = probe.dims?.at(-1);
	if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions <= 0) {
		throw new TypeError("Embedding model returned invalid dimensions");
	}
	rows(probe, 1, dimensions);

	return {
		model,
		dimensions,
		async embed(texts) {
			const result: Float32Array[] = [];
			for (let offset = 0; offset < texts.length; offset += 32) {
				const batch = texts.slice(offset, offset + 32);
				result.push(...rows(await extractor(batch, options), batch.length, dimensions));
			}
			return result;
		},
	};
}
