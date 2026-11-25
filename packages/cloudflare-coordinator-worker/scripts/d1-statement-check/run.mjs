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
import { readCapture, verdict } from "./classify.mjs";
import { checkStatements } from "./compile.mjs";

const here = import.meta.dirname;
const packageRoot = resolve(here, "../..");

// The owner-proof suite runs 500-subject cases and must not share a runner with other
// suites, so it is captured alone with one worker, as test:ci:isolated runs it.
const ISOLATED_SUITE = "coordinator-legacy-completion-owner-proof.test.ts";
const CAPTURE_RUNS = [
	{ name: "core coordinator tests", selection: ["--exclude", `**/${ISOLATED_SUITE}`] },
	{ name: "owner-proof suite", selection: [`src/${ISOLATED_SUITE}`, "--maxWorkers=1"] },
];

const secondsSince = (started) => Math.round((performance.now() - started) / 1000);

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

/** The captured statements and schemas, and how long each capture run took. */
function captureStatements(directory) {
	const runs = CAPTURE_RUNS.map(({ name, selection }) => {
		const started = performance.now();
		runCapture(directory, selection);
		return { name, seconds: secondsSince(started) };
	});
	const lines = readdirSync(directory).flatMap((file) =>
		readFileSync(join(directory, file), "utf8").split("\n"),
	);
	return { capture: readCapture(lines), runs };
}

const brief = (sql) => sql.replace(/\s+/g, " ").slice(0, 140);

function reportCapture({ capture, runs }) {
	const seconds = runs.reduce((total, run) => total + run.seconds, 0);
	const each = runs.map((run) => `${run.name} ${run.seconds}s`).join(", ");
	console.log(
		`Captured ${capture.statements.length} statement and schema pairs and ${capture.schemas.size} schemas in ${seconds}s (${each}).`,
	);
}

function report(result, seconds) {
	console.log(
		`Compiled ${result.total} distinct coordinator statements, ${result.attempts} statement and schema pairs, on the ${result.schemas} schemas they were prepared on, rebuilding ${result.schemasRebuilt} schemas in the local D1, in ${seconds}s.`,
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
		const captured = captureStatements(directory);
		reportCapture(captured);
		const started = performance.now();
		const result = await checkStatements(proxy.env.COORDINATOR_DB, captured.capture);
		report(result, secondsSince(started));
		const outcome = verdict(result);
		console.log(outcome.message);
		return outcome.ok ? 0 : 1;
	} finally {
		await proxy.dispose();
		rmSync(directory, { recursive: true, force: true });
	}
}

process.exitCode = await main();
