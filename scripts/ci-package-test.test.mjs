import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCommands, isolatedEnv, main, outputDirectory } from "./ci-package-test.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const temps = join(root, ".tmp/ci-package-launcher-tests");
const workerPath = "packages/cloudflare-coordinator-worker";
const manifest = JSON.parse(fs.readFileSync(join(root, workerPath, "package.json"), "utf8"));
const ciScript = JSON.parse(fs.readFileSync(join(root, "package.json"), "utf8")).scripts["test:ci"];
fs.mkdirSync(temps, { recursive: true });
const fixture = (script = ciScript) => {
	const root = fs.mkdtempSync(join(temps, "unit-"));
	fs.writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { "test:ci": script } }));
	return root;
};
const read = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
// Fabricated reports verify launcher contracts only; they are not performance evidence.
function report(entry, data = {}) {
	const index = entry.args.indexOf("--outputFile");
	if (index !== -1)
		fs.writeFileSync(
			entry.args[index + 1],
			JSON.stringify({ success: true, testResults: [], startTime: Date.now(), ...data }),
		);
}

it("discovers an ordinary project from its package basename and nests its reports", async () => {
	// Arrange
	const root = fixture(),
		cwd = join(root, "packages/example");
	fs.mkdirSync(cwd, { recursive: true });
	const calls = [];
	// Act
	const code = await main([], {
		root,
		cwd,
		baseEnv: {},
		runCommand: (entry) => {
			calls.push(entry);
			report(entry);
			return 0;
		},
	});
	// Assert
	assert.equal(code, 0);
	assert.equal(calls[0].name, "example");
	assert.equal(calls[0].cwd, cwd);
	assert.equal(outputDirectory("example", root, cwd), join(cwd, ".tmp/ci-package-test/unit"));
	assert.ok(calls[0].args.includes("example"));
});

for (const project of ["core", "viewer-server", "cli"]) {
	it(`${project} runs from the root with a separate output directory`, () => {
		// Arrange
		const cwd = join(root, "packages/other");
		// Act
		const entries = buildCommands(project, root, cwd);
		// Assert
		assert.equal(outputDirectory(project, root, cwd), join(root, ".tmp/ci-package-test", project));
		assert.equal(entries.length, project === "core" ? 2 : 1);
		const reports = entries.map((entry) => entry.args[entry.args.indexOf("--outputFile") + 1]);
		assert.equal(new Set(reports).size, entries.length);
		for (const entry of entries) {
			assert.equal(entry.cwd, root);
			assert.equal(entry.args[entry.args.indexOf("--project") + 1], project);
		}
		assert.ok(reports.every((path) => dirname(path) === outputDirectory(project, root)));
		if (project === "core") assert.ok(entries.at(-1).args.includes("--maxWorkers=1"));
	});
}

for (const [selector, workers] of [
	["fixture-first.test.ts", 1],
	["fixture-renamed.test.ts", 3],
]) {
	it(`follows manifest-owned core scheduling for ${selector} and ${workers} workers`, () => {
		// Arrange
		const glob = `**/${selector}`,
			file = `packages/core/src/${selector}`;
		const root = fixture(
			`pnpm exec vitest run --exclude "${glob}" && pnpm exec vitest run ${file} --maxWorkers=${workers}`,
		);
		// Act
		const entries = buildCommands("core", root);
		// Assert
		assert.deepEqual(
			entries.map((entry) => entry.name),
			["core-1", "core-2"],
		);
		assert.deepEqual(entries[0].args.slice(0, 5), ["exec", "vitest", "run", "--exclude", glob]);
		assert.deepEqual(entries[1].args.slice(0, 5), [
			"exec",
			"vitest",
			"run",
			file,
			`--maxWorkers=${workers}`,
		]);
		assert.ok(!entries[1].args.includes(glob));
	});
}

for (const script of [
	"pnpm exec vitest run ; echo unsafe",
	"node custom-runner.mjs",
	'pnpm exec vitest run "$(echo unsafe)"',
]) {
	it(`rejects an unsafe or unsupported core script: ${script}`, () => {
		// Arrange
		const root = fixture(script);
		// Act / Assert
		assert.throws(
			() => buildCommands("core", root),
			/Expected a simple pnpm exec vitest run script/,
		);
	});
}

for (const failAt of [-1, 0, 1]) {
	it(`records distinct core phase reports and stops at failing phase ${failAt}`, async () => {
		// Arrange
		const root = fixture(),
			calls = [];
		// Act
		const code = await main(["core"], {
			root,
			baseEnv: {},
			runCommand: (entry) => {
				calls.push(entry);
				report(entry);
				return calls.length - 1 === failAt ? 19 : 0;
			},
		});
		const metadata = read(join(outputDirectory("core", root), "execution.json"));
		// Assert
		assert.equal(code, failAt === -1 ? 0 : 19);
		assert.equal(calls.length, failAt === 0 ? 1 : 2);
		assert.equal(metadata.status, failAt === -1 ? "success" : "failure");
		assert.deepEqual(
			metadata.commands.map((entry) => entry.report),
			calls.map((entry) => entry.args[entry.args.indexOf("--outputFile") + 1]),
		);
		assert.equal(new Set(metadata.commands.map((entry) => entry.report)).size, calls.length);
	});
}

for (const project of ["../escape", "core;echo", "", "CORE"]) {
	it(`rejects unsafe project ${JSON.stringify(project)}`, () => {
		// Arrange
		const launch = () => buildCommands(project, root);
		// Act / Assert
		assert.throws(launch, /simple Vitest project/);
		assert.throws(() => outputDirectory(project, root), /simple Vitest project/);
	});
}

it("preserves all five worker stages, six node entrypoints, and both JSON reporters", () => {
	// Arrange
	const names = manifest.scripts["test:worker"]
		.split(" && ")
		.map((stage) => stage.slice("pnpm run ".length));
	// Act
	const entries = buildCommands("worker-integration", root);
	// Assert
	assert.equal(entries.length, 5);
	assert.deepEqual(
		entries.map((entry) => entry.name),
		names,
	);
	for (const entry of entries) {
		assert.equal(entry.cwd, join(root, workerPath));
		if (!["test:node", "test:native"].includes(entry.name)) {
			assert.deepEqual(entry.args, ["run", entry.name]);
			continue;
		}
		assert.deepEqual(
			entry.args.slice(0, entry.args.indexOf("--reporter")),
			manifest.scripts[entry.name].split(" ").slice(1),
		);
		assert.ok(entry.args.includes("json"));
		assert.ok(
			entry.args.includes(
				join(outputDirectory("worker-integration", root), `${entry.name.replace(":", "-")}.json`),
			),
		);
	}
	assert.equal(entries[1].args.filter((arg) => arg.endsWith(".test.ts")).length, 6);
});

for (const body of ["node test/extra.mjs", "pnpm exec vitest run src/extra.test.ts"]) {
	it(`discovers an added worker stage from its manifest: ${body}`, () => {
		// Arrange
		const root = fixture(),
			directory = join(root, workerPath);
		const modified = structuredClone(manifest);
		modified.scripts["test:extra"] = body;
		modified.scripts["test:worker"] += " && pnpm run test:extra";
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(join(directory, "package.json"), JSON.stringify(modified));
		// Act
		const entries = buildCommands("worker-integration", root);
		const extra = entries.at(-1);
		// Assert
		assert.equal(entries.length, 6);
		assert.equal(extra.name, "test:extra");
		assert.equal(extra.cwd, directory);
		if (body.startsWith("pnpm exec vitest run")) {
			assert.deepEqual(extra.args.slice(0, 4), body.split(" ").slice(1));
			assert.ok(extra.args.includes("json"));
			assert.equal(
				extra.args[extra.args.indexOf("--outputFile") + 1],
				join(outputDirectory("worker-integration", root), "test-extra.json"),
			);
		} else {
			assert.deepEqual(extra.args, ["run", "test:extra"]);
		}
	});
}

for (const change of ["chain", "injection"]) {
	it(`rejects a worker manifest with ${change}`, () => {
		// Arrange
		const root = fixture(),
			directory = join(root, workerPath),
			modified = structuredClone(manifest);
		fs.mkdirSync(directory, { recursive: true });
		modified.scripts[change === "chain" ? "test:worker" : "test:node"] +=
			change === "chain" ? " && pnpm run extra" : " ; echo injected";
		fs.writeFileSync(join(directory, "package.json"), JSON.stringify(modified));
		// Act / Assert
		assert.throws(
			() => buildCommands("worker-integration", root),
			/Unexpected worker test chain|Expected a simple/,
		);
	});
}

it("rejects temporary directories under a package scope even outside Git", () => {
	// Arrange
	const env = isolatedEnv(root, outputDirectory("core", root), {});
	fs.writeFileSync(join(env.TMPDIR, "package.json"), '{"type":"module"}');
	const nested = join(env.TMPDIR, "nested");
	fs.mkdirSync(nested);
	const keys = ["TMPDIR", "TMP", "TEMP"];
	const original = keys.map((key) => process.env[key]);
	try {
		for (const key of keys) process.env[key] = nested;
		// Act / Assert
		assert.throws(
			() => isolatedEnv(root, outputDirectory("core", root), {}),
			/outside repository and package scopes/,
		);
	} finally {
		keys.forEach((key, index) => {
			if (original[index] === undefined) delete process.env[key];
			else process.env[key] = original[index];
		});
	}
});

it("isolates profiles outside checkouts without overriding application defaults", () => {
	// Arrange
	const root = fixture(),
		output = outputDirectory("example", root);
	const base = {
		PATH: "/synthetic/bin",
		HOME: "/synthetic/home",
		OPENAI_API_KEY: "fake",
		ANTHROPIC_API_KEY: "fake",
		GITHUB_TOKEN: "fake",
		SSH_AUTH_SOCK: "fake",
		NODE_OPTIONS: "--inspect",
		CODEMEM_DB: "fake",
		CODEMEM_CONFIG: "fake",
		CODEMEM_PROVIDER: "fake",
		CODEMEM_KEYS_DIR: "fake",
		CODEMEM_SYNC_KEY_STORE: "fake",
	};
	// Act
	const env = isolatedEnv(root, output, base);
	// Assert
	const [bin, inheritedPath, ...extra] = env.PATH.split(delimiter);
	assert.equal(inheritedPath, base.PATH);
	assert.deepEqual(extra, []);
	assert.equal(
		fs.realpathSync(join(bin, process.platform === "win32" ? "node.exe" : "node")),
		fs.realpathSync(process.execPath),
	);
	for (const key of Object.keys(base).filter((key) => key !== "PATH"))
		assert.notEqual(env[key], base[key]);
	assert.ok(!Object.keys(env).some((key) => key.startsWith("CODEMEM_")));
	for (const key of [
		"OPENAI_API_KEY",
		"ANTHROPIC_API_KEY",
		"GITHUB_TOKEN",
		"SSH_AUTH_SOCK",
		"NODE_OPTIONS",
	]) {
		assert.equal(Object.hasOwn(env, key), false);
	}
	for (const key of [
		"HOME",
		"USERPROFILE",
		"XDG_CONFIG_HOME",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
		"TMPDIR",
		"TMP",
		"TEMP",
	]) {
		assert.ok(fs.statSync(env[key]).isDirectory());
		for (const checkout of [root, temps, output]) {
			const path = relative(checkout, env[key]);
			assert.ok(path.startsWith("..") || isAbsolute(path));
		}
		for (let parent = fs.realpathSync(env[key]); ; parent = dirname(parent)) {
			assert.equal(fs.existsSync(join(parent, ".git")), false);
			if (parent === dirname(parent)) break;
		}
	}
	assert.equal(env.HOME, env.USERPROFILE);
	assert.equal(env.TMPDIR, env.TMP);
	assert.equal(env.TMPDIR, env.TEMP);
	assert.deepEqual(fs.readdirSync(env.HOME), []);
});

it("links the parent pnpm executable without invoking a Corepack shim", {
	skip: !process.env.npm_execpath || !fs.existsSync(process.env.npm_execpath),
}, () => {
	// Arrange
	const parentExecutable = process.env.npm_execpath;
	// Act
	const env = isolatedEnv(root, outputDirectory("core", root), { PATH: "/synthetic/bin" });
	const executable = join(
		env.PATH.split(delimiter)[0],
		process.platform === "win32" ? "pnpm.exe" : "pnpm",
	);
	// Assert: inspect the link only; executing a shim could download a runtime.
	assert.ok(fs.lstatSync(executable).isSymbolicLink());
	assert.equal(fs.readlinkSync(executable), parentExecutable);
	assert.equal(fs.realpathSync(executable), fs.realpathSync(parentExecutable));
	assert.notEqual(dirname(executable), dirname(parentExecutable));
});

it("runs an extensionless require script as CommonJS through the isolated Node PATH", () => {
	// Arrange: repository-local temporary files previously inherited type:module.
	const env = isolatedEnv(root, outputDirectory("core", root), { PATH: "/synthetic/bin" });
	const script = join(env.TMPDIR, "fake-child");
	fs.writeFileSync(
		script,
		'process.stdout.write(require("node:fs").readFileSync(__filename, "utf8"));',
	);
	// Act
	const child = spawnSync("node", [script], { cwd: env.TMPDIR, env, encoding: "utf8" });
	// Assert
	assert.equal(child.error, undefined);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout, fs.readFileSync(script, "utf8"));
	assert.equal(child.stderr, "");
});

for (const failAt of [-1, 1]) {
	it(`writes failure before children and ${failAt < 0 ? "completes every command" : "stops on the original child exit"}`, async () => {
		// Arrange
		const root = fixture(),
			output = outputDirectory("e2e-unit", root),
			calls = [],
			markers = [];
		const expected = [
			"test:release",
			"test:adapter-normalizers",
			"test:ci-workflow",
			"test:semantic-installed",
			"e2e-unit",
		];
		const unrelated = join(root, "other-project.json");
		fs.writeFileSync(unrelated, "untouched");
		// Act
		const code = await main(["e2e-unit"], {
			root,
			baseEnv: {},
			runCommand: (entry) => {
				markers.push(read(join(output, "execution.json")));
				calls.push(entry.name);
				report(entry);
				return calls.length - 1 === failAt ? 17 : 0;
			},
		});
		const final = read(join(output, "execution.json"));
		// Assert
		assert.equal(code, failAt < 0 ? 0 : 17);
		assert.deepEqual(calls, expected.slice(0, failAt < 0 ? expected.length : failAt + 1));
		assert.ok(
			markers.every(
				(marker) => marker.status === "failure" && marker.executedAt === final.executedAt,
			),
		);
		assert.equal(final.status, failAt < 0 ? "success" : "failure");
		assert.deepEqual(
			final.commands.map((entry) => entry.name),
			calls,
		);
		assert.equal(fs.readFileSync(unrelated, "utf8"), "untouched");
	});
}

for (const invalid of ["missing", "stale", "failed", "incomplete", "no-time"]) {
	it(`rejects ${invalid} results instead of accepting cached success`, async () => {
		// Arrange
		const root = fixture(),
			output = outputDirectory("core", root);
		fs.mkdirSync(output, { recursive: true });
		fs.writeFileSync(
			join(output, "execution.json"),
			JSON.stringify({ status: "success", executedAt: "2000-01-01" }),
		);
		const data = {
			stale: { startTime: 0 },
			failed: { success: false },
			incomplete: { testResults: null },
			"no-time": { startTime: null },
		};
		let calls = 0;
		// Act / Assert
		await assert.rejects(
			main(["core"], {
				root,
				baseEnv: {},
				runCommand: (entry) => {
					calls++;
					if (invalid !== "missing") report(entry, data[invalid]);
					return 0;
				},
			}),
		);
		assert.equal(calls, 1);
		assert.equal(read(join(output, "execution.json")).status, "failure");
	});
}

it("keeps the root ordinary script entrypoint available", () => {
	// Arrange
	const { scripts } = read(join(root, "package.json"));
	// Act
	const script = scripts["test:ci-package"];
	// Assert
	assert.equal(script, "node --test scripts/ci-package-*.test.mjs");
	assert.ok(!script.includes("performance"));
});
