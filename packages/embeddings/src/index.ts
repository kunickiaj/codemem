export interface EmbeddingRuntimeRequest {
	model: string;
	revision?: string;
}

export interface EmbeddingRuntimeIdentity {
	readonly package: "@huggingface/transformers";
	readonly version: string;
	readonly model: string;
	readonly revision: string;
	readonly requestedRevision?: string;
	readonly dtype: "fp32";
	readonly device: "cpu";
	readonly pooling: "mean";
	readonly normalization: "l2";
	readonly dimensions: number;
}

export interface EmbeddingClient {
	readonly model: string;
	readonly dimensions: number;
	readonly identity: EmbeddingRuntimeIdentity;
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

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";
const DEFAULT_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const CANONICAL_REVISION_PATTERN = /^[0-9a-f]{40}$/;

interface HubEnvironment {
	remoteHost: string;
	remotePathTemplate: string;
	allowRemoteModels: boolean;
	fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

function isLocalModelPath(model: string): boolean {
	// Transformers.js accepts at most owner/name as a Hub repository ID; other path forms are local.
	return (
		model.startsWith(".") ||
		model.startsWith("/") ||
		model.startsWith("~") ||
		model.includes("\\") ||
		model.split("/").length > 2
	);
}

function configuredRevisionToResolve(
	model: string,
	configuredRevision: string | undefined,
): string | undefined {
	if (model === DEFAULT_MODEL && configuredRevision === DEFAULT_REVISION) return undefined;
	return configuredRevision;
}

async function resolveCanonicalRevision(
	model: string,
	revision: string,
	env: HubEnvironment,
): Promise<string> {
	const remotePath = env.remotePathTemplate
		.replaceAll("{model}", model.split("/").map(encodeURIComponent).join("/"))
		.replaceAll("{revision}", encodeURIComponent(revision));
	const url = `${env.remoteHost.replace(/\/+$/, "")}/${remotePath.replace(/^\/+|\/+$/g, "")}/config.json`;
	const headers = new Headers();
	const hostname = new URL(url).hostname;
	if (hostname === "huggingface.co" || hostname === "hf.co") {
		const token = process.env.HF_TOKEN ?? process.env.HF_ACCESS_TOKEN;
		if (token) headers.set("Authorization", `Bearer ${token}`);
	}
	const response = await env.fetch(url, {
		method: "HEAD",
		redirect: "follow",
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) {
		throw new TypeError(
			`Unable to resolve Hugging Face model ${model}@${revision}: HTTP ${response.status}`,
		);
	}
	const canonicalRevision = response.headers.get("x-repo-commit")?.trim().toLowerCase();
	if (!canonicalRevision || !CANONICAL_REVISION_PATTERN.test(canonicalRevision)) {
		throw new TypeError(
			`Hugging Face did not return a canonical commit for model ${model}@${revision}`,
		);
	}
	return canonicalRevision;
}

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
	revision: revisionRequest,
}: EmbeddingRuntimeRequest): Promise<EmbeddingClient> {
	const configuredRevision = revisionRequest?.trim();
	if (model !== DEFAULT_MODEL && !configuredRevision) {
		throw new TypeError("A revision is required when creating a runtime for a custom model");
	}
	const { env, pipeline } = await import("@huggingface/transformers");
	const requestedRevision = configuredRevision || DEFAULT_REVISION;
	let revision = requestedRevision;
	const revisionToResolve = configuredRevisionToResolve(model, configuredRevision);
	if (revisionToResolve) {
		if (isLocalModelPath(model)) {
			if (!CANONICAL_REVISION_PATTERN.test(revisionToResolve)) {
				throw new TypeError("Local embedding models require a 40-character revision identity");
			}
		} else if (!env.allowRemoteModels) {
			if (CANONICAL_REVISION_PATTERN.test(revisionToResolve)) {
				revision = revisionToResolve;
			} else {
				throw new TypeError(
					`Cannot resolve mutable embedding revision ${revisionToResolve} while remote models are disabled`,
				);
			}
		} else {
			revision = await resolveCanonicalRevision(model, revisionToResolve, env);
		}
	}
	// Runtime validation below guards the structural boundary hidden by upstream's broad pipeline type.
	const extractor = (await pipeline("feature-extraction", model, {
		revision,
		device: "cpu",
		dtype: "fp32",
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
		identity: {
			package: "@huggingface/transformers",
			version: "4.2.0",
			model,
			revision,
			requestedRevision,
			dtype: "fp32",
			device: "cpu",
			pooling: "mean",
			normalization: "l2",
			dimensions,
		},
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
