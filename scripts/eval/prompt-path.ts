import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MemoryStore } from "@codemem/core";
import {
	CommandInterruptedError,
	killProcessGroup,
	ownedChildren,
	runCommand,
	stopOwnedChildren,
} from "./prompt-path-children.js";
import {
	classifyFailure,
	emptyFailureCounts,
	evaluatePromptPathGate,
	PromptPathBenchmarkError,
	parseSubprocessLog,
	RELEASE_REPETITIONS,
	type SubprocessCounts,
	subprocessActivitySettled,
	summarizeTimings,
	type TimingSummary,
} from "./prompt-path-lib.js";
import { type PhaseRequest, runPhaseProcess } from "./prompt-path-process.js";

const PROMPT = "trace prompt path latency and preserve classified fallback";
const PROJECT = "codemem-benchmark";
const CLI_TIMEOUT_MS = 120_000;
const VIEWER_START_TIMEOUT_MS = 30_000;
const LEDGER_SETTLE_TIMEOUT_MS = 30_000;
const STARTUP_SETTLE_TIMEOUT_MS = 30_000;
const HEALTHY_POST_MEASURE_OBSERVE_MS = 2_000;
const POLL_INTERVAL_MS = 25;

type Hook = (input: { sessionID: string }, output: MessageOutput) => Promise<void>;
type PluginFactory = (input: {
	project: { name: string };
	client: { app: { log: () => Promise<void> }; tui: Record<string, never> };
	directory: string;
	worktree: string;
}) => Promise<Record<string, unknown>>;

interface MessageOutput {
	messages: Array<{
		info: { id: string; sessionID: string; role: "user" };
		parts: Array<{
			id: string;
			sessionID: string;
			messageID: string;
			type: "text";
			text: string;
			synthetic?: boolean;
		}>;
	}>;
}

export interface PathResult extends TimingSummary {
	subprocesses: SubprocessCounts;
}

interface BenchmarkReport {
	schema_version: 1;
	repetitions: number;
	discarded_warmups_per_path: 1;
	release_gate_eligible: boolean;
	run_valid: boolean;
	paths: {
		direct_cli: PathResult;
		healthy_viewer_plugin: PathResult;
		viewer_unavailable_cli_fallback: PathResult & {
			expected_transport_failure: "viewer_unavailable_retryable";
		};
	};
	gate: {
		passed: boolean;
		healthy_median_improved: boolean;
		healthy_p95_not_regressed: boolean;
		healthy_zero_pack_ledger_subprocesses: boolean;
		all_repetitions_succeeded: boolean;
	};
}

function parseRepetitions(argv: readonly string[]): number {
	const index = argv.indexOf("--repetitions");
	if (index === -1) return RELEASE_REPETITIONS;
	const raw = argv[index + 1] ?? "";
	if (!/^\d+$/.test(raw) || Number(raw) < 1) {
		throw new Error("--repetitions must be a positive integer");
	}
	return Number(raw);
}

function runnerSource(): string {
	return `import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
let kind = "other";
if (args[0] === "pack" || (args[0] === "memory" && args[1] === "pack")) kind = "pack";
else if (args[0] === "prompt-pack-ledger") kind = "ledger";
appendFileSync(process.env.CODEMEM_BENCH_COUNTER, "start " + kind + "\\n");
const input = readFileSync(0);
const result = spawnSync("pnpm", ["exec", "tsx", "--conditions", "source", process.env.CODEMEM_BENCH_CLI, ...args], {
  cwd: process.env.CODEMEM_BENCH_ROOT,
  env: process.env,
  input,
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
const status = Number.isInteger(result.status) ? result.status : 1;
appendFileSync(process.env.CODEMEM_BENCH_COUNTER, "end " + kind + " " + status + "\\n");
process.exitCode = status;
`;
}

function readSubprocessCounts(counterPath: string): SubprocessCounts {
	return parseSubprocessLog(readFileSync(counterPath, "utf8")).counts;
}

function readSubprocessActivity(counterPath: string): { started: number; ended: number } {
	const { started, ended } = parseSubprocessLog(readFileSync(counterPath, "utf8"));
	return { started, ended };
}

function resetSubprocessCounts(counterPath: string): void {
	writeFileSync(counterPath, "", "utf8");
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
	timeoutMs: number,
	message: string,
): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (performance.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolveWait) => setTimeout(resolveWait, POLL_INTERVAL_MS));
	}
	throw new PromptPathBenchmarkError("harness", message);
}

async function settlePluginStartupChecks(counterPath: string): Promise<void> {
	// Plugin initialization schedules verifyCliCompatibility, whose version CLI
	// invocation is recorded as `other`; observe that causal event before reset.
	await waitFor(
		() => {
			const counts = readSubprocessCounts(counterPath);
			return counts.other >= 1 && subprocessActivitySettled(readSubprocessActivity(counterPath));
		},
		STARTUP_SETTLE_TIMEOUT_MS,
		"plugin compatibility version subprocess did not start and settle",
	);
}

async function observeHealthySubprocessQuiescence(counterPath: string): Promise<void> {
	// This bounded post-measurement window catches delayed work without adding it
	// to measured latency. Two seconds is a defense-in-depth heuristic; the healthy
	// path has no known per-request delayed spawn source. The aggregate count below
	// still fails on completed work.
	await new Promise((resolveWait) => setTimeout(resolveWait, HEALTHY_POST_MEASURE_OBSERVE_MS));
	await waitFor(
		() => subprocessActivitySettled(readSubprocessActivity(counterPath)),
		CLI_TIMEOUT_MS,
		"healthy path subprocesses did not settle",
	);
}

async function reservePort(): Promise<number> {
	const { createServer } = await import("node:net");
	return new Promise((resolvePort, rejectPort) => {
		const server = createServer();
		server.once("error", rejectPort);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				rejectPort(new Error("could not reserve benchmark port"));
				return;
			}
			server.close((error) => (error ? rejectPort(error) : resolvePort(address.port)));
		});
	});
}

async function loadPlugin(): Promise<PluginFactory> {
	const moduleUrl = new URL(
		"../../packages/opencode-plugin/.opencode/plugins/codemem.js",
		import.meta.url,
	).href;
	const pluginModule = (await import(moduleUrl)) as { CodememPlugin?: PluginFactory };
	if (typeof pluginModule.CodememPlugin !== "function") {
		throw new Error("canonical CodememPlugin export is unavailable");
	}
	return pluginModule.CodememPlugin;
}

function createMessageOutput(iteration: number, sessionID: string): MessageOutput {
	const messageId = `benchmark-message-${iteration}`;
	return {
		messages: [
			{
				info: { id: messageId, sessionID, role: "user" },
				parts: [
					{
						id: `${messageId}-text`,
						sessionID,
						messageID: messageId,
						type: "text",
						text: PROMPT,
					},
				],
			},
		],
	};
}

function assertInjected(output: MessageOutput): void {
	const injected = output.messages[0]?.parts.some(
		(part) => part.synthetic === true && part.id.startsWith("codemem-context-"),
	);
	if (!injected) {
		throw new PromptPathBenchmarkError("terminal_contract", "plugin did not inject a pack");
	}
}

async function createPluginHook(
	pluginFactory: PluginFactory,
	root: string,
	viewerPort: number,
	options: { onDispose: (dispose: () => Promise<void>) => void },
): Promise<Hook> {
	process.env.CODEMEM_VIEWER_PORT = String(viewerPort);
	const hooks = await pluginFactory({
		project: { name: PROJECT },
		client: { app: { log: async () => undefined }, tui: {} },
		directory: root,
		worktree: root,
	});
	const hook = hooks["experimental.chat.messages.transform"];
	if (typeof hook !== "function") throw new Error("message transform hook is unavailable");
	if (typeof hooks.dispose === "function") options.onDispose(hooks.dispose as () => Promise<void>);
	return hook as Hook;
}

async function invokeHook(hook: Hook, iteration: number, sessionID: string): Promise<void> {
	const output = createMessageOutput(iteration, sessionID);
	await hook({ sessionID }, output);
	assertInjected(output);
}

async function measure(
	repetitions: number,
	operation: (iteration: number) => Promise<void>,
	options: {
		beforeEach?: (iteration: number) => unknown;
		afterEach?: (iteration: number, before: unknown) => Promise<void> | void;
	} = {},
): Promise<TimingSummary> {
	const timings: number[] = [];
	const failures = emptyFailureCounts();
	for (let iteration = 0; iteration < repetitions; iteration += 1) {
		const before = options.beforeEach?.(iteration);
		const started = performance.now();
		try {
			await operation(iteration);
			const duration = performance.now() - started;
			await options.afterEach?.(iteration, before);
			timings.push(duration);
		} catch (error) {
			if (error instanceof CommandInterruptedError) throw error;
			failures[classifyFailure(error)] += 1;
		}
	}
	return summarizeTimings(timings, repetitions, failures);
}

async function seedFixture(dbPath: string): Promise<void> {
	const store = new MemoryStore(dbPath);
	try {
		const sessionId = store.startSession({
			project: PROJECT,
			toolVersion: "prompt-path-benchmark",
		});
		store.remember(
			sessionId,
			"decision",
			"Prompt path transport policy",
			"Healthy viewer retrieval avoids pack and ledger subprocess startup while classified fallback remains available.",
			0.95,
		);
		store.remember(
			sessionId,
			"feature",
			"Viewer-backed prompt packs",
			"The warm viewer reuses its store and embedding client for prompt context retrieval.",
			0.9,
		);
		store.remember(
			sessionId,
			"bugfix",
			"Classified CLI fallback",
			"Retryable viewer transport failures fall back to the source CLI without suppressing usable context.",
			0.9,
		);
		await store.flushPendingVectorWrites();
	} finally {
		store.close();
	}
}

function startViewer(
	root: string,
	port: number,
	env: NodeJS.ProcessEnv,
	options: { detached?: boolean } = {},
): ChildProcess {
	const viewer = spawn(
		"pnpm",
		[
			"exec",
			"tsx",
			"--conditions",
			"source",
			"packages/cli/src/index.ts",
			"serve",
			"start",
			"--foreground",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
		],
		{ cwd: root, env, detached: options.detached ?? true, stdio: "ignore" },
	);
	ownedChildren.add(viewer);
	viewer.once("exit", () => ownedChildren.delete(viewer));
	return viewer;
}

async function waitForViewer(port: number, viewer: ChildProcess): Promise<void> {
	await waitFor(
		async () => {
			if (viewer.exitCode != null) throw new Error("viewer exited during startup");
			try {
				const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
					signal: AbortSignal.timeout(500),
				});
				return response.ok;
			} catch {
				return false;
			}
		},
		VIEWER_START_TIMEOUT_MS,
		"viewer did not become ready",
	);
}

async function stopViewer(viewer: ChildProcess): Promise<void> {
	if (viewer.exitCode != null) return;
	killProcessGroup(viewer, "SIGTERM");
	await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
	killProcessGroup(viewer, "SIGKILL");
	if (viewer.exitCode == null) {
		await Promise.race([
			new Promise<void>((resolveExit) => viewer.once("exit", () => resolveExit())),
			new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 4_000)),
		]);
	}
	ownedChildren.delete(viewer);
}

function benchmarkEnvironment(
	base: NodeJS.ProcessEnv,
	paths: {
		db: string;
		config: string;
		runtimeRoot: string;
		runner: string;
		counter: string;
		root: string;
	},
): NodeJS.ProcessEnv {
	return {
		...base,
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_CONFIG: paths.config,
		CODEMEM_DB: paths.db,
		CODEMEM_INJECT_CONTEXT: "1",
		CODEMEM_INJECT_HTTP_MAX_TIME_S: "120",
		CODEMEM_PLUGIN_CMD_TIMEOUT: String(CLI_TIMEOUT_MS),
		CODEMEM_PLUGIN_DEBUG: "0",
		CODEMEM_PLUGIN_LOG: "0",
		CODEMEM_PROJECT: PROJECT,
		CODEMEM_RAW_EVENTS: "0",
		CODEMEM_RUNNER: "node",
		CODEMEM_RUNNER_FROM: paths.runner,
		CODEMEM_RUNTIME_ROOT: paths.runtimeRoot,
		CODEMEM_VIEWER: "1",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_VIEWER_AUTO_STOP: "0",
		CODEMEM_VIEWER_HOST: "127.0.0.1",
		CODEMEM_VIEWER_STATIC_DIR: join(paths.root, "packages/ui/static"),
		CODEMEM_BENCH_CLI: join(paths.root, "packages/cli/src/index.ts"),
		CODEMEM_BENCH_COUNTER: paths.counter,
		CODEMEM_BENCH_ROOT: paths.root,
	};
}

function applyEnvironment(env: NodeJS.ProcessEnv): () => void {
	const original = { ...process.env };
	process.env = { ...env };
	return () => {
		process.env = original;
	};
}

function validatePackJson(stdout: string): void {
	try {
		const payload = JSON.parse(stdout) as { pack_text?: unknown };
		if (typeof payload.pack_text !== "string" || payload.pack_text.length === 0) throw new Error();
	} catch {
		throw new PromptPathBenchmarkError("terminal_contract", "CLI returned an invalid pack");
	}
}

function withSubprocesses(summary: TimingSummary, counts: SubprocessCounts): PathResult {
	return { ...summary, subprocesses: counts };
}

function buildReport(
	repetitions: number,
	direct: PathResult,
	healthy: PathResult,
	fallback: PathResult,
): BenchmarkReport {
	const gate = evaluatePromptPathGate(repetitions, direct, healthy, fallback);
	const eligible = repetitions === RELEASE_REPETITIONS;
	return {
		schema_version: 1,
		repetitions,
		discarded_warmups_per_path: 1,
		release_gate_eligible: eligible,
		run_valid: gate.runValid,
		paths: {
			direct_cli: direct,
			healthy_viewer_plugin: healthy,
			viewer_unavailable_cli_fallback: {
				...fallback,
				expected_transport_failure: "viewer_unavailable_retryable",
			},
		},
		gate: {
			passed: gate.passed,
			healthy_median_improved: gate.healthyMedianImproved,
			healthy_p95_not_regressed: gate.healthyP95NotRegressed,
			healthy_zero_pack_ledger_subprocesses: gate.healthyZeroSubprocesses,
			all_repetitions_succeeded: gate.allSucceeded,
		},
	};
}

async function preparePhaseFixture(tempRoot: string, root: string) {
	const paths = {
		db: join(tempRoot, "fixture.sqlite"),
		config: join(tempRoot, "config.toml"),
		runtimeRoot: join(tempRoot, "runtime"),
		runner: join(tempRoot, "source-runner.mjs"),
		counter: join(tempRoot, "subprocess.log"),
		root,
	};
	writeFileSync(paths.config, "", "utf8");
	writeFileSync(paths.runner, runnerSource(), "utf8");
	appendFileSync(paths.counter, "", "utf8");
	const env = benchmarkEnvironment(process.env, paths);
	await runCommand(
		"pnpm",
		[
			"exec",
			"tsx",
			"--conditions",
			"source",
			"packages/cli/src/index.ts",
			"maintenance",
			"database",
			"init",
		],
		{ cwd: root, env, detached: false },
	);
	const restoreEnvironment = applyEnvironment(env);
	try {
		await seedFixture(paths.db);
	} finally {
		restoreEnvironment();
	}
	return { paths, env };
}

type PhaseFixture = Awaited<ReturnType<typeof preparePhaseFixture>>;

async function measureDirectPhase(
	{ paths, env }: PhaseFixture,
	repetitions: number,
): Promise<PathResult> {
	const cliArgs = ["memory", "pack", `${PROMPT} ${PROJECT}`, "--json"];
	const runDirect = async () => {
		try {
			const result = await runCommand(process.execPath, [paths.runner, ...cliArgs], {
				cwd: paths.root,
				env,
				detached: false,
			});
			validatePackJson(result.stdout);
		} catch (error) {
			if (error instanceof CommandInterruptedError) throw error;
			if (error instanceof PromptPathBenchmarkError) throw error;
			throw new PromptPathBenchmarkError("terminal_contract", "direct CLI pack failed");
		}
	};
	await runDirect();
	resetSubprocessCounts(paths.counter);
	const summary = await measure(repetitions, async () => runDirect());
	return withSubprocesses(summary, readSubprocessCounts(paths.counter));
}

async function measureHealthyPhase(
	healthyHook: Hook,
	counter: string,
	repetitions: number,
): Promise<PathResult> {
	await invokeHook(healthyHook, -1, "benchmark-healthy");
	await settlePluginStartupChecks(counter);
	resetSubprocessCounts(counter);
	const healthySummary = await measure(
		repetitions,
		async (iteration) => invokeHook(healthyHook, iteration, "benchmark-healthy"),
		{
			beforeEach: () => readSubprocessCounts(counter),
			afterEach: (_iteration, beforeValue) => {
				const before = beforeValue as SubprocessCounts;
				const after = readSubprocessCounts(counter);
				if (
					after.pack !== before.pack ||
					after.ledger !== before.ledger ||
					after.other !== before.other
				) {
					throw new PromptPathBenchmarkError(
						"retryable_transport_protocol",
						"healthy viewer path used a CLI subprocess",
					);
				}
			},
		},
	);
	await observeHealthySubprocessQuiescence(counter);
	return withSubprocesses(healthySummary, readSubprocessCounts(counter));
}

async function waitForFallback(counter: string, expected: number): Promise<void> {
	await waitFor(
		() => {
			const counts = readSubprocessCounts(counter);
			return (
				counts.pack >= expected &&
				counts.ledger >= expected &&
				subprocessActivitySettled(readSubprocessActivity(counter))
			);
		},
		LEDGER_SETTLE_TIMEOUT_MS,
		"fallback subprocesses did not settle",
	);
}

async function measureFallbackPhase(
	fallbackHook: Hook,
	counter: string,
	repetitions: number,
): Promise<PathResult> {
	await invokeHook(fallbackHook, -2, "benchmark-fallback");
	await settlePluginStartupChecks(counter);
	await waitForFallback(counter, 1);
	resetSubprocessCounts(counter);
	const fallbackSummary = await measure(
		repetitions,
		async (iteration) => invokeHook(fallbackHook, iteration, "benchmark-fallback"),
		{
			afterEach: (iteration) => waitForFallback(counter, iteration + 1),
		},
	);
	return withSubprocesses(fallbackSummary, readSubprocessCounts(counter));
}

export async function executePhase({
	phase,
	repetitions,
	tempRoot,
	root,
}: PhaseRequest): Promise<PathResult> {
	const fixture = await preparePhaseFixture(tempRoot, root);
	const restoreEnvironment = applyEnvironment(fixture.env);
	let viewer: ChildProcess | undefined;
	let disposePlugin: (() => Promise<void>) | undefined;
	try {
		if (phase === "direct_cli") return await measureDirectPhase(fixture, repetitions);
		const port = await reservePort();
		if (phase === "healthy_viewer_plugin") {
			viewer = startViewer(root, port, fixture.env, { detached: false });
			await waitForViewer(port, viewer);
		}
		const hook = await createPluginHook(await loadPlugin(), root, port, {
			onDispose: (dispose) => {
				disposePlugin = dispose;
			},
		});
		if (phase === "healthy_viewer_plugin")
			return await measureHealthyPhase(hook, fixture.paths.counter, repetitions);
		return await measureFallbackPhase(hook, fixture.paths.counter, repetitions);
	} finally {
		try {
			await disposePlugin?.();
		} finally {
			if (viewer) await stopViewer(viewer);
			await stopOwnedChildren();
			restoreEnvironment();
		}
	}
}

export async function runBenchmark(repetitions: number): Promise<BenchmarkReport> {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
	const direct = await runPhaseProcess("direct_cli", repetitions, { root });
	const healthy = await runPhaseProcess("healthy_viewer_plugin", repetitions, { root });
	const fallback = await runPhaseProcess("viewer_unavailable_cli_fallback", repetitions, { root });
	return buildReport(repetitions, direct, healthy, fallback);
}

async function main(): Promise<void> {
	const repetitions = parseRepetitions(process.argv.slice(2));
	const report = await runBenchmark(repetitions);
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	if (!report.run_valid || (report.release_gate_eligible && !report.gate.passed))
		process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

export {
	applyEnvironment,
	benchmarkEnvironment,
	createMessageOutput,
	type Hook,
	type PluginFactory,
	readSubprocessCounts,
	reservePort,
	runCommand,
	runnerSource,
	settlePluginStartupChecks,
	startViewer,
	stopOwnedChildren,
	stopViewer,
	waitFor,
	waitForViewer,
};

if (entrypoint === import.meta.url) {
	main().catch((error) => {
		const detail =
			error instanceof PromptPathBenchmarkError ? ` (${error.failureClass}: ${error.message})` : "";
		process.stderr.write(
			`prompt-path benchmark failed before producing a safe aggregate report${detail}\n`,
		);
		process.exitCode = 1;
	});
}
