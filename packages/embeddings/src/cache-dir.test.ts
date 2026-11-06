import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { pipelineMock, transformersEnv } = vi.hoisted(() => ({
	pipelineMock: vi.fn(),
	transformersEnv: {
		cacheDir: "/usr/local/lib/node_modules/@huggingface/transformers/.cache/" as string | null,
		remoteHost: "https://huggingface.co/",
		remotePathTemplate: "{model}/resolve/{revision}/",
		allowRemoteModels: true,
		fetch: vi.fn(),
	},
}));
vi.mock("@huggingface/transformers", () => ({ env: transformersEnv, pipeline: pipelineMock }));

import { createEmbeddingRuntime, resolveEmbeddingCacheDir } from "./index.js";

describe("embedding model cache directory", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("defaults to .codemem/models under the home directory", () => {
		expect(resolveEmbeddingCacheDir({ HOME: "/home/node" })).toBe("/home/node/.codemem/models");
	});

	it("falls back to the OS home directory when HOME is unset", () => {
		expect(resolveEmbeddingCacheDir({})).toBe(join(homedir(), ".codemem", "models"));
	});

	it("uses CODEMEM_EMBEDDING_CACHE_DIR when set", () => {
		expect(
			resolveEmbeddingCacheDir({ HOME: "/home/node", CODEMEM_EMBEDDING_CACHE_DIR: " /models " }),
		).toBe("/models");
	});

	it("expands a leading ~ in CODEMEM_EMBEDDING_CACHE_DIR", () => {
		expect(
			resolveEmbeddingCacheDir({ HOME: "/home/node", CODEMEM_EMBEDDING_CACHE_DIR: "~/models" }),
		).toBe("/home/node/models");
		expect(resolveEmbeddingCacheDir({ HOME: "/home/node", CODEMEM_EMBEDDING_CACHE_DIR: "~" })).toBe(
			"/home/node",
		);
	});

	it("points the runtime's model cache away from its package directory", async () => {
		vi.stubEnv("CODEMEM_EMBEDDING_CACHE_DIR", "/models");
		pipelineMock.mockResolvedValue(
			vi.fn().mockResolvedValue({ data: new Float64Array([1, 2]), dims: [1, 2] }),
		);

		await createEmbeddingRuntime({ model: "Xenova/bge-small-en-v1.5" });

		expect(transformersEnv.cacheDir).toBe("/models");
	});
});
