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

function makeRepo(version = "0.16.0") {
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
  "version": "${version}",
  "mcpServers": {
    "codemem": {
      "command": "npx",
      "args": ["-y", "--package", "codemem@${version}", "--package", "@codemem/embeddings@${version}", "codemem", "mcp"]
    }
  }
}
`,
	);
	write(
		join(root, ".claude-plugin/marketplace.json"),
		`{
  "metadata": {
    "version": "${version}"
  },
  "plugins": [
    {
      "name": "codemem",
      "version": "${version}"
    }
  ]
}
`,
	);
	write(
		join(root, "plugins/codex/.codex-plugin/plugin.json"),
		`{
  "name": "codemem",
  "version": "${version}"
}
`,
	);
	write(
		join(root, "plugins/codex/.mcp.json"),
		JSON.stringify({ codemem: {
			command: "npx",
			args: ["-y", "--package", `codemem@${version}`, "--package", `@codemem/embeddings@${version}`, "codemem", "mcp"],
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
	for (const version of ["0.47.0", "0.47.0-beta.1"]) {
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
					const root = makeRepo("0.47.0-beta.1");
					changeLauncher(root, launcher, (server) => { server.args[pin.index] = spec; });

					// Act.
					const result = checkRepo(root);

					// Assert.
					assert.equal(result.code, 1);
					assert.match(result.stdout, new RegExp(`${launcher.key}_${pin.name}:`));
					assert.equal(result.stderr, "");
					if (spec === pin.spec) assert.match(result.stdout, /Invalid release version values detected:/);
				});
			}
		}

		it(`repairs unversioned ${launcher.name} packages when manifest versions already match`, () => {
			// Arrange: legacy launchers resolve stable even though manifests say beta.
			const root = makeRepo("0.47.0-beta.1");
			changeLauncher(root, launcher, (server) => {
				server.args[2] = "codemem";
				server.args[4] = "@codemem/embeddings";
			});
			const before = repoContents(root);

			// Act: dry run and real repair share validation and change reporting.
			const planned = setVersion(root, "0.47.0-beta.1", { dryRun: true });
			assert.deepEqual(repoContents(root), before);
			const changed = setVersion(root, "0.47.0-beta.1");

			// Assert: a same-version request must still repair package specs.
			assert.deepEqual(planned, [launcher.path]);
			assert.deepEqual(changed, [launcher.path]);
			assert.deepEqual(launcher.server(readLauncher(root, launcher)).args,
				["-y", "--package", "codemem@0.47.0-beta.1", "--package", "@codemem/embeddings@0.47.0-beta.1", "codemem", "mcp"]);
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
		setVersion(root, "1.0.1-alpha.0");
		assert.deepEqual(new Set(Object.values(readVersions(root))), new Set(["1.0.1-alpha.0"]));
		setVersion(root, "1.0.1-beta.2");
		assert.deepEqual(new Set(Object.values(readVersions(root))), new Set(["1.0.1-beta.2"]));
		setVersion(root, "1.0.1-rc.1");
		assert.deepEqual(new Set(Object.values(readVersions(root))), new Set(["1.0.1-rc.1"]));
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
