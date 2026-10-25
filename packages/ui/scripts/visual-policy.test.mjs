import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	assertCanonicalPlatform,
	GOLDEN_FILES,
	HARNESS_FILES,
	isGalleryRequest,
	isPublicSource,
	parseMode,
	selectSourcePaths,
	snapshotMode,
	validateGeneratedGoldens,
} from "./visual-policy.mjs";

test("canonical platform accepts Linux x64", () => {
	// Arrange
	const runtime = { platform: "linux", arch: "x64" };
	// Act
	const result = assertCanonicalPlatform(runtime);
	// Assert
	assert.equal(result, undefined);
});

test("noncanonical platforms fail with Docker wrapper instructions", () => {
	// Arrange
	const runtimes = [
		{ platform: "darwin", arch: "arm64" },
		{ platform: "darwin", arch: "x64" },
		{ platform: "linux", arch: "arm64" },
		{ platform: "win32", arch: "x64" },
	];
	// Act / Assert
	for (const runtime of runtimes) {
		assert.throws(
			() => assertCanonicalPlatform(runtime),
			/Linux x64.*visual:test or visual:update.*Docker wrapper/,
		);
	}
});

test("staging accepts public source and explicit harness additions", () => {
	// Arrange
	const paths = [
		"pnpm-lock.yaml",
		"packages/ui/static/tokens.css",
		...HARNESS_FILES,
		...GOLDEN_FILES,
	];
	// Act
	const results = paths.map(isPublicSource);
	// Assert
	assert.ok(results.every(Boolean));
});

test("source selection deduplicates tracked files and never scans unrelated untracked paths", () => {
	// Arrange
	const tracked = ["package.json", "package.json", ".env.local", ".tmp/private.sqlite"];
	// Act
	const selected = selectSourcePaths(tracked);
	// Assert
	assert.deepEqual(selected, ["package.json", ...HARNESS_FILES, ...GOLDEN_FILES]);
	assert.equal(selected.includes("packages/ui/unrelated-untracked.ts"), false);
});

test("staging rejects secrets, private databases, dependencies and generated paths", () => {
	// Arrange
	const paths = [
		".git/config",
		".beads/issues.jsonl",
		".tmp/private.txt",
		".env",
		"packages/ui/.env.local",
		"node_modules/a.js",
		".opencode/config.json",
		".venv/bin/python",
		"data.sqlite-wal",
		"nested/private.db",
		"packages/ui/dist/app.js",
		"packages/viewer-server/static/app.js",
		"../secret",
		"packages/../secret",
		"packages/ui/../../secret",
		"packages//secret",
		"/secret",
	];
	// Act
	const results = paths.map(isPublicSource);
	// Assert
	assert.ok(results.every((result) => !result));
});

test("staging rejects npm configuration at every depth regardless of case", () => {
	const paths = [
		".npmrc",
		".NPMRC",
		"packages/pkg/.npmrc",
		"packages/pkg/.NpMrC",
		"nested/deeper/.npmrc",
		".npmrc/child",
		"../.npmrc",
		"packages/../.npmrc",
	];
	assert.ok(paths.every((path) => !isPublicSource(path)));
	const selected = selectSourcePaths(paths);
	assert.deepEqual(selected, [...HARNESS_FILES, ...GOLDEN_FILES]);
});

test("source selection never loads synthetic npm authentication fixtures", () => {
	const fixtures = new Map([
		["package.json", '{"name":"synthetic-public-fixture"}'],
		[".npmrc", "//registry.npmjs.org/:_authToken=SYNTHETIC_NOT_A_CREDENTIAL"],
		["packages/pkg/.npmrc", "_auth=SYNTHETIC_NOT_A_CREDENTIAL"],
		["packages/pkg/.NPMRC", "_password=SYNTHETIC_NOT_A_CREDENTIAL"],
		["untracked/.npmrc", "_auth=SYNTHETIC_NOT_A_CREDENTIAL"],
	]);
	const tracked = ["package.json", ".npmrc", "packages/pkg/.npmrc", "packages/pkg/.NPMRC"];
	/** @type {string[]} */
	const loaded = [];
	selectSourcePaths(tracked).forEach((path) => {
		const content = fixtures.get(path);
		if (content === undefined) return;
		loaded.push(path);
		assert.doesNotMatch(content, /_auth|_password/);
	});
	assert.deepEqual(loaded, ["package.json"]);
});

test("container installs use generated public registry config without forwarding host config", () => {
	const runner = readFileSync(new URL("./visual-runner.mjs", import.meta.url), "utf8");
	assert.match(runner, /printf 'registry=https:\/\/registry\.npmjs\.org\/\\\\n' > \/work\/\.npmrc/);
	assert.match(runner, /NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\//);
	assert.match(runner, /npm install --global --prefix \/work\/\.tools/);
	assert.match(runner, /HUSKY=0 pnpm install --frozen-lockfile/);
	assert.doesNotMatch(runner, /"--env",\s*"[^"=]+"/u);
	assert.doesNotMatch(
		runner,
		/process\.env\.(?:NPM|npm|PNPM|pnpm)|--network|--ignore-scripts|--allow-build/,
	);
});

test("browser requests permit local assets but reject APIs and external origins", () => {
	// Arrange
	const addresses = [
		"http://127.0.0.1:38923/gallery.html",
		"http://127.0.0.1:38923/src/gallery.css",
		"http://127.0.0.1:38923/api/stats",
		"https://example.com/font.woff2",
		"http://127.0.0.1:38922/gallery.html",
	];
	// Act
	const results = addresses.map(isGalleryRequest);
	// Assert
	assert.deepEqual(results, [true, true, false, false, false]);
});

test("normal, control and explicit local update modes are accepted", () => {
	// Arrange
	const args = [[], ["--control"], ["--update"]];
	// Act
	const results = args.map((value) => parseMode(value, undefined));
	// Assert
	assert.deepEqual(results, ["test", "--control", "--update"]);
});

test("CI updates and unknown runner options fail closed", () => {
	// Arrange
	const cases = [
		{ args: ["--update"], ci: "1" },
		{ args: ["--update-snapshots"], ci: undefined },
		{ args: ["--control", "--update"], ci: undefined },
	];
	// Act / Assert
	for (const { args, ci } of cases) assert.throws(() => parseMode(args, ci));
});

test("snapshot policy never updates by default and permits explicit local authoring", () => {
	// Arrange
	const normal = { args: [], ci: "1" };
	// Act
	const modes = [
		snapshotMode(normal),
		snapshotMode({ args: [], update: "1", browserPath: "/ms-playwright" }),
	];
	// Assert
	assert.deepEqual(modes, ["none", "changed"]);
});

test("snapshot policy rejects CLI overrides and CI authoring", () => {
	// Arrange
	const flags = ["-u", "-uall", "--update-snapshots", "--update-snapshots=all"];
	// Act / Assert
	for (const flag of flags) assert.throws(() => snapshotMode({ args: [flag] }));
	assert.throws(() => snapshotMode({ args: [], ci: "true", update: "1" }));
});

test("snapshot policy rejects ignored comparisons and bare-Linux updates", () => {
	// Arrange
	const flags = ["--ignore-snapshots", "--ignore-snapshots=true", "--ignore-snapshots=false"];
	// Act / Assert
	for (const flag of flags) assert.throws(() => snapshotMode({ args: [flag] }), /cannot ignore/);
	for (const browserPath of [undefined, "", "/home/browsers"]) {
		assert.throws(
			() => snapshotMode({ args: [], update: "1", browserPath }),
			/visual:update Docker wrapper/,
		);
	}
	assert.equal(snapshotMode({ args: [], browserPath: "/other" }), "none");
});

test("golden validation returns all approved paths despite enumeration order", () => {
	// Arrange
	const expected = GOLDEN_FILES.map((path) =>
		path.replace("packages/ui/visual/__screenshots__/", ""),
	);
	// Act
	const approved = validateGeneratedGoldens([...expected].reverse());
	// Assert
	assert.deepEqual(approved, expected);
});

test("golden validation rejects extra, missing, duplicate and traversal paths before copy-back", () => {
	// Arrange
	const expected = GOLDEN_FILES.map((path) =>
		path.replace("packages/ui/visual/__screenshots__/", ""),
	);
	const invalid = [
		[...expected, "desktop-dark/extra.png"],
		expected.slice(1),
		[expected[0], ...expected.slice(0, -1)],
		["../outside.png", ...expected.slice(1)],
		["desktop-dark/../all-families.png", ...expected.slice(1)],
		["/desktop-dark/all-families.png", ...expected.slice(1)],
	];
	// Act / Assert
	for (const paths of invalid)
		assert.throws(() => validateGeneratedGoldens(paths), /exactly the 24 approved/);
});

test("gallery screenshot names and project matrix match the golden allowlist", () => {
	// Arrange
	const spec = readFileSync(new URL("../visual/gallery.spec.ts", import.meta.url), "utf8");
	const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
	// Act
	const names = [...spec.matchAll(/assertScreenshot\([^,]+, "([^"]+\.png)"\)/g)].map(
		(match) => match[1],
	);
	const paths = ["desktop-dark", "desktop-light", "narrow-dark", "narrow-light"].flatMap(
		(project) => names.map((name) => `${project}/${name}`),
	);
	// Assert
	assert.equal(names.length, 5);
	assert.equal(validateGeneratedGoldens(paths).length, 20);
	assert.match(config, /\[1280, 390\]\.flatMap/);
	assert.match(config, /\["dark", "light"\] as const/);
	assert.match(config, /name: `webkit-narrow-\$\{colorScheme\}`/);
	assert.match(config, /testMatch: "layout\.spec\.ts"/);
});

test("layout checks are explicitly staged without adding WebKit goldens", () => {
	// Arrange
	const path = "packages/ui/visual/layout.spec.ts";
	// Act
	const selected = selectSourcePaths([]);
	// Assert
	assert.ok(HARNESS_FILES.includes(path));
	assert.ok(selected.includes(path));
	assert.equal(GOLDEN_FILES.length, 20);
	assert.ok(GOLDEN_FILES.every((golden) => !golden.includes("webkit")));
	assert.equal(selected.includes("packages/ui/visual/unapproved.spec.ts"), false);
});
