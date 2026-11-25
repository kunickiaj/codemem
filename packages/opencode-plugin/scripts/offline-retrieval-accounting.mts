import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";
import { sourceLiteral } from "./lib/scripted-host.mjs";

type Query = { query: string; project: string; limit: number; kind?: string };
type Item = { id: number; title: string; metadata: object; body_text?: string };
type Items = { items: Item[] };
type Tool = { name: string; description: string; inputSchema: object; outputSchema: object };
type Call = { name: string; arguments: object };
type Mode = "direct" | "deferred" | "program";
type Scenario = {
	name: string;
	task: string;
	queries: Query[];
	candidates: number[][];
	select: string[];
	expected: number[];
};

const SEARCH = "memory_search_index";
const HYDRATE = "memory_get_observations";
const FIXTURE_TIME = "2026-11-25T00:00:00Z";
const PROTOCOL = "2025-11-25";
const MODES: Mode[] = ["direct", "deferred", "program"];
const query = (term: string, project = "atlas", kind?: string): Query => ({
	query: term, project, limit: 20, ...(kind ? { kind } : {}),
});
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const jsonBytes = (value: unknown) => bytes(JSON.stringify(value));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ids = (value: Items) => value.items.map(({ id }) => id);

const SEED = [
	["atlas", "discovery", "relayresume checkpoint", "Backfill finished. Resume at the French (français) client smoke test."],
	["atlas", "exploration", "relayresume scratch", "Earlier notes about an unrelated dry run."],
	["atlas", "decision", "queuepolicy accepted", "Use a bounded queue to preserve backpressure."],
	["atlas", "exploration", "queuepolicy proposal", "An unbounded queue was rejected for memory growth."],
	["atlas", "bugfix", "socketstall reproduction", 'The stall starts when the proxy emits a quoted "retry" header.'],
	["atlas", "bugfix", "socketstall fix", "Flush the writer before closing the retry timer."],
	["boreal", "bugfix", "socketstall foreign", "This similarly named failure belongs to the other project."],
	["atlas", "decision", "cacheformat retired", "Version 1 is no longer supported."],
	["atlas", "decision", "cacheformat current", "Version 2 adds a checksum. Use v2 for new writes."],
	["atlas", "bugfix", "workitem critical", "Fix the API crash before launch."],
	["atlas", "bugfix", "workitem blocking", "Restore the index before restarting the worker."],
	...Array.from({ length: 12 }, (_, i) =>
		["atlas", "exploration", `workitem backlog${i}`, "An exploratory note outside the release checklist."]),
];

const SCENARIOS: Scenario[] = [
	{ name: "resume", task: "Find the next step for relayresume.", queries: [query("relayresume")],
		candidates: [[1, 2]], select: ["checkpoint"], expected: [1] },
	{ name: "decision", task: "Find the accepted queuepolicy and the rejected proposal.",
		queries: [query("queuepolicy", "atlas", "decision"), query("queuepolicy", "atlas", "exploration")],
		candidates: [[3], [4]], select: ["accepted", "proposal"], expected: [3, 4] },
	{ name: "recurring-bug", task: "Find the socketstall reproduction and fix in Atlas.",
		queries: [query("socketstall")], candidates: [[5, 6]], select: ["reproduction", "fix"], expected: [5, 6] },
	{ name: "cross-project-scope", task: "Compare Boreal's socketstall with the Atlas fix, in that order.",
		queries: [query("socketstall", "boreal"), query("socketstall")],
		candidates: [[7], [5, 6]], select: ["foreign", "fix"], expected: [7, 6] },
	{ name: "superseded", task: "Find the current cacheformat and omit the retired version.",
		queries: [query("cacheformat")], candidates: [[8, 9]], select: ["current"], expected: [9] },
	{ name: "broad-filter-hydrate", task: "Find the critical and blocking workitem records, omitting backlog notes.",
		queries: [query("workitem")], candidates: [Array.from({ length: 14 }, (_, i) => i + 10)],
		select: ["critical", "blocking"], expected: [10, 11] },
];

const requireFixtureConfig = () => {
	assert.ok(!("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET" in process.env));
	assert.ok(!("CODEMEM_SYNC_COORDINATOR_URL" in process.env));
	assert.ok(process.env.CODEMEM_CONFIG, "Set CODEMEM_CONFIG to a file containing {}");
	const config = resolve(process.env.CODEMEM_CONFIG);
	assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), {});
	return config;
};

function startMcp(home: string, config: string) {
	const fromRoot = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
	const clock = `import {mock} from "node:test";mock.timers.enable({apis:["Date"],now:new Date(${JSON.stringify(FIXTURE_TIME)})});`;
	const child = spawn(process.execPath, [
		"--import", `data:text/javascript,${encodeURIComponent(clock)}`,
		"--import", fromRoot("packages/cli/node_modules/tsx/dist/loader.mjs"),
		"--conditions", "source", fromRoot("packages/mcp-server/src/stdio.ts"),
	], {
		cwd: home, timeout: 60_000, stdio: ["pipe", "pipe", "inherit"],
		env: {
			PATH: process.env.PATH, HOME: home, TMPDIR: home, XDG_CONFIG_HOME: home,
			XDG_DATA_HOME: home, XDG_STATE_HOME: home, XDG_CACHE_HOME: home,
			CODEMEM_CONFIG: config, CODEMEM_DB: join(home, "fixture.sqlite"),
			CODEMEM_EMBEDDING_DISABLED: "1", CODEMEM_VIEWER: "0",
		},
	});
	const closed = once(child, "close");
	const lines = createInterface({ input: child.stdout });
	const pending = new Map<number, PromiseWithResolvers<string>>();
	lines.on("line", (line) => {
		const { id } = JSON.parse(line) as { id: number };
		const request = pending.get(id);
		assert.ok(request, `Unexpected MCP response ID ${id}`);
		pending.delete(id);
		request.resolve(line);
	});
	lines.on("close", () => {
		for (const entry of pending.values()) entry.reject(new Error("MCP closed before replying"));
		pending.clear();
	});
	let nextID = 1000;

	async function rpc<T>(method: string, params: object) {
		const id = nextID++;
		const sent = `${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`;
		const reply = Promise.withResolvers<string>();
		pending.set(id, reply);
		child.stdin.write(sent);
		const line = await reply.promise;
		const response = JSON.parse(line) as { id: number; error?: unknown; result: T };
		assert.equal(response.id, id);
		assert.equal(response.error, undefined);
		return { result: response.result, requestBytes: bytes(sent), replyBytes: bytes(line) + 1 };
	}

	async function call<T>(name: string, args: object) {
		const { result, ...wire } = await rpc<{
			isError?: boolean; content: { type: string; text: string }[]; structuredContent: T;
		}>("tools/call", { name, arguments: args });
		assert.ok(!result.isError, JSON.stringify(result.content));
		const [content] = result.content;
		assert.ok(content?.type === "text" && result.content.length === 1);
		assert.deepEqual(JSON.parse(content.text), result.structuredContent);
		return { value: result.structuredContent, text: content.text, ...wire };
	}
	return { call, rpc, child, closed };
}

type Mcp = ReturnType<typeof startMcp>;
const gateway = { name: "execute", inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } };
const catalog = "codemem: two retrieval tools. Discover their contracts with search.";

// One selector for all modes. It orders by task evidence, never by fixture ID or completion order.
const SELECT_SOURCE = "((results, markers) => markers.flatMap(marker => results.flatMap(r => r.items).filter(row => row.title.endsWith(' ' + marker)).map(row => row.id)))";
const selectIDs = compileFunction(`return ${SELECT_SOURCE}(...arguments);`) as
	(results: Items[], markers: string[]) => number[];
const asCall = (name: string, args: object): Call => ({ name, arguments: args });
const execute = (code: string) => asCall("execute", { code });
const invoke = (name: string, args: object) => `tools.codemem.${name}(${sourceLiteral(args)})`;
const parallel = (queries: Query[]) => `Promise.all([${queries.map((q) => invoke(SEARCH, q)).join(",")}])`;
const discoveryCode = 'return search({namespace:"codemem",query:"memory_search_index memory_get_observations"});';

async function measure(mcp: Mcp, scenario: Scenario, mode: Mode) {
	const get = (args: { ids: number[] }) => mcp.call<Items>(HYDRATE, args);
	const pendingSearches: ReturnType<typeof mcp.call<Items>>[] = [];
	const read = async (arg: Query) => {
		const result = mcp.call<Items>(SEARCH, arg);
		pendingSearches.push(result);
		return (await result).value;
	};
	const getCalls: Awaited<ReturnType<typeof get>>[] = [];
	const tools = { codemem: { [SEARCH]: read, [HYDRATE]: async (args: { ids: number[] }) => {
		const result = await get(args);
		getCalls.push(result);
		return result.value;
	} } };
	const code = `const results = await ${parallel(scenario.queries)};\nreturn await tools.codemem.${HYDRATE}({ids: ${SELECT_SOURCE}(results, ${sourceLiteral(scenario.select)})});`;
	let rounds: { calls: Call[]; results: string[] }[];
	if (mode === "program") {
		// The only source compiled here comes from constants and trusted fixture literals.
		await compileFunction(`return (async () => {${code}})();`, ["tools"])(tools);
		rounds = [{ calls: [execute(code)], results: getCalls.map(({ text }) => text) }];
	} else {
		const results = await Promise.all(scenario.queries.map(read));
		const args = { ids: selectIDs(results, scenario.select) };
		await tools.codemem[HYDRATE](args);
		const calls = scenario.queries.map((q) => asCall(SEARCH, q));
		const batch = asCall(HYDRATE, args);
		const resultsText = (await Promise.all(pendingSearches)).map(({ text }) => text);
		rounds = mode === "direct" ? [{ calls, results: resultsText }, { calls: [batch], results: getCalls.map(({ text }) => text) }]
			: [{ calls: [execute(`return await ${parallel(scenario.queries)};`)], results: [JSON.stringify(results)] },
				{ calls: [execute(`return await ${invoke(HYDRATE, args)};`)], results: getCalls.map(({ text }) => text) }];
	}
	const searchCalls = await Promise.all(pendingSearches);
	assert.deepEqual(searchCalls.map(({ value }) => ids(value).toSorted((a, b) => a - b)), scenario.candidates);
	assert.ok(searchCalls.every(({ value }) => value.items.every((item) =>
		!Object.hasOwn(item, "body") && !Object.hasOwn(item, "body_text") && Object.keys(item.metadata).length === 0)));
	assert.equal(getCalls.length, 1);
	assert.deepEqual(getCalls.map(({ value }) => ids(value)), [scenario.expected]);
	assert.ok(getCalls.every(({ value }) => value.items.every(({ body_text }) => body_text)));
	return { searchCalls, getCalls, rounds };
}

function mockAccount(scenario: Scenario, mode: Mode, tools: Tool[], rounds: Awaited<ReturnType<typeof measure>>["rounds"], temperature: "cold" | "warm") {
	const direct = mode === "direct";
	const signatures = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
	const schema = direct ? signatures : [gateway];
	const discoveredSignatures = JSON.stringify(signatures);
	const discovery = { calls: [execute(discoveryCode)], results: [discoveredSignatures] };
	const discover = !direct && temperature === "cold";
	const planned = discover ? [discovery, ...rounds] : rounds;
	const transcript: object[] = [{ role: "user", content: scenario.task }];
	if (!direct && !discover) transcript.unshift({ role: "system", content: discoveredSignatures });
	const requests = [];
	for (const round of planned) {
		requests.push(jsonBytes({ tools: schema, catalog: direct ? "" : catalog, messages: transcript }));
		transcript.push({ role: "assistant", tool_calls: round.calls });
		transcript.push(...round.results.map((content) => ({ role: "tool", content })));
	}
	requests.push(jsonBytes({ tools: schema, catalog: direct ? "" : catalog, messages: transcript }));
	const codeBytes = rounds.flatMap(({ calls }) => calls).reduce((sum, call) => {
		if ("code" in call.arguments && typeof call.arguments.code === "string") return sum + bytes(call.arguments.code);
		return sum;
	}, 0);
	return {
		schemaBytesPerRequest: jsonBytes(schema), catalogBytesPerRequest: direct ? 0 : bytes(catalog),
		discoveryCalls: Number(discover), discoveryResultBytes: direct ? 0 : bytes(discoveredSignatures),
		discoverySourceBytes: discover ? bytes(discoveryCode) : 0,
		retrievalProgramSourceBytes: codeBytes, inferenceRequests: requests.length, requestEnvelopeBytes: requests,
		modelToolCalls: planned.reduce((sum, { calls }) => sum + calls.length, 0),
		modelDependencyRounds: planned.length,
		modelIntermediateBytes: planned.slice(0, -1).flatMap(({ results }) => results).reduce((sum, text) => sum + bytes(text), 0),
		modelFinalBytes: rounds.at(-1)?.results.reduce((sum, text) => sum + bytes(text), 0),
	};
}

function ledger(dbPath: string) {
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		return db.prepare(`SELECT a.surface, a.delivery_status, e.memory_id, e.rank
			FROM retrieval_attempts a LEFT JOIN retrieval_exposures e USING (attempt_id)
			WHERE a.source = 'mcp' ORDER BY a.rowid, e.rank`).all();
	} finally {
		db.close();
	}
}

async function run(home: string, config: string) {
	const mcp = startMcp(home, config);
	try {
		const init = await mcp.rpc<{ protocolVersion: string; serverInfo: { version: string } }>("initialize", {
			protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "offline-accounting", version: "1" },
		});
		assert.equal(init.result.protocolVersion, PROTOCOL);
		mcp.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
		const listing = await mcp.rpc<{ tools: Tool[] }>("tools/list", {});
		const tools = listing.result.tools.filter(({ name }) => name === SEARCH || name === HYDRATE);
		assert.equal(tools.length, 2);
		assert.ok(tools.every(({ inputSchema, outputSchema }) => inputSchema && outputSchema));
		for (const [i, [project, kind, title, body]] of SEED.entries()) {
			const result = await mcp.call<{ id: number }>("memory_remember", { project, kind, title, body });
			assert.equal(result.value.id, i + 1);
		}
		const scenarios = [];
		for (const scenario of SCENARIOS) scenarios.push(await compare(mcp, home, scenario, tools));
		return { fixture: { time: FIXTURE_TIME, seedHash: hash({ SEED, SCENARIOS }) },
			runtime: { node: process.version, model: "scripted transcript v1", protocol: PROTOCOL, serverVersion: init.result.serverInfo.version },
			contracts: { selectedToolsSHA256: hash(tools), listReplyBytes: listing.replyBytes }, scenarios,
			...(process.argv.includes("--include-fixture-payloads") ? { toolDescriptors: tools } : {}) };
	} finally {
		mcp.child.stdin.end();
		const [code] = await mcp.closed;
		assert.equal(code, 0);
	}
}

async function compare(mcp: Mcp, home: string, scenario: Scenario, tools: Tool[]) {
	const dbPath = join(home, "fixture.sqlite");
	const results = [];
	let direct: Awaited<ReturnType<typeof measure>>["searchCalls"] | undefined;
	for (const mode of MODES) {
		const priorCount = ledger(dbPath).length;
		const { searchCalls, getCalls, rounds } = await measure(mcp, scenario, mode);
		const fixtureCalls = [...searchCalls, ...getCalls];
		const resultLedger = ledger(dbPath).slice(priorCount);
		assert.deepEqual(resultLedger.map(({ surface, memory_id }) => [surface, memory_id]),
			fixtureCalls.flatMap(({ value }, i) => ids(value).map((id) =>
				[`mcp_${i < searchCalls.length ? "search_index" : "get_observations"}`, id])));
		assert.ok(resultLedger.every(({ delivery_status }) => delivery_status === "handed_off"));
		direct ??= fixtureCalls;
		assert.deepEqual(fixtureCalls, direct, `Different MCP payloads for ${scenario.name}/${mode}`);
		const warm = mockAccount(scenario, mode, tools, rounds, "warm");
		const cold = mockAccount(scenario, mode, tools, rounds, "cold");
		assert.equal(warm.inferenceRequests, mode === "program" ? 2 : 3);
		assert.equal(cold.inferenceRequests, warm.inferenceRequests + Number(mode !== "direct"));
		if (mode === "program") assert.equal(warm.modelIntermediateBytes, 0);
		results.push({ mode, warm, cold, capture: { mcpLedgerIds: resultLedger.map(({ memory_id }) => memory_id) } });
	}
	assert.ok(direct?.length);
	const final = direct.at(-1);
	assert.ok(final);
	return { scenario: scenario.name, expectedIds: scenario.expected, actualIds: ids(final.value),
		mcp: { dependencyRounds: 2, calls: direct.map(({ value, text, ...wire }, i) =>
			({ tool: i < scenario.queries.length ? SEARCH : HYDRATE, ids: ids(value), textBytes: bytes(text), ...wire })) }, results,
		...(process.argv.includes("--include-fixture-payloads") ? {
			fixturePayloads: { task: scenario.task, queries: scenario.queries, index: direct.slice(0, -1).map(({ value }) => value), hydrated: final.value },
		} : {}),
	};
}

const config = requireFixtureConfig();
const home = mkdtempSync(join(tmpdir(), "codemem-offline-accounting-"));
try {
	process.stdout.write(`${JSON.stringify(await run(home, config), null, 2)}\n`);
} finally {
	rmSync(home, { recursive: true, force: true });
}
