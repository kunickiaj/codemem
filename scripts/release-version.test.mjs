import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { main, readVersions, setVersion, versionsAreAligned } from "./release-version.mjs";

const tempRoots = [];

function write(path, content) {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, content, "utf8");
}

/** `pin` is the version the four plugin manifest files hold. */
function makeRepo(version = "0.16.0", pin = version) {
	const root = mkdtempSync(join(tmpdir(), "codemem-release-version-"));
	tempRoots.push(root);
	write(join(root, "packages/core/package.json"), `{
\t"version": "${version}"
}
`);
	write(join(root, "packages/embeddings/package.json"), `{
	"version": "${version}"
}
`);
	write(join(root, "packages/cli/package.json"), `{
\t"version": "${version}"
}
`);
	write(join(root, "packages/opencode-plugin/package.json"), `{
\t"version": "${version}"
}
`);
	write(join(root, "packages/mcp-server/package.json"), `{
\t"version": "${version}"
}
`);
	write(join(root, "packages/viewer-server/package.json"), `{
\t"version": "${version}"
}
`);
	write(join(root, "packages/pi-extension/package.json"), `{
\t"version": "${version}"
}
`);
	write(join(root, "packages/core/src/index.ts"), `export const VERSION = "${version}";\n`);
	write(join(root, "packages/core/src/index.test.ts"), `expect(VERSION).toBe("${version}");\n`);
	write(
		join(root, "packages/cli/.opencode/plugins/codemem.js"),
		`const PINNED_BACKEND_VERSION = "${version}";\n`,
	);
	write(
		join(root, "packages/opencode-plugin/.opencode/lib/runtime.js"),
		`const PINNED_BACKEND_VERSION = "${version}";\n`,
	);
	write(
		join(root, "plugins/claude/.claude-plugin/plugin.json"),
		`{
  "version": "${pin}",
  "mcpServers": {
    "codemem": {
      "command": "npx",
      "args": ["-y", "--package", "codemem@${pin}", "--package", "@codemem/embeddings@${pin}", "codemem", "mcp"]
    }
  }
}
`,
	);
	write(
		join(root, ".claude-plugin/marketplace.json"),
		`{
  "metadata": {
    "version": "${pin}"
  },
  "plugins": [
    {
      "name": "codemem",
      "version": "${pin}"
    }
  ]
}
`,
	);
	write(
		join(root, "plugins/codex/.codex-plugin/plugin.json"),
		`{
  "name": "codemem",
  "version": "${pin}"
}
`,
	);
	write(
		join(root, "plugins/codex/.mcp.json"),
		JSON.stringify({ codemem: {
			command: "npx",
			args: ["-y", "--package", `codemem@${pin}`, "--package", `@codemem/embeddings@${pin}`, "codemem", "mcp"],
			startup_timeout_sec: 30,
			tool_timeout_sec: 60,
		} }, null, 2) + "\n",
	);
	return root;
}

afterEach(() => {
	while (tempRoots.length > 0) {
		rmSync(tempRoots.pop(), { recursive: true, force: true });
	}
});

function withCwd(nextCwd, fn) {
	const previous = process.cwd();
	process.chdir(nextCwd);
	try {
		return fn();
	} finally {
		process.chdir(previous);
	}
}

const launchers = [
	{ name: "Claude", path: "plugins/claude/.claude-plugin/plugin.json", key: "claude_mcp", server: (json) => json.mcpServers.codemem },
	{ name: "Codex", path: "plugins/codex/.mcp.json", key: "codex_mcp", server: (json) => json.codemem },
];

function readLauncher(root, launcher) {
	return JSON.parse(readFileSync(join(root, launcher.path), "utf8"));
}

function changeLauncher(root, launcher, mutate) {
	const json = readLauncher(root, launcher);
	mutate(launcher.server(json), json);
	write(join(root, launcher.path), `${JSON.stringify(json, null, 2)}\n`);
}

// Compare every fixture file byte-for-byte to catch writes queued before a late failure.
function repoContents(root, directory = "") {
	const contents = {};
	for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			Object.assign(contents, repoContents(root, path));
		} else {
			contents[path] = readFileSync(join(root, path), "utf8");
		}
	}
	return contents;
}

const MANIFEST_FILES = [
	".claude-plugin/marketplace.json",
	"plugins/claude/.claude-plugin/plugin.json",
	"plugins/codex/.codex-plugin/plugin.json",
	"plugins/codex/.mcp.json",
];
const MANIFEST_KEYS = new Set([
	"claude_plugin_manifest",
	"marketplace_metadata",
	"marketplace_plugin",
	"codex_plugin_manifest",
	"claude_mcp_cli",
	"claude_mcp_embeddings",
	"codex_mcp_cli",
	"codex_mcp_embeddings",
]);

/** The distinct versions held by package files and by plugin manifest files. */
function versionGroups(snapshot) {
	const distinct = (manifest) => [
		...new Set(Object.entries(snapshot).filter(([key]) => MANIFEST_KEYS.has(key) === manifest).map(([, value]) => value)),
	];
	return { packages: distinct(false), manifests: distinct(true) };
}

function manifestContents(root) {
	return Object.fromEntries(MANIFEST_FILES.map((path) => [path, readFileSync(join(root, path), "utf8")]));
}

function runCli(root, argv) {
	let stdout = "";
	let stderr = "";
	const code = withCwd(root, () => main(argv,
		{ write: (chunk) => (stdout += chunk) },
		{ write: (chunk) => (stderr += chunk) },
	));
	return { code, stdout, stderr };
}

function checkRepo(root) {
	let stdout = "";
	let stderr = "";
	const code = withCwd(root, () => main(["check"],
		{ write: (chunk) => (stdout += chunk) },
		{ write: (chunk) => (stderr += chunk) },
	));
	return { code, stdout, stderr };
}

describe("MCP release package pins", () => {
	// A prerelease `set` leaves the launchers alone; see the plugin manifest tests below.
	for (const version of ["0.47.0", "1.0.0"]) {
		it(`reads and checks all four exact pins at ${version}`, () => {
			// Arrange: all managed versions and launcher packages agree.
			const root = makeRepo(version);

			// Act.
			const versions = readVersions(root);
			const result = checkRepo(root);

			// Assert: checking must include both packages in both launchers.
			for (const launcher of launchers) {
				assert.equal(versions[`${launcher.key}_cli`], version);
				assert.equal(versions[`${launcher.key}_embeddings`], version);
			}
			assert.equal(result.code, 0);
			assert.equal(result.stdout, `OK: release versions are aligned at ${version}\n`);
			assert.equal(result.stderr, "");
		});

		it(`sets exact package specs at ${version} without changing launcher options`, () => {
			// Arrange: unrelated npx/server options must survive a release update.
			const root = makeRepo("0.46.0");
			for (const launcher of launchers) {
				changeLauncher(root, launcher, (server) => {
					server.args.unshift("--offline");
					server.env = { TEST_SETTING: "unchanged" };
				});
			}
			const before = launchers.map((launcher) => launcher.server(readLauncher(root, launcher)));

			// Act.
			const changed = setVersion(root, version);

			// Assert: only package specs change, not the plain executable or mcp command.
			for (const [index, launcher] of launchers.entries()) {
				assert.equal(changed.filter((path) => path === launcher.path).length, 1);
				assert.deepEqual(launcher.server(readLauncher(root, launcher)), {
					...before[index],
					args: ["--offline", "-y", "--package", `codemem@${version}`, "--package", `@codemem/embeddings@${version}`, "codemem", "mcp"],
				});
			}
			assert.deepEqual(versionsAreAligned(readVersions(root)), { aligned: true, details: [] });
			assert.deepEqual(setVersion(root, version), []);
		});

		it(`leaves every file unchanged during a ${version} dry run`, () => {
			// Arrange.
			const root = makeRepo("0.46.0");
			const before = repoContents(root);

			// Act.
			const changed = setVersion(root, version, { dryRun: true });

			// Assert: both launchers are reported but neither is written.
			for (const launcher of launchers) assert.ok(changed.includes(launcher.path));
			assert.equal(changed.length, 15);
			assert.deepEqual(repoContents(root), before);
		});
	}

	for (const launcher of launchers) {
		for (const invocation of [
			{ name: "echo before the expected executable", index: 5 },
			{ name: "echo before the package flags", index: 1 },
		]) {
			it(`rejects ${launcher.name} ${invocation.name} without writing any file`, () => {
				// Arrange: valid pins must not hide an earlier npx executable.
				const root = makeRepo("0.47.0-beta.1");
				changeLauncher(root, launcher, (server) => {
					server.args.splice(invocation.index, 0, "echo");
				});
				const before = repoContents(root);

				// Act: exercise every entry point before asserting rejection.
				let readError;
				try {
					readVersions(root);
				} catch (error) {
					readError = error;
				}
				const check = checkRepo(root);
				let setError;
				try {
					setVersion(root, "0.47.1-beta.1");
				} catch (error) {
					setError = error;
				}

				// Assert: reject the invocation before committing any queued updates.
				assert.ok(readError instanceof Error, "readVersions accepted an echo invocation");
				assert.ok(readError.message.includes(`${launcher.path} MCP launcher`));
				assert.equal(check.code, 2);
				assert.equal(check.stdout, "");
				assert.ok(check.stderr.includes(`${launcher.path} MCP launcher`));
				assert.ok(setError instanceof Error, "setVersion accepted an echo invocation");
				assert.ok(setError.message.includes(`${launcher.path} MCP launcher`));
				assert.deepEqual(repoContents(root), before);
			});
		}

		for (const pin of [
			{ name: "cli", index: 2, spec: "codemem" },
			{ name: "embeddings", index: 4, spec: "@codemem/embeddings" },
		]) {
			for (const spec of [`${pin.spec}@0.46.0`, pin.spec]) {
				it(`check rejects ${launcher.name} ${pin.name} spec ${spec}`, () => {
					// Arrange: drift or an unversioned package must not pass release checks.
					const root = makeRepo("0.47.0");
					changeLauncher(root, launcher, (server) => { server.args[pin.index] = spec; });

					// Act.
					const result = checkRepo(root);

					// Assert.
					assert.equal(result.code, 1);
					assert.match(result.stdout, new RegExp(`${launcher.key}_${pin.name}\\)?:`));
					assert.equal(result.stderr, "");
					if (spec === pin.spec) assert.match(result.stdout, /Invalid release version values detected:/);
				});
			}
		}

		it(`repairs unversioned ${launcher.name} packages when manifest versions already match`, () => {
			// Arrange: legacy launchers resolve npm's latest tag whatever the manifests say.
			const root = makeRepo("0.47.0");
			changeLauncher(root, launcher, (server) => {
				server.args[2] = "codemem";
				server.args[4] = "@codemem/embeddings";
			});
			const before = repoContents(root);

			// Act: dry run and real repair share validation and change reporting.
			const planned = setVersion(root, "0.47.0", { dryRun: true });
			assert.deepEqual(repoContents(root), before);
			const changed = setVersion(root, "0.47.0");

			// Assert: a same-version request must still repair package specs.
			assert.deepEqual(planned, [launcher.path]);
			assert.deepEqual(changed, [launcher.path]);
			assert.deepEqual(launcher.server(readLauncher(root, launcher)).args,
				["-y", "--package", "codemem@0.47.0", "--package", "@codemem/embeddings@0.47.0", "codemem", "mcp"]);
			assert.deepEqual(versionsAreAligned(readVersions(root)), { aligned: true, details: [] });
		});

		const invalidLaunchers = [
			{ name: "missing args", mutate: (server) => { delete server.args; } },
			{ name: "non-array args", mutate: (server) => { server.args = "codemem mcp"; } },
			{ name: "non-string arg", mutate: (server) => { server.args[2] = null; } },
			{ name: "missing CLI package", mutate: (server) => { server.args.splice(1, 2); } },
			{ name: "missing embeddings package", mutate: (server) => { server.args.splice(3, 2); } },
			{ name: "duplicate CLI package", mutate: (server) => { server.args.push("--package", "codemem@0.46.0"); } },
			{ name: "duplicate embeddings package", mutate: (server) => { server.args.push("--package", "@codemem/embeddings@0.46.0"); } },
			{ name: "empty CLI version", mutate: (server) => { server.args[2] = "codemem@"; } },
			{ name: "non-exact CLI version", mutate: (server) => { server.args[2] = "codemem@^0.46.0"; } },
			{ name: "non-exact embeddings version", mutate: (server) => { server.args[4] = "@codemem/embeddings@latest"; } },
		];
		for (const invalid of invalidLaunchers) {
			it(`rejects ${launcher.name} ${invalid.name} before writing any file`, () => {
				// Arrange: failure occurs after earlier package updates would be queued.
				const root = makeRepo("0.46.0");
				changeLauncher(root, launcher, invalid.mutate);
				const before = repoContents(root);

				// Act / Assert: both read and set must reject malformed launchers.
				const launcherError = (error) => {
					assert.ok(error instanceof Error);
					assert.ok(error.message.includes(`${launcher.path} MCP launcher`), error.message);
					assert.match(error.message, /args|--package/);
					return true;
				};
				assert.throws(() => readVersions(root), launcherError);
				assert.throws(() => setVersion(root, "0.47.0-beta.1"), launcherError);
				assert.deepEqual(repoContents(root), before);
			});
		}
	}

	it("requires the Codex MCP file before reading or writing release files", () => {
		// Arrange.
		const root = makeRepo("0.46.0");
		rmSync(join(root, "plugins/codex/.mcp.json"));
		const before = repoContents(root);

		// Act / Assert.
		assert.throws(() => readVersions(root), /Expected a codemem repo root.*plugins\/codex\/\.mcp\.json/);
		assert.throws(() => setVersion(root, "0.47.0-beta.1"), /Expected a codemem repo root/);
		assert.deepEqual(repoContents(root), before);
	});
});

describe("release-version script", () => {
	it("treats matching managed files as aligned", () => {
		const root = makeRepo("1.2.3");
		const result = versionsAreAligned(readVersions(root));
		assert.deepEqual(result, { aligned: true, details: [] });
	});

	it("reports drift when one managed file differs", () => {
		const root = makeRepo("1.2.3");
		writeFileSync(join(root, "packages/core/package.json"), '{\n\t"version": "9.9.9"\n}\n');
		const result = versionsAreAligned(readVersions(root));
		assert.equal(result.aligned, false);
		assert.equal(result.details.some((line) => line.includes("core_package")), true);
	});

	it("reports invalid version values", () => {
		const root = makeRepo("1.2.3");
		writeFileSync(join(root, "packages/core/package.json"), '{\n\t"version": "release-candidate"\n}\n');
		const result = versionsAreAligned(readVersions(root));
		assert.equal(result.aligned, false);
		assert.equal(result.details[0], "Invalid release version values detected:");
		assert.equal(
			result.details.some((line) => line.includes("core_package: release-candidate")),
			true,
		);
	});

	it("updates all managed locations", () => {
		const root = makeRepo("1.0.0");
		const changed = setVersion(root, "1.0.1");
		assert.deepEqual([...changed].sort(), [
			".claude-plugin/marketplace.json",
			"packages/cli/.opencode/plugins/codemem.js",
			"packages/cli/package.json",
			"packages/core/package.json",
			"packages/core/src/index.test.ts",
			"packages/core/src/index.ts",
			"packages/embeddings/package.json",
			"packages/mcp-server/package.json",
			"packages/opencode-plugin/.opencode/lib/runtime.js",
			"packages/opencode-plugin/package.json",
			"packages/pi-extension/package.json",
			"packages/viewer-server/package.json",
			"plugins/claude/.claude-plugin/plugin.json",
			"plugins/codex/.codex-plugin/plugin.json",
			"plugins/codex/.mcp.json",
		]);
		assert.deepEqual(new Set(Object.values(readVersions(root))), new Set(["1.0.1"]));
	});

	it("supports dry run without writing", () => {
		const root = makeRepo("1.0.0");
		const changed = setVersion(root, "1.0.1", { dryRun: true });
		assert.equal(changed.length, 15);
		assert.deepEqual(new Set(Object.values(readVersions(root))), new Set(["1.0.0"]));
	});

	it("rejects invalid semver", () => {
		const root = makeRepo("1.0.0");
		assert.throws(() => setVersion(root, "v1.0.1"), /Expected format: X.Y.Z/);
	});

	it("accepts alpha/beta/rc prerelease tags routed by the Release workflow", () => {
		const root = makeRepo("1.0.0");
		for (const version of ["1.0.1-alpha.0", "1.0.1-beta.2", "1.0.1-rc.1"]) {
			setVersion(root, version);
			assert.deepEqual(versionGroups(readVersions(root)), { packages: [version], manifests: ["1.0.0"] });
		}
	});

	it("rejects unknown prerelease identifiers", () => {
		const root = makeRepo("1.0.0");
		assert.throws(() => setVersion(root, "1.0.1-canary.0"), /Expected format: X.Y.Z/);
		assert.throws(() => setVersion(root, "1.0.1-alpha"), /Expected format: X.Y.Z/);
	});

	it("does not write partial changes before validation failure", () => {
		const root = makeRepo("1.0.0");
		writeFileSync(join(root, ".claude-plugin/marketplace.json"), '{"metadata": {"version": "1.0.0"}, "plugins": []}\n');
		assert.throws(() => setVersion(root, "1.0.1"), /missing codemem plugin entry/);
		assert.match(readFileSync(join(root, "packages/core/package.json"), "utf8"), /"1.0.0"/);
		assert.match(
			readFileSync(join(root, "packages/opencode-plugin/.opencode/lib/runtime.js"), "utf8"),
			/PINNED_BACKEND_VERSION = "1.0.0"/,
		);
	});

	it("reports clean cli errors without stack traces", () => {
		const root = makeRepo("1.0.0");
		writeFileSync(join(root, ".claude-plugin/marketplace.json"), '{"metadata": {"version": "1.0.0"}, "plugins": []}\n');
		let stdout = "";
		let stderr = "";
		const code = withCwd(root, () =>
			main(["set", "1.0.1"], { write: (chunk) => (stdout += chunk) }, { write: (chunk) => (stderr += chunk) }),
		);
		assert.equal(code, 2);
		assert.equal(stdout, "");
		assert.match(stderr, /Error:/);
		assert.equal(stderr.includes("Traceback"), false);
	});

	it("rejects roots that do not look like a managed codemem repo", () => {
		const root = mkdtempSync(join(tmpdir(), "codemem-release-version-invalid-"));
		tempRoots.push(root);
		assert.throws(() => readVersions(root), /Expected a codemem repo root/);
	});
});

describe("plugin manifests track the latest stable release", () => {
	const SKIPPED = MANIFEST_FILES.map((path) => `- ${path}`).join("\n");

	it("leaves the manifests byte-for-byte unchanged on a prerelease set and says why", () => {
		const root = makeRepo("0.49.1");
		const before = manifestContents(root);

		const result = runCli(root, ["set", "0.50.0-beta.2"]);

		assert.equal(result.code, 0);
		assert.deepEqual(manifestContents(root), before);
		assert.deepEqual(versionGroups(readVersions(root)), { packages: ["0.50.0-beta.2"], manifests: ["0.49.1"] });
		assert.match(result.stdout, /^updated 11 file\(s\):\n/);
		assert.ok(
			result.stdout.includes(
				"left 4 plugin manifest file(s) unchanged, because plugin installs from the default branch " +
					`pin the latest stable release and 0.50.0-beta.2 is a prerelease:\n${SKIPPED}\n`,
			),
			result.stdout,
		);
		assert.equal(result.stderr, "");
	});

	it("reports the same rule in a prerelease dry run without writing", () => {
		const root = makeRepo("0.49.1");
		const before = repoContents(root);

		const result = runCli(root, ["set", "0.50.0-beta.2", "--dry-run"]);

		assert.equal(result.code, 0);
		assert.deepEqual(repoContents(root), before);
		assert.match(result.stdout, /^would update 11 file\(s\):\n/);
		const [updates] = result.stdout.split("would leave");
		for (const path of MANIFEST_FILES) assert.equal(updates.includes(path), false, path);
		assert.ok(result.stdout.includes(`would leave 4 plugin manifest file(s) unchanged`), result.stdout);
		assert.ok(result.stdout.endsWith(`${SKIPPED}\nDry run complete; no files written.\n`), result.stdout);
	});

	it("updates the manifests on a later stable set", () => {
		const root = makeRepo("0.49.1");
		setVersion(root, "0.50.0-beta.2");

		const planned = setVersion(root, "0.50.0", { dryRun: true });
		const result = runCli(root, ["set", "0.50.0"]);

		for (const path of MANIFEST_FILES) assert.ok(planned.includes(path), path);
		assert.equal(result.code, 0);
		assert.equal(result.stdout.includes("plugin manifest file(s) unchanged"), false);
		assert.deepEqual(versionGroups(readVersions(root)), { packages: ["0.50.0"], manifests: ["0.50.0"] });
	});

	it("accepts one stable pin below a prerelease's base version", () => {
		for (const [version, pin] of [
			["0.50.0-beta.2", "0.49.1"],
			["0.50.0-rc.1", "0.48.0"],
			["1.0.0-alpha.0", "0.99.9"],
			["0.50.1-beta.1", "0.50.0"],
		]) {
			const result = checkRepo(makeRepo(version, pin));

			assert.equal(result.code, 0, `${version} over ${pin}: ${result.stdout}`);
			assert.equal(
				result.stdout,
				`OK: release versions are aligned at ${version}; plugin manifests pin stable ${pin}\n`,
			);
		}
	});

	for (const [name, pin] of [
		["a prerelease pin", "0.50.0-beta.1"],
		["the same prerelease pin", "0.50.0-beta.2"],
		["a stable pin equal to the base version", "0.50.0"],
		["a stable pin above the package version", "0.51.0"],
	]) {
		it(`rejects ${name} while packages are at a prerelease`, () => {
			const result = checkRepo(makeRepo("0.50.0-beta.2", pin));

			assert.equal(result.code, 1);
			assert.match(
				result.stdout,
				/^Plugin manifest pins must all hold one stable release below 0\.50\.0 while packages are at 0\.50\.0-beta\.2:\n/,
			);
			assert.ok(result.stdout.includes(`- plugins/codex/.mcp.json (codex_mcp_cli): ${pin}\n`), result.stdout);
			assert.ok(result.stdout.includes(`- .claude-plugin/marketplace.json (marketplace_metadata): ${pin}\n`));
		});
	}

	it("rejects a mix of stable pins while packages are at a prerelease", () => {
		const root = makeRepo("0.50.0-beta.2", "0.49.1");
		writeFileSync(
			join(root, "plugins/codex/.codex-plugin/plugin.json"),
			'{\n  "name": "codemem",\n  "version": "0.49.0"\n}\n',
		);

		const result = checkRepo(root);

		assert.equal(result.code, 1);
		assert.ok(result.stdout.includes("- plugins/codex/.codex-plugin/plugin.json (codex_plugin_manifest): 0.49.0\n"));
		assert.ok(result.stdout.includes("- plugins/claude/.claude-plugin/plugin.json (claude_plugin_manifest): 0.49.1\n"));
	});

	it("rejects stable packages whose manifests pin an older stable release", () => {
		const result = checkRepo(makeRepo("0.50.0", "0.49.1"));

		assert.equal(result.code, 1);
		assert.match(result.stdout, /^Plugin manifest pins must equal the stable release 0\.50\.0:\n/);
		assert.ok(result.stdout.includes("- plugins/claude/.claude-plugin/plugin.json (claude_mcp_cli): 0.49.1\n"));
	});

	it("still fails a prerelease set whose manifests already hold a prerelease", () => {
		const root = makeRepo("0.50.0-beta.1");
		const before = manifestContents(root);

		const result = runCli(root, ["set", "0.50.0-beta.2"]);

		assert.equal(result.code, 1);
		assert.deepEqual(manifestContents(root), before);
		assert.ok(result.stdout.includes("- plugins/codex/.mcp.json (codex_mcp_embeddings): 0.50.0-beta.1\n"));
	});
});
