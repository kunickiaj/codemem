import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	assertWorkerBundleOutputClean,
	findForbiddenWorkerImports,
} from "./assert-worker-bundle-clean.mjs";

test("allows Worker-compatible imports", () => {
	const source = 'import { createHash } from "node:crypto";\nimport { Hono } from "hono";';
	assert.deepEqual(findForbiddenWorkerImports(source), []);
});

test("rejects static, dynamic, and generated require imports of forbidden modules", () => {
	const source = [
		'import { createRequire } from "node:module";',
		'await import("bonjour-service");',
		'const Database = require("better-sqlite3");',
		'const fs = __require("node:fs");',
		'const os = __require2("node:os");',
		'const bareFs = require("fs");',
		'import "os";',
	].join("\n");
	assert.deepEqual(findForbiddenWorkerImports(source), [
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
