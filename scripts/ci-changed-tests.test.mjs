import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { expandScripts, isUntraced, parseVitest, selectFiles } from "./ci-changed-tests.mjs";

describe("expandScripts", () => {
	it("expands nested same-package scripts into ordered commands", () => {
		// Arrange
		const scripts = {
			"test:ci": "pnpm exec vitest run --exclude a && pnpm run test:heavy",
			"test:heavy": "pnpm exec vitest run heavy.test.ts --maxWorkers=1",
			"test:release": "node --test release.test.mjs",
		};
		// Act
		const commands = expandScripts(["test:release", "test:ci"], scripts);
		// Assert
		assert.deepEqual(commands, [
			"node --test release.test.mjs",
			"pnpm exec vitest run --exclude a",
			"pnpm exec vitest run heavy.test.ts --maxWorkers=1",
		]);
	});

	it("rejects unknown scripts instead of silently skipping them", () => {
		assert.throws(() => expandScripts(["missing"], {}), /Unknown script: missing/u);
	});

	it("expands the real root and Worker test chains used by CI", () => {
		// Arrange
		const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).scripts;
		// Act
		const root = expandScripts(["test:ci"], read("../package.json"));
		const worker = expandScripts(
			["test:worker"],
			read("../packages/cloudflare-coordinator-worker/package.json"),
		);
		// Assert: both Core phases and both Worker Vitest stages stay selectable, and every
		// parsed filter is a test file (a misparsed flag value would silently become a filter).
		const vitest = [...root, ...worker].filter((command) =>
			command.startsWith("pnpm exec vitest run"),
		);
		assert.equal(vitest.length, 4);
		for (const command of vitest) {
			for (const filter of parseVitest(command).filters) assert.match(filter, /\.test\.ts$/u);
		}
	});
});

describe("parseVitest", () => {
	it("separates value flags, inline flags, and quoted file filters", () => {
		// Act
		const parsed = parseVitest(
			'pnpm exec vitest run --exclude "**/heavy.test.ts" --config vitest.node.config.ts a.test.ts --maxWorkers=1',
		);
		// Assert
		assert.deepEqual(parsed, {
			flags: [
				"--exclude",
				"**/heavy.test.ts",
				"--config",
				"vitest.node.config.ts",
				"--maxWorkers=1",
			],
			filters: ["a.test.ts"],
		});
	});
});

describe("isUntraced", () => {
	for (const [label, source] of [
		["process spawning", 'import { spawnSync } from "node:child_process";'],
		["computed dynamic imports", "const hook = await import(scriptUrl.href);"],
		["Vite query imports", 'import html from "../static/index.html?raw";'],
		["worker threads", 'new Worker(new URL("./worker.ts", import.meta.url));'],
		[
			"repository file reads",
			'import { readFileSync } from "node:fs";\nreadFileSync(new URL("../x.sql", import.meta.url));',
		],
	]) {
		it(`always runs files with ${label}`, () => {
			assert.equal(isUntraced(source), true);
		});
	}

	for (const [label, source] of [
		["literal dynamic imports", 'const mod = await import("./module.js");'],
		[
			"temporary-directory file access",
			'import { mkdtempSync } from "node:fs";\nmkdtempSync(tmp);',
		],
		["plain imports", 'import { add } from "./math.js";'],
	]) {
		it(`leaves ${label} to import tracing`, () => {
			assert.equal(isUntraced(source), false);
		});
	}
});

describe("selectFiles", () => {
	const all = ["/a.test.ts", "/b.test.ts", "/c.test.ts"];

	it("runs traced changes plus untraced files in suite order", () => {
		// Act
		const files = selectFiles({
			all,
			changed: new Set(["/c.test.ts"]),
			untraced: new Set(["/a.test.ts"]),
		});
		// Assert
		assert.deepEqual(files, ["/a.test.ts", "/c.test.ts"]);
	});

	it("runs the unchanged command when Vitest selects every file", () => {
		// Act: Vitest selects everything when a rerun trigger such as package.json changes.
		const files = selectFiles({ all, changed: new Set(all), untraced: new Set() });
		// Assert
		assert.equal(files, null);
	});

	it("ignores traced files outside the command's own suite", () => {
		// Act
		const files = selectFiles({ all, changed: new Set(["/other.test.ts"]), untraced: new Set() });
		// Assert: an empty selection skips the command.
		assert.deepEqual(files, []);
	});
});
