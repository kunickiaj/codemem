import { describe, expect, it } from "vitest";
import type { ReleaseEvalMainDependencies } from "./release-eval.js";
import { main, parseReleaseEvalArguments } from "./release-eval.js";

describe("release eval command parsing", () => {
	it("accepts synthetic and manifest-bound run commands", () => {
		expect(parseReleaseEvalArguments(["--", "synthetic"])).toEqual({ command: "synthetic" });
		expect(
			parseReleaseEvalArguments(["run", "--manifest", "manifest.json", "--output", "summary.json"]),
		).toEqual({ command: "run", manifestPath: "manifest.json", outputPath: "summary.json" });
		expect(
			parseReleaseEvalArguments([
				"run",
				"--manifest",
				"manifest.json",
				"--retrieval-corpus",
				"private-retrieval-corpus.json",
				"--injection-corpus",
				"public-injection-corpus.json",
			]),
		).toEqual({
			command: "run",
			manifestPath: "manifest.json",
			retrievalCorpusPath: "private-retrieval-corpus.json",
			injectionCorpusPath: "public-injection-corpus.json",
		});
		expect(parseReleaseEvalArguments(["verify", "--report", "attestation.json"])).toEqual({
			command: "verify",
			reportPath: "attestation.json",
		});
	});

	it("rejects missing and duplicate arguments", () => {
		expect(() => parseReleaseEvalArguments(["run"])).toThrow("requires --manifest");
		expect(() => parseReleaseEvalArguments(["run", "--manifest", "a", "--manifest", "b"])).toThrow(
			"only once",
		);
		expect(() => parseReleaseEvalArguments(["verify"])).toThrow("requires --report");
		expect(() => parseReleaseEvalArguments(["verify", "--report", "a", "--output", "b"])).toThrow(
			"accepts only --report",
		);
	});

	it("dispatches the shipped synthetic command path and writes its public result envelope", async () => {
		let output = "";
		let syntheticCalls = 0;
		const dependencies: ReleaseEvalMainDependencies = {
			repositoryRoot: () => "/repository",
			runSynthetic: async () => {
				syntheticCalls += 1;
				return {
					runId: "synthetic-observer",
					detailedPath: "/repository/.tmp/eval-results/release/detailed.json",
					sanitizedPath: "/repository/.tmp/eval-results/release/summary.json",
					summary: { status: "partial", scope: "observer" },
				};
			},
			run: async () => {
				throw new Error("run command must not be called");
			},
			verify: async () => {
				throw new Error("verify command must not be called");
			},
			writeStdout: (value) => {
				output += value;
			},
		};
		await main(["synthetic"], dependencies);
		expect(syntheticCalls).toBe(1);
		expect(JSON.parse(output)).toEqual({
			status: "partial",
			scope: "observer",
			run_id: "synthetic-observer",
			detailed_report: "/repository/.tmp/eval-results/release/detailed.json",
			sanitized_summary: "/repository/.tmp/eval-results/release/summary.json",
		});
	});

	it("dispatches offline verification and prints the attestation result", async () => {
		let output = "";
		const dependencies: ReleaseEvalMainDependencies = {
			repositoryRoot: () => "/repository",
			runSynthetic: async () => {
				throw new Error("synthetic command must not be called");
			},
			run: async () => {
				throw new Error("run command must not be called");
			},
			verify: async ({ reportPath }) => ({
				status: "pass",
				release_version: "0.40.0",
				profile_id: reportPath,
				candidate_commit: "a".repeat(40),
			}),
			writeStdout: (value) => {
				output += value;
			},
		};
		await main(["verify", "--report", "stable-release-v1"], dependencies);
		expect(JSON.parse(output)).toMatchObject({ status: "pass", profile_id: "stable-release-v1" });
	});
});
