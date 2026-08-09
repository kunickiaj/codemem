import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseComponentFileSetManifest } from "./manifest.js";

describe("release evaluator component file set", () => {
	it("binds observer, retrieval, injection, private-corpus, and attestation behavior", async () => {
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
				"scripts/eval/release/retrieval-matrix.ts",
				"scripts/eval/release/semantic-retrieval.ts",
				"scripts/eval/release/injection-benchmark.ts",
				"scripts/eval/release/attestation.ts",
			]),
		);
		expect(manifest.components.evaluator).toContain("packages/core/src/ingest-prompts.ts");
		expect(manifest.components.evaluator).toContain("scripts/eval/release/attestation.ts");
		expect(manifest.components.evaluator).toContain(
			"packages/opencode-plugin/.opencode/plugins/codemem.js",
		);
		expect(manifest.components.evaluator).toContain("scripts/eval/release/fake-pack-runner.mjs");
		expect(manifest.components.retrieval).toEqual(
			expect.arrayContaining([
				"packages/core/src/pack.ts",
				"scripts/eval/release/retrieval-scoring.ts",
				"scripts/eval/release/semantic-retrieval.ts",
			]),
		);
		expect(manifest.components.injection).toEqual(
			expect.arrayContaining([
				"packages/opencode-plugin/.opencode/plugins/codemem.js",
				"scripts/eval/release/fake-pack-runner.mjs",
			]),
		);
	});
});
