// End-to-end check for codemem's plugin-native memory tools inside a real
// OpenCode V2 host (design doc rollout step 6). It starts a scratch viewer on
// a temp database, a pinned `opencode serve` host that loads this checkout's
// plugin with CODEMEM_OPENCODE_NATIVE_TOOLS=1, and a fake OpenAI-compatible
// provider that scripts memory tool calls. Everything runs under a temp HOME
// with isolated XDG/CODEMEM_* env; nothing touches the user's real config,
// database, or viewer.
//
// Run from packages/opencode-plugin: `node ./scripts/native-memory-tools-host-smoke.mjs`
// Set CODEMEM_SMOKE_KEEP=1 to keep the temp directory (provider request
// bodies, host logs, the scratch DB) and CODEMEM_SMOKE_VERBOSE=1 to include
// full tool results in the summary.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const packageRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const opencode2 = join(packageRoot, "node_modules/@opencode/cli/bin/opencode.exe");
const tsxBin = join(workspaceRoot, "packages/cli/node_modules/.bin/tsx");
const cliEntry = join(workspaceRoot, "packages/cli/src/index.ts");
const MCP_PREFERRED_TEXT = "codemem MCP server is configured";
const MEMORY_TOOL_RE = /codemem[._]memory_/;
const keepTemp = process.env.CODEMEM_SMOKE_KEEP === "1";
const verbose = process.env.CODEMEM_SMOKE_VERBOSE === "1";

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "codemem-native-tools-smoke-")));
const children = new Set();
const servers = new Set();
const checks = [];
const timings = {};
const startedAt = Date.now();

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function check(name, pass, evidence) {
	checks.push({ name, pass: Boolean(pass), ...(pass ? {} : { evidence }) });
	return Boolean(pass);
}

async function timed(label, fn) {
	const t0 = Date.now();
	try {
		return await fn();
	} finally {
		timings[label] = Date.now() - t0;
	}
}

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? packageRoot,
		encoding: "utf8",
		env: options.env ?? process.env,
		timeout: options.timeoutMs ?? 120_000,
	});
	if (result.error || result.status !== 0) {
		throw new Error(
			`Command failed: ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
		);
	}
	return result;
}

async function freePort() {
	const server = createNetServer();
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	const { port } = server.address();
	await new Promise((resolvePromise) => server.close(resolvePromise));
	return port;
}

// Detached so the viewer's maintenance worker (and anything else in the
// group) can be killed with one signal.
function spawnTracked(command, args, options) {
	const child = spawn(command, args, { ...options, detached: true });
	children.add(child);
	let output = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});
	child.on("close", () => children.delete(child));
	return { child, output: () => output };
}

async function stopTracked(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = once(child, "close");
	const signalGroup = (signal) => {
		try {
			process.kill(-child.pid, signal);
		} catch {
			child.kill(signal);
		}
	};
	signalGroup("SIGTERM");
	const forceKill = setTimeout(() => signalGroup("SIGKILL"), 5_000);
	await Promise.race([closed, sleep(10_000)]);
	clearTimeout(forceKill);
}

// ---------------------------------------------------------------- environment

function initRepo(dir, gitEnv) {
	mkdirSync(dir, { recursive: true });
	run("git", ["init", "--initial-branch=main"], { cwd: dir, env: gitEnv });
	writeFileSync(join(dir, "README.md"), `# ${dir}\n`, "utf8");
	run("git", ["add", "README.md"], { cwd: dir, env: gitEnv });
	run(
		"git",
		["-c", "user.email=smoke@example.invalid", "-c", "user.name=Smoke", "commit", "-m", "init"],
		{
			cwd: dir,
			env: gitEnv,
		},
	);
}

function buildEnvironment(viewerPort) {
	const home = join(tempRoot, "home");
	const binDir = join(tempRoot, "bin");
	mkdirSync(join(home, ".config"), { recursive: true });
	mkdirSync(binDir, { recursive: true });
	const configPath = join(tempRoot, "codemem-config.json");
	writeFileSync(configPath, "{}\n", "utf8");
	const dbPath = join(tempRoot, "mem.sqlite");
	// The plugin's CLI runner and anything that resolves `codemem` on PATH get
	// this checkout's source CLI, never a globally installed one.
	const wrapper = join(binDir, "codemem");
	writeFileSync(
		wrapper,
		`#!/bin/sh\nexec "${tsxBin}" --conditions source "${cliEntry}" "$@"\n`,
		"utf8",
	);
	chmodSync(wrapper, 0o755);
	const base = {
		PATH: `${binDir}:${process.env.PATH ?? ""}`,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		XDG_DATA_HOME: join(home, ".local/share"),
		XDG_STATE_HOME: join(home, ".local/state"),
		XDG_CACHE_HOME: join(home, ".cache"),
		CODEMEM_CONFIG: configPath,
		CODEMEM_DB: dbPath,
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_BACKEND_UPDATE_POLICY: "off",
	};
	for (const name of ["TMPDIR", "LANG", "LC_ALL"]) {
		if (process.env[name]) base[name] = process.env[name];
	}
	const viewerEnv = { ...base, CODEMEM_PLUGIN_IGNORE: "1" };
	const hostEnv = {
		...base,
		CODEMEM_OPENCODE_NATIVE_TOOLS: "1",
		CODEMEM_VIEWER_PORT: String(viewerPort),
		CODEMEM_VIEWER_HOST: "127.0.0.1",
		CODEMEM_VIEWER_AUTO: "0",
		CODEMEM_VIEWER_AUTO_STOP: "0",
		CODEMEM_RUNNER: wrapper,
		CODEMEM_PLUGIN_LOG: join(tempRoot, "plugin.log"),
		OPENCODE_DISABLE_AUTOUPDATE: "true",
		OPENCODE_DISABLE_MODELS_FETCH: "true",
		OPENCODE_SERVER_PASSWORD: randomBytes(32).toString("base64url"),
	};
	return { home, dbPath, viewerEnv, hostEnv };
}

// A throwaway V2 plugin, written into the temp dir, that makes the same
// `mcp.list()` call codemem's precedence check makes, at setup and shortly
// after, so a precedence failure shows what the host returned and when.
function writeMcpObserver(reportPath) {
	const dir = join(tempRoot, "mcp-observer");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "smoke-mcp-observer", type: "module", main: "./index.mjs" }),
		"utf8",
	);
	writeFileSync(
		join(dir, "index.mjs"),
		`import { appendFileSync } from "node:fs";
const report = (record) => appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify(record) + "\\n");
const probe = async (context, phase, t0) => {
	try {
		const response = await context.mcp.list();
		report({ phase, ms: Date.now() - t0, data: response?.data ?? response });
	} catch (error) {
		report({ phase, ms: Date.now() - t0, error: String(error?.message ?? error) });
	}
};
export default {
	id: "smoke-mcp-observer",
	async setup(context) {
		const t0 = Date.now();
		await probe(context, "setup", t0);
		const timers = [250, 1000, 3000].map((delay) => setTimeout(() => probe(context, "after_" + delay + "ms", t0), delay));
		return async () => timers.forEach(clearTimeout);
	},
};
`,
		"utf8",
	);
	return dir;
}

function writeProjectConfig(dir, providerBaseURL, { mcpServers, extraPlugins } = {}) {
	const config = {
		model: { providerID: "smoke", model: "smoke-model" },
		plugin: [packageRoot],
		...(extraPlugins ? { plugins: extraPlugins.map((pkg) => ({ package: pkg })) } : {}),
		providers: {
			smoke: {
				package: "@opencode/ai/providers/openai-compatible",
				settings: { apiKey: "smoke", baseURL: providerBaseURL, provider: "smoke" },
				models: {
					"smoke-model": { modelID: "smoke-model", limit: { context: 200000, output: 8192 } },
				},
			},
		},
		...(mcpServers ? { mcp: { servers: mcpServers } } : {}),
	};
	writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2), "utf8");
}

function writeCaptureObserver(reportPath) {
	const dir = join(tempRoot, "capture-observer");
	mkdirSync(dir);
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke-capture-observer", type: "module", main: "./index.mjs" }));
	writeFileSync(join(dir, "index.mjs"), `import { appendFileSync } from "node:fs";
export default { id: "smoke-capture-observer", async setup(context) {
  const controller = new AbortController();
  const task = (async () => {
    for await (const event of context.event.subscribe({ signal: controller.signal })) {
      if (!event.data?.sessionID) continue;
      appendFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ id: event.id, type: event.type,
        sessionID: event.data.sessionID, itemType: event.data.item?.type,
        instance: context.location.directory, location: event.location }) + "\\n");
    }
  })().catch(error => { if (!controller.signal.aborted) throw error; });
  return async () => { controller.abort(); await task; };
} };`);
	return dir;
}

// --------------------------------------------------------------------- viewer

async function startViewer(env, port, dbPath) {
	const viewer = spawnTracked(
		tsxBin,
		[
			"--conditions",
			"source",
			cliEntry,
			"serve",
			"start",
			"--foreground",
			"--host",
			"127.0.0.1",
			"--port",
			String(port),
			"--db-path",
			dbPath,
		],
		{ cwd: tempRoot, env },
	);
	for (let attempt = 0; attempt < 240; attempt += 1) {
		if (viewer.child.exitCode !== null) throw new Error(`Viewer exited\n${viewer.output()}`);
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/prompt-pack-profile`);
			if (response.ok) {
				const profile = await response.json();
				if (!profile.capabilities?.includes("memory_tool_call")) {
					throw new Error(`Viewer lacks memory_tool_call: ${JSON.stringify(profile)}`);
				}
				return { ...viewer, profile };
			}
		} catch (error) {
			if (String(error?.message).includes("memory_tool_call")) throw error;
		}
		await sleep(250);
	}
	throw new Error(`Viewer did not start\n${viewer.output()}`);
}

// ------------------------------------------------------------------- provider

const textOf = (content) => (typeof content === "string" ? content : JSON.stringify(content));

// Code Mode lists its catalog in the system prompt, not in the `execute`
// tool's schema, so both are inspected.
function classifyExposure(tools, messages = []) {
	const names = tools.map((tool) => tool.function?.name).filter(Boolean);
	const direct = names.filter((name) => MEMORY_TOOL_RE.test(name));
	const execute = tools.find((tool) => tool.function?.name === "execute");
	const systemText = messages
		.filter((message) => message.role === "system")
		.map((message) => textOf(message.content))
		.join("\n");
	const catalogLine =
		systemText.split("\n").find((line) => /^- codemem \(/.test(line.trim())) ?? null;
	const catalogPaths = [...new Set(systemText.match(/tools\.codemem\.[a-z_]+/g) ?? [])];
	const executeMentions =
		Boolean(execute) &&
		(catalogPaths.length > 0 || /memory_search/.test(JSON.stringify(execute.function)));
	let mode = "absent";
	if (direct.length > 0) mode = "direct";
	else if (executeMentions) mode = "codemode";
	return {
		mode,
		names,
		direct,
		execute: execute?.function ?? null,
		catalogLine: catalogLine?.trim() ?? null,
		catalogPaths,
	};
}

function codeArgumentName(executeFunction) {
	const properties = executeFunction?.parameters?.properties ?? {};
	if (properties.code) return "code";
	return Object.keys(properties).find((key) => properties[key]?.type === "string") ?? "code";
}

// One scripted step becomes either a direct function call or a Code Mode
// `execute` call running the same memory tool.
function toolCallFor(step, exposure) {
	if (exposure.mode === "direct") {
		const name =
			exposure.direct.find((candidate) => candidate.endsWith(step.tool)) ?? `codemem_${step.tool}`;
		return { name, arguments: JSON.stringify(step.args) };
	}
	const code = `return await tools.codemem.${step.tool}(${JSON.stringify(step.args)});`;
	return {
		name: "execute",
		arguments: JSON.stringify({ [codeArgumentName(exposure.execute)]: code }),
	};
}

function sseChunk(delta, finishReason = null) {
	return `data: ${JSON.stringify({
		id: "chatcmpl-smoke",
		object: "chat.completion.chunk",
		created: 0,
		model: "smoke-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`;
}

function respondText(response, text) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(sseChunk({ role: "assistant", content: text }));
	response.write(sseChunk({}, "stop"));
	response.end("data: [DONE]\n\n");
}

function respondToolCall(response, call, callID) {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(
		sseChunk({
			role: "assistant",
			tool_calls: [{ index: 0, id: callID, type: "function", function: call }],
		}),
	);
	response.write(sseChunk({}, "tool_calls"));
	response.end("data: [DONE]\n\n");
}

function dumpRequest(index, rawBody) {
	if (!keepTemp) return;
	mkdirSync(join(tempRoot, "provider-requests"), { recursive: true });
	writeFileSync(join(tempRoot, "provider-requests", `${index}.json`), rawBody, "utf8");
}

function parseCompletionRequest(body) {
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
	const scenarioMatch = textOf(messages[latestUserIndex]?.content).match(
		/smoke-scenario=([a-z-]+)/,
	);
	return {
		tools,
		scenarioName: scenarioMatch?.[1] ?? null,
		toolMessages: messages.slice(latestUserIndex + 1).filter((m) => m.role === "tool"),
		exposure: classifyExposure(tools, messages),
	};
}

// Records tool results for earlier steps of the scenario and returns the next
// tool call to send, or null when the scenario is done.
function advanceScenario(state, scenarios, parsed) {
	const { scenarioName, toolMessages, exposure, tools } = parsed;
	const scenario = scenarioName ? scenarios[scenarioName] : null;
	if (!scenario) return null;
	state.results[scenarioName] ??= { exposure, steps: [] };
	const record = state.results[scenarioName];
	record.exposure = exposure;
	toolMessages.forEach((message, index) => {
		if (record.steps[index]) record.steps[index].toolResult = message.content;
	});
	const nextStep = scenario.steps[toolMessages.length];
	if (!nextStep || tools.length === 0 || exposure.mode === "absent") return null;
	const call = toolCallFor(nextStep, exposure);
	record.steps[toolMessages.length] = { ...nextStep, call };
	state.callCounter += 1;
	return { call, callID: `call_smoke_${state.callCounter}` };
}

async function startProvider(scenarios) {
	const state = { requests: [], results: {}, callCounter: 0 };
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		if (!request.url?.endsWith("/chat/completions")) {
			response.writeHead(404).end();
			return;
		}
		const rawBody = Buffer.concat(chunks).toString("utf8");
		dumpRequest(state.requests.length, rawBody);
		const parsed = parseCompletionRequest(JSON.parse(rawBody));
		state.requests.push({
			scenario: parsed.scenarioName,
			toolCount: parsed.tools.length,
			exposure: parsed.exposure.mode,
			toolNames: parsed.exposure.names,
		});
		const next = advanceScenario(state, scenarios, parsed);
		if (next) respondToolCall(response, next.call, next.callID);
		else respondText(response, "smoke-done");
	});
	servers.add(server);
	await new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolvePromise);
	});
	return {
		baseURL: `http://127.0.0.1:${server.address().port}/v1`,
		requests: () => state.requests,
		results: () => state.results,
	};
}

// ----------------------------------------------------------------------- host

const authHeader = (env) =>
	`Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;

async function hostFetch(host, path, { method = "GET", body, directory } = {}) {
	const url = new URL(path, host.baseURL);
	if (directory) url.searchParams.set("location[directory]", directory);
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: authHeader(host.env),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text}`);
	return text ? JSON.parse(text) : null;
}

async function startHost(cwd, env) {
	const host = spawnTracked(
		opencode2,
		["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"],
		{ cwd, env },
	);
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (host.child.exitCode !== null)
			throw new Error(`Host exited during startup\n${host.output()}`);
		const match = host.output().match(/server listening on (http:\/\/\S+)/);
		if (match) {
			try {
				const response = await fetch(`${match[1]}/api/info`, {
					headers: { Authorization: authHeader(env) },
				});
				if (response.ok) return { ...host, baseURL: match[1], env };
			} catch {
				// not bound yet
			}
		}
		await sleep(50);
	}
	throw new Error(`Host did not start\n${host.output()}`);
}

async function waitForPlugin(host, directory) {
	let entries = [];
	for (let attempt = 0; attempt < 400; attempt += 1) {
		entries = (await hostFetch(host, "/api/plugin", { directory })).data ?? [];
		const failed = entries.filter((entry) => entry.state?.status === "failed");
		if (failed.length > 0) throw new Error(`Plugin activation failed: ${JSON.stringify(failed)}`);
		if (entries.some((entry) => entry.id === "codemem" && entry.state?.status === "active")) {
			return entries;
		}
		await sleep(50);
	}
	throw new Error(`codemem plugin did not activate in ${directory}: ${JSON.stringify(entries)}`);
}

async function createSession(host, directory) {
	const response = await hostFetch(host, "/api/session", {
		method: "POST",
		directory,
		body: {
			agent: "build",
			model: { providerID: "smoke", id: "smoke-model" },
			location: { directory },
		},
	});
	const id = response?.id ?? response?.data?.id;
	if (typeof id !== "string")
		throw new Error(`Session create returned ${JSON.stringify(response)}`);
	return id;
}

async function moveSession(host, session, directory) {
	await hostFetch(host, `/api/session/${session}/move`, { method: "POST", body: { directory, delivery: "queue" } });
	for (let attempt = 0; attempt < 200; attempt += 1) {
		const result = await hostFetch(host, `/api/session/${session}`);
		if ((result.data ?? result).location?.directory === directory) return;
		await sleep(25);
	}
	throw new Error("Synthetic session move did not reach its destination");
}

async function promptAndWait(host, sessionID, directory, text) {
	await hostFetch(host, `/api/session/${sessionID}/prompt`, {
		method: "POST",
		directory,
		body: { text },
	});
	await hostFetch(host, `/api/experimental/session/${sessionID}/wait`, {
		method: "POST",
		directory,
	});
}

// Best effort: the host's own view of tool parts, for error-shape evidence.
async function readSessionMessages(host, sessionID, directory) {
	for (const path of [`/api/session/${sessionID}/message`, `/api/session/${sessionID}/messages`]) {
		try {
			return { path, data: await hostFetch(host, path, { directory }) };
		} catch (error) {
			if (!String(error.message).includes("HTTP 404")) return { path, error: error.message };
		}
	}
	return null;
}

function collectToolParts(value, found = []) {
	if (Array.isArray(value)) {
		for (const item of value) collectToolParts(item, found);
	} else if (value && typeof value === "object") {
		if (value.type === "tool" || (typeof value.tool === "string" && "state" in value)) {
			found.push(value);
			return found;
		}
		for (const item of Object.values(value)) collectToolParts(item, found);
	}
	return found;
}

// ------------------------------------------------------------- process checks

function descendantsOf(rootPid) {
	const output = run("ps", ["-axo", "pid=,ppid=,command="]).stdout;
	const rows = output
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
		.filter(Boolean)
		.map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command }));
	const found = [];
	const frontier = [rootPid];
	while (frontier.length > 0) {
		const parent = frontier.pop();
		for (const row of rows.filter((candidate) => candidate.ppid === parent)) {
			found.push(row);
			frontier.push(row.pid);
		}
	}
	return found;
}

const isCodememMcpProcess = (command) =>
	/codemem/.test(command) && /(\s|^)mcp(\s|$)|mcp-server/.test(command);

// ----------------------------------------------------------------- db checks

function openDb(dbPath) {
	return new DatabaseSync(dbPath, { readOnly: true });
}

function columnsOf(db, table) {
	return db
		.prepare(`PRAGMA table_info(${table})`)
		.all()
		.map((row) => row.name);
}

function memoryRows(db, title) {
	return db
		.prepare(
			`SELECT m.id, m.title, m.kind, m.session_id, s.cwd, s.project
			 FROM memory_items m LEFT JOIN sessions s ON s.id = m.session_id
			 WHERE m.title = ?`,
		)
		.all(title);
}

function retrievalSummary(db) {
	return db
		.prepare(
			"SELECT surface, COUNT(*) AS count, GROUP_CONCAT(DISTINCT stream_id) AS streams FROM retrieval_attempts GROUP BY surface",
		)
		.all();
}

function rawEventSummary(db) {
	const tables = db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'raw_event%'")
		.all()
		.map((row) => row.name);
	if (!tables.includes("raw_events")) return { tables, rows: [] };
	const columns = columnsOf(db, "raw_events");
	const payloadColumn = columns.find((name) => /payload/.test(name)) ?? null;
	const typeColumn = columns.find((name) => name === "event_type") ?? null;
	const rows = db
		.prepare(
			`SELECT ${[typeColumn, payloadColumn].filter(Boolean).join(", ") || "*"} FROM raw_events`,
		)
		.all()
		.map((row) => ({
			type: typeColumn ? row[typeColumn] : null,
			payload: payloadColumn ? String(row[payloadColumn] ?? "") : JSON.stringify(row),
		}));
	return { tables, columns, rows };
}

function toolEventsIn(rawEvents) {
	return rawEvents.rows
		.map((row) => {
			let parsed = null;
			try {
				parsed = JSON.parse(row.payload);
			} catch {
				// payload is not JSON
			}
			const tool = parsed?.tool ?? parsed?.tool_name ?? parsed?.name ?? null;
			return { type: row.type, tool, parsed, payload: row.payload };
		})
		.filter((event) => event.tool || /tool/.test(String(event.type)));
}

// --------------------------------------------------------------------- flows

const rememberStep = (title, project) => ({
	tool: "memory_remember",
	args: { kind: "decision", title, body: `${project} only`, project },
});
const searchStep = { tool: "memory_search", args: { query: "smoke" } };

const SCENARIOS = {
	alpha: { steps: [rememberStep("Alpha smoke", "alpha"), searchStep] },
	beta: { steps: [rememberStep("Beta smoke", "beta"), searchStep] },
	// Alpha searches again once beta's memory exists, so alpha's isolation
	// check has a foreign-project memory to exclude.
	"alpha-after-beta": { steps: [searchStep] },
	nested: { steps: [] },
	"move-alpha": { steps: [] },
	"move-beta": { steps: [] },
	"move-worktree": { steps: [] },
	"move-alpha-back": { steps: [] },
	// Step 1 fails host-side schema validation; step 2 passes the schema and
	// fails in the MCP handler, so it exercises the plugin's Tool.Error path.
	"bad-args": {
		steps: [
			{ tool: "memory_get", args: { memory_id: "x" } },
			{ tool: "memory_distill_candidates", args: { all_projects: true, project: "alpha" } },
		],
	},
	precedence: { steps: [searchStep] },
};

function assertSearchIsolation(results) {
	// Both searches run after both memories exist (beta writes after alpha).
	for (const [scenario, searchResult, own, other] of [
		[
			"alpha",
			textOf(results["alpha-after-beta"]?.steps[0]?.toolResult ?? ""),
			"Alpha smoke",
			"Beta smoke",
		],
		["beta", textOf(results.beta?.steps[1]?.toolResult ?? ""), "Beta smoke", "Alpha smoke"],
	]) {
		check(
			`a.${scenario}_search_scoped`,
			searchResult.includes(own) && !searchResult.includes(other),
			{ toolResult: searchResult.slice(0, 2000) },
		);
		const rememberResult = textOf(results[scenario]?.steps[0]?.toolResult ?? "");
		check(
			`a.${scenario}_remember_ok`,
			/"id"|memory_id|\d/.test(rememberResult) && !/error/i.test(rememberResult),
			{
				toolResult: rememberResult.slice(0, 2000),
			},
		);
	}
}

// Expected mcp_search ledger rows per OpenCode session: alpha searches twice
// (before and after beta writes), beta once.
function assertSearchStreams(db, sessions) {
	const rows = db
		.prepare(
			"SELECT stream_id AS stream, COUNT(*) AS count FROM retrieval_attempts WHERE surface = 'mcp_search' GROUP BY stream_id",
		)
		.all();
	const counts = Object.fromEntries(rows.map((row) => [row.stream, row.count]));
	const expected = { [sessions.alpha]: 2, [sessions.beta]: 1 };
	check(
		"c.retrieval_mcp_search_streams",
		Boolean(sessions.alpha && sessions.beta) &&
			rows.length === 2 &&
			Object.entries(expected).every(([stream, count]) => counts[stream] === count),
		{ expected, actual: counts },
	);
}

function assertDatabase(dbPath, repos, sessions) {
	const db = openDb(dbPath);
	try {
		for (const [title, dir] of [
			["Alpha smoke", repos.alpha],
			["Beta smoke", repos.beta],
		]) {
			const rows = memoryRows(db, title);
			check(
				`c.${title.split(" ")[0].toLowerCase()}_session_cwd`,
				rows.length === 1 && existsSync(String(rows[0].cwd)) && realpathSync(rows[0].cwd) === dir,
				{ rows, expectedCwd: dir },
			);
		}
		assertSearchStreams(db, sessions);
		return { retrieval: retrievalSummary(db) };
	} finally {
		db.close();
	}
}

// Capture ownership is a hard privacy gate alongside native-tool scope isolation.
function captureAttribution(dbPath, sessionDirs) {
	const db = openDb(dbPath);
	try {
		const sessions = db
			.prepare("SELECT opencode_session_id AS session, cwd, project FROM raw_event_sessions")
			.all()
			.map((row) => ({ ...row, expectedCwds: [sessionDirs[row.session] ?? []].flat() }));
		const duplicatePrompts = db
			.prepare(
				`SELECT opencode_session_id AS session, json_extract(payload_json, '$.prompt_text') AS prompt,
				 COUNT(*) AS copies FROM raw_events WHERE event_type = 'user_prompt'
				 GROUP BY 1, 2 HAVING COUNT(*) > 1`,
			)
			.all();
		return {
			misattributedSessions: sessions.filter(
				(row) => row.expectedCwds.length > 0 && !row.expectedCwds.includes(row.cwd),
			),
			duplicatePrompts,
			conversationCounts: conversationEventCounts(db, Object.keys(sessionDirs)),
		};
	} finally {
		db.close();
	}
}

// Ordinary conversation events per tested session. Capture exclusion is only
// meaningful when capture demonstrably ran for those sessions.
function conversationEventCounts(db, sessionIds) {
	const counts = {};
	for (const session of sessionIds) {
		const row = db
			.prepare(
				`SELECT SUM(event_type = 'user_prompt') AS prompts,
				 SUM(event_type = 'assistant_message') AS assistant
				 FROM raw_events WHERE opencode_session_id = ?`,
			)
			.get(session);
		counts[session] = { prompts: Number(row?.prompts ?? 0), assistant: Number(row?.assistant ?? 0) };
	}
	return counts;
}

function assertMovedSessionCapture(dbPath, session, repos) {
	const db = openDb(dbPath);
	try {
		const rows = db.prepare(`SELECT s.cwd, s.project, SUM(r.event_type = 'user_prompt') AS prompts,
			SUM(r.event_type = 'assistant_message') AS assistant
			FROM raw_events r JOIN raw_event_sessions s ON s.source = r.source AND s.stream_id = r.stream_id
			WHERE r.opencode_session_id = ? GROUP BY s.stream_id`).all(session);
		const expected = new Map([[repos.alpha, ["alpha", 2]], [repos.beta, ["beta", 1]], [repos.worktree, ["alpha", 1]]]);
		check("c.move_capture_by_project_and_worktree", rows.length === 3 && rows.every(row => {
			const target = expected.get(row.cwd);
			return target && row.project === target[0] && row.prompts === target[1] && row.assistant === target[1];
		}), { streams: rows });
	} finally { db.close(); }
}

const hasConversation = (counts) =>
	Object.values(counts).every((entry) => entry.prompts > 0 && entry.assistant > 0);

/** Wait until every tested session has captured prompt and assistant events. */
async function waitForRawEvents(dbPath, sessionIds, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let summary;
	let counts = {};
	while (Date.now() < deadline) {
		const db = openDb(dbPath);
		try {
			summary = rawEventSummary(db);
			if (summary.tables.includes("raw_events")) counts = conversationEventCounts(db, sessionIds);
		} finally {
			db.close();
		}
		if (sessionIds.length > 0 && hasConversation(counts)) break;
		await sleep(250);
	}
	check("c.capture_ran_for_tested_sessions", sessionIds.length > 0 && hasConversation(counts), {
		conversationEvents: counts,
		rawEventRows: summary?.rows.length ?? 0,
	});
	return summary;
}

function assertCapture(rawEvents, exposureMode) {
	const toolEvents = toolEventsIn(rawEvents);
	const memoryEvents = toolEvents.filter((event) => MEMORY_TOOL_RE.test(String(event.tool)));
	check("c.capture_no_memory_tool_events", memoryEvents.length === 0, {
		memoryEvents: memoryEvents.map((event) => event.payload.slice(0, 400)),
	});
	const executeEvents = toolEvents.filter((event) => event.tool === "execute");
	const leaked = executeEvents.filter((event) =>
		/Alpha smoke|Beta smoke|memory_remember|memory_search/.test(event.payload),
	);
	if (exposureMode === "codemode") {
		check("c.capture_outer_execute_has_no_memory_payload", leaked.length === 0, {
			leakedExecuteEvents: leaked.length,
			firstLeakedPayload: leaked[0]?.payload.slice(0, 400),
		});
	}
	return {
		rawEventCount: rawEvents.rows.length,
		rawEventTables: rawEvents.tables,
		toolEvents: toolEvents.map((event) => ({ type: event.type, tool: event.tool })),
		executeEventSamples: executeEvents.slice(0, 2).map((event) => event.payload.slice(0, 500)),
	};
}

async function runMainHost({ hostEnv, repos }) {
	const host = await timed("host_start", () => startHost(repos.alpha, hostEnv));
	const evidence = {};
	try {
		await timed("plugin_activate", async () => {
			await waitForPlugin(host, repos.alpha);
			await waitForPlugin(host, repos.beta);
		});
		const alphaSession = await createSession(host, repos.alpha);
		const betaSession = await createSession(host, repos.beta);
		evidence.sessionDirs = { [alphaSession]: repos.alpha, [betaSession]: repos.beta };
		evidence.sessions = { alpha: alphaSession, beta: betaSession };
		await timed("alpha_session", () =>
			promptAndWait(host, alphaSession, repos.alpha, "smoke-scenario=alpha"),
		);
		await timed("beta_session", () =>
			promptAndWait(host, betaSession, repos.beta, "smoke-scenario=beta"),
		);
		await timed("alpha_after_beta_session", () =>
			promptAndWait(host, alphaSession, repos.alpha, "smoke-scenario=alpha-after-beta"),
		);
		await timed("bad_args_session", () =>
			promptAndWait(host, alphaSession, repos.alpha, "smoke-scenario=bad-args"),
		);
		const nested = join(repos.alpha, "nested");
		mkdirSync(nested);
		await waitForPlugin(host, nested);
		const nestedSession = await createSession(host, nested);
		// Captured metadata uses the working-copy root, while plugin ownership uses
		// the exact session location so nested sessions retain their own runtime.
		evidence.sessionDirs[nestedSession] = repos.alpha;
		evidence.sessions.nested = nestedSession;
		await timed("nested_session", () => promptAndWait(host, nestedSession, nested, "smoke-scenario=nested"));
		const moving = await createSession(host, repos.alpha);
		evidence.sessions.moving = moving;
		evidence.sessionDirs[moving] = [repos.alpha, repos.beta, repos.worktree];
		await promptAndWait(host, moving, repos.alpha, "smoke-scenario=move-alpha");
		for (const [destination, scenario] of [[repos.beta, "move-beta"], [repos.worktree, "move-worktree"], [repos.alpha, "move-alpha-back"]]) {
			await waitForPlugin(host, destination);
			await moveSession(host, moving, destination);
			await promptAndWait(host, moving, destination, `smoke-scenario=${scenario}`);
		}
		const descendants = descendantsOf(host.child.pid);
		const mcpChildren = descendants.filter((row) => isCodememMcpProcess(row.command));
		check("b.no_codemem_mcp_descendants", mcpChildren.length === 0, { mcpChildren, descendants });
		evidence.descendantCommands = descendants.map((row) => row.command.slice(0, 160));
		const messages = await readSessionMessages(host, alphaSession, repos.alpha);
		evidence.badArgsHostToolParts = collectToolParts(messages?.data)
			.filter((part) => /memory_(get|distill_candidates)/.test(JSON.stringify(part)))
			.map((part) => JSON.stringify(part).slice(0, 1500));
		evidence.sessionMessagesRoute = messages?.path ?? null;
		evidence.sessionMessagesError = messages?.error ?? null;
	} finally {
		await timed("host_stop", () => stopTracked(host.child));
		if (keepTemp) writeFileSync(join(tempRoot, "host-main.log"), host.output(), "utf8");
	}
	evidence.hostLogMcpPreferred = host
		.output()
		.split("\n")
		.filter((line) => line.includes(MCP_PREFERRED_TEXT));
	evidence.hostLogTail = host
		.output()
		.split("\n")
		.filter((line) => /codemem/i.test(line))
		.slice(-15);
	return evidence;
}

const readText = (path) => (existsSync(path) ? readFileSync(path, "utf8") : "");

const readJsonLines = (path) =>
	readText(path)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));

async function runPrecedenceHost({ hostEnv, provider, repos, observerReport }) {
	let precedenceSession = null;
	const env = { ...hostEnv, CODEMEM_PLUGIN_LOG: join(tempRoot, "plugin-precedence.log") };
	const host = await timed("precedence_host_start", () => startHost(repos.gamma, env));
	try {
		await waitForPlugin(host, repos.gamma);
		const session = await createSession(host, repos.gamma);
		precedenceSession = session;
		const before = provider.requests().length;
		await timed("precedence_session", () =>
			promptAndWait(host, session, repos.gamma, "smoke-scenario=precedence"),
		);
		const requests = provider
			.requests()
			.slice(before)
			.filter((request) => request.scenario === "precedence" && request.toolCount > 0);
		const exposure = provider.results().precedence?.exposure;
		check(
			"d.precedence_memory_tools_hidden",
			requests.length > 0 && requests.every((request) => request.exposure === "absent"),
			{
				primaryRequestsWithTools: requests.length,
				exposureModes: requests.map((request) => request.exposure),
				catalogLine: exposure?.catalogLine ?? null,
			},
		);
		const mcpList = await hostFetch(host, "/api/mcp", { directory: repos.gamma }).catch(
			(error) => ({
				error: error.message,
			}),
		);
		// The walk should find the placeholder MCP server here; that proves the
		// main run's empty result is real and not a broken process walk.
		const descendants = descendantsOf(host.child.pid);
		check(
			"b.process_walk_sees_configured_mcp_child",
			descendants.some((row) => row.command.includes("setInterval")),
			{ descendants },
		);
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline && !readText(observerReport).includes("after_3000ms")) {
			await sleep(100);
		}
		return {
			toolNamesSeen: requests[0]?.toolNames ?? [],
			codeModeCatalogLine: exposure?.catalogLine ?? null,
			codeModeCatalogPaths: exposure?.catalogPaths ?? [],
			mcpList,
			logFile: env.CODEMEM_PLUGIN_LOG,
			session: precedenceSession,
			host,
		};
	} finally {
		await stopTracked(host.child);
		if (keepTemp) writeFileSync(join(tempRoot, "host-precedence.log"), host.output(), "utf8");
	}
}

function findTextInTree(root, needle) {
	const hits = [];
	const visit = (path) => {
		const stat = statSync(path, { throwIfNoEntry: false });
		if (!stat) return;
		if (stat.isDirectory()) {
			for (const entry of readdirSync(path)) visit(join(path, entry));
			return;
		}
		if (!stat.isFile() || stat.size > 5_000_000 || path.endsWith(".sqlite")) return;
		const lines = readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.includes(needle));
		if (lines.length > 0)
			hits.push({ path: path.slice(tempRoot.length + 1), lines: lines.slice(0, 3) });
	};
	visit(root);
	return hits;
}

// ----------------------------------------------------------------------- main

function summarizeToolResults(results) {
	const summary = {};
	for (const [scenario, value] of Object.entries(results)) {
		summary[scenario] = value.steps.map((step) => ({
			tool: step.tool,
			call: step.call,
			toolResult: textOf(step.toolResult ?? null).slice(0, 600),
		}));
	}
	return summary;
}

async function setupFixture() {
	if (!existsSync(opencode2)) throw new Error(`Pinned OpenCode V2 binary missing: ${opencode2}`);
	if (!existsSync(tsxBin)) throw new Error(`tsx missing: ${tsxBin}`);
	const gitEnv = {
		...process.env,
		HOME: join(tempRoot, "home"),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	delete gitEnv.GIT_DIR;
	delete gitEnv.GIT_WORK_TREE;
	const repos = {
		alpha: join(tempRoot, "alpha"),
		beta: join(tempRoot, "beta"),
		gamma: join(tempRoot, "gamma"),
	};
	for (const dir of Object.values(repos)) initRepo(dir, gitEnv);
	repos.worktree = join(tempRoot, "alpha-worktree");
	run("git", ["worktree", "add", "--detach", repos.worktree, "HEAD"], { cwd: repos.alpha, env: gitEnv });
	const viewerPort = await freePort();
	const { dbPath, viewerEnv, hostEnv } = buildEnvironment(viewerPort);
	const viewer = await timed("viewer_start", () => startViewer(viewerEnv, viewerPort, dbPath));
	const provider = await startProvider(SCENARIOS);
	const captureObserver = writeCaptureObserver(join(tempRoot, "capture-events.jsonl"));
	for (const repo of [repos.alpha, repos.beta, repos.worktree]) writeProjectConfig(repo, provider.baseURL, { extraPlugins: [captureObserver] });
	const observerReport = join(tempRoot, "mcp-observer.jsonl");
	writeProjectConfig(repos.gamma, provider.baseURL, {
		mcpServers: {
			codemem: { type: "local", command: ["node", "-e", "setInterval(()=>{},1e9)"] },
		},
		extraPlugins: [writeMcpObserver(observerReport)],
	});
	const hostVersion = run(opencode2, ["--version"], {
		cwd: repos.alpha,
		env: hostEnv,
	}).stdout.trim();
	return { repos, viewerPort, dbPath, hostEnv, viewer, provider, observerReport, hostVersion };
}

function assertErrorPaths(results) {
	const schemaError = textOf(results["bad-args"]?.steps[0]?.toolResult ?? "");
	check("e.bad_args_error_visible", /invalid|expected/i.test(schemaError), {
		toolResult: schemaError,
	});
	const handlerError = textOf(results["bad-args"]?.steps[1]?.toolResult ?? "");
	check("e.handler_error_visible", /all_projects/.test(handlerError), {
		toolResult: handlerError,
	});
	return { schemaError, handlerError };
}

function precedenceSummary(precedence, observerRecords) {
	return {
		codeModeCatalogLine: precedence.codeModeCatalogLine,
		mcpListAfterPrompt: precedence.mcpList?.data ?? precedence.mcpList,
		observerMcpList: observerRecords.map((record) => ({
			phase: record.phase,
			ms: record.ms,
			servers: record.error ?? record.data,
		})),
		hostLogLines: precedence.host
			.output()
			.split("\n")
			.filter((line) => line.includes(MCP_PREFERRED_TEXT)),
		filesMentioningWarning: findTextInTree(tempRoot, MCP_PREFERRED_TEXT)
			.filter((hit) => !hit.path.includes("/.cache/"))
			.map((hit) => hit.path),
	};
}

async function main() {
	const fixture = await setupFixture();
	const { repos, dbPath, hostEnv, provider, observerReport } = fixture;
	const mainEvidence = await runMainHost({ hostEnv, repos });
	const results = provider.results();
	const exposure = results.alpha?.exposure ?? classifyExposure([]);
	check("exposure.memory_tools_offered", exposure.mode !== "absent", {
		requests: provider.requests(),
	});
	assertSearchIsolation(results);
	const errors = assertErrorPaths(results);
	const { retrieval } = assertDatabase(dbPath, repos, mainEvidence.sessions ?? {});
	// Raw events flush at idle/dispose; give the viewer a moment to ingest.
	const testedSessions = Object.keys(mainEvidence.sessionDirs ?? {});
	const capture = assertCapture(
		await waitForRawEvents(dbPath, testedSessions, 10_000),
		exposure.mode,
	);

	const precedence = await runPrecedenceHost({ hostEnv, provider, repos, observerReport });
	const attribution = captureAttribution(dbPath, {
		...mainEvidence.sessionDirs,
		...(precedence.session ? { [precedence.session]: repos.gamma } : {}),
	});
	check("c.capture_session_ownership", attribution.misattributedSessions.length === 0, attribution);
	check("c.capture_no_duplicate_prompts", attribution.duplicatePrompts.length === 0, attribution);
	for (const [name, session, count] of [
		["alpha", mainEvidence.sessions.alpha, 3],
		["beta", mainEvidence.sessions.beta, 1],
		["nested", mainEvidence.sessions.nested, 1],
		["moving", mainEvidence.sessions.moving, 4],
	]) {
		const actual = attribution.conversationCounts[session];
		check(`c.${name}_exactly_once_capture`, actual?.prompts === count && actual?.assistant === count,
			{ expected: count, actual });
	}
	const publications = new Map(readJsonLines(join(tempRoot, "capture-events.jsonl"))
		.filter(event => event.sessionID === mainEvidence.sessions.moving && event.type === "session.inbox.enqueued" && event.itemType === "user")
		.map(event => [event.id, event.location?.directory]));
	check("c.move_publication_locations", JSON.stringify([...publications.values()]) === JSON.stringify([
		repos.alpha, repos.beta, repos.worktree, repos.alpha,
	]), { locations: [...publications.values()] });
	assertMovedSessionCapture(dbPath, mainEvidence.sessions.moving, repos);
	await stopTracked(fixture.viewer.child);

	const failed = checks.filter((entry) => !entry.pass);
	const summary = {
		ok: failed.length === 0,
		hostVersion: fixture.hostVersion,
		exposureMode: exposure.mode,
		effectiveToolNames: exposure.mode === "direct" ? exposure.direct : exposure.catalogPaths,
		codeModeCatalogLine: exposure.catalogLine,
		checks,
		errorPaths: {
			schemaError: errors.schemaError.slice(0, 400),
			handlerError: errors.handlerError.slice(0, 400),
			hostToolParts: mainEvidence.badArgsHostToolParts.map((part) => part.slice(0, 600)),
		},
		retrieval,
		capture,
		captureAttribution: attribution,
		precedence: precedenceSummary(precedence, readJsonLines(observerReport)),
		codememMcpDescendants: mainEvidence.descendantCommands.filter(isCodememMcpProcess),
		timingsMs: { ...timings, total: Date.now() - startedAt },
		...(verbose ? { toolResults: summarizeToolResults(results), mainEvidence } : {}),
		...(keepTemp ? { tempRoot } : {}),
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	return failed.length === 0;
}

let exitCode = 1;
try {
	exitCode = (await main()) ? 0 : 1;
} catch (error) {
	process.stderr.write(`native-memory-tools-host-smoke: ${error?.stack ?? error}\n`);
	process.stdout.write(
		`${JSON.stringify({ ok: false, error: String(error?.message ?? error), checks, timingsMs: timings }, null, 2)}\n`,
	);
} finally {
	for (const child of [...children]) await stopTracked(child);
	for (const server of servers) server.close();
	if (!keepTemp)
		rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	else process.stderr.write(`kept ${tempRoot}\n`);
}
process.exit(exitCode);
