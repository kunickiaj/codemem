// DO NOT MERGE: one branch-only Ubuntu measurement, not a replacement CI gate.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, cpus, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const worker = join(root, "packages/cloudflare-coordinator-worker");
const output = join(root, ".tmp/worker-runtime-diagnostic");
const phases = [
	{
		name: "node",
		config: "vitest.node.config.ts",
		files: [
			"src/index.test.ts",
			"src/browser-auth-env.test.ts",
			"src/owner-admin.test.ts",
			"src/configured-worker.test.ts",
			"src/owner-profile-worker.test.ts",
			"src/owner-qualification-runtime.test.ts",
		],
		expectedFiles: 6,
		expectedTests: 220,
	},
	{
		name: "native",
		config: "vitest.config.ts",
		files: [],
		expectedFiles: 118,
		expectedTests: 3113,
	},
];

export function isolatedEnvironment(base = process.env) {
	const env = { ...base };
	for (const name of Object.keys(env)) {
		if (name.startsWith("CODEMEM_") || /(?:^|_)(?:API_KEY|TOKEN|SECRET)$/u.test(name))
			delete env[name];
	}
	const home = mkdtempSync(join(tmpdir(), "codemem-worker-diagnostic-"));
	return {
		...env,
		HOME: home,
		CODEMEM_DB: join(home, "mem.sqlite"),
		CODEMEM_KEYS_DIR: join(home, "keys"),
		CODEMEM_CONFIG: join(home, "config.json"),
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_METRICS: "false",
		CODEMEM_SYNC_KEY_STORE: "file",
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_CACHE_HOME: join(home, "cache"),
		WRANGLER_SEND_METRICS: "false",
		CI: "true",
	};
}

function run(name, args, cwd = root) {
	const started = performance.now();
	console.info(JSON.stringify({ phase: name, event: "start" }));
	const stdout = join(output, `${name}.stdout.log`);
	const stderr = join(output, `${name}.stderr.log`);
	const out = openSync(stdout, "w");
	const err = openSync(stderr, "w");
	// Direct child descriptors retain immediate stage writes even on job cancellation.
	const result = spawnSync("pnpm", args, {
		cwd,
		env: isolatedEnvironment(),
		stdio: ["ignore", out, err],
	});
	closeSync(out);
	closeSync(err);
	process.stdout.write(readFileSync(stdout));
	process.stderr.write(readFileSync(stderr));
	const summary = {
		phase: name,
		exitCode: result.status,
		signal: result.signal,
		spawnFailed: Boolean(result.error),
		elapsedMs: Math.round(performance.now() - started),
	};
	console.info(JSON.stringify(summary));
	return summary;
}

function measure(phase) {
	const report = join(output, `${phase.name}.vitest.json`);
	// Native pool interception hides passing console markers; only change log transport.
	const logging = phase.name === "native" ? ["--disableConsoleIntercept"] : [];
	const result = run(
		phase.name,
		[
			"exec",
			"vitest",
			"run",
			"--config",
			phase.config,
			...phase.files,
			...logging,
			"--reporter=default",
			"--reporter=json",
			"--outputFile",
			report,
		],
		worker,
	);
	let executedTests = null;
	let executedFiles = null;
	try {
		const counts = JSON.parse(readFileSync(report, "utf8"));
		executedTests = counts.numPassedTests + counts.numFailedTests;
		executedFiles = counts.testResults.length;
	} catch {
		// Missing reports, zero tests and partial selections must fail this diagnostic.
	}
	return {
		...result,
		executedTests,
		executedFiles,
		selectionValid: executedTests === phase.expectedTests && executedFiles === phase.expectedFiles,
	};
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	if (process.argv.includes("--plan")) {
		console.info(JSON.stringify(phases, null, 2));
	} else if (process.argv[2] === "--isolated") {
		const child = spawnSync(process.argv[3], process.argv.slice(4), {
			cwd: root,
			env: isolatedEnvironment(),
			stdio: "inherit",
		});
		process.exitCode = child.status ?? 1;
	} else {
		mkdirSync(output, { recursive: true });
		writeFileSync(
			join(output, "runtime.json"),
			JSON.stringify(
				{
					node: process.version,
					platform: platform(),
					arch: arch(),
					availableParallelism: availableParallelism(),
					cpuCount: cpus().length,
					cpuModel: cpus()[0]?.model,
					pnpm: spawnSync("pnpm", ["--version"], { encoding: "utf8" }).stdout?.trim(),
				},
				null,
				2,
			),
		);
		const prerequisite = run("bundle", [
			"--filter",
			"@codemem/cloudflare-coordinator-worker",
			"check:bundle",
		]);
		// Always measure BOTH phases once; retain the first failure in the final exit.
		const results = [prerequisite, ...phases.map(measure)];
		writeFileSync(join(output, "summary.json"), JSON.stringify(results, null, 2));
		if (results.some((r) => r.exitCode !== 0 || r.spawnFailed || r.selectionValid === false))
			process.exitCode = 1;
	}
}
