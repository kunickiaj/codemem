import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	compareDiagnostics,
	createLintFeedbackController,
	createWorktreeLintFeedbackController,
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
		expect(getTouchedPaths("patch", { patchText: patch }, repositoryRoot)).toEqual([
			"packages/core/src/example.ts",
		]);
	});
});

describe("lint feedback lifecycle", () => {
	it("keeps concurrent call snapshots isolated", async () => {
		const diagnostics = new Map<string, LintDiagnostic[]>();
		const controller = createLintFeedbackController({
			worktree: repositoryRoot,
			command: ["unused"],
			timeoutMs: 1,
			fileExists: async () => true,
			runDiagnostics: async (relativePath) => diagnostics.get(relativePath) ?? [],
		});
		const first = {
			tool: "edit",
			sessionID: "session-a",
			callID: "call-a",
			args: { path: "packages/core/src/a.ts" },
		};
		const second = {
			...first,
			callID: "call-b",
			args: { path: "packages/core/src/b.ts" },
		};
		await Promise.all([controller.before(first), controller.before(second)]);
		diagnostics.set("packages/core/src/a.ts", [
			{ category: "lint/a", description: "first regression", line: 1 },
		]);
		diagnostics.set("packages/core/src/b.ts", [
			{ category: "lint/b", description: "second regression", line: 2 },
		]);

		expect(await controller.after(second)).toContain("second regression");
		expect(await controller.after(first)).toContain("first regression");
	});

	it("preserves edits and warns once per session after timeout", async () => {
		const worktree = await mkdtemp(path.join(tmpdir(), "codemem-lint-feedback-"));
		const relativePath = "packages/core/src/example.ts";
		await mkdir(path.join(worktree, path.dirname(relativePath)), { recursive: true });
		await writeFile(path.join(worktree, relativePath), "export const value = 1;\n", "utf8");
		const controller = createWorktreeLintFeedbackController(worktree, {
			command: [process.execPath, "-e", "setTimeout(() => {}, 1000)"],
			timeoutMs: 20,
		});
		expect(controller).toBeDefined();
		const invocation = {
			tool: "write",
			sessionID: "session-a",
			callID: "call-a",
			args: { path: relativePath },
		};

		await controller?.before(invocation);
		expect(await controller?.after(invocation)).toContain("edit was preserved");
		await controller?.before({ ...invocation, callID: "call-b" });
		expect(await controller?.after({ ...invocation, callID: "call-b" })).toBeUndefined();
		await controller?.dispose();
		await rm(worktree, { recursive: true, force: true });
	});

	it("makes in-flight capture inert after disposal", async () => {
		const entered = Promise.withResolvers<void>();
		let release: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const runDiagnostics = vi.fn(async () => []);
		const controller = createLintFeedbackController({
			worktree: repositoryRoot,
			command: ["unused"],
			timeoutMs: 1,
			fileExists: async () => {
				entered.resolve();
				await blocked;
				return true;
			},
			runDiagnostics,
		});
		const invocation = {
			tool: "edit",
			sessionID: "session-a",
			callID: "call-a",
			args: { path: "packages/core/src/a.ts" },
		};
		const capture = controller.before(invocation);
		await entered.promise;
		await controller.dispose();
		release?.();
		await capture;

		expect(runDiagnostics).not.toHaveBeenCalled();
		expect(await controller.after(invocation)).toBeUndefined();
	});
});

describe("lint feedback subprocess ownership", () => {
	it("disposes only subprocesses owned by one controller", async () => {
		const worktrees = await Promise.all([
			mkdtemp(path.join(tmpdir(), "codemem-lint-owner-a-")),
			mkdtemp(path.join(tmpdir(), "codemem-lint-owner-b-")),
		]);
		const relativePath = "packages/core/src/example.ts";
		const markers = worktrees.map((worktree) => path.join(worktree, "started"));
		const report = JSON.stringify({
			summary: { errors: 0, warnings: 0, infos: 0, diagnosticsNotPrinted: 0 },
			diagnostics: [],
		});
		const script =
			'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"started");' +
			`setTimeout(()=>console.log(${JSON.stringify(report)}),200);`;
		try {
			await Promise.all(
				worktrees.map(async (worktree) => {
					await mkdir(path.join(worktree, path.dirname(relativePath)), { recursive: true });
					await writeFile(path.join(worktree, relativePath), "export const value = 1;\n", "utf8");
				}),
			);
			const controllers = worktrees.map((worktree, index) =>
				createWorktreeLintFeedbackController(worktree, {
					command: [process.execPath, "-e", script, markers[index] ?? ""],
					timeoutMs: 2_000,
				}),
			);
			const invocation = {
				tool: "edit",
				sessionID: "session-a",
				callID: "call-a",
				args: { path: relativePath },
			};
			const captures = controllers.map((controller) => controller?.before(invocation));
			await Promise.all(
				markers.map(async (marker) => {
					for (let attempt = 0; attempt < 100; attempt += 1) {
						if (await readFile(marker, "utf8").catch(() => undefined)) return;
						await new Promise((resolve) => setTimeout(resolve, 10));
					}
					throw new Error(`Lint subprocess did not start: ${path.basename(marker)}`);
				}),
			);
			await controllers[0]?.dispose();
			await Promise.all(captures);

			expect(await controllers[1]?.after(invocation)).toBeUndefined();
			await controllers[1]?.dispose();
		} finally {
			await Promise.all(
				worktrees.map((worktree) => rm(worktree, { recursive: true, force: true })),
			);
		}
	});
});

describe("lint feedback configured paths", () => {
	it("admits only source paths represented by the mirrored Biome includes", async () => {
		const biome = JSON.parse(await readFile(path.join(repositoryRoot, "biome.json"), "utf8"));
		const sourceIncludes = biome.files.includes.filter(
			(include: string) => !include.endsWith(".json"),
		);

		expect(sourceIncludes).toEqual([
			"packages/**/src/**/*.ts",
			"packages/**/src/**/*.tsx",
			"packages/**/src/**/*.js",
			"packages/opencode-plugin/.opencode/lib/**/*.js",
			"packages/opencode-plugin/.opencode/plugins/**/*.js",
			".opencode/plugins/**/*.js",
			"packages/**/vite.config.ts",
			"packages/ui/playwright*.config.ts",
			"packages/ui/visual/**/*.ts",
			"packages/ui/scripts/visual-*.mjs",
			"plugins/claude/scripts/ingest-hook.mjs",
			"plugins/claude/scripts/user-prompt-hook.mjs",
			"plugins/codex/scripts/ingest-hook.mjs",
			"plugins/codex/scripts/user-prompt-hook.mjs",
			"scripts/ci-workflow.test.mjs",
			"vitest.config.ts",
		]);
		for (const include of sourceIncludes.filter((candidate: string) => !candidate.includes("*"))) {
			expect(resolveWorktreePath(repositoryRoot, include)).toBe(include);
		}
		expect(resolveWorktreePath(repositoryRoot, "packages/core/src/example.ts")).toBe(
			"packages/core/src/example.ts",
		);
		expect(
			resolveWorktreePath(repositoryRoot, "packages/opencode-plugin/.opencode/lib/runtime.js"),
		).toBe("packages/opencode-plugin/.opencode/lib/runtime.js");
		expect(
			resolveWorktreePath(repositoryRoot, "packages/opencode-plugin/.opencode/plugins/codemem.js"),
		).toBe("packages/opencode-plugin/.opencode/plugins/codemem.js");
		expect(resolveWorktreePath(repositoryRoot, ".opencode/plugins/codemem.js")).toBe(
			".opencode/plugins/codemem.js",
		);
		expect(
			getTouchedPaths(
				"edit",
				{ path: "packages/opencode-plugin/.opencode/lib/runtime.js" },
				repositoryRoot,
			),
		).toEqual(["packages/opencode-plugin/.opencode/lib/runtime.js"]);
		expect(resolveWorktreePath(repositoryRoot, "scripts/example.ts")).toBeUndefined();
		expect(resolveWorktreePath(repositoryRoot, "scripts/ci-workflow.test.mjs")).toBe(
			"scripts/ci-workflow.test.mjs",
		);
		expect(resolveWorktreePath(repositoryRoot, "e2e/bin/run-local.ts")).toBeUndefined();
	});

	it.each([
		"packages/ui/playwright.config.ts",
		"packages/ui/playwright.visual.config.ts",
		"packages/ui/visual/tooltip.spec.ts",
		"packages/ui/visual/fixtures/feed.ts",
		"packages/ui/scripts/visual-compare.mjs",
	])("admits configured UI visual source path %s", (candidate) => {
		expect(resolveWorktreePath(repositoryRoot, candidate)).toBe(candidate);
	});

	it.each([
		"packages/core/playwright.config.ts",
		"packages/ui/playwright/nested.config.ts",
		"packages/ui/playwright.config.tsx",
		"packages/ui/playwright.config.json",
		"packages/ui/not-playwright.config.ts",
		"packages/core/visual/tooltip.spec.ts",
		"packages/ui/visuals/tooltip.spec.ts",
		"packages/ui/visual/tooltip.spec.tsx",
		"packages/ui/visual/fixtures/feed.json",
		"packages/ui/visual/snapshots/tooltip.png",
		"packages/core/scripts/visual-compare.mjs",
		"packages/ui/scripts/visual-helpers/compare.mjs",
		"packages/ui/scripts/visual-compare.ts",
		"packages/ui/scripts/compare.mjs",
		"packages/ui/visual/../other.ts",
		"packages/ui/scripts/visual-../other.mjs",
		"../packages/ui/visual/tooltip.spec.ts",
	])("rejects nearby, non-source, or escaping UI visual path %s", (candidate) => {
		expect(resolveWorktreePath(repositoryRoot, candidate)).toBeUndefined();
	});

	it("rejects removed CI helper paths", () => {
		const removedPaths = [
			".github/scripts/ci-classify.mjs",
			".github/scripts/ci-classify.test.mjs",
			".github/scripts/ci-gate.mjs",
			".github/scripts/ci-gate.test.mjs",
			"scripts/ci-stack-topology.mjs",
			"scripts/ci-stack-topology.test.mjs",
		];

		expect(removedPaths.map((candidate) => resolveWorktreePath(repositoryRoot, candidate))).toEqual(
			removedPaths.map(() => undefined),
		);
	});
});
