import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRootBiomeEntrypoint } from "./biome-ratchet-cli.js";

const root = path.resolve(import.meta.dirname, "../../..");
const temporaryDirectories: string[] = [];

function readRepositoryConfig() {
	return JSON.parse(readFileSync(path.join(root, "biome.json"), "utf8"));
}

function createFixture(secondModule: string): string {
	const directory = mkdtempSync(path.join(tmpdir(), "codemem-import-cycles-"));
	temporaryDirectories.push(directory);
	const config = readRepositoryConfig();
	// Only VCS discovery differs: the maintained includes and lint policy remain intact.
	writeFileSync(
		path.join(directory, "biome.json"),
		JSON.stringify({ ...config, vcs: { ...config.vcs, enabled: false } }),
	);
	const sourceDirectory = path.join(directory, "packages/fixture/src");
	mkdirSync(sourceDirectory, { recursive: true });
	writeFileSync(
		path.join(sourceDirectory, "a.ts"),
		'import { b } from "./b";\nexport function a(): number { return b(); }\n',
	);
	writeFileSync(path.join(sourceDirectory, "b.ts"), secondModule);
	return directory;
}

function lintImportCycles(directory: string) {
	return spawnSync(
		process.execPath,
		[
			resolveRootBiomeEntrypoint(root),
			"lint",
			"--only=suspicious/noImportCycles",
			"--reporter=json",
			"packages/fixture/src",
		],
		{ cwd: directory, encoding: "utf8", timeout: 10_000 },
	);
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("maintained source import cycle policy", () => {
	it("enables noImportCycles as an error in the repository config", () => {
		const config = readRepositoryConfig();

		const level = config.linter.rules.suspicious.noImportCycles;

		expect(level).toBe("error");
	});

	it("fails for a cycle under the maintained source includes", () => {
		const directory = createFixture(
			'import { a } from "./a";\nexport function b(): number { return a(); }\n',
		);

		const result = lintImportCycles(directory);

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(1);
		const report = JSON.parse(result.stdout);
		expect(report.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					category: "lint/suspicious/noImportCycles",
					severity: "error",
				}),
			]),
		);
	});

	it("passes for acyclic imports under the same maintained source includes", () => {
		const directory = createFixture("export function b(): number { return 1; }\n");

		const result = lintImportCycles(directory);

		expect(result.error).toBeUndefined();
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout);
		expect(report.summary.errors).toBe(0);
		expect(report.diagnostics).toEqual([]);
	});
});
