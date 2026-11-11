#!/usr/bin/env node
/**
 * Compiles every coordinator statement, of any length, on the SQLite that Wrangler's
 * local D1 runs, which matches production D1. Local better-sqlite3 and the native Vitest pool
 * use an older SQLite with looser limits, so they cannot catch these failures.
 *
 * Steps: run the core coordinator tests with capture on, then, for each schema a
 * statement was prepared on, rebuild that schema in a local D1 and EXPLAIN the
 * statement there. The check fails when a statement exceeds a D1 limit on any schema,
 * compiles on none of them, or a schema object cannot be created. Only test oracles
 * listed in classify.mjs are excluded, and they are reported.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// An alias pinned to the Wrangler whose local D1 matches production. The package's own
// wrangler stays on the version the native Vitest pool supports.
import { getPlatformProxy } from "wrangler-d1-parity";
import {
	aggregateAttempts,
	limitKind,
	orderSchema,
	readCapture,
	schemaExclusionFor,
	staticLimits,
	toCompileOnly,
	verdict,
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

async function compileError(db, sql, values = []) {
	try {
		await db
			.prepare(sql)
			.bind(...values)
			.all();
		return null;
	} catch (error) {
		return String(error?.message ?? error);
	}
}

const DROP_ORDER = ["trigger", "view", "index", "table"];

/** The local D1's own objects, which no captured schema names. */
async function currentSchema(db) {
	const { results } = await db
		.prepare(
			"SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
		)
		.all();
	return results;
}

/**
 * Makes the local D1 hold exactly `objects`: drops what differs, then creates what is
 * missing. Returns each object that could not be created.
 */
async function applySchema(db, objects) {
	const wanted = new Map(objects.map((object) => [object.name, object.sql]));
	const stale = (await currentSchema(db))
		.filter((object) => wanted.get(object.name) !== object.sql)
		.sort((a, b) => DROP_ORDER.indexOf(a.type) - DROP_ORDER.indexOf(b.type));
	for (const object of stale)
		await compileError(db, `DROP ${object.type.toUpperCase()} IF EXISTS "${object.name}"`);
	const present = new Set((await currentSchema(db)).map((object) => object.name));
	const failures = [];
	const excluded = [];
	for (const object of orderSchema(objects)) {
		if (present.has(object.name)) continue;
		const exclusion = schemaExclusionFor(object);
		if (exclusion) {
			excluded.push({ name: object.name, reason: exclusion.reason });
			continue;
		}
		const error = await compileError(db, object.sql);
		if (error) failures.push({ name: object.name, error });
	}
	return { failures, excluded };
}

/** One statement's outcome on the schema now in the local D1. */
async function compileOutcome(db, sql) {
	let compiled;
	try {
		compiled = toCompileOnly(sql);
	} catch (error) {
		return { kind: "refused", message: String(error?.message ?? error) };
	}
	const [limit] = staticLimits(sql, compiled.values.length);
	if (limit) return { kind: "limit", limit };
	const error = await compileError(db, compiled.sql, compiled.values);
	if (!error) return { kind: "compiled" };
	const kind = limitKind(error);
	return kind ? { kind: "limit", limit: kind } : { kind: "error", message: error };
}

/** Compiles each statement on every schema it was prepared on. */
async function checkStatements(db, capture) {
	const attempts = [];
	const schemaFailures = new Map();
	const schemaExcluded = new Map();
	const bySchema = Map.groupBy(capture.statements, (statement) => statement.schema);
	for (const [hash, statements] of bySchema) {
		const objects = capture.schemas.get(hash);
		if (objects) {
			const applied = await applySchema(db, objects);
			for (const failure of applied.failures)
				schemaFailures.set(`${failure.name}\n${failure.error}`, failure);
			for (const entry of applied.excluded) schemaExcluded.set(entry.name, entry);
		}
		for (const { sql, origin } of statements) {
			const outcome = objects ? await compileOutcome(db, sql) : { kind: "schema_missing" };
			attempts.push({ sql, schema: hash, outcome, origin });
		}
	}
	return {
		...aggregateAttempts(attempts),
		schemaFailures: [...schemaFailures.values()],
		schemaExcluded: [...schemaExcluded.values()],
		schemas: bySchema.size,
	};
}

const brief = (sql) => sql.replace(/\s+/g, " ").slice(0, 140);

function report(result, seconds) {
	console.log(
		`Compiled ${result.total} distinct coordinator statements, ${result.attempts} statement and schema pairs, on the ${result.schemas} schemas they were prepared on, in ${seconds}s.`,
	);
	console.log(
		`${result.checked} checked; ${result.erroredElsewhere} pairs failed on one schema but compiled on another; ${result.excluded.length} excused, each listed below.`,
	);
	// Always name every failure and exclusion, so nobody reads the count as full coverage.
	for (const { sql, limits } of result.overLimit) console.log(`over limit (${limits}): ${brief(sql)}`);
	for (const { sql, errors } of result.unchecked)
		console.log(`unchecked (${errors.join("; ").slice(0, 200)}): ${brief(sql)}`);
	for (const { name, error } of result.schemaFailures)
		console.log(`schema object ${name} not created: ${error}`);
	for (const { sql, reason } of result.excluded) console.log(`excluded (${reason}): ${brief(sql)}`);
	for (const { name, reason } of result.schemaExcluded)
		console.log(`schema object ${name} excluded (${reason})`);
	for (const reason of result.unusedExclusions) console.log(`stale exclusion: ${reason}`);
}

async function main() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-d1-statements-"));
	const proxy = await getPlatformProxy({
		configPath: join(here, "wrangler.jsonc"),
		persist: false,
		remoteBindings: false,
	});
	try {
		const started = performance.now();
		const capture = captureStatements(directory);
		const result = await checkStatements(proxy.env.COORDINATOR_DB, capture);
		report(result, ((performance.now() - started) / 1000).toFixed(0));
		const outcome = verdict(result);
		console.log(outcome.message);
		return outcome.ok ? 0 : 1;
	} finally {
		await proxy.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
}

process.exitCode = await main();
