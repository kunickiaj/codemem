import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	compareBiomePolicy,
	compareChangedDiagnostics,
	parsePinnedBiomeReport,
} from "./biome-ratchet.js";
import {
	formatHumanResult,
	parseArguments,
	parseNameStatus,
	runRatchet,
} from "./biome-ratchet-cli.js";
import type { LintDiagnostic } from "./lint-diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function diagnostic(
	pathValue: string,
	line: number,
	measuredValue: number,
	sourceText: string,
): LintDiagnostic {
	return {
		category: "lint/complexity/noExcessiveCognitiveComplexity",
		description: `Excessive complexity of ${measuredValue}`,
		path: pathValue,
		line,
		measuredValue,
		sourceText,
	};
}

function config(options: { include?: string[]; level?: string; maxLines?: number } = {}): string {
	return JSON.stringify({
		files: { includes: options.include ?? ["src/**/*.ts"] },
		linter: {
			rules: {
				complexity: {
					noExcessiveLinesPerFunction: {
						level: options.level ?? "warn",
						options: { maxLines: options.maxLines ?? 5 },
					},
				},
			},
		},
	});
}

describe("Biome diagnostic comparison", () => {
	it("does not let improvement in one same-rule function hide worsening in another", () => {
		const before = [
			{ ...diagnostic("src/a.ts", 10, 30, "first"), scopeIdentity: ":function:first" },
			{ ...diagnostic("src/a.ts", 100, 20, "second"), scopeIdentity: ":function:second" },
		];
		const after = [
			{ ...diagnostic("src/a.ts", 100, 20, "first changed"), scopeIdentity: ":function:first" },
			{ ...diagnostic("src/a.ts", 10, 29, "second changed"), scopeIdentity: ":function:second" },
		];

		expect(
			compareChangedDiagnostics(before, after, [
				{ status: "modified", beforePath: "src/a.ts", afterPath: "src/a.ts" },
			]),
		).toEqual([after[1]]);
	});

	it("handles unchanged debt after line shifts and reports additions", () => {
		const unchanged = diagnostic("src/a.ts", 20, 18, "same function");
		const shifted = diagnostic("src/a.ts", 200, 18, "same function");
		const added = diagnostic("src/new.ts", 1, 16, "new function");

		expect(
			compareChangedDiagnostics(
				[unchanged],
				[shifted, added],
				[
					{ status: "modified", beforePath: "src/a.ts", afterPath: "src/a.ts" },
					{ status: "added", afterPath: "src/new.ts" },
				],
			),
		).toEqual([added]);
	});

	it("preserves an unambiguous measured diagnostic when its scope is renamed", () => {
		const before = {
			...diagnostic("src/a.ts", 10, 18, "function beforeName"),
			scopeIdentity: ":function:beforeName",
		};
		const after = {
			...diagnostic("src/a.ts", 10, 18, "function afterName"),
			scopeIdentity: ":function:afterName",
		};

		expect(
			compareChangedDiagnostics(
				[before],
				[after],
				[{ status: "modified", beforePath: "src/a.ts", afterPath: "src/a.ts" }],
			),
		).toEqual([]);
	});

	it("does not assign a preceding class to a later top-level diagnostic", () => {
		const report = JSON.stringify({
			summary: { errors: 0, warnings: 1, infos: 0, diagnosticsNotPrinted: 0 },
			diagnostics: [
				{
					category: "lint/style/useConst",
					description: "Use const instead",
					location: {
						path: "src/a.ts",
						start: { line: 4, column: 1 },
						end: { line: 4, column: 15 },
					},
				},
			],
		});
		const source = (className: string) => `class ${className} {\n\tmethod() {}\n}\nlet value = 1;`;
		const before = parsePinnedBiomeReport(report, () => source("Before"));
		const after = parsePinnedBiomeReport(report, () => source("After"));

		expect(before[0]?.scopeIdentity).toBe(":binding:value");
		expect(
			compareChangedDiagnostics(before, after, [
				{ status: "modified", beforePath: "src/a.ts", afterPath: "src/a.ts" },
			]),
		).toEqual([]);
	});

	it("maps renames and ignores diagnostics removed with deleted files", () => {
		const before = [
			diagnostic("src/old.ts", 4, 16, "same"),
			diagnostic("src/gone.ts", 1, 20, "gone"),
		];
		const renamed = diagnostic("src/new.ts", 40, 16, "same");

		expect(
			compareChangedDiagnostics(
				before,
				[renamed],
				[
					{ status: "renamed", beforePath: "src/old.ts", afterPath: "src/new.ts" },
					{ status: "deleted", beforePath: "src/gone.ts" },
				],
			),
		).toEqual([]);
	});

	it("fails closed when repeated measured scopes cannot be paired", () => {
		const before = [
			{ ...diagnostic("src/a.ts", 10, 30, "same body"), scopeIdentity: ":binding:handler" },
			{ ...diagnostic("src/a.ts", 30, 20, "same body"), scopeIdentity: ":binding:handler" },
		];
		const after = [
			{ ...diagnostic("src/a.ts", 10, 20, "same body"), scopeIdentity: ":binding:handler" },
			{ ...diagnostic("src/a.ts", 30, 29, "same body"), scopeIdentity: ":binding:handler" },
		];

		expect(() =>
			compareChangedDiagnostics(before, after, [
				{ status: "modified", beforePath: "src/a.ts", afterPath: "src/a.ts" },
			]),
		).toThrow("Ambiguous");
	});
});

describe("pinned Biome report schema", () => {
	it("accepts the actual reporter output from the pinned binary", () => {
		const entrypoint = createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
		const result = spawnSync(
			process.execPath,
			[entrypoint, "lint", "--reporter=json", "packages/opencode-plugin/src/lint-diagnostics.ts"],
			{ cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8" },
		);

		expect([0, 1]).toContain(result.status);
		expect(() => parsePinnedBiomeReport(result.stdout)).not.toThrow();
	});

	it("derives function identity from the diagnostic source path", () => {
		const output = JSON.stringify({
			summary: { errors: 0, warnings: 1, infos: 0, diagnosticsNotPrinted: 0 },
			diagnostics: [
				{
					category: "lint/complexity/noExcessiveCognitiveComplexity",
					message: "Excessive complexity of 16",
					location: {
						path: "src/a.ts",
						start: { line: 2, column: 1 },
						end: { line: 4, column: 2 },
					},
				},
			],
		});
		const diagnostics = parsePinnedBiomeReport(
			output,
			() => "const before = 1;\nfunction calculate() {\n  return before;\n}\n",
		);

		expect(diagnostics[0]?.scopeIdentity).toBe(":function:calculate");
	});

	it("rejects malformed, truncated, and incomplete reports", () => {
		expect(() => parsePinnedBiomeReport("{")).toThrow();
		expect(() => parsePinnedBiomeReport(JSON.stringify({ diagnostics: [] }))).toThrow(
			"pinned reporter schema",
		);
		expect(() =>
			parsePinnedBiomeReport(
				JSON.stringify({
					summary: { errors: 0, warnings: 1, infos: 0, diagnosticsNotPrinted: 1 },
					diagnostics: [],
				}),
			),
		).toThrow("omitted diagnostics");
		expect(() =>
			parsePinnedBiomeReport(
				JSON.stringify({
					summary: { errors: 1, warnings: 0, infos: 0, diagnosticsNotPrinted: 0 },
					diagnostics: [{ category: "parse", message: "syntax error" }],
				}),
			),
		).toThrow("non-lint diagnostic");
		expect(() =>
			parsePinnedBiomeReport(
				JSON.stringify({
					summary: { errors: 0, warnings: 1, infos: 0, diagnosticsNotPrinted: 0 },
					diagnostics: [
						{
							category: "lint/complexity/noExcessiveCognitiveComplexity",
							message: "Complexity unavailable",
							location: { path: "src/a.ts", start: { line: 1, column: 1 } },
						},
					],
				}),
			),
		).toThrow("no measured value");
	});
});

describe("Biome policy comparison", () => {
	it("fails coverage, severity, threshold, and suppression weakening", () => {
		const violations = compareBiomePolicy(
			config(),
			config({ include: ["!src/generated.ts"], level: "info", maxLines: 10 }),
			[
				{
					status: "modified",
					beforePath: "src/a.ts",
					afterPath: "src/a.ts",
					beforeSource: "const value = 1;",
					afterSource: "// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;",
				},
			],
		);

		expect(violations.map((violation) => violation.kind)).toEqual([
			"coverage",
			"coverage",
			"rule-level",
			"suppression",
		]);
	});

	it("rejects a new explicit rule disable that could override a preset", () => {
		const baseConfig = JSON.stringify({
			linter: { enabled: true, rules: { preset: "recommended" } },
		});
		const headConfig = JSON.stringify({
			linter: {
				enabled: true,
				rules: { preset: "recommended", correctness: { noUnusedVariables: "off" } },
			},
		});

		expect(compareBiomePolicy(baseConfig, headConfig, [])).toContainEqual({
			kind: "rule-level",
			message: "Biome rule explicitly disabled: correctness.noUnusedVariables",
		});
	});

	it("rejects newly weakened severities for recommended preset rules", () => {
		const baseConfig = JSON.stringify({
			linter: { enabled: true, rules: { preset: "recommended" } },
		});

		for (const level of ["warn", "info"]) {
			const headConfig = JSON.stringify({
				linter: {
					enabled: true,
					rules: { preset: "recommended", correctness: { noUnusedVariables: level } },
				},
			});
			expect(compareBiomePolicy(baseConfig, headConfig, [])).toContainEqual({
				kind: "rule-level",
				message: "Biome preset rule weakened: correctness.noUnusedVariables",
			});
		}
	});

	it("rejects newly weakened severities for all preset rules", () => {
		const baseConfig = JSON.stringify({ linter: { rules: { preset: "all" } } });
		const headConfig = JSON.stringify({
			linter: { rules: { preset: "all", correctness: { noUnusedVariables: "warn" } } },
		});

		expect(compareBiomePolicy(baseConfig, headConfig, [])).toContainEqual({
			kind: "rule-level",
			message: "Biome preset rule weakened: correctness.noUnusedVariables",
		});
	});

	it("requires review for options added to an implicitly enabled preset rule", () => {
		const baseConfig = JSON.stringify({ linter: { rules: { preset: "all" } } });
		const headConfig = JSON.stringify({
			linter: {
				rules: {
					preset: "all",
					complexity: {
						noExcessiveLinesPerFunction: {
							level: "error",
							options: { maxLines: 1_000 },
						},
					},
				},
			},
		});

		expect(compareBiomePolicy(baseConfig, headConfig, [])).toContainEqual({
			kind: "rule-level",
			message:
				"Biome rule options changed; explicit policy review required: complexity.noExcessiveLinesPerFunction",
		});
	});

	it("rejects narrowing default coverage with explicit includes", () => {
		expect(
			compareBiomePolicy("{}", JSON.stringify({ files: { includes: ["src/**"] } }), []),
		).toContainEqual({
			kind: "coverage",
			message: "Biome includes added to default coverage; explicit coverage review required",
		});
	});

	it("allows removal of an explicitly disabled rule", () => {
		const baseConfig = JSON.stringify({
			linter: { rules: { preset: "recommended", correctness: { noUnusedVariables: "off" } } },
		});
		const headConfig = JSON.stringify({ linter: { rules: { preset: "recommended" } } });

		expect(compareBiomePolicy(baseConfig, headConfig, [])).toEqual([]);
	});

	it("detects changed suppression identities even when the count is unchanged", () => {
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					beforePath: "src/a.ts",
					afterPath: "src/a.ts",
					beforeSource: "// biome-ignore lint/a\nconst value = 1;",
					afterSource: "// biome-ignore lint/a lint/b\nconst value = 1;",
				},
			]),
		).toMatchObject([{ kind: "suppression" }]);
	});

	it("detects suppression directives moved between identical function bodies", () => {
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					beforePath: "src/a.ts",
					afterPath: "src/a.ts",
					beforeSource:
						"function first() {\n// biome-ignore lint/a\nreturn value;\n}\nfunction second() {\nreturn value;\n}",
					afterSource:
						"function first() {\nreturn value;\n}\nfunction second() {\n// biome-ignore lint/a\nreturn value;\n}",
				},
			]),
		).toMatchObject([{ kind: "suppression" }]);
	});

	it("reports threshold weakening when the rule level stays fixed", () => {
		expect(compareBiomePolicy(config(), config({ maxLines: 10 }), [])).toMatchObject([
			{ kind: "threshold" },
		]);
	});

	it("does not treat suppression text inside a string as a directive", () => {
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					beforePath: "src/a.ts",
					afterPath: "src/a.ts",
					beforeSource: "",
					afterSource: 'const example = "// biome-ignore lint/suspicious/noExplicitAny";',
				},
			]),
		).toEqual([]);
	});

	it("ignores suppression-like examples outside Biome lint coverage", () => {
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					beforePath: "docs/example.md",
					afterPath: "docs/example.md",
					beforeSource: "Example:\n",
					afterSource:
						"Example:\n  // biome-ignore lint/suspicious/noExplicitAny\n  const value: any = 1;",
				},
			]),
		).toEqual([]);
	});

	it("applies ordered file and linter include exceptions to suppression checks", () => {
		const coverageConfig = JSON.stringify({
			files: { includes: ["**", "!docs", "docs/linted.ts"] },
			linter: { includes: ["**/*.ts", "!**/*.generated.ts"] },
		});
		const change = (pathValue: string) => ({
			status: "modified" as const,
			beforePath: pathValue,
			afterPath: pathValue,
			beforeSource: "",
			afterSource: "// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;",
		});

		expect(compareBiomePolicy(coverageConfig, coverageConfig, [change("src/a.ts")])).toMatchObject([
			{ kind: "suppression", path: "src/a.ts" },
		]);
		expect(
			compareBiomePolicy(coverageConfig, coverageConfig, [change("src/a.generated.ts")]),
		).toEqual([]);
		expect(compareBiomePolicy(coverageConfig, coverageConfig, [change("docs/example.md")])).toEqual(
			[],
		);
	});

	it("treats regex metacharacters in include patterns as literal path characters", () => {
		const coverageConfig = JSON.stringify({
			files: { includes: ["src/(legacy)+.ts"] },
		});
		const source = "// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;";

		expect(
			compareBiomePolicy(coverageConfig, coverageConfig, [
				{
					status: "modified",
					beforePath: "src/(legacy)+.ts",
					afterPath: "src/(legacy)+.ts",
					beforeSource: "",
					afterSource: source,
				},
			]),
		).toContainEqual({
			kind: "suppression",
			message: "1 Biome suppression directive added or changed",
			path: "src/(legacy)+.ts",
		});
	});
});

describe("Biome policy bypass prevention", () => {
	it("treats an absent base linter as enabled by default", () => {
		expect(
			compareBiomePolicy("{}", JSON.stringify({ linter: { enabled: false } }), []),
		).toContainEqual({ kind: "rule-level", message: "Biome linter disabled" });
	});

	it("ignores template text but detects suppressions inside template expressions", () => {
		const templateText = "const example = `// biome-ignore lint/suspicious/noExplicitAny`;";
		const templateExpression = [
			"const example = `$",
			"{(() => {\n// biome-ignore lint/suspicious/noExplicitAny",
			"\nconst value: any = 1;\nreturn value;\n})()}`;",
		].join("");

		expect(
			compareBiomePolicy(config(), config(), [{ status: "modified", afterSource: templateText }]),
		).toEqual([]);
		expect(
			compareBiomePolicy(config(), config(), [
				{ status: "modified", afterPath: "src/a.ts", afterSource: templateExpression },
			]),
		).toContainEqual({
			kind: "suppression",
			message: "1 Biome suppression directive added or changed",
			path: "src/a.ts",
		});
	});

	it("detects suppressions after regex literals containing quotes", () => {
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					afterPath: "src/a.ts",
					afterSource:
						'const quote = /"/;\n// biome-ignore lint/suspicious/noExplicitAny\nconst value: any = 1;',
				},
			]),
		).toContainEqual({
			kind: "suppression",
			message: "1 Biome suppression directive added or changed",
			path: "src/a.ts",
		});
	});

	it("detects suppressions after regex literals used as control-flow bodies", () => {
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					afterPath: "src/a.ts",
					afterSource:
						'if (ready(")")) /"/.test(value);\n// biome-ignore lint/suspicious/noExplicitAny\nconst hidden: any = value;',
				},
			]),
		).toContainEqual({
			kind: "suppression",
			message: "1 Biome suppression directive added or changed",
			path: "src/a.ts",
		});
	});

	it("rejects edits covered by existing broad suppressions", () => {
		const fileWide = "// biome-ignore-all lint/a: legacy\nconst first = 1;";
		const range = [
			"const outside = 1;",
			"// biome-ignore-start lint/a: legacy",
			"const hidden = 1;",
			"// biome-ignore-end lint/a: legacy",
		].join("\n");

		for (const [beforeSource, afterSource] of [
			[fileWide, `${fileWide}\nconst hidden = 2;`],
			[range, range.replace("const hidden = 1;", "const hidden = 2;")],
		]) {
			expect(
				compareBiomePolicy(config(), config(), [
					{ status: "modified", afterPath: "src/a.ts", beforeSource, afterSource },
				]),
			).toContainEqual({
				kind: "suppression",
				message: "Code changed under an existing broad Biome suppression",
				path: "src/a.ts",
			});
		}

		const outsideOnly = range
			.replace("const outside = 1;", "const outside = 2;")
			.concat("\nconst after = 1;");
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					afterPath: "src/a.ts",
					beforeSource: range,
					afterSource: outsideOnly,
				},
			]),
		).not.toContainEqual({
			kind: "suppression",
			message: "Code changed under an existing broad Biome suppression",
			path: "src/a.ts",
		});
	});

	it("rejects edits inside a node with an existing ordinary suppression", () => {
		const beforeSource = [
			"// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: legacy",
			"function calculate(value: number) {",
			"\tif (value > 0) return value;",
			"\treturn 0;",
			"}",
			"const outside = 1;",
		].join("\n");
		const insideEdit = beforeSource.replace(
			"\treturn 0;",
			"\tif (value < 0) return -value;\n\treturn 0;",
		);
		const outsideEdit = beforeSource.replace("const outside = 1;", "const outside = 2;");

		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					afterPath: "src/a.ts",
					beforeSource,
					afterSource: insideEdit,
				},
			]),
		).toContainEqual({
			kind: "suppression",
			message: "Code changed under an existing Biome suppression",
			path: "src/a.ts",
		});
		expect(
			compareBiomePolicy(config(), config(), [
				{
					status: "modified",
					afterPath: "src/a.ts",
					beforeSource,
					afterSource: outsideEdit,
				},
			]),
		).not.toContainEqual({
			kind: "suppression",
			message: "Code changed under an existing Biome suppression",
			path: "src/a.ts",
		});
	});

	it("limits an ordinary JSX suppression to the annotated element", () => {
		const beforeSource = [
			"const view = <>",
			"\t{/* biome-ignore lint/a: legacy */}",
			'\t<div tabIndex="0">legacy</div>',
			"\t<span>outside</span>",
			"</>;",
		].join("\n");
		const insideEdit = beforeSource.replace("legacy</div>", "changed</div>");
		const siblingEdit = beforeSource.replace("outside</span>", "changed</span>");

		for (const [afterSource, expected] of [
			[insideEdit, true],
			[siblingEdit, false],
		] as const) {
			const jsxConfig = config({ include: ["src/**/*.ts", "src/**/*.tsx"] });
			const violations = compareBiomePolicy(jsxConfig, jsxConfig, [
				{ status: "modified", afterPath: "src/a.tsx", beforeSource, afterSource },
			]);
			expect(
				violations.some(
					(violation) => violation.message === "Code changed under an existing Biome suppression",
				),
			).toBe(expected);
		}
	});

	it("requires review for changed language-level lint controls", () => {
		const baseConfig = JSON.stringify({ javascript: { formatter: { quoteStyle: "double" } } });
		const headConfig = JSON.stringify({
			javascript: { formatter: { quoteStyle: "single" }, globals: ["hiddenGlobal"] },
		});

		expect(compareBiomePolicy(baseConfig, headConfig, [])).toContainEqual({
			kind: "coverage",
			message: "Biome language or top-level controls changed; explicit policy review required",
		});
	});

	it("requires review when an inherited Biome policy file changes", () => {
		const configWithExtends = JSON.stringify({ extends: ["./config/biome-base.jsonc"] });
		const inheritedChange = {
			status: "modified" as const,
			beforePath: "config/biome-base.jsonc",
			afterPath: "config/biome-base.jsonc",
			beforeSource: '{ "linter": { "rules": { "preset": "recommended" } } }',
			afterSource: '{ "linter": { "rules": { "preset": "none" } } }',
		};

		expect(
			compareBiomePolicy(configWithExtends, configWithExtends, [inheritedChange]),
		).toContainEqual({
			kind: "coverage",
			message: "Inherited Biome policy changed; explicit policy review required",
			path: "config/biome-base.jsonc",
		});
	});

	it("requires review for language-only changes behind transitive inheritance", () => {
		const configWithExtends = JSON.stringify({ extends: ["./config/biome-base.jsonc"] });

		expect(
			compareBiomePolicy(configWithExtends, configWithExtends, [
				{
					status: "modified",
					beforePath: "config/globals.json",
					afterPath: "config/globals.json",
					beforeSource: '{ "javascript": { "globals": [] } }',
					afterSource: '{ "javascript": { "globals": ["hiddenGlobal"] } }',
				},
			]),
		).toContainEqual({
			kind: "coverage",
			message: "Inherited Biome policy changed; explicit policy review required",
			path: "config/globals.json",
		});
	});
});

describe("Biome policy fail-closed controls", () => {
	it("fails closed when lint overrides change or linting is disabled", () => {
		const base = JSON.parse(config());
		const overridden = {
			...base,
			overrides: [{ includes: ["src/**"], linter: { enabled: false } }],
		};
		const disabled = { ...base, linter: { ...base.linter, enabled: false } };

		expect(compareBiomePolicy(JSON.stringify(base), JSON.stringify(overridden), [])).toMatchObject([
			{ kind: "rule-level" },
		]);
		expect(compareBiomePolicy(JSON.stringify(base), JSON.stringify(disabled), [])).toMatchObject([
			{ kind: "rule-level", message: "Biome linter disabled" },
		]);
	});

	it("fails closed when language controls change inside an override", () => {
		const base = JSON.parse(config());
		const head = {
			...base,
			overrides: [{ includes: ["src/**"], javascript: { globals: ["hiddenGlobal"] } }],
		};

		expect(compareBiomePolicy(JSON.stringify(base), JSON.stringify(head), [])).toContainEqual({
			kind: "rule-level",
			message: "Biome lint overrides changed; explicit policy review required",
		});
	});

	it("requires explicit coverage review for changed ignore policy", () => {
		for (const ignorePath of [".gitignore", ".ignore"]) {
			expect(
				compareBiomePolicy(config(), config(), [
					{
						status: "modified",
						beforePath: ignorePath,
						afterPath: ignorePath,
						beforeSource: "dist/\n",
						afterSource: "dist/\nsrc/generated/\n",
					},
				]),
			).toMatchObject([{ kind: "coverage", path: ignorePath }]);
		}
	});

	it("fails closed when other Biome coverage controls change", () => {
		const base = JSON.parse(config());
		for (const head of [
			{ ...base, vcs: { enabled: false, useIgnoreFile: false } },
			{ ...base, files: { ...base.files, maxSize: 1 } },
			{ ...base, linter: { ...base.linter, includes: ["src/a.ts"] } },
		]) {
			expect(compareBiomePolicy(JSON.stringify(base), JSON.stringify(head), [])).not.toEqual([]);
		}
		const noPreset = structuredClone(base);
		noPreset.linter.rules.preset = "none";
		expect(compareBiomePolicy(JSON.stringify(base), JSON.stringify(noPreset), [])).toMatchObject([
			{ kind: "rule-level" },
		]);
		const nestedPreset = structuredClone(base);
		nestedPreset.linter.rules.complexity.preset = "none";
		expect(
			compareBiomePolicy(JSON.stringify(base), JSON.stringify(nestedPreset), []),
		).toMatchObject([{ kind: "rule-level" }]);
	});
});

describe("Biome ratchet CLI", () => {
	it("requires an explicit base and parses committed or working-tree mode", () => {
		expect(() => parseArguments([])).toThrow("--base is required");
		expect(parseArguments(["--", "--base", "main", "--json"])).toEqual({
			base: "main",
			json: true,
		});
		expect(parseArguments(["--base", "main", "--head", "HEAD"])).toEqual({
			base: "main",
			head: "HEAD",
			json: false,
		});
	});

	it("parses rename, addition, modification, and deletion status", () => {
		expect(parseNameStatus("R100\0old.ts\0new.ts\0A\0add.ts\0M\0same.ts\0D\0gone.ts\0")).toEqual([
			{ status: "renamed", beforePath: "old.ts", afterPath: "new.ts" },
			{ status: "added", afterPath: "add.ts" },
			{ status: "modified", beforePath: "same.ts", afterPath: "same.ts" },
			{ status: "deleted", beforePath: "gone.ts" },
		]);
	});

	it("caps human output without dropping JSON regressions", () => {
		const regressions = Array.from({ length: 12 }, (_, index) =>
			diagnostic("src/a.ts", index + 1, 16, `function ${index}`),
		);
		const result = {
			mode: "refs" as const,
			base: "a".repeat(40),
			head: "b".repeat(40),
			changedFiles: 1,
			regressions,
			policyViolations: [],
			baseDiagnosticCount: 0,
			headDiagnosticCount: 12,
		};

		expect(formatHumanResult(result)).toContain("…and 2 more regressions");
		expect(JSON.parse(JSON.stringify(result)).regressions).toHaveLength(12);
	});

	it("includes an untracked maintained file and fails closed on missing refs or tool failure", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "codemem-biome-ratchet-test-"));
		temporaryDirectories.push(root);
		mkdirSync(path.join(root, "src"));
		writeFileSync(path.join(root, "biome.json"), config());
		writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
		writeFileSync(path.join(root, "src/base.ts"), "export const base = 1;\n");
		execFileSync("git", ["init", "-q"], { cwd: root });
		execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: root });
		execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
		execFileSync("git", ["add", "biome.json", ".gitignore", "src/base.ts"], { cwd: root });
		execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
		writeFileSync(
			path.join(root, "src/untracked.ts"),
			"export function untracked() {\n  let value = 0;\n  value += 1;\n  value += 2;\n  value += 3;\n  value += 4;\n  value += 5;\n  return value;\n}\n",
		);
		const indexBefore = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
			cwd: root,
			encoding: "utf8",
		});

		const result = await runRatchet(
			{ base: "HEAD", json: true },
			{
				cwd: root,
				afterSnapshot: () => {
					writeFileSync(path.join(root, "src/late.ts"), "const late: any = 1;\n");
				},
			},
		);
		expect(result.changedFiles).toBe(1);
		expect(result.regressions).toHaveLength(1);
		expect(result.regressions[0]?.path).toBe("src/untracked.ts");
		expect(result.regressions.some((item) => item.path === "src/late.ts")).toBe(false);
		expect(
			execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
				cwd: root,
				encoding: "utf8",
			}),
		).toBe(indexBefore);
		await expect(runRatchet({ base: "missing", json: true }, { cwd: root })).rejects.toThrow();
		await expect(
			runRatchet(
				{ base: "HEAD", json: true },
				{ cwd: root, biomeEntrypoint: path.join(root, "missing-biome.js") },
			),
		).rejects.toThrow();
		expect(readFileSync(path.join(root, "src/untracked.ts"), "utf8")).toContain("untracked");
	});

	it("keeps the shared CLI and diagnostic modules free of OpenCode SDK imports", () => {
		for (const file of ["biome-ratchet.ts", "biome-ratchet-cli.ts", "lint-diagnostics.ts"]) {
			expect(readFileSync(path.join(import.meta.dirname, file), "utf8")).not.toContain("@opencode");
		}
	});
});
