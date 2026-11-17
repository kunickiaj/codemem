// Shared pieces for host smoke scripts: a scripted OpenAI-compatible provider
// that turns a named scenario into codemem memory tool calls, and helpers to
// run and inspect a real `opencode serve` host under an isolated HOME.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** Message content as text. Missing content is the empty string, never undefined. */
export const textOf = (content) =>
	typeof content === "string" ? content : (JSON.stringify(content) ?? "");

export function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
	if (result.error || result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
	}
	return result.stdout;
}

export async function freePort() {
	const server = createNetServer();
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	const { port } = server.address();
	await new Promise((done) => server.close(done));
	return port;
}

export function initRepo(dir, home) {
	mkdirSync(dir, { recursive: true });
	const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	run("git", ["init", "--initial-branch=main"], { cwd: dir, env });
	writeFileSync(join(dir, "README.md"), "# smoke\n");
	run("git", ["add", "README.md"], { cwd: dir, env });
	const identity = ["-c", "user.email=smoke@example.invalid", "-c", "user.name=Smoke"];
	run("git", [...identity, "commit", "-m", "init"], { cwd: dir, env });
}

// ------------------------------------------------------------------ provider

const MEMORY_TOOL_RE = /codemem[._]memory_/;

function sse(response, delta, finishReason) {
	const chunk = (d, finish = null) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-smoke",
			object: "chat.completion.chunk",
			created: 0,
			model: "smoke-model",
			choices: [{ index: 0, delta: d, finish_reason: finish }],
		})}\n\n`;
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write(chunk(delta));
	response.write(chunk({}, finishReason));
	response.end("data: [DONE]\n\n");
}

/** How the host offers the memory tools: as direct tools, through Code Mode, or not at all. */
function exposureOf(tools, messages) {
	const names = tools.map((tool) => tool.function?.name).filter(Boolean);
	const direct = names.filter((name) => MEMORY_TOOL_RE.test(name));
	if (direct.length > 0) return { mode: "direct", direct };
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => textOf(message.content))
		.join("\n");
	const inCatalog = names.includes("execute") && /tools\.codemem\.memory_/.test(system);
	return { mode: inCatalog ? "codemode" : "absent", direct, system };
}

function toolCallFor(step, exposure) {
	if (exposure.mode === "direct") {
		const name = exposure.direct.find((candidate) => candidate.endsWith(step.tool));
		return { name: name ?? `codemem_${step.tool}`, arguments: JSON.stringify(step.args) };
	}
	const code = `return await tools.codemem.${step.tool}(${JSON.stringify(step.args)});`;
	return { name: "execute", arguments: JSON.stringify({ code }) };
}

/**
 * Each prompt names a scenario (`smoke-scenario=<name>`). The scripted model
 * issues that scenario's steps one tool call at a time and records each
 * result. `scenarios` may be extended while the provider runs.
 */
export async function startProvider(scenarios) {
	const state = { results: {}, exposures: {}, callerArgumentSeen: false, calls: 0 };
	const marker = /smoke-scenario=([a-z0-9-]+)/;
	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8") || "{}";
		const body = JSON.parse(raw);
		const messages = body.messages ?? [];
		const tools = body.tools ?? [];
		if (tools.length > 0 && raw.includes("_codemem_caller")) state.callerArgumentSeen = true;
		// The host may append its own user-role notices after the prompt.
		const anchor = messages.findLastIndex(
			(message) => message.role === "user" && marker.test(textOf(message.content)),
		);
		const name = textOf(messages[anchor]?.content).match(marker)?.[1];
		const steps = scenarios[name]?.steps;
		if (!steps || tools.length === 0) return sse(response, { content: "done" }, "stop");
		const exposure = exposureOf(tools, messages);
		state.exposures[name] = exposure.mode;
		const results = messages.slice(anchor + 1).filter((message) => message.role === "tool");
		state.results[name] = results.map((message) => textOf(message.content));
		const step = steps[results.length];
		if (!step || exposure.mode === "absent") return sse(response, { content: "done" }, "stop");
		state.calls += 1;
		const call = {
			index: 0,
			id: `call_smoke_${state.calls}`,
			type: "function",
			function: toolCallFor(step, exposure),
		};
		return sse(response, { role: "assistant", tool_calls: [call] }, "tool_calls");
	});
	await new Promise((done) => server.listen(0, "127.0.0.1", done));
	return { server, state, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

export const providerConfig = (baseURL) => ({
	model: { providerID: "smoke", model: "smoke-model" },
	providers: {
		smoke: {
			package: "@opencode/ai/providers/openai-compatible",
			settings: { apiKey: "smoke", baseURL, provider: "smoke" },
			models: { "smoke-model": { modelID: "smoke-model", limit: { context: 200000, output: 8192 } } },
		},
	},
});

// ---------------------------------------------------------------------- host

const authHeader = (env) =>
	`Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;

export async function hostFetch(host, path, { method = "GET", body, directory } = {}) {
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

/** Spawn a process in its own group and collect its output. */
export function spawnTracked(children, command, args, options) {
	const child = spawn(command, args, { ...options, detached: true });
	children.add(child);
	let output = "";
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding("utf8");
		stream.on("data", (chunk) => {
			output += chunk;
		});
	}
	child.on("close", () => children.delete(child));
	return { child, output: () => output };
}

export async function stopChild(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const closed = once(child, "close");
	const signal = (name) => {
		try {
			process.kill(-child.pid, name);
		} catch {
			child.kill(name);
		}
	};
	signal("SIGTERM");
	const force = setTimeout(() => signal("SIGKILL"), 5_000);
	await Promise.race([closed, sleep(10_000)]);
	clearTimeout(force);
}

export async function startHost(children, binary, cwd, env) {
	const port = await freePort();
	const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"];
	const tracked = spawnTracked(children, binary, args, { cwd, env });
	const host = { ...tracked, env, baseURL: `http://127.0.0.1:${port}` };
	for (let attempt = 0; attempt < 400; attempt += 1) {
		if (tracked.child.exitCode !== null) throw new Error(`Host exited\n${tracked.output()}`);
		const info = await hostFetch(host, "/api/info").catch(() => null);
		if (info) return { ...host, version: info.version };
		await sleep(50);
	}
	throw new Error(`Host did not start\n${tracked.output()}`);
}

export async function createSession(host, directory) {
	const response = await hostFetch(host, "/api/session", {
		method: "POST",
		directory,
		body: {
			agent: "build",
			model: { providerID: "smoke", id: "smoke-model" },
			location: { directory },
		},
	});
	return response?.id ?? response?.data?.id;
}

export async function prompt(host, sessionID, directory, scenario) {
	await hostFetch(host, `/api/session/${sessionID}/prompt`, {
		method: "POST",
		directory,
		body: { text: `smoke-scenario=${scenario}` },
	});
	await hostFetch(host, `/api/experimental/session/${sessionID}/wait`, {
		method: "POST",
		directory,
	});
}

/** The named MCP server's status as one directory sees it, or null. */
export async function mcpStatus(host, directory, name) {
	const response = await hostFetch(host, "/api/mcp", { directory }).catch(() => null);
	const servers = response?.data ?? response ?? [];
	return servers.find?.((server) => server.name === name)?.status?.status ?? null;
}

export async function waitForMcp(host, directory, name, wanted = "connected") {
	const startedAt = performance.now();
	for (let attempt = 0; attempt < 1200; attempt += 1) {
		if ((await mcpStatus(host, directory, name)) === wanted) {
			return Math.round(performance.now() - startedAt);
		}
		await sleep(25);
	}
	throw new Error(`MCP server ${name} did not become ${wanted} in ${directory}`);
}

// ------------------------------------------------------------------ processes

export function descendantsOf(rootPid) {
	const rows = run("ps", ["-axo", "pid=,ppid=,rss=,command="])
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
		.filter(Boolean)
		.map(([, pid, ppid, rss, command]) => ({
			pid: Number(pid),
			ppid: Number(ppid),
			rssKiB: Number(rss),
			command,
		}));
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

/**
 * Memory the process alone accounts for, which is what exits with it. RSS
 * also counts pages shared with other processes. macOS only; null elsewhere.
 */
export function physicalFootprintKiB(pid) {
	const result = spawnSync("vmmap", ["-summary", String(pid)], { encoding: "utf8", timeout: 30_000 });
	const match = result.stdout?.match(/Physical footprint:\s+([\d.]+)([KMG])/);
	if (!match) return null;
	const scale = { K: 1, M: 1024, G: 1024 * 1024 }[match[2]];
	return Math.round(Number(match[1]) * scale);
}
