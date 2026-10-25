import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { computeSharedInputs } from "./ci-package-inputs.mjs";

const fixtures = fileURLToPath(new URL("../.tmp/ci-shared-input-tests/", import.meta.url));
fs.mkdirSync(fixtures, { recursive: true });
const gitEnv = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
function fixture() {
	const root = fs.mkdtempSync(join(fixtures, "repo-"));
	const git = (...args) => execFileSync("git", args, { cwd: root, env: gitEnv, stdio: "pipe" });
	const write = (path, text = "initial\n") => {
		fs.mkdirSync(dirname(join(root, path)), { recursive: true });
		fs.writeFileSync(join(root, path), text);
	};
	git("init", "--quiet");
	write(".gitignore", "node_modules/\n.tmp/\n");
	for (const path of [
		"package.json",
		"root.config",
		"packages/a/package.json",
		"packages/b/package.json",
		"packages/a/src.js",
		"packages/b/src.js",
	])
		write(path);
	const commit = () => {
		git("add", "--all");
		git(
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		);
	};
	commit();
	const packages = ["a", "b"].map((name) => ({ name, path: join(root, "packages", name) }));
	return {
		root,
		git,
		write,
		commit,
		packages,
		compute: () => computeSharedInputs(root, { packages }),
	};
}
function assertUncertain(result) {
	assert.equal(result.cacheable, false);
	assert.equal(result.reason, "Shared inputs could not be verified");
	assert.match(result.digest, /^[a-f0-9]{64}$/u);
}

// Every tracked root input is shared, without a maintained input manifest.
for (const path of [
	"root.config",
	"package.json",
	"packages/a/package.json",
	"packages/b/package.json",
	"future/tool.config",
]) {
	it(`invalidates shared inputs when ${path} changes or appears`, () => {
		// Arrange
		const f = fixture();
		const before = f.compute();
		// Act
		f.write(path, "changed\n");
		f.commit();
		const after = f.compute();
		// Assert
		assert.equal(before.cacheable, true);
		assert.equal(after.cacheable, true);
		assert.notEqual(after.digest, before.digest);
		assert.ok(after.files.includes(path));
	});
}

for (const change of ["delete", "rename", "mode"]) {
	it(`invalidates on tracked shared input ${change}`, () => {
		// Arrange
		const f = fixture();
		const before = f.compute();
		// Act
		if (change === "delete") fs.unlinkSync(join(f.root, "root.config"));
		if (change === "rename") f.git("mv", "root.config", "renamed.config");
		if (change === "mode") fs.chmodSync(join(f.root, "root.config"), 0o755);
		const after = f.compute();
		// Assert
		assert.equal(after.cacheable, true);
		assert.notEqual(after.digest, before.digest);
	});
}

it("leaves package source and ignored root artifacts to native caching", () => {
	// Arrange
	const f = fixture();
	const before = f.compute();
	// Act
	f.write("packages/a/src.js", "changed");
	f.write("packages/b/untracked.js", "native input");
	f.write("node_modules/artifact", "ignored");
	f.write(".tmp/artifact", "ignored");
	const after = f.compute();
	// Assert
	assert.deepEqual(after, before);
	assert.equal(after.cacheable, true);
	assert.ok(!after.files.includes("packages/a/src.js"));
});

it("rejects untracked shared content without hashing it or exposing it", (t) => {
	// Arrange
	const f = fixture();
	f.write("private.config", "synthetic-private-marker");
	const read = fs.readFileSync;
	let privateReads = 0;
	t.mock.method(fs, "readFileSync", (path, ...args) => {
		if (String(path) === join(f.root, "private.config")) privateReads++;
		return read(path, ...args);
	});
	syncBuiltinESMExports();
	// Act
	let result;
	try {
		result = f.compute();
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	// Assert
	assertUncertain(result);
	assert.equal(privateReads, 0);
	assert.ok(!JSON.stringify(result).includes("synthetic-private-marker"));
});

for (const target of ["packages/a/src.js", "packages/a"]) {
	it(`follows shared symlink ${target} to actual tracked package bytes`, () => {
		// Arrange
		const f = fixture();
		fs.symlinkSync(target, join(f.root, "shared-link"));
		f.commit();
		const before = f.compute();
		// Act
		f.write("packages/a/src.js", "target changed");
		const after = f.compute();
		// Assert
		assert.equal(before.cacheable, true);
		assert.equal(after.cacheable, true);
		assert.ok(after.files.includes("packages/a/src.js"));
		assert.notEqual(after.digest, before.digest);
	});
}

for (const target of ["cycle", "packages/a/untracked.js", "packages/a"]) {
	it(`fails closed for cyclic or untracked shared symlink target ${target}`, () => {
		// Arrange
		const f = fixture();
		fs.symlinkSync(target, join(f.root, "cycle"));
		f.commit();
		f.write("packages/a/untracked.js", "unknown input");
		// Act
		const result = f.compute();
		// Assert
		assertUncertain(result);
	});
}

it("rejects outside symlinks without reading their target", (t) => {
	// Arrange
	const f = fixture();
	const outside = fs.mkdtempSync(join(fixtures, "outside-"));
	const target = join(outside, "private");
	fs.writeFileSync(target, "synthetic-external-marker");
	fs.symlinkSync(target, join(f.root, "shared-link"));
	f.commit();
	const read = fs.readFileSync;
	let targetReads = 0;
	t.mock.method(fs, "readFileSync", (path, ...args) => {
		if (String(path) === target) targetReads++;
		return read(path, ...args);
	});
	syncBuiltinESMExports();
	// Act
	let result;
	try {
		result = f.compute();
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
	}
	// Assert
	assertUncertain(result);
	assert.equal(targetReads, 0);
	assert.ok(!JSON.stringify(result).includes("synthetic-external-marker"));
});

it("injects discovery and keeps results stable across package order", () => {
	// Arrange
	const f = fixture();
	const calls = [];
	// Act
	const result = computeSharedInputs(f.root, {
		listSource: (root) => {
			calls.push(root);
			return [...f.packages].reverse();
		},
	});
	// Assert
	assert.deepEqual(calls, [fs.realpathSync(f.root)]);
	assert.deepEqual(result, f.compute());
	assert.deepEqual(result.files, [...result.files].sort());
});

for (const discovery of ["outside", "invalid", "throws"]) {
	it(`fails closed when package discovery is ${discovery}`, () => {
		// Arrange
		const f = fixture();
		const outside = fs.mkdtempSync(join(fixtures, "project-"));
		const listSource = () => {
			if (discovery === "throws") throw new Error("synthetic discovery failure");
			if (discovery === "invalid") return [{ name: "invalid" }];
			return [{ name: "external", path: outside }];
		};
		// Act
		const result = computeSharedInputs(f.root, { listSource });
		// Assert
		assertUncertain(result);
		assert.ok(!JSON.stringify(result).includes(outside));
	});
}
