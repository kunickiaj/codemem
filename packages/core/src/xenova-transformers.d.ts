/**
 * Minimal type declarations for @xenova/transformers.
 *
 * This package is an optional runtime dependency — only needed when
 * CODEMEM_EMBEDDING_DISABLED is not set and semantic search is active.
 * The dynamic import in embeddings.ts gracefully falls back when absent.
 */
declare module "@xenova/transformers" {
	interface PipelineOutput {
		data: Float32Array;
		dims?: number[];
	}

	type FeatureExtractionPipeline = (
		text: string,
		options?: { pooling?: string; normalize?: boolean },
	) => Promise<PipelineOutput>;

	export function pipeline(
		task: "feature-extraction",
		model: string,
		options?: { quantized?: boolean },
	): Promise<FeatureExtractionPipeline>;
}
