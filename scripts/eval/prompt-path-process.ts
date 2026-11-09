import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathResult } from "./prompt-path.js";
import { runCommand } from "./prompt-path-children.js";
import {
	PromptPathBenchmarkError,
	parseSubprocessLog,
	subprocessActivitySettled,
	summarizeTimings,
} from "./prompt-path-lib.js";

export type PhaseName = "direct_cli" | "healthy_viewer_plugin" | "viewer_unavailable_cli_fallback";

export interface PhaseRequest {
	phase: PhaseName;
	repetitions: number;
	root: string;
	tempRoot: string;
}

export interface PhaseResponse {
	result: PathResult;
	counterLog: string;
}

export interface PhaseProcessOptions {
	root: string;
	workerEntrypoint?: string;
	timeoutMs?: number;
	env?: NodeJS.ProcessEnv;
}

function isolatedEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	// Only this harness opts into removing inherited application configuration.
	return Object.fromEntries(
		Object.entries(base).filter(
			([key]) => !key.startsWith("CODEMEM_") || key === "CODEMEM_EMBEDDING_DISABLED",
		),
	);
}

function validateResponse(stdout: string, counterLog: string, repetitions: number): PathResult {
	const response = JSON.parse(stdout) as PhaseResponse;
	const activity = parseSubprocessLog(counterLog);
	if (response.counterLog !== counterLog || !subprocessActivitySettled(activity)) {
		throw new PromptPathBenchmarkError(
			"harness",
			"phase activity changed during shutdown or did not settle",
		);
	}
	const result = response.result;
	if (
		!result ||
		result.attempted !== repetitions ||
		!Array.isArray(result.sorted_ms) ||
		result.succeeded !== result.sorted_ms.length ||
		result.sorted_ms.some((value) => !Number.isFinite(value) || value < 0) ||
		!result.failures ||
		!["terminal_contract", "retryable_transport_protocol", "harness"].every(
			(key) =>
				Number.isInteger(result.failures[key as keyof typeof result.failures]) &&
				result.failures[key as keyof typeof result.failures] >= 0,
		) ||
		!result.subprocesses ||
		!Object.entries(activity.counts).every(
			([key, value]) => result.subprocesses[key as keyof typeof result.subprocesses] === value,
		)
	) {
		throw new PromptPathBenchmarkError("harness", "phase returned an invalid aggregate");
	}
	// Keep worker-only fields and private fixture paths out of the public report.
	const summary = summarizeTimings(result.sorted_ms, repetitions, {
		terminal_contract: result.failures.terminal_contract,
		retryable_transport_protocol: result.failures.retryable_transport_protocol,
		harness: result.failures.harness,
	});
	if (
		summary.median_ms !== result.median_ms ||
		summary.p95_ms !== result.p95_ms ||
		Object.values(summary.failures).reduce((sum, count) => sum + count, summary.succeeded) !==
			repetitions
	) {
		throw new PromptPathBenchmarkError("harness", "phase timing aggregate is inconsistent");
	}
	return { ...summary, subprocesses: activity.counts };
}

export async function runPhaseProcess(
	phase: PhaseName,
	repetitions: number,
	options: PhaseProcessOptions,
): Promise<PathResult> {
	const tempRoot = mkdtempSync(join(tmpdir(), "codemem-prompt-phase-"));
	const controller = new AbortController();
	const interrupt = () => controller.abort();
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		const request: PhaseRequest = { phase, repetitions, root: options.root, tempRoot };
		const worker =
			options.workerEntrypoint ??
			fileURLToPath(new URL("./prompt-path-worker.ts", import.meta.url));
		const { stdout } = await runCommand(
			process.execPath,
			["--import", "tsx", "--conditions", "source", worker],
			{
				cwd: options.root,
				env: {
					...isolatedEnvironment(process.env),
					...options.env,
					HOME: tempRoot,
					XDG_CONFIG_HOME: join(tempRoot, "config"),
					CODEMEM_KEYS_DIR: join(tempRoot, "keys"),
					CODEMEM_SYNC_ENABLED: "0",
				},
				stdin: JSON.stringify(request),
				timeoutMs: options.timeoutMs ?? (repetitions + 2) * 240_000 + 120_000,
				stopGroupOnExit: true,
				signal: controller.signal,
			},
		);
		return validateResponse(
			stdout,
			readFileSync(join(tempRoot, "subprocess.log"), "utf8"),
			repetitions,
		);
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		rmSync(tempRoot, { recursive: true, force: true });
	}
}
