// End-to-end check and measurement for a codemem MCP server shared by several
// project directories (OpenCode `pool: true`), inside a real OpenCode host.
//
// The server runs `codemem mcp --caller-context required` in one fixed
// directory. This checkout's plugin adds each caller's directory to every
// call. Everything runs under a temp HOME with scratch databases and a
// scripted loopback provider; nothing touches the user's config or database.
//
// Usage, from packages/opencode-plugin:
//   CODEMEM_SMOKE_OPENCODE_BIN=/path/to/opencode node ./scripts/pooled-mcp-host-smoke.mjs
// The binary must support pooling (2.2.6 or later); it is not a workspace
// dependency. Options, all through the environment:
//   CODEMEM_SMOKE_CLI=dist      run the built CLI (after `pnpm build`), not source
//   CODEMEM_SMOKE_CLI=packed    pack the CLI, its workspace packages and this plugin
//                               (after `pnpm build`), install the tarballs into the
//                               temp directory, and run the installed CLI and plugin
//   CODEMEM_SMOKE_MEASURE=N     also measure private, pooled, and native with N projects
//   CODEMEM_SMOKE_KEEP=1        keep the temp directory

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	createSession,
	descendantsOf,
	freePort,
	hostFetch,
	initRepo,
	mcpStatus,
	physicalFootprintKiB,
	prompt,
	providerConfig,
	sleep,
	spawnTracked,
	startHost,
	startProvider,
	stopChild,
	waitForMcp,
} from "./lib/scripted-host.mjs";
import { installPackedCodemem } from "./lib/packed-install.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const opencodeBin = process.env.CODEMEM_SMOKE_OPENCODE_BIN;
const CLI_MODES = ["source", "dist", "packed"];
const cliMode = process.env.CODEMEM_SMOKE_CLI || "source";
if (!CLI_MODES.includes(cliMode)) {
	throw new Error(`CODEMEM_SMOKE_CLI must be one of ${CLI_MODES.join(", ")}`);
}
const measureProjects = Number(process.env.CODEMEM_SMOKE_MEASURE ?? 0);
const keepTemp = process.env.CODEMEM_SMOKE_KEEP === "1";
const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "codemem-pooled-smoke-")));
const home = join(tempRoot, "home");
/** The plugin OpenCode loads: this checkout's, or the packed install's. */
let pluginPackage = packageRoot;
const children = new Set();
const checks = [];
const SERVER = "codemem";

function check(name, pass, evidence) {
	checks.push({ name, pass: Boolean(pass), ...(pass ? {} : { evidence }) });
}

// The launcher execs this checkout's CLI entry point, or the packed install's,
// so that path identifies the servers whatever the directory is called.
const CLI_ENTRY_RE =
	/(packages\/cli\/(src\/index\.ts|dist\/index\.js)|node_modules\/codemem\/dist\/index\.js)\s+mcp(\s|$)/;
const isCodememMcp = (row) => CLI_ENTRY_RE.test(row.command);

/**
 * One entry per server the host started. A launcher may exec through wrapper
 * processes (tsx does), so each server is reported with every PID under it.
 */
function mcpProcesses(host) {
	const rows = descendantsOf(host.child.pid).filter(isCodememMcp);
	const pids = new Set(rows.map((row) => row.pid));
	return rows
		.filter((row) => !pids.has(row.ppid))
		.map((root) => {
			const tree = [root, ...descendantsOf(root.pid)];
			return { pid: root.pid, pids: tree.map((row) => row.pid), rssKiB: tree.map((row) => row.rssKiB) };
		});
}

// ------------------------------------------------------------------- fixture

/**
 * A `codemem` launcher for this checkout, or for the packed install made in the
 * temp directory, so no globally installed CLI is ever used.
 */
function writeCodememLauncher(packedCliEntry) {
	const binDir = join(tempRoot, "bin");
	mkdirSync(binDir, { recursive: true });
	const tsx = join(workspaceRoot, "packages/cli/node_modules/.bin/tsx");
	const entries = {
		source: `"${tsx}" --conditions source "${join(workspaceRoot, "packages/cli/src/index.ts")}"`,
		dist: `"${process.execPath}" "${join(workspaceRoot, "packages/cli/dist/index.js")}"`,
		packed: `"${process.execPath}" "${packedCliEntry}"`,
	};
	const command = entries[cliMode];
	const launcher = join(binDir, "codemem");
	writeFileSync(launcher, `#!/bin/sh\nexec ${command} "$@"\n`);
	chmodSync(launcher, 0o755);
	return launcher;
}

function scratchTarget(name) {
	const dir = join(tempRoot, "targets", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), "{}\n");
	return { dbPath: join(dir, "mem.sqlite"), configPath: join(dir, "config.json") };
}

function baseEnv(launcher, target) {
	mkdirSync(join(home, ".config"), { recursive: true });
	const env = {
		PATH: `${join(tempRoot, "bin")}:${process.env.PATH ?? ""}`,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_STATE_HOME: join(home, ".local/state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		CODEMEM_CONFIG: target.configPath,
		CODEMEM_DB: target.dbPath,
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
		CODEMEM_RUNNER: launcher,
	};
	if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
	return env;
}

function hostEnv(launcher, target, viewerPort, extra = {}) {
	return {
		...baseEnv(launcher, target),
		CODEMEM_VIEWER: "0",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_VIEWER_AUTO_STOP: "0",
		CODEMEM_VIEWER_HOST: "127.0.0.1",
		CODEMEM_VIEWER_PORT: String(viewerPort),
		OPENCODE_DISABLE_AUTOUPDATE: "true",
		OPENCODE_DISABLE_MODELS_FETCH: "true",
		OPENCODE_SERVER_PASSWORD: randomBytes(24).toString("base64url"),
		...extra,
	};
}

async function startViewer(launcher, target, port) {
	const env = { ...baseEnv(launcher, target), CODEMEM_PLUGIN_IGNORE: "1" };
	const args = ["serve", "start", "--foreground", "--host", "127.0.0.1", "--port", String(port)];
	const viewer = spawnTracked(children, launcher, [...args, "--db-path", target.dbPath], {
		cwd: tempRoot,
		env,
	});
	for (let attempt = 0; attempt < 240; attempt += 1) {
		if (viewer.child.exitCode !== null) throw new Error(`Viewer exited\n${viewer.output()}`);
		const ok = await fetch(`http://127.0.0.1:${port}/api/prompt-pack-profile`)
			.then((response) => response.ok)
			.catch(() => false);
		if (ok) return viewer;
		await sleep(250);
	}
	throw new Error(`Viewer did not start\n${viewer.output()}`);
}

/** The codemem MCP entry for one mode. Pooled entries must be identical across projects. */
function mcpEntry(mode, launcher, target, { codemode } = {}) {
	if (mode === "native") return null;
	const environment = {
		CODEMEM_DB: target.dbPath,
		CODEMEM_CONFIG: target.configPath,
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_VIEWER: "0",
	};
	const shared = { type: "local", environment, ...(codemode === undefined ? {} : { codemode }) };
	if (mode === "private") return { ...shared, command: [launcher, "mcp"] };
	return {
		...shared,
		command: [launcher, "mcp", "--caller-context", "required"],
		cwd: join(tempRoot, "pool-cwd"),
		protocol: "2026-07-28",
		pool: true,
	};
}

function writeProjectConfig(dir, providerBaseURL, entry) {
	const config = {
		...providerConfig(providerBaseURL),
		plugins: [{ package: pluginPackage }],
		...(entry ? { mcp: { servers: { [SERVER]: entry } } } : {}),
	};
	writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2));
}

function makeRepos(prefix, names) {
	const repos = {};
	for (const name of names) {
		repos[name] = join(tempRoot, prefix, name);
		initRepo(repos[name], home);
	}
	return repos;
}

// ------------------------------------------------------------------ database

function query(dbPath, sql, ...params) {
	if (!existsSync(dbPath)) return [];
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(sql).all(...params);
	} finally {
		db.close();
	}
}

const memoryRows = (dbPath, title) =>
	query(
		dbPath,
		`SELECT m.title, s.cwd, s.project FROM memory_items m
		 LEFT JOIN sessions s ON s.id = m.session_id WHERE m.title = ?`,
		title,
	);

const searchStreams = (dbPath) =>
	Object.fromEntries(
		query(
			dbPath,
			`SELECT stream_id AS stream, COUNT(*) AS count FROM retrieval_attempts
			 WHERE surface = 'mcp_search' GROUP BY stream_id`,
		).map((row) => [row.stream, row.count]),
	);

// ---------------------------------------------------------------- correctness

const remember = (title, project) => ({
	tool: "memory_remember",
	args: { kind: "decision", title, body: `${project} sentinel`, project },
});
const search = { tool: "memory_search", args: { query: "sentinel" } };
const distill = { tool: "memory_distill_candidates", args: { judge: false } };

const SCENARIOS = {
	"alpha-write": { steps: [remember("Alpha smoke", "alpha")] },
	"beta-write": { steps: [remember("Beta smoke", "beta")] },
	"gamma-write": { steps: [remember("Gamma smoke", "gamma")] },
	// Two identical searches in one turn must record two ledger rows.
	"alpha-read": { steps: [search, search, distill] },
	"beta-read": { steps: [search, distill] },
	"read-again": { steps: [search] },
};

const contextDocuments = (result) => JSON.parse(result).metadata?.context_document_count;

function assertIsolation(label, results, target, repos, sessions) {
	const [alphaSearch, , alphaDistill] = results["alpha-read"] ?? [];
	const [betaSearch, betaDistill] = results["beta-read"] ?? [];
	check(
		`${label}.search_scoped_to_caller`,
		alphaSearch?.includes("Alpha smoke") &&
			!alphaSearch.includes("Beta smoke") &&
			betaSearch?.includes("Beta smoke") &&
			!betaSearch.includes("Alpha smoke"),
		{ alphaSearch, betaSearch },
	);
	for (const [title, dir] of [
		["Alpha smoke", repos.alpha],
		["Beta smoke", repos.beta],
	]) {
		const rows = memoryRows(target.dbPath, title);
		check(`${label}.write_session_cwd.${title}`, rows.length === 1 && rows[0].cwd === dir, {
			rows,
			expected: dir,
		});
	}
	// Alpha has an AGENTS.md and beta has none. The pool directory has one too,
	// so a server reading its own directory would report one for beta.
	check(
		`${label}.distill_reads_caller_repo`,
		contextDocuments(alphaDistill ?? "{}") === 1 && contextDocuments(betaDistill ?? "{}") === 0,
		{ alphaDistill: alphaDistill?.slice(0, 400), betaDistill: betaDistill?.slice(0, 400) },
	);
	const streams = searchStreams(target.dbPath);
	check(
		`${label}.ledger_per_session`,
		streams[sessions.alpha] === 2 && streams[sessions.beta] === 1,
		{ streams, sessions },
	);
}

async function assertLifecycle(label, host, repos, sessions, provider) {
	const before = mcpProcesses(host);
	// One directory disconnects: the other keeps the shared process.
	await hostFetch(host, `/api/experimental/mcp/${SERVER}/disconnect`, {
		method: "POST",
		directory: repos.alpha,
	});
	await prompt(host, sessions.beta, repos.beta, "read-again");
	const afterOne = mcpProcesses(host);
	check(
		`${label}.disconnect_one_keeps_other`,
		afterOne.length === 1 &&
			afterOne[0].pid === before[0]?.pid &&
			provider.state.results["read-again"]?.[0]?.includes("Beta smoke"),
		{ before, afterOne, result: provider.state.results["read-again"] },
	);
	// The last holder disconnects: the process exits.
	await hostFetch(host, `/api/experimental/mcp/${SERVER}/disconnect`, {
		method: "POST",
		directory: repos.beta,
	});
	await sleep(1_500);
	check(`${label}.last_holder_closes_process`, mcpProcesses(host).length === 0, {
		remaining: mcpProcesses(host),
	});
	// Both reconnect and share one new process.
	for (const dir of [repos.alpha, repos.beta]) {
		await hostFetch(host, `/api/experimental/mcp/${SERVER}/connect`, {
			method: "POST",
			directory: dir,
		});
		await waitForMcp(host, dir, SERVER);
	}
	const reconnected = mcpProcesses(host);
	check(`${label}.reconnect_shares_one_process`, reconnected.length === 1, { reconnected });
	return reconnected[0]?.pid;
}

async function assertCrash(label, host, repos, sessions, provider, target, pid) {
	const crashed = mcpProcesses(host).find((server) => server.pid === pid);
	for (const member of crashed?.pids ?? [pid]) process.kill(member, "SIGKILL");
	await sleep(750);
	const statuses = [
		await mcpStatus(host, repos.alpha, SERVER),
		await mcpStatus(host, repos.beta, SERVER),
	];
	// A write attempted while the server is down must fail visibly, not vanish
	// or land twice once the server is back.
	delete provider.state.results["gamma-write"];
	await prompt(host, sessions.alpha, repos.alpha, "gamma-write");
	const whileDown = provider.state.results["gamma-write"] ?? [];
	const writtenWhileDown = memoryRows(target.dbPath, "Gamma smoke").length;
	for (const dir of [repos.alpha, repos.beta]) {
		await hostFetch(host, `/api/experimental/mcp/${SERVER}/connect`, {
			method: "POST",
			directory: dir,
		}).catch(() => {});
		await waitForMcp(host, dir, SERVER);
	}
	delete provider.state.results["read-again"];
	await prompt(host, sessions.beta, repos.beta, "read-again");
	const recovered = mcpProcesses(host);
	check(`${label}.crash_marks_every_holder_failed`, statuses.every((s) => s === "failed"), {
		statuses,
	});
	check(`${label}.call_while_down_writes_nothing`, writtenWhileDown === 0, { whileDown });
	check(
		`${label}.manual_reconnect_restores_one_process`,
		recovered.length === 1 &&
			recovered[0].pid !== pid &&
			provider.state.results["read-again"]?.[0]?.includes("Beta smoke"),
		{ recovered, result: provider.state.results["read-again"] },
	);
	return { statusesAfterCrash: statuses, toolResultWhileDown: whileDown[0]?.slice(0, 200) ?? null };
}

async function runCorrectness(launcher, provider, codemode) {
	const label = codemode ? "codemode" : "direct";
	const target = scratchTarget(label);
	const otherTarget = scratchTarget(`${label}-other`);
	const repos = makeRepos(label, ["alpha", "beta", "gamma"]);
	writeFileSync(join(repos.alpha, "AGENTS.md"), "# alpha context\n- Alpha recurring lesson\n");
	writeFileSync(join(tempRoot, "pool-cwd", "AGENTS.md"), "# pool context\n");
	const entry = mcpEntry("pooled", launcher, target, { codemode });
	writeProjectConfig(repos.alpha, provider.baseURL, entry);
	writeProjectConfig(repos.beta, provider.baseURL, entry);
	// Gamma points the same command at another database, so it must not share.
	writeProjectConfig(
		repos.gamma,
		provider.baseURL,
		mcpEntry("pooled", launcher, otherTarget, { codemode }),
	);
	const viewerPort = await freePort();
	const host = await startHost(children, opencodeBin, repos.alpha, hostEnv(launcher, target, viewerPort));
	try {
		const sessions = {};
		for (const name of ["alpha", "beta", "gamma"]) {
			await waitForMcp(host, repos[name], SERVER);
			sessions[name] = await createSession(host, repos[name]);
		}
		// Both memories exist before either isolation check runs.
		await prompt(host, sessions.alpha, repos.alpha, "alpha-write");
		await prompt(host, sessions.beta, repos.beta, "beta-write");
		await prompt(host, sessions.gamma, repos.gamma, "gamma-write");
		await prompt(host, sessions.alpha, repos.alpha, "alpha-read");
		await prompt(host, sessions.beta, repos.beta, "beta-read");

		check(`${label}.exposure`, provider.state.exposures["alpha-read"] === label, {
			exposures: provider.state.exposures,
		});
		const processes = mcpProcesses(host);
		check(`${label}.two_directories_one_process_plus_other_target`, processes.length === 2, {
			processes,
		});
		check(
			`${label}.other_target_isolated`,
			memoryRows(otherTarget.dbPath, "Gamma smoke").length === 1 &&
				memoryRows(target.dbPath, "Gamma smoke").length === 0 &&
				memoryRows(otherTarget.dbPath, "Alpha smoke").length === 0,
			{ other: memoryRows(otherTarget.dbPath, "Gamma smoke") },
		);
		assertIsolation(label, provider.state.results, target, repos, sessions);
		check(`${label}.caller_argument_hidden_from_model`, !provider.state.callerArgumentSeen, {});

		// Gamma leaves so the lifecycle checks watch only the shared process.
		await hostFetch(host, `/api/experimental/mcp/${SERVER}/disconnect`, {
			method: "POST",
			directory: repos.gamma,
		});
		await sleep(1_000);
		const pid = await assertLifecycle(label, host, repos, sessions, provider);
		const crash = await assertCrash(label, host, repos, sessions, provider, target, pid);
		return { label, hostVersion: host.version, crash };
	} finally {
		await stopChild(host.child);
		if (keepTemp) writeFileSync(join(tempRoot, `host-${label}.log`), host.output());
	}
}

// ---------------------------------------------------------------- measurement

async function measureMode(mode, launcher, provider, count) {
	const target = scratchTarget(`measure-${mode}`);
	const names = Array.from({ length: count }, (_, index) => `p${index + 1}`);
	const repos = makeRepos(`measure-${mode}`, names);
	const entry = mcpEntry(mode, launcher, target);
	for (const dir of Object.values(repos)) writeProjectConfig(dir, provider.baseURL, entry);
	for (const name of names) {
		SCENARIOS[`${mode}-${name}`] = { steps: [remember(`${mode} ${name}`, name), search] };
		SCENARIOS[`${mode}-${name}-again`] = { steps: [remember(`${mode} ${name} again`, name), search] };
		SCENARIOS[`${mode}-${name}-idle`] = { steps: [] };
	}
	const viewerPort = await freePort();
	const viewer = await startViewer(launcher, target, viewerPort);
	// Every mode uses the viewer started above, as a normal install does. With
	// it disabled the plugin runs a CLI process per turn for recall, and native
	// tools run one per call, so the timings would measure those processes.
	const extra = {
		CODEMEM_VIEWER: "1",
		...(mode === "native" ? { CODEMEM_OPENCODE_NATIVE_TOOLS: "1" } : {}),
	};
	const hostStartedAt = performance.now();
	const host = await startHost(
		children,
		opencodeBin,
		repos[names[0]],
		hostEnv(launcher, target, viewerPort, extra),
	);
	try {
		const hostStartMs = Math.round(performance.now() - hostStartedAt);
		const readyMs = [];
		const firstCallMs = [];
		const repeatTurnMs = [];
		const noToolTurnMs = [];
		for (const name of names) {
			if (entry) readyMs.push(await waitForMcp(host, repos[name], SERVER));
			const session = await createSession(host, repos[name]);
			const startedAt = performance.now();
			await prompt(host, session, repos[name], `${mode}-${name}`);
			firstCallMs.push(Math.round(performance.now() - startedAt));
			// The same two calls again in the warm session, then a turn with no tool call.
			const repeatAt = performance.now();
			await prompt(host, session, repos[name], `${mode}-${name}-again`);
			repeatTurnMs.push(Math.round(performance.now() - repeatAt));
			const idleAt = performance.now();
			await prompt(host, session, repos[name], `${mode}-${name}-idle`);
			noToolTurnMs.push(Math.round(performance.now() - idleAt));
		}
		const stored = names.filter(
			(name) => memoryRows(target.dbPath, `${mode} ${name}`).length === 1,
		).length;
		check(`measure.${mode}.every_project_wrote`, stored === count, { stored, count });
		const viaCli = names.filter((name) =>
			(provider.state.results[`${mode}-${name}`] ?? []).some((result) =>
				result.includes("ran via CLI"),
			),
		);
		check(`measure.${mode}.no_cli_fallback`, viaCli.length === 0, { viaCli });
		const processes = mcpProcesses(host);
		const sum = (values) => values.reduce((total, value) => total + (value ?? 0), 0);
		const footprintOfPids = (pids) => {
			const parts = pids.map(physicalFootprintKiB);
			return parts.includes(null) ? null : sum(parts);
		};
		const footprints = processes.map((server) => footprintOfPids(server.pids));
		// The viewer and everything it started, including its maintenance worker.
		const viewerPids = [viewer.child.pid, ...descendantsOf(viewer.child.pid).map((row) => row.pid)];
		return {
			mode,
			projects: count,
			hostStartMs,
			mcpProcesses: processes.length,
			osProcessesPerServer: processes[0]?.pids.length ?? 0,
			mcpRssKiB: processes.map((server) => sum(server.rssKiB)),
			mcpRssTotalKiB: sum(processes.flatMap((server) => server.rssKiB)),
			mcpFootprintKiB: footprints,
			mcpFootprintTotalKiB: footprints.includes(null) ? null : sum(footprints),
			viewerProcesses: viewerPids.length,
			viewerFootprintKiB: footprintOfPids(viewerPids),
			mcpReadyMs: readyMs,
			firstTurnMs: firstCallMs,
			repeatTurnMs,
			noToolTurnMs,
		};
	} finally {
		await stopChild(host.child);
		await stopChild(viewer.child);
	}
}

// ----------------------------------------------------------------------- main

async function main() {
	if (!opencodeBin || !existsSync(opencodeBin)) {
		throw new Error("Set CODEMEM_SMOKE_OPENCODE_BIN to an OpenCode binary that supports pooling");
	}
	mkdirSync(join(tempRoot, "pool-cwd"), { recursive: true });
	const packed = cliMode === "packed" ? installPackedCodemem(workspaceRoot, join(tempRoot, "packed-install")) : null;
	if (packed) pluginPackage = packed.pluginRoot;
	const launcher = writeCodememLauncher(packed?.cliEntry);
	const provider = await startProvider(SCENARIOS);
	try {
		const correctness = [];
		for (const codemode of [false, true]) {
			provider.state.results = {};
			provider.state.callerArgumentSeen = false;
			correctness.push(await runCorrectness(launcher, provider, codemode));
		}
		const measurements = [];
		for (const mode of measureProjects > 0 ? ["private", "pooled", "native"] : []) {
			measurements.push(await measureMode(mode, launcher, provider, measureProjects));
		}
		const failed = checks.filter((entry) => !entry.pass);
		const summary = {
			ok: failed.length === 0,
			cli: cliMode,
			correctness,
			measurements,
			checks,
			...(keepTemp ? { tempRoot } : {}),
		};
		process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
		return failed.length === 0;
	} finally {
		provider.server.close();
	}
}

let exitCode = 1;
try {
	exitCode = (await main()) ? 0 : 1;
} catch (error) {
	process.stderr.write(`pooled-mcp-host-smoke: ${error?.stack ?? error}\n`);
	process.stdout.write(`${JSON.stringify({ ok: false, checks }, null, 2)}\n`);
} finally {
	for (const child of [...children]) await stopChild(child);
	if (keepTemp) process.stderr.write(`kept ${tempRoot}\n`);
	else rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
process.exit(exitCode);
