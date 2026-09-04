import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	compareDiagnostics,
	getTouchedPaths,
	type LintDiagnostic,
	parseApplyPatchPaths,
	parseBiomeDiagnostics,
	resolveWorktreePath,
} from "./lint-feedback-core.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");

it("parses the prior score from Biome complexity advice", () => {
	const diagnostics = parseBiomeDiagnostics(
		JSON.stringify({
			diagnostics: [
				{
					category: "lint/complexity/noExcessiveCognitiveComplexity",
					message: "This function is too complex.",
					advices: [
						{ log: "Reduce the complexity score from 17 to the max allowed complexity 15." },
					],
				},
			],
		}),
	);

	expect(diagnostics[0]?.measuredValue).toBe(17);
});

describe("lint feedback", () => {
	it("exposes only one plugin factory from the configured entrypoint", async () => {
		const plugin = await import("./lint-feedback.js");

		expect(Object.keys(plugin)).toEqual(["default"]);
		const hooks = await plugin.default({ worktree: repositoryRoot } as never);
		expect(Object.keys(hooks)).toContain("tool.execute.before");
	});

	it("reports an equal-count replacement with a different message", () => {
		const parse = (description: string) =>
			parseBiomeDiagnostics(
				JSON.stringify({
					diagnostics: [
						{
							category: "lint/correctness/noUnusedVariables",
							description,
							location: { path: "packages/core/src/example.ts", start: { line: 2, column: 1 } },
						},
					],
				}),
			);

		expect(compareDiagnostics(parse("old variable"), parse("new variable"))).toMatchObject([
			{ description: "new variable" },
		]);
	});

	it("matches reordered measured diagnostics by source before location", () => {
		const alpha: LintDiagnostic = {
			category: "lint/complexity/noExcessiveCognitiveComplexity",
			description: "complex",
			line: 10,
			sourceText: "function alpha",
			measuredValue: 20,
		};
		const beta: LintDiagnostic = {
			category: "lint/complexity/noExcessiveCognitiveComplexity",
			description: "complex",
			line: 100,
			sourceText: "function beta",
			measuredValue: 30,
		};
		const before = [alpha, beta];
		const after: LintDiagnostic[] = [
			{ ...beta, line: 10 },
			{ ...alpha, line: 100 },
		];

		expect(compareDiagnostics(before, after)).toEqual([]);
	});

	it("uses source text to distinguish repeated generic diagnostics", () => {
		const parse = (sourceCode: string) =>
			parseBiomeDiagnostics(
				JSON.stringify({
					diagnostics: [
						{
							category: "lint/style/noNestedTernary",
							message: "Do not nest ternary expressions.",
							location: {
								path: { file: "packages/core/src/example.ts" },
								sourceCode,
								span: [0, Buffer.byteLength(sourceCode)],
							},
						},
					],
				}),
			);

		expect(compareDiagnostics(parse("a ? b : c ? d : e"), parse("x ? y : z ? q : r"))).toHaveLength(
			1,
		);
	});

	it("extracts source identity from actual Biome start and end locations", () => {
		const parse = (sourceCode: string) =>
			parseBiomeDiagnostics(
				JSON.stringify({
					diagnostics: [
						{
							category: "lint/style/noNestedTernary",
							message: "Do not nest ternary expressions.",
							location: {
								path: "packages/core/src/example.ts",
								start: { line: 1, column: 1 },
								end: { line: 1, column: sourceCode.length + 1 },
							},
						},
					],
				}),
				sourceCode,
			);

		expect(compareDiagnostics(parse("a ? b : c ? d : e"), parse("x ? y : z ? q : r"))).toHaveLength(
			1,
		);
	});
});

describe("lint feedback scope and measurements", () => {
	it("matches measured diagnostics by location before comparing scores", () => {
		const diagnostic = (measuredValue: number, line: number) => ({
			category: "lint/complexity/noExcessiveCognitiveComplexity",
			description: `Excessive complexity of ${measuredValue}`,
			line,
			measuredValue,
		});

		expect(
			compareDiagnostics(
				[diagnostic(30, 10), diagnostic(20, 100)],
				[diagnostic(20, 10), diagnostic(29, 100)],
			),
		).toEqual([diagnostic(29, 100)]);
	});

	it("parses measured values from Biome advice", () => {
		const diagnostics = parseBiomeDiagnostics(
			JSON.stringify({
				diagnostics: [
					{
						category: "lint/complexity/noExcessiveLinesPerFunction",
						message: "This function is too long.",
						advices: [{ log: "This function has 63 lines. Maximum allowed is 50." }],
						location: {
							path: "packages/core/src/example.ts",
							start: { line: 1, column: 1 },
						},
					},
				],
			}),
		);

		expect(diagnostics[0]?.measuredValue).toBe(63);
	});

	it("prefers primary measurements and separates advice fragments", () => {
		const parse = (message: string, advice: string) =>
			parseBiomeDiagnostics(
				JSON.stringify({
					diagnostics: [
						{
							category: "lint/complexity/noExcessiveLinesPerFunction",
							message,
							advices: [{ log: advice }],
						},
					],
				}),
			)[0]?.measuredValue;

		expect(parse("This function has too many lines (63).", "Consider 2 lines.")).toBe(63);
		expect(parse("Rule version 2", "5 lines")).toBe(5);
	});

	it("tracks apply_patch move destinations", () => {
		expect(
			parseApplyPatchPaths(
				"*** Update File: packages/core/src/old.ts\n*** Move to: packages/core/src/new.ts",
			),
		).toEqual([
			{
				operation: "Update",
				path: "packages/core/src/old.ts",
				moveTo: "packages/core/src/new.ts",
			},
		]);
	});

	it("tracks moves entering the configured lint scope", () => {
		const patch = "*** Update File: scripts/example.ts\n*** Move to: packages/core/src/example.ts";

		expect(parseApplyPatchPaths(patch)).toEqual([
			{
				operation: "Update",
				path: "scripts/example.ts",
				moveTo: "packages/core/src/example.ts",
			},
		]);
		expect(getTouchedPaths("apply_patch", { patchText: patch }, repositoryRoot)).toEqual([
			"packages/core/src/example.ts",
		]);
	});

	it("admits only source paths represented by the mirrored Biome includes", async () => {
		const biome = JSON.parse(await readFile(path.join(repositoryRoot, "biome.json"), "utf8"));
		const sourceIncludes = biome.files.includes.filter(
			(include: string) => !include.endsWith(".json"),
		);

		expect(sourceIncludes).toEqual([
			"packages/**/src/**/*.ts",
			"packages/**/src/**/*.tsx",
			"packages/**/src/**/*.js",
			"packages/**/vite.config.ts",
			"plugins/claude/scripts/ingest-hook.mjs",
			"plugins/claude/scripts/user-prompt-hook.mjs",
			"plugins/codex/scripts/ingest-hook.mjs",
			"plugins/codex/scripts/user-prompt-hook.mjs",
			"vitest.config.ts",
		]);
		expect(resolveWorktreePath(repositoryRoot, "packages/core/src/example.ts")).toBe(
			"packages/core/src/example.ts",
		);
		expect(resolveWorktreePath(repositoryRoot, "scripts/example.ts")).toBeUndefined();
		expect(resolveWorktreePath(repositoryRoot, "e2e/bin/run-local.ts")).toBeUndefined();
	});
});
