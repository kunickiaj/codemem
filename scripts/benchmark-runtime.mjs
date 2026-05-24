#!/usr/bin/env node

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";

function usage() {
	return `Usage: node scripts/benchmark-runtime.mjs [options] -- <command> [args...]

Options:
  --label <text>      benchmark label (default: command basename)
  --repeat <n>        measured iterations (default: 10)
  --warmup <n>        warmup iterations ignored in stats (default: 2)
  --out <path>        write JSON result to path instead of stdout
  --cwd <path>        command working directory (default: current directory)

Examples:
  node scripts/benchmark-runtime.mjs --label pack --repeat 25 -- codemem pack "release context" --json --db-path /data/mem.sqlite
  node scripts/benchmark-runtime.mjs --label embed --repeat 1 --warmup 0 -- codemem embed --all-projects --db-path /data/mem.sqlite --json
`;
}

function parseArgs(argv) {
	const args = argv[0] === "--" && argv.some((arg, index) => index > 0 && arg === "--") ? argv.slice(1) : argv;
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(usage());
		process.exit(0);
	}
	const separator = args.indexOf("--");
	if (separator < 0) throw new Error("Missing command separator `--`.\n\n" + usage());
	const optionArgs = args.slice(0, separator);
	const command = args.slice(separator + 1);
	if (command.length === 0) throw new Error("Missing command after `--`.\n\n" + usage());

	const options = {
		label: command[0],
		repeat: 10,
		warmup: 2,
		out: null,
		cwd: process.cwd(),
	};

	for (let index = 0; index < optionArgs.length; index += 1) {
		const arg = optionArgs[index];
		const value = optionArgs[index + 1];
		if (!value) throw new Error(`Missing value for ${arg}`);
		if (arg === "--label") options.label = value;
		else if (arg === "--repeat") options.repeat = parsePositiveInt(value, arg);
		else if (arg === "--warmup") options.warmup = parseNonNegativeInt(value, arg);
		else if (arg === "--out") options.out = value;
		else if (arg === "--cwd") options.cwd = value;
		else throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
		index += 1;
	}

	return { options, command };
}

function parsePositiveInt(value, label) {
	if (!/^\d+$/.test(value)) throw new Error(`${label} must be a positive integer`);
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
	return parsed;
}

function parseNonNegativeInt(value, label) {
	if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer`);
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
	return parsed;
}

function percentile(sorted, rank) {
	if (sorted.length === 0) return null;
	const index = Math.min(sorted.length - 1, Math.ceil((rank / 100) * sorted.length) - 1);
	return sorted[index];
}

function summarize(samples) {
	const durations = samples.map((sample) => sample.duration_ms).sort((a, b) => a - b);
	const total = durations.reduce((sum, value) => sum + value, 0);
	return {
		count: durations.length,
		min_ms: durations[0] ?? null,
		max_ms: durations.at(-1) ?? null,
		mean_ms: durations.length > 0 ? total / durations.length : null,
		p50_ms: percentile(durations, 50),
		p95_ms: percentile(durations, 95),
	};
}

async function runCommand(command, cwd) {
	const started = process.hrtime.bigint();
	const child = spawn(command[0], command.slice(1), {
		cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const { code, signal } = await new Promise((resolve, reject) => {
		child.on("error", reject);
		child.on("exit", (code, signal) => resolve({ code, signal }));
	});
	const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
	return { code, signal, duration_ms: durationMs, stdout_bytes: stdout.length, stderr_bytes: stderr.length, stderr };
}

async function main() {
	const { options, command } = parseArgs(process.argv.slice(2));
	const totalRuns = options.warmup + options.repeat;
	const warmup = [];
	const samples = [];

	for (let index = 0; index < totalRuns; index += 1) {
		const result = await runCommand(command, options.cwd);
		if (result.code !== 0) {
			throw new Error(
				`Command failed on iteration ${index + 1} with exit ${result.code ?? result.signal}: ${result.stderr}`,
			);
		}
		const sample = {
			iteration: index + 1,
			duration_ms: result.duration_ms,
			stdout_bytes: result.stdout_bytes,
			stderr_bytes: result.stderr_bytes,
		};
		if (index < options.warmup) warmup.push(sample);
		else samples.push(sample);
	}

	const result = {
		label: options.label,
		created_at: new Date().toISOString(),
		host: {
			hostname: os.hostname(),
			platform: process.platform,
			arch: process.arch,
			cpus: os.cpus().length,
			total_memory_bytes: os.totalmem(),
			node: process.version,
		},
		command,
		warmup_count: options.warmup,
		repeat_count: options.repeat,
		stats: summarize(samples),
		warmup,
		samples,
	};

	const output = `${JSON.stringify(result, null, 2)}\n`;
	if (options.out) writeFileSync(options.out, output, "utf8");
	else process.stdout.write(output);
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
