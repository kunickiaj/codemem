import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	expandScripts,
	isUntraced,
	main,
	parseMaxShare,
	parseVitest,
	selectFiles,
	shardArgs,
	shareSkipReason,
	supportImports,
} from "./ci-changed-tests.mjs";
import { TEST_CONFIG_TRIGGERS } from "./test-rerun-triggers.mjs";

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
		[
			"repository reads through vi.importActual",
			'const fs = await vi.importActual("node:fs");\nfs.readFileSync(resolve(import.meta.dirname, "index.html"));',
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

describe("supportImports", () => {
	it("finds the shared fixture that starts a real worker thread", () => {
		// Arrange: this suite looks traceable, but its fixture spawns the worker entry by URL.
		const file = fileURLToPath(
			new URL("../packages/core/src/semantic/semantic-worker-integration.test.ts", import.meta.url),
		);
		// Act
		const helpers = supportImports(file, readFileSync(file, "utf8"));
		// Assert
		const fixture = helpers.find((path) => path.endsWith("semantic-worker-test-fixtures.ts"));
		assert.ok(fixture, `expected the semantic worker fixture in ${helpers.join(", ")}`);
		assert.equal(isUntraced(readFileSync(fixture, "utf8")), true);
	});

	it("ignores production modules even when they spawn processes", () => {
		// Arrange
		const file = "/repo/src/sync.test.ts";
		const source = 'import { identity } from "./sync-identity.js";';
		// Act + Assert: only test-support file names are scanned.
		assert.deepEqual(supportImports(file, source), []);
	});
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

describe("shardArgs", () => {
	it("adds nothing without a shard", () => {
		assert.deepEqual(shardArgs("", { selected: true }), []);
	});

	it("lets a shard of a selection pass with no files, but not a shard of a full run", () => {
		// Assert: Vitest otherwise fails when a small selection leaves a shard without files.
		assert.deepEqual(shardArgs("2/2", { selected: true }), ["--shard=2/2", "--passWithNoTests"]);
		assert.deepEqual(shardArgs("1/2", { selected: false }), ["--shard=1/2"]);
	});

	it("rejects a malformed shard instead of running every file", () => {
		for (const shard of ["2", "0/2", "1/0", "1/2 --project x", "a/b"])
			assert.throws(() => shardArgs(shard, { selected: true }), /Invalid CI_TEST_SHARD/u, shard);
	});
});

describe("parseMaxShare", () => {
	it("reads a share in (0, 1] and leaves an unset value unlimited", () => {
		assert.equal(parseMaxShare(undefined), null);
		assert.equal(parseMaxShare(""), null);
		assert.equal(parseMaxShare("0.5"), 0.5);
		assert.equal(parseMaxShare("1"), 1);
	});

	it("rejects values outside (0, 1] or that are not plain decimals", () => {
		for (const value of ["0", "1.5", "50%", "-0.5", "half"])
			assert.throws(() => parseMaxShare(value), /Invalid CI_TEST_MAX_SHARE/u, value);
	});
});

describe("shareSkipReason", () => {
	it("skips a full selection, or one over the share, and runs everything else", () => {
		const total = 758;
		// A changed test config selects everything, as a release bump does.
		assert.equal(
			shareSkipReason({ files: null, total, maxShare: 0.5 }),
			"Skipping 758 of 758 test files: the selection is more than 50% of them.",
		);
		assert.match(
			shareSkipReason({ files: Array(380).fill("f"), total, maxShare: 0.5 }) ?? "",
			/^Skipping 380 of 758/u,
		);
		assert.equal(shareSkipReason({ files: Array(379).fill("f"), total, maxShare: 0.5 }), null);
		assert.equal(shareSkipReason({ files: null, total, maxShare: null }), null);
	});
});

describe("main with a share limit", () => {
	it("refuses an invalid CI_TEST_MAX_SHARE before running anything", () => {
		const cwd = mkdtempSync(join(tmpdir(), "ci-changed-tests-"));
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { "test:x": "true" } }));
		try {
			assert.throws(
				() => main(["test:x"], { cwd, env: { CI_TEST_BASE: "abc", CI_TEST_MAX_SHARE: "2" } }),
				/Invalid CI_TEST_MAX_SHARE: 2/u,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("main with a shard", () => {
	it("refuses to run a command that is not a Vitest run, which every shard would repeat", () => {
		// Arrange
		const cwd = mkdtempSync(join(tmpdir(), "ci-changed-tests-"));
		const scripts = {
			"test:mixed": "node --test a.test.mjs && pnpm exec vitest run",
		};
		writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts }));
		try {
			// Act + Assert: it fails before running anything.
			assert.throws(
				() => main(["test:mixed"], { cwd, env: { CI_TEST_SHARD: "1/2", CI_TEST_BASE: "" } }),
				/CI_TEST_SHARD cannot split: node --test a\.test\.mjs/u,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("test config changes", () => {
	const root = fileURLToPath(new URL("..", import.meta.url));
	// Vitest matches its forceRerunTriggers against absolute changed paths with picomatch.
	const require = createRequire(createRequire(import.meta.url).resolve("vitest/package.json"));
	const picomatch = require("picomatch");
	const triggered = (patterns, path) => picomatch(patterns)(join(root, path));

	it("run every test when a test config, setup file or the selection changes", () => {
		for (const path of [
			"vitest.config.ts",
			"packages/core/vite.config.ts",
			"packages/ui/vite.config.ts",
			"packages/cloudflare-coordinator-worker/vitest.node.config.ts",
			"packages/core/src/test-environment-isolation.ts",
			"packages/ui/src/preact-frame-test-setup.ts",
			"packages/ui/ui-aliases.ts",
			"packages/core/test-worker-v8-flags.ts",
			"scripts/ci-changed-tests.mjs",
			"scripts/test-rerun-triggers.mjs",
		])
			assert.equal(triggered(TEST_CONFIG_TRIGGERS, path), true, path);
	});

	it("leave ordinary source and test files to import tracing", () => {
		for (const path of [
			"packages/core/src/store.ts",
			"packages/core/src/store.test.ts",
			"packages/ui/src/app.ts",
			"scripts/release-version.mjs",
		])
			assert.equal(triggered(TEST_CONFIG_TRIGGERS, path), false, path);
	});

	it("cover every setup file and local module each test config loads", () => {
		// Arrange: every Vitest config in the workspace and the files it names.
		const configs = [
			"vitest.config.ts",
			...readdirSync(join(root, "packages")).flatMap((pkg) =>
				readdirSync(join(root, "packages", pkg))
					.filter((name) => /^(vite|vitest)(\..+)?\.config\.ts$/u.test(name))
					.map((name) => `packages/${pkg}/${name}`),
			),
		];
		const missing = [];
		for (const config of configs) {
			const source = readFileSync(join(root, config), "utf8");
			// A config's own trigger list also counts, for files only that config loads.
			const own = [...source.matchAll(/"(\*\*\/[^"]+)"/gu)].map((match) => match[1]);
			const setup = [...source.matchAll(/setupFiles:\s*\[([^\]]*)\]/gu)].flatMap((match) =>
				[...match[1].matchAll(/"([^"]+)"/gu)].map((file) => file[1]),
			);
			const imports = [...source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/gu)].map((match) => match[1]);
			for (const file of [...setup, ...imports]) {
				const path = join(dirname(config), file);
				if (!triggered([...TEST_CONFIG_TRIGGERS, ...own], path)) missing.push(`${config}: ${file}`);
			}
		}

		// Assert
		assert.ok(configs.length > 10, "expected the workspace's test configs");
		assert.deepEqual(missing, []);
	});

	it("are the root config's rerun triggers", () => {
		const config = readFileSync(join(root, "vitest.config.ts"), "utf8");
		assert.match(config, /\.\.\.TEST_CONFIG_TRIGGERS,/u);
		assert.match(config, /from "\.\/scripts\/test-rerun-triggers\.mjs"/u);
	});
});
