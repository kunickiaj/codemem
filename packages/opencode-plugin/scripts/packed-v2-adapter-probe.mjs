import { createServer } from "node:http";

const V2_SESSION = "packed-session";
const V1_SESSION = "packed-v1-session";
const CAPTURE_TYPES = new Set([
	"user_prompt",
	"assistant_message",
	"assistant_usage",
	"tool.execute.after",
]);

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function startReceiver() {
	const rows = [];
	const server = createServer(async (request, response) => {
		if (request.method === "GET" && request.url?.startsWith("/api/raw-events/status")) {
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ingest: { available: true } }));
			return;
		}
		if (request.method === "POST" && request.url === "/api/raw-events") {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			rows.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true }));
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	return { rows, server };
}

function rowsForSession(rows, sessionID) {
	const uniqueRows = new Map();
	for (const row of rows) {
		if (row.session_id !== sessionID || !CAPTURE_TYPES.has(row.event_type)) continue;
		uniqueRows.set(row.event_id, row);
	}
	return [...uniqueRows.values()];
}

async function waitForRows(rows, sessionID, count) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (rowsForSession(rows, sessionID).length >= count) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(
		`Packed capture timed out for ${sessionID}: ${JSON.stringify(rowsForSession(rows, sessionID).map((row) => ({ eventID: row.event_id, toolCallID: row.payload?.tool_call_id, type: row.event_type })))}`,
	);
}

async function waitWithTimeout(promise, timeoutMs, message) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function normalizePayload(row) {
	const payload = row.payload;
	if (row.event_type === "user_prompt") {
		return { type: row.event_type, promptNumber: payload.prompt_number, text: payload.prompt_text };
	}
	if (row.event_type === "assistant_message") {
		return {
			type: row.event_type,
			messageID: payload.message_id.replace(/^v[12]-/, ""),
			text: payload.assistant_text,
		};
	}
	if (row.event_type === "assistant_usage") {
		return { type: row.event_type, usage: payload.usage };
	}
	return {
		type: row.event_type,
		tool: payload.tool,
		args: payload.args,
		result: payload.result,
		error: payload.error,
	};
}

const normalizeRows = (rows, sessionID) =>
	rowsForSession(rows, sessionID)
		.map(normalizePayload)
		.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

function assertEntrypoint(mod) {
	assert(mod.default && typeof mod.default === "object", "default export is not an object");
	assert(mod.default.id === "codemem", "default export has the wrong id");
	assert(typeof mod.default.server === "function", "default server is not a function");
	assert(typeof mod.default.setup === "function", "default setup is not a function");
	assert(typeof mod.CodememPlugin === "function", "canonical V1 export is not a function");
	assert(mod.default.server === mod.CodememPlugin, "default server is not canonical V1");
	assert(mod.OpencodeMemPlugin === mod.CodememPlugin, "legacy V1 export is not an alias");
}

function assertPackedTranslation(adapter) {
	const translator = adapter.createV2EventTranslator();
	translator.translate({
		type: "session.step.ended",
		data: {
			sessionID: "translation-session",
			assistantMessageID: "translation-message",
			finish: "tool-calls",
			tokens: { input: 2, output: 1 },
		},
	});
	const terminal = translator.translate({
		type: "session.step.ended",
		data: {
			sessionID: "translation-session",
			assistantMessageID: "translation-message",
			finish: "stop",
			tokens: { input: 3, output: 4 },
		},
	});
	assert(terminal[0]?.usage?.input === 5, "packed V2 usage was not cumulative");
	assert(
		translator.translate({ type: "session.text.delta", data: {} }).length === 0,
		"packed V2 adapter accepted a non-allowlisted event",
	);
	const failed = adapter.translateV2ToolResult({
		status: "error",
		sessionID: "translation-session",
		tool: "read",
		input: {},
	});
	assert(
		failed.output.error?.name === "CodememToolCaptureError",
		"packed V2 adapter lost malformed failure status",
	);
}

const v2Events = [
	{ type: "session.created", data: { sessionID: V2_SESSION } },
	{
		id: "v2-user-event",
		type: "session.inbox.enqueued",
		data: {
			sessionID: V2_SESSION,
			inboxID: "v2-user",
			item: { type: "user", payload: { text: "parity prompt" } },
		},
	},
	{
		id: "v2-user-event",
		type: "session.inbox.enqueued",
		data: {
			sessionID: V2_SESSION,
			inboxID: "v2-user",
			item: { type: "user", payload: { text: "parity prompt" } },
		},
	},
	{
		id: "v2-user-event-repeat",
		type: "session.inbox.enqueued",
		data: {
			sessionID: V2_SESSION,
			inboxID: "v2-user-repeat",
			item: { type: "user", payload: { text: "parity prompt" } },
		},
	},
	{
		id: "v2-assistant-event",
		type: "session.text.ended",
		data: {
			sessionID: V2_SESSION,
			assistantMessageID: "v2-assistant",
			text: "parity ",
		},
	},
	{
		type: "session.step.ended",
		data: {
			sessionID: V2_SESSION,
			assistantMessageID: "v2-assistant",
			finish: "tool-calls",
			tokens: { input: 2, output: 1 },
		},
	},
	{
		id: "v2-assistant-event-after-tool",
		type: "session.text.ended",
		data: {
			sessionID: V2_SESSION,
			assistantMessageID: "v2-assistant",
			text: "response",
		},
	},
	{
		type: "session.step.ended",
		data: {
			sessionID: V2_SESSION,
			assistantMessageID: "v2-assistant",
			finish: "stop",
			tokens: { input: 2, output: 1 },
		},
	},
	{
		id: "v2-assistant-repeat-event",
		type: "session.text.ended",
		data: {
			sessionID: V2_SESSION,
			assistantMessageID: "v2-assistant-repeat",
			text: "parity response",
		},
	},
	{
		type: "session.step.ended",
		data: {
			sessionID: V2_SESSION,
			assistantMessageID: "v2-assistant-repeat",
			finish: "stop",
			tokens: { input: 4, output: 2 },
		},
	},
];

function createV2Subscription(rows, state, toolsHandled, markTerminalHandled) {
	return async function* subscribe({ signal }) {
		for (const event of v2Events) yield event;
		await toolsHandled;
		await waitForRows(rows, V2_SESSION, 8);
		yield { type: "session.execution.succeeded", data: { sessionID: V2_SESSION } };
		markTerminalHandled();
		await new Promise((resolve, reject) => {
			const stop = () => {
				state.aborted = true;
				reject(new DOMException("aborted", "AbortError"));
			};
			if (signal.aborted) stop();
			else signal.addEventListener("abort", stop, { once: true });
		});
	};
}

function createV2Context(rows) {
	let hook;
	const memoryTools = [];
	const state = { aborted: false, hookDisposed: false, transformDisposed: false };
	let markTerminalHandled;
	let markToolsHandled;
	const terminalHandled = new Promise((resolve) => {
		markTerminalHandled = resolve;
	});
	const toolsHandled = new Promise((resolve) => {
		markToolsHandled = resolve;
	});
	return {
		context: {
			location: {
				directory: process.cwd(),
				project: { id: "packed-v2", directory: process.cwd(), canonical: process.cwd() },
			},
			event: {
				subscribe: createV2Subscription(rows, state, toolsHandled, markTerminalHandled),
			},
			tool: {
				hook: async (name, callback) => {
					assert(name === "execute.after", "packed V2 setup registered the wrong hook");
					hook = callback;
					return {
						dispose: async () => {
							state.hookDisposed = true;
						},
					};
				},
				transform: async (callback) => {
					callback({ add: (tool) => memoryTools.push(tool) });
					return {
						dispose: async () => {
							state.transformDisposed = true;
						},
					};
				},
			},
		},
		getHook: () => hook,
		getMemoryTools: () => memoryTools,
		isAborted: () => state.aborted,
		isDisposed: () => state.hookDisposed && state.transformDisposed,
		markToolsHandled,
		terminalHandled,
	};
}

async function driveV2(mod, rows) {
	const fixture = createV2Context(rows);
	const cleanup = await mod.default.setup(fixture.context);
	const hook = fixture.getHook();
	const memoryTools = fixture.getMemoryTools();
	assert(typeof cleanup === "function", "packed V2 setup did not return cleanup");
	assert(typeof hook === "function", "packed V2 setup did not register tool capture");
	assert(
		JSON.stringify(memoryTools.map((tool) => tool.name).sort()) ===
			JSON.stringify(["mem-recent", "mem-stats", "mem-status"]),
		"packed V2 setup did not register all shared memory tools",
	);
	const recentTool = memoryTools.find((tool) => tool.name === "mem-recent");
	assert(recentTool.input.properties.limit.type === "number", "packed V2 recent limit is not numeric");
	const recentResult = await recentTool.execute({ limit: 1 });
	assert(typeof recentResult.content === "string", "packed V2 memory tool returned invalid content");
	assert(
		!recentResult.content.startsWith("Failed to fetch recent:"),
		`packed V2 memory tool failed: ${recentResult.content}`,
	);
	await hook({
		id: "v2-tool-present-1",
		status: "completed",
		sessionID: V2_SESSION,
		tool: "read",
		input: { path: "present" },
		result: { output: "read ok" },
	});
	await hook({
		id: "v2-tool-missing",
		status: "error",
		sessionID: V2_SESSION,
		tool: "read",
		input: { path: "missing" },
		error: { message: "missing" },
	});
	fixture.markToolsHandled();
	await waitForRows(rows, V2_SESSION, 8);
	const toolCallIDs = rowsForSession(rows, V2_SESSION)
		.filter((row) => row.event_type === "tool.execute.after")
		.map((row) => row.payload.tool_call_id)
		.sort();
	assert(
		JSON.stringify(toolCallIDs) ===
			JSON.stringify(["v2-tool-missing", "v2-tool-present-1"]),
		`packed V2 capture lost tool-call identity: ${JSON.stringify(toolCallIDs)}`,
	);
	await waitWithTimeout(fixture.terminalHandled, 3_000, "Packed V2 terminal event timed out");
	await cleanup();
	assert(fixture.isAborted(), "packed V2 cleanup did not abort event consumption");
	assert(fixture.isDisposed(), "packed V2 cleanup did not dispose hook registration");
}

async function emitV1Event(hooks, event) {
	await hooks.event({ event });
}

const createV1Context = () => ({
	project: { name: "packed-v1" },
	directory: process.cwd(),
	worktree: process.cwd(),
	client: { app: { log: async () => {} }, tui: {} },
});

const v1ConversationEvents = [
	{ type: "session.created", properties: { info: { id: V1_SESSION } } },
	{
		type: "message.updated",
		properties: { info: { id: "v1-user", role: "user", sessionID: V1_SESSION } },
	},
	{
		type: "message.part.updated",
		properties: {
			part: {
				id: "v1-user-part",
				messageID: "v1-user",
				sessionID: V1_SESSION,
				type: "text",
				text: "parity prompt",
			},
		},
	},
	{
		type: "message.part.updated",
		properties: {
			part: {
				id: "v1-user-part",
				messageID: "v1-user",
				sessionID: V1_SESSION,
				type: "text",
				text: "parity prompt",
			},
		},
	},
	{
		type: "message.updated",
		properties: { info: { id: "v1-user-repeat", role: "user", sessionID: V1_SESSION } },
	},
	{
		type: "message.part.updated",
		properties: {
			part: {
				id: "v1-user-part-repeat",
				messageID: "v1-user-repeat",
				sessionID: V1_SESSION,
				type: "text",
				text: "parity prompt",
			},
		},
	},
	{
		type: "message.part.updated",
		properties: {
			part: {
				id: "v1-assistant-part",
				messageID: "v1-assistant",
				sessionID: V1_SESSION,
				type: "text",
				text: "parity response",
			},
		},
	},
	{
		type: "message.updated",
		properties: {
			info: {
				id: "v1-assistant",
				role: "assistant",
				sessionID: V1_SESSION,
				finish: true,
				tokens: { input: 4, output: 2 },
			},
		},
	},
	{
		type: "message.part.updated",
		properties: {
			part: {
				id: "v1-assistant-repeat-part",
				messageID: "v1-assistant-repeat",
				sessionID: V1_SESSION,
				type: "text",
				text: "parity response",
			},
		},
	},
	{
		type: "message.updated",
		properties: {
			info: {
				id: "v1-assistant-repeat",
				role: "assistant",
				sessionID: V1_SESSION,
				finish: true,
				tokens: { input: 4, output: 2 },
			},
		},
	},
];

const v1FailureEvent = {
	type: "message.part.updated",
	properties: {
		part: {
			id: "v1-failed",
			callID: "v1-failed",
			messageID: "v1-assistant",
			sessionID: V1_SESSION,
			type: "tool",
			tool: "read",
			state: {
				status: "error",
				input: { path: "missing" },
				error: { message: "missing" },
			},
		},
	},
};

async function driveV1(mod, rows) {
	const hooks = await mod.default.server(createV1Context());
	assert(typeof hooks.event === "function", "packed V1 server did not activate");
	for (const event of v1ConversationEvents) await emitV1Event(hooks, event);
	await hooks["tool.execute.after"](
		{ sessionID: V1_SESSION, tool: "read", args: { path: "present" } },
		{ output: "read ok" },
	);
	await emitV1Event(hooks, v1FailureEvent);
	await waitForRows(rows, V1_SESSION, 8);
	await emitV1Event(hooks, { type: "session.idle", properties: { sessionID: V1_SESSION } });
	await hooks.dispose();
	const reloaded = await mod.default.server(createV1Context());
	assert(typeof reloaded.event === "function", "packed V1 dispose did not release ownership");
	await reloaded.dispose();
}

const [entrypointURL, adapterURL] = process.argv.slice(2);
assert(entrypointURL && adapterURL, "Packed V2 probe requires package URLs");
const receiver = await startReceiver();
const address = receiver.server.address();
assert(address && typeof address === "object", "Packed receiver did not bind a port");
process.env.CODEMEM_RAW_EVENTS = "1";
process.env.CODEMEM_VIEWER_HOST = "127.0.0.1";
process.env.CODEMEM_VIEWER_PORT = String(address.port);

try {
	const mod = await import(entrypointURL);
	const adapter = await import(adapterURL);
	assertEntrypoint(mod);
	assertPackedTranslation(adapter);
	await driveV2(mod, receiver.rows);
	await driveV1(mod, receiver.rows);
	const v2Rows = normalizeRows(receiver.rows, V2_SESSION);
	const v1Rows = normalizeRows(receiver.rows, V1_SESSION);
	assert(
		v2Rows.length === 8,
		`packed V2 capture had unexpected rows: ${JSON.stringify(v2Rows)}`,
	);
	assert(
		v1Rows.length === 8,
		`packed V1 capture had unexpected rows: ${JSON.stringify(v1Rows)}`,
	);
	assert(
		JSON.stringify(v2Rows) === JSON.stringify(v1Rows),
		`packed V1/V2 normalized capture mismatch: ${JSON.stringify({ v1Rows, v2Rows })}`,
	);
} finally {
	await new Promise((resolve, reject) => {
		receiver.server.close((error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
