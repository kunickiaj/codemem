import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertWorkerBundleMetafileClean,
	assertWorkerBundleOutputClean,
	findForbiddenWorkerImports,
	findForbiddenWorkerMetafileModules,
} from "./assert-worker-bundle-clean.mjs";

test("allows Worker-compatible imports", () => {
	const source = 'import { createHash } from "node:crypto";\nimport { Hono } from "hono";';
	assert.deepEqual(findForbiddenWorkerImports(source), []);
});

test("rejects static, dynamic, and generated require imports of forbidden modules", () => {
	const source = [
		'import { createRequire } from "node:module";',
		'import "@codemem/embeddings";',
		'import "@xenova/transformers";',
		'await import("bonjour-service");',
		'const Database = require("better-sqlite3");',
		'const fs = __require("node:fs");',
		'const os = __require2("node:os");',
		'const bareFs = require("fs");',
		'import "os";',
	].join("\n");
	assert.deepEqual(findForbiddenWorkerImports(source), [
		"@codemem/embeddings",
		"@xenova/transformers",
		"better-sqlite3",
		"bonjour-service",
		"fs",
		"node:fs",
		"node:module",
		"node:os",
		"os",
	]);
});

test("allows only the Node imports used by the Worker bundle", () => {
	const source = [
		'import { createHash } from "node:crypto";',
		'import { resolve } from "node:path";',
		'const crypto = require("crypto");',
		'import "path";',
	].join("\n");
	assert.deepEqual(findForbiddenWorkerImports(source), []);
});

test("rejects forbidden packages after the bundler resolves their import specifiers", () => {
	const metafile = {
		inputs: {
			"../embeddings/src/index.ts": {
				bytes: 100,
				imports: [],
			},
			"../core/src/embeddings.ts": {
				bytes: 100,
				imports: [
					{
						path: "../../node_modules/.pnpm/@xenova+transformers@2.17.2/node_modules/@xenova/transformers/src/transformers.js",
						original: "@xenova/transformers",
					},
				],
			},
			"node_modules/@xenova/transformers/src/env.js": {
				bytes: 100,
				imports: [],
			},
		},
	};
	assert.deepEqual(findForbiddenWorkerMetafileModules(metafile), [
		"@codemem/embeddings",
		"@xenova/transformers",
	]);
});

test("allows a clean metafile", () => {
	const metafile = {
		inputs: {
			"../core/src/index.ts": { bytes: 100, imports: [] },
		},
	};
	assert.deepEqual(findForbiddenWorkerMetafileModules(metafile), []);
});

test("rejects an empty bundle metafile", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codemem-worker-metafile-empty-"));
	try {
		const metafilePath = join(directory, "meta.json");
		await writeFile(metafilePath, "{}");
		await assert.rejects(
			assertWorkerBundleMetafileClean(metafilePath),
			/Worker bundle metafile has no inputs:/u,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects malformed bundle metafile imports", () => {
	assert.throws(
		() =>
			findForbiddenWorkerMetafileModules({
				inputs: { "../core/src/index.ts": { imports: {} } },
			}),
		/Worker bundle metafile has invalid imports for: \.\.\/core\/src\/index\.ts/u,
	);
});

test("checks every JavaScript chunk in the bundle output", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codemem-worker-bundle-"));
	try {
		await mkdir(join(directory, "chunks"));
		await writeFile(join(directory, "index.js"), 'import { createHash } from "node:crypto";');
		await writeFile(join(directory, "chunks", "unsafe.js"), 'import "node:fs";');
		await assert.rejects(
			assertWorkerBundleOutputClean(directory),
			/Worker bundle contains forbidden imports: node:fs/u,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("rejects a bundle output with no JavaScript", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codemem-worker-bundle-empty-"));
	try {
		await assert.rejects(
			assertWorkerBundleOutputClean(directory),
			/Worker bundle contains no JavaScript files:/u,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
