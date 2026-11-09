import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { ownedChildren, runCommand } from "./prompt-path-children.js";
import { evaluatePromptPathGate } from "./prompt-path-lib.js";
import { runPhaseProcess } from "./prompt-path-process.js";

const root = resolve(import.meta.dirname, "../..");

async function cleanProbeChild(child: ChildProcess, kill: typeof process.kill): Promise<void> {
	try {
		if (!child.pid) return;
		try {
			kill(-child.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		const deadline = performance.now() + 5000;
		while (true) {
			try {
				kill(-child.pid, 0);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ESRCH") return;
				if (code !== "EPERM") throw error;
			}
			assert.ok(performance.now() < deadline, "test-owned process group did not exit");
			await new Promise((done) => setTimeout(done, 25));
		}
	} finally {
		ownedChildren.delete(child);
	}
}

function fixture(t: TestContext, body = "report();") {
	const dir = mkdtempSync(join(tmpdir(), "prompt-process-test-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const workerEntrypoint = join(dir, "worker.mjs");
	writeFileSync(
		workerEntrypoint,
		`
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
const request = JSON.parse(readFileSync(0, "utf8"));
const logPath = join(request.tempRoot, "subprocess.log");
const pack = request.phase !== "healthy_viewer_plugin" ? request.repetitions : 0;
const ledger = request.phase === "viewer_unavailable_cli_fallback" ? request.repetitions : 0;
const counterLog = "start pack\\nend pack 0\\n".repeat(pack)
  + "start ledger\\nend ledger 0\\n".repeat(ledger);
writeFileSync(logPath, counterLog);
const result = {
  attempted: request.repetitions, succeeded: request.repetitions,
  median_ms: request.phase === "healthy_viewer_plugin" ? 1 : 10,
  p95_ms: request.phase === "healthy_viewer_plugin" ? 1 : 10,
  sorted_ms: Array(request.repetitions).fill(request.phase === "healthy_viewer_plugin" ? 1 : 10),
  failures: { terminal_contract: 0, retryable_transport_protocol: 0, harness: 0 },
  subprocesses: { pack, ledger, other: 0, failed: 0 },
};
function report() { process.stdout.write(JSON.stringify({ result, counterLog })); }
${body}
`,
	);
	return { dir, options: { root, workerEntrypoint } };
}

it("runs sequential phases with fresh contexts, environments, and counters", async (t) => {
	const f = fixture(
		t,
		`
writeFileSync(process.env.OBSERVE, JSON.stringify({ pid: process.pid, home: process.env.HOME,
  config: process.env.CODEMEM_TEST_INHERITED, seen: globalThis.phaseSeen ?? false }));
globalThis.phaseSeen = true;
setImmediate(() => writeFileSync(process.env.LATE, "contamination"));
process.stdout.write(JSON.stringify({ result, counterLog }), () => process.exit(0));
`,
	);
	const previous = process.env.CODEMEM_TEST_INHERITED;
	process.env.CODEMEM_TEST_INHERITED = "private";
	t.after(() => {
		if (previous === undefined) delete process.env.CODEMEM_TEST_INHERITED;
		else process.env.CODEMEM_TEST_INHERITED = previous;
	});
	const observations: { pid: number; home: string; config?: string; seen: boolean }[] = [];
	const results = [];
	const late = join(f.dir, "late");
	for (const phase of [
		"direct_cli",
		"healthy_viewer_plugin",
		"viewer_unavailable_cli_fallback",
	] as const) {
		const observe = join(f.dir, phase);
		results.push(
			await runPhaseProcess(phase, 1, {
				...f.options,
				env: { OBSERVE: observe, LATE: late },
			}),
		);
		observations.push(JSON.parse(readFileSync(observe, "utf8")));
	}

	assert.equal(new Set(observations.map((value) => value.pid)).size, 3);
	assert.equal(new Set(observations.map((value) => value.home)).size, 3);
	assert.ok(
		observations.every(
			(value) => !value.seen && value.config === undefined && !existsSync(value.home),
		),
	);
	assert.equal(existsSync(late), false);
	const [direct, healthy, fallback] = results;
	assert.ok(direct && healthy && fallback);
	assert.equal(evaluatePromptPathGate(1, direct, healthy, fallback).runValid, true);
	assert.equal(evaluatePromptPathGate(1, direct, healthy, fallback).passed, false);
	assert.equal(ownedChildren.size, 0);
});

it("recomputes safe aggregates and strips private fields at every level", async (t) => {
	const f = fixture(
		t,
		`
result.sorted_ms = [2, 1]; result.median_ms = 1.5; result.p95_ms = 2;
result.privatePath = request.tempRoot; result.failures.privatePath = request.tempRoot;
result.subprocesses.privatePath = request.tempRoot; report();
`,
	);

	const result = await runPhaseProcess("healthy_viewer_plugin", 2, f.options);

	assert.deepEqual(result, {
		attempted: 2,
		succeeded: 2,
		median_ms: 1.5,
		p95_ms: 2,
		sorted_ms: [1, 2],
		failures: { terminal_contract: 0, retryable_transport_protocol: 0, harness: 0 },
		subprocesses: { pack: 0, ledger: 0, other: 0, failed: 0 },
	});
});

for (const mutation of [
	"result.attempted = 2",
	"result.succeeded = 0",
	"result.sorted_ms = [-1]",
	"result.failures.harness = -1",
	"result.failures.harness = 1",
	"result.median_ms = 2",
	"result.p95_ms = 2",
	"result.subprocesses.other = 1",
]) {
	it(`rejects malformed aggregate: ${mutation}`, async (t) => {
		const f = fixture(t, `${mutation}; report();`);

		const execution = runPhaseProcess("healthy_viewer_plugin", 1, f.options);

		await assert.rejects(execution, /aggregate/);
		assert.equal(ownedChildren.size, 0);
	});
}

for (const descendant of [false, true]) {
	it(`rejects counters changed after reporting by ${descendant ? "a descendant" : "the worker"}`, async (t) => {
		const change = `appendFileSync(logPath, "start other\\nend other 0\\n");`;
		const f = fixture(
			t,
			descendant
				? `
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
const { appendFileSync } = require("node:fs");
process.on("message", path => { appendFileSync(path, "start other\\nend other 0\\n"); process.exit(0); });
process.send("ready");`)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => { report(); child.send(logPath); });
await new Promise(done => child.once("exit", done));
`
				: `report(); setImmediate(() => { ${change} });`,
		);

		const execution = runPhaseProcess("healthy_viewer_plugin", 1, f.options);

		await assert.rejects(execution, /activity changed/);
		assert.equal(ownedChildren.size, 0);
	});
}

it("rejects matching but unsettled counter activity", async (t) => {
	const f = fixture(
		t,
		`
writeFileSync(logPath, "start other\\n"); result.subprocesses.other = 1;
process.stdout.write(JSON.stringify({ result, counterLog: "start other\\n" }));
`,
	);

	const execution = runPhaseProcess("healthy_viewer_plugin", 1, f.options);

	await assert.rejects(execution, /did not settle/);
	assert.equal(ownedChildren.size, 0);
});

for (const mode of ["success", "failure", "timeout", "interrupt"] as const) {
	it(`cleans up ${mode} before a subsequent phase`, { timeout: 15_000 }, async (t) => {
		let action = 'writeFileSync(process.env.READY, "ready"); setInterval(() => {}, 1000);';
		if (mode === "success") action = "report(); process.exit(0);";
		if (mode === "failure") action = 'process.stderr.write("PRIVATE_MARKER"); process.exit(7);';
		const f = fixture(
			t,
			`
const child = spawn(process.execPath, ["-e", 'process.send("ready"); setInterval(() => {}, 1000);'],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.once("message", () => {
  writeFileSync(process.env.PID_FILE, String(child.pid)); child.disconnect(); child.unref();
  ${action}
});
`,
		);
		const ready = join(f.dir, "ready");
		const pidFile = join(f.dir, "pid");
		const watcher = watch(f.dir);
		t.after(() => watcher.close());
		if (mode === "interrupt")
			watcher.on("change", () => {
				if (existsSync(ready)) {
					watcher.close();
					process.emit("SIGINT");
				}
			});
		const next = fixture(t);

		const execution = runPhaseProcess("healthy_viewer_plugin", 1, {
			...f.options,
			timeoutMs: mode === "timeout" ? 2000 : 10_000,
			env: { READY: ready, PID_FILE: pidFile },
		});

		if (mode === "success") await execution;
		else
			await assert.rejects(execution, (error: Error) => {
				assert.match(error.message, mode === "failure" ? /exit 7/ : /timed out or interrupted/);
				assert.equal(error.message.includes("PRIVATE_MARKER"), false);
				return true;
			});
		const pid = Number(readFileSync(pidFile, "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		assert.equal(ownedChildren.size, 0);
		const result = await runPhaseProcess("healthy_viewer_plugin", 1, next.options);
		assert.deepEqual(result.subprocesses, { pack: 0, ledger: 0, other: 0, failed: 0 });
	});
}

for (const mode of ["success", "timeout", "exited_parent_timeout"] as const) {
	it(`settles a nested non-detached command on ${mode} without waiting for the phase deadline`, {
		timeout: 15_000,
	}, async (t) => {
		// Inherited output pipes must not keep the nested command pending after its deadline.
		const command = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
writeFileSync(process.env.COMMAND_PID_FILE, String(process.pid));
const child = spawn(process.execPath, ["-e", ${JSON.stringify(`
process.on("message", () => process.exit(0));
process.send("ready");
setInterval(() => {}, 1000);
`)}], { detached: false, stdio: ["ignore", "inherit", "inherit", "ipc"] });
child.once("message", () => {
  writeFileSync(process.env.PID_FILE, String(child.pid));
  if (${JSON.stringify(mode)} === "success") child.send("finish");
  // The command can exit before its deadline while its descendant retains the pipes.
  if (${JSON.stringify(mode)} === "exited_parent_timeout") process.exit(0);
});
child.once("exit", () => process.exit(0));
`;
		const f = fixture(
			t,
			`
const { runCommand } = await import(${JSON.stringify(pathToFileURL(join(root, "scripts/eval/prompt-path-children.ts")).href)});
writeFileSync(process.env.HOME_FILE, request.tempRoot);
try {
  await runCommand(process.execPath, ["-e", ${JSON.stringify(command)}], {
    cwd: request.root, env: process.env, detached: false, timeoutMs: 2000,
  });
  writeFileSync(process.env.SETTLED, "success");
  report();
} catch (error) {
  writeFileSync(process.env.SETTLED, error.message);
  process.exit(7);
}
`,
		);
		const pidFile = join(f.dir, "nested-pid");
		const commandPidFile = join(f.dir, "command-pid");
		const homeFile = join(f.dir, "phase-home");
		const settled = join(f.dir, "settled");
		const next = fixture(t);
		const previousChildren = new Set(ownedChildren);
		let cleanupDeadlineReached = false;

		const execution = runPhaseProcess("healthy_viewer_plugin", 1, {
			...f.options,
			timeoutMs: 10_000,
			env: {
				PID_FILE: pidFile,
				COMMAND_PID_FILE: commandPidFile,
				HOME_FILE: homeFile,
				SETTLED: settled,
			},
		});
		const phaseChild = [...ownedChildren].find((child) => !previousChildren.has(child));
		assert.ok(phaseChild?.pid && phaseChild.pid > 1 && phaseChild.pid !== process.pid);
		const phasePid = phaseChild.pid;
		const cleanup = () => {
			try {
				// Only the detached phase created by this test owns this process group.
				process.kill(-phasePid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		const cleanupTimer = setTimeout(() => {
			cleanupDeadlineReached = true;
			cleanup();
		}, 5000);
		t.after(() => {
			clearTimeout(cleanupTimer);
			cleanup();
		});
		let executionError: unknown;
		try {
			await execution;
		} catch (error) {
			executionError = error;
		} finally {
			clearTimeout(cleanupTimer);
		}

		assert.equal(cleanupDeadlineReached, false, "nested command waited for test cleanup");
		if (mode === "success") assert.equal(executionError, undefined);
		else {
			assert.ok(executionError instanceof Error);
			assert.match(executionError.message, /exit 7/);
		}
		assert.match(readFileSync(settled, "utf8"), mode === "success" ? /^success$/ : /timed out/);
		for (const pid of [
			phasePid,
			Number(readFileSync(commandPidFile, "utf8")),
			Number(readFileSync(pidFile, "utf8")),
		]) {
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		}
		assert.equal(existsSync(readFileSync(homeFile, "utf8")), false);
		assert.equal(ownedChildren.size, 0);
		const result = await runPhaseProcess("healthy_viewer_plugin", 1, next.options);
		assert.deepEqual(result.subprocesses, { pack: 0, ledger: 0, other: 0, failed: 0 });
	});
}

for (const mode of ["transient EPERM", "persistent EPERM", "unexpected EINVAL"] as const) {
	it(`confirms group cleanup after ${mode}`, { timeout: 10_000 }, async () => {
		// Only ESRCH confirms absence. Permission errors must not release ownership.
		assert.equal(ownedChildren.size, 0);
		const originalKill = process.kill;
		const probeError = Object.assign(new Error("injected group probe error"), {
			code: mode === "unexpected EINVAL" ? "EINVAL" : "EPERM",
		});
		const started = performance.now();
		const pending = runCommand(process.execPath, ["-e", "process.stdout.write('complete')"], {
			cwd: root,
			env: process.env,
			stopGroupOnExit: true,
		});
		const child = [...ownedChildren][0];
		assert.ok(child?.pid && child.pid > 1 && child.pid !== process.pid);
		const pid = child.pid;
		let probes = 0;
		let confirmedAbsent = false;
		let fulfilled = false;
		void pending.then(
			() => {
				fulfilled = true;
			},
			() => undefined,
		);
		process.kill = ((target: number, signal?: number | NodeJS.Signals) => {
			if (target !== -pid || signal !== 0) return originalKill(target, signal);
			probes += 1;
			assert.equal(fulfilled, false, "command fulfilled before absence was confirmed");
			assert.equal(ownedChildren.has(child), true);
			if (mode !== "transient EPERM" || probes === 1) throw probeError;
			if (probes === 2) return true;
			confirmedAbsent = true;
			throw Object.assign(new Error("injected group absence"), { code: "ESRCH" });
		}) as typeof process.kill;

		try {
			if (mode === "transient EPERM") {
				const result = await pending;
				assert.equal(result.stdout, "complete");
				assert.equal(confirmedAbsent, true);
				assert.equal(probes, 3);
				assert.equal(ownedChildren.has(child), false);
			} else if (mode === "persistent EPERM") {
				await assert.rejects(pending, /phase descendants did not exit/);
				assert.ok(performance.now() - started >= 5000);
				assert.ok(probes > 2);
				assert.equal(confirmedAbsent, false);
				assert.equal(ownedChildren.has(child), true);
			} else {
				await assert.rejects(pending, (error) => error === probeError);
				assert.equal(probeError.code, "EINVAL");
				assert.equal(probes, 1);
				assert.equal(ownedChildren.has(child), true);
			}
		} finally {
			process.kill = originalKill;
			await cleanProbeChild(child, originalKill);
		}
		assert.throws(() => originalKill(pid, 0), { code: "ESRCH" });
		assert.throws(() => originalKill(-pid, 0), { code: "ESRCH" });
		assert.equal(ownedChildren.size, 0);
	});
}
