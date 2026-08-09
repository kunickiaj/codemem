import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseComponentFileSetManifest } from "./manifest.js";

describe("release evaluator component file set", () => {
	it("binds current evaluator, observer scoring, and private-corpus generation behavior", async () => {
		const manifest = parseComponentFileSetManifest(
			JSON.parse(await readFile(new URL("./component-files.json", import.meta.url), "utf8")),
		);
		expect(manifest.components.evaluator).toEqual(
			expect.arrayContaining([
				"packages/core/src/extraction-benchmark-scoring.ts",
				"packages/core/src/extraction-benchmarks.ts",
				"packages/core/src/extraction-replay.ts",
				"packages/core/src/ingest-xml-parser.ts",
				"scripts/eval/export-private-release-corpus.ts",
				"scripts/eval/release/observer-runner.ts",
				"scripts/eval/release/orchestrator.ts",
				"scripts/eval/release/reports.ts",
			]),
		);
		expect(manifest.components.evaluator).toContain("packages/core/src/ingest-prompts.ts");
		expect(manifest.components.evaluator.some((path) => path.includes("attestation"))).toBe(false);
		expect(manifest.components.evaluator.some((path) => path.includes("retrieval"))).toBe(false);
		expect(manifest.components.evaluator.some((path) => path.includes("injection"))).toBe(false);
	});
});
