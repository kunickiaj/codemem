import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
	write(join(root, "packages/core/src/index.ts"), `export const VERSION = "${version}";\n`);
	write(join(root, "packages/core/src/index.test.ts"), `expect(VERSION).toBe("${version}");\n`);
	write(
		join(root, "packages/cli/.opencode/plugins/codemem.js"),
		`const PINNED_BACKEND_VERSION = "${version}";\n`,
	);
	write(
		join(root, "packages/opencode-plugin/.opencode/plugins/codemem.js"),
		`const PINNED_BACKEND_VERSION = "${version}";\n`,
	);
	write(
		join(root, "plugins/claude/.claude-plugin/plugin.json"),
		`{
  "version": "${version}",
  "mcpServers": {
    "codemem": {
      "args": ["-y", "codemem", "mcp"]
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
			"packages/mcp-server/package.json",
			"packages/opencode-plugin/.opencode/plugins/codemem.js",
			"packages/opencode-plugin/package.json",
			"packages/viewer-server/package.json",
			"plugins/claude/.claude-plugin/plugin.json",
		]);
		assert.deepEqual(new Set(Object.values(readVersions(root))), new Set(["1.0.1"]));
	});

	it("supports dry run without writing", () => {
		const root = makeRepo("1.0.0");
		const changed = setVersion(root, "1.0.1", { dryRun: true });
		assert.equal(changed.length, 11);
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
			readFileSync(join(root, "packages/opencode-plugin/.opencode/plugins/codemem.js"), "utf8"),
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
