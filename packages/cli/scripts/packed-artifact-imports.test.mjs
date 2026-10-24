import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hasExternalEmbeddingsImport } from "./packed-artifact-smoke.mjs";

function fixture(modules) {
	const sources = new Map(
		Object.entries(modules).map(([name, source]) => [resolve("fixture/dist", name), source]),
	);
	return {
		entrypoint: resolve("fixture/dist/index.js"),
		readSource(path) {
			if (!sources.has(path)) throw new Error(`Unexpected module read: ${path}`);
			return sources.get(path);
		},
	};
}

describe("packed core external embeddings import", () => {
	it("accepts the external dynamic import in the entrypoint", () => {
		// Arrange: preserve the original single-bundle check.
		const { entrypoint, readSource } = fixture({
			"index.js": 'const runtime = import("@codemem/embeddings");',
		});

		// Act
		const found = hasExternalEmbeddingsImport(entrypoint, { readSource });

		// Assert
		expect(found).toBe(true);
	});

	it.each([
		'import { rank } from "./shared.js";',
		'export { rank } from "./shared.js";',
		'import "./shared.js";',
		'const shared = import("./shared.js");',
	])("accepts an external import through a reachable shared chunk: %s", (entry) => {
		// Arrange: multi-entry builds may move the lazy runtime into shared chunks.
		const { entrypoint, readSource } = fixture({
			"index.js": entry,
			"shared.js": 'export * from "./nested/ranking.mjs";',
			"nested/ranking.mjs": "const runtime = import ( '@codemem/embeddings' );",
		});

		// Act
		const found = hasExternalEmbeddingsImport(entrypoint, { readSource });

		// Assert
		expect(found).toBe(true);
	});

	it("rejects reachable modules without the external dynamic import", () => {
		// Arrange: bare imports and non-JavaScript assets are not local chunks.
		const { entrypoint, readSource } = fixture({
			"index.js": 'import "node:fs"; import "./metadata.json"; export * from "./shared.js";',
			"shared.js": 'import runtime from "@codemem/embeddings";',
		});

		// Act
		const found = hasExternalEmbeddingsImport(entrypoint, { readSource });

		// Assert
		expect(found).toBe(false);
	});

	it("rejects an external import found only in an orphan chunk", () => {
		// Arrange: scanning all dist files would incorrectly accept this artifact.
		const { entrypoint, readSource } = fixture({
			"index.js": 'export * from "./shared.js";',
			"shared.js": "export const rank = () => [];",
			"orphan.js": 'const runtime = import("@codemem/embeddings");',
		});

		// Act
		const found = hasExternalEmbeddingsImport(entrypoint, { readSource });

		// Assert
		expect(found).toBe(false);
	});

	it.each([true, false])("handles cyclic chunks with external import present=%s", (present) => {
		// Arrange: cycles must not prevent finding an import or finishing a failed check.
		const { entrypoint, readSource } = fixture({
			"index.js": 'import "./shared.js";',
			"shared.js": `import "./index.js"; ${present ? 'import("@codemem/embeddings");' : ""}`,
		});

		// Act
		const found = hasExternalEmbeddingsImport(entrypoint, { readSource });

		// Assert
		expect(found).toBe(present);
	});
});
