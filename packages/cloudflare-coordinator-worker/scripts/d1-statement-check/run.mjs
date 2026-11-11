#!/usr/bin/env node
/**
 * Compiles every large coordinator statement on the SQLite that Wrangler's local D1
 * runs, which matches production D1. Local better-sqlite3 and the native Vitest pool
 * use an older SQLite with looser limits, so they cannot catch these failures.
 *
 * Steps: run the core coordinator tests with capture on, rebuild their schema in a
 * local D1, EXPLAIN each captured statement there, and compare with baseline.json.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// An alias pinned to the Wrangler whose local D1 matches production. The package's own
// wrangler stays on the version the native Vitest pool supports.
import { getPlatformProxy } from "wrangler-d1-parity";
import {
	compareWithBaseline,
	limitKind,
	orderSchema,
	readCapture,
	toCompileOnly,
} from "./classify.mjs";

const here = import.meta.dirname;
const packageRoot = resolve(here, "../..");

// The owner-proof suite runs 500-subject cases and must not share a runner with other
// suites, so it is captured alone with one worker, as test:ci:isolated runs it.
const ISOLATED_SUITE = "coordinator-legacy-completion-owner-proof.test.ts";
const CAPTURE_RUNS = [
	["--exclude", `**/${ISOLATED_SUITE}`],
	[`src/${ISOLATED_SUITE}`, "--maxWorkers=1"],
];

function runCapture(directory, selection) {
	const result = spawnSync(
		"pnpm",
		["exec", "vitest", "run", "--config", join(here, "capture.vitest.config.ts"), ...selection],
		{
			cwd: packageRoot,
			env: { ...process.env, CODEMEM_D1_STATEMENT_CAPTURE_DIR: directory },
			stdio: ["ignore", "ignore", "inherit"],
		},
	);
	if (result.status !== 0) throw new Error("The core coordinator tests failed during capture.");
}

function captureStatements(directory) {
	for (const selection of CAPTURE_RUNS) runCapture(directory, selection);
	const lines = readdirSync(directory).flatMap((file) =>
		readFileSync(join(directory, file), "utf8").split("\n"),
	);
	return readCapture(lines);
}

async function compileError(db, sql) {
	try {
		await db.prepare(sql).all();
		return null;
	} catch (error) {
		return String(error?.message ?? error);
	}
}

async function buildSchema(db, objects) {
	let failed = 0;
	for (const object of orderSchema(objects)) if (await compileError(db, object.sql)) failed += 1;
	return failed;
}

async function checkStatements(db, statements) {
	const overLimit = [];
	const unchecked = [];
	for (const sql of statements) {
		const error = await compileError(db, toCompileOnly(sql));
		const kind = limitKind(error);
		if (kind) overLimit.push({ kind, sql });
		else if (error) unchecked.push({ kind: error, sql });
	}
	return { overLimit, unchecked };
}

function report(result, total, schemaFailures) {
	console.log(`Compiled ${total} coordinator statements on Wrangler's local D1.`);
	if (schemaFailures) console.log(`${schemaFailures} schema objects could not be created.`);
	if (result.unchecked.length)
		console.log(
			`${result.unchecked.length} statements failed for other reasons and were not checked.`,
		);
	if (!process.env.CODEMEM_D1_STATEMENT_CHECK_VERBOSE) return;
	for (const { kind, sql } of [...result.overLimit, ...result.unchecked])
		console.log(`${kind}: ${sql.replace(/\s+/g, " ").slice(0, 110)}`);
}

async function main() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-d1-statements-"));
	const proxy = await getPlatformProxy({
		configPath: join(here, "wrangler.jsonc"),
		persist: false,
		remoteBindings: false,
	});
	try {
		const capture = captureStatements(directory);
		const db = proxy.env.COORDINATOR_DB;
		const schemaFailures = await buildSchema(db, capture.schema);
		const result = await checkStatements(db, capture.statements);
		report(result, capture.statements.length, schemaFailures);
		const baseline = JSON.parse(readFileSync(join(here, "baseline.json"), "utf8"));
		const verdict = compareWithBaseline(result.overLimit.length, baseline);
		console.log(verdict.message);
		return verdict.ok ? 0 : 1;
	} finally {
		await proxy.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
}

process.exitCode = await main();
