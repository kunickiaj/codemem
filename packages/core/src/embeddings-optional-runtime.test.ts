import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@codemem/embeddings", () => {
	throw Object.assign(new Error("Cannot find package '@codemem/embeddings'"), {
		code: "ERR_MODULE_NOT_FOUND",
	});
});

import {
	_resetEmbeddingRuntimeFactory,
	embedTexts,
	getEmbeddingClient,
	getEmbeddingRuntimeStatus,
} from "./embeddings.js";

describe("optional embedding runtime", () => {
	beforeEach(() => {
		delete process.env.CODEMEM_EMBEDDING_DISABLED;
		_resetEmbeddingRuntimeFactory();
	});

	afterEach(() => vi.restoreAllMocks());

	it("falls back to lexical-only behavior when the runtime package is absent", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await expect(getEmbeddingClient()).resolves.toBeNull();
		await expect(embedTexts(["query"])).resolves.toEqual([]);
		expect(getEmbeddingRuntimeStatus()).toEqual({
			state: "unavailable",
			reason: "missing_package",
		});
		expect(warn).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(
			"Semantic search is unavailable. Install @codemem/embeddings and restart Codemem to enable it.",
		);
	});
});
