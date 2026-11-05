import { tool } from "@opencode-ai/plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertObjectShape } from "../.opencode/lib/memory-tool-schema.js";
import {
	CLI_FALLBACK_NOTE,
	createMemoryToolExecutor,
	formatMemoryToolOutcome,
	isMemoryToolId,
	loadMemoryToolContracts,
	memoryToolId,
	nativeMemoryToolsEnabled,
} from "../.opencode/lib/memory-tools.js";

const BASE_URL = "http://127.0.0.1:38888";
const DB_PATH = "/home/user/.codemem/mem.sqlite";
const IDENTITY = { device_id: null, home_dir: "/home/user" };
const DIRECTORY = "/repo/worktree/nested";

const jsonResponse = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

const profile = (capabilities = ["memory_tool_call"]) => ({
	service: "codemem-viewer",
	db_path: DB_PATH,
	identity_target: IDENTITY,
	capabilities,
});

const connectionError = (code) => {
	const error = new TypeError("fetch failed");
	error.cause = Object.assign(new Error(code), { code });
	return error;
};

const cliSuccess = (result = { items: ["cli"] }) => ({
	exitCode: 0,
	stdout: `${JSON.stringify({ ok: true, result })}\n`,
	stderr: "",
});

/** Route GET profile and POST tool calls to separate handlers. */
function makeFetch({ profileBody = profile(), profileError, post } = {}) {
	return vi.fn(async (url, init) => {
		if (String(url).endsWith("/api/prompt-pack-profile")) {
			if (profileError) throw profileError;
			return jsonResponse(profileBody);
		}
		return post(url, init);
	});
}

function makeExecutor({ fetchImpl, runCli = vi.fn(async () => cliSuccess()), ...options } = {}) {
	const executor = createMemoryToolExecutor({
		viewerEnabled: true,
		viewerBaseUrl: BASE_URL,
		dbPath: DB_PATH,
		identityTarget: IDENTITY,
		isProfileMatch: (body) => body?.db_path === DB_PATH,
		runCli,
		defaultDirectory: "/fallback",
		readEnvProject: () => "  env-project  ",
		fetchImpl,
		...options,
	});
	return { executor, runCli };
}

const postCalls = (fetchImpl) =>
	fetchImpl.mock.calls.filter(([url]) => String(url).includes("/api/memory-tools/"));

const context = { directory: DIRECTORY, sessionID: "ses_1", callID: "call_1" };

afterEach(() => {
	vi.useRealTimers();
});

const expectCliCall = (runCli, name, args) => {
	expect(runCli).toHaveBeenCalledOnce();
	const [cliArgs, options] = runCli.mock.calls[0];
	expect(cliArgs).toEqual([
		"memory-tool",
		name,
		"--db-path",
		DB_PATH,
		"--session-id",
		"ses_1",
		"--request-id",
		"call_1",
	]);
	expect(options.cwd).toBe(DIRECTORY);
	expect(JSON.parse(options.stdinText)).toEqual(args);
	expect(options.timeoutMs).toBeGreaterThan(0);
};

describe("native memory tool flag", () => {
	it("is off unless CODEMEM_OPENCODE_NATIVE_TOOLS is truthy", () => {
		expect(nativeMemoryToolsEnabled({})).toBe(false);
		expect(nativeMemoryToolsEnabled({ CODEMEM_OPENCODE_NATIVE_TOOLS: "0" })).toBe(false);
		expect(nativeMemoryToolsEnabled({ CODEMEM_OPENCODE_NATIVE_TOOLS: "no" })).toBe(false);
		for (const value of ["1", "true", "YES"]) {
			expect(nativeMemoryToolsEnabled({ CODEMEM_OPENCODE_NATIVE_TOOLS: value })).toBe(true);
		}
	});
});

describe("memory tool names", () => {
	it("prefixes every effective tool ID with codemem_memory_", () => {
		const ids = loadMemoryToolContracts().map((contract) => memoryToolId(contract.name));
		expect(ids).toHaveLength(14);
		for (const id of ids) {
			expect(id.startsWith("codemem_memory_")).toBe(true);
			expect(isMemoryToolId(id)).toBe(true);
		}
	});

	it("recognizes dotted namespace forms and ignores other tools", () => {
		expect(isMemoryToolId("codemem.memory_search")).toBe(true);
		expect(isMemoryToolId("codemem_memory_remember")).toBe(true);
		expect(isMemoryToolId("read")).toBe(false);
		expect(isMemoryToolId("mem-status")).toBe(false);
		expect(isMemoryToolId(undefined)).toBe(false);
	});
});

describe("V1 schema conversion", () => {
	it("converts every contract to a Zod shape", () => {
		for (const contract of loadMemoryToolContracts()) {
			const shape = convertObjectShape(tool.schema, contract.input, contract.name);
			expect(Object.keys(shape)).toEqual(Object.keys(contract.input.properties));
			const required = contract.input.required ?? [];
			const parsed = tool.schema.object(shape).safeParse({});
			expect(parsed.success, contract.name).toBe(required.length === 0);
		}
	});

	it("keeps bounds, enums, unions, defaults, and descriptions", () => {
		const search = loadMemoryToolContracts().find((contract) => contract.name === "memory_search");
		const schema = tool.schema.object(convertObjectShape(tool.schema, search.input));
		expect(schema.parse({ query: "x" }).limit).toBe(5);
		expect(schema.safeParse({ query: "x", limit: 0 }).success).toBe(false);
		expect(schema.safeParse({ query: "x", limit: 1.5 }).success).toBe(false);
		expect(schema.safeParse({ query: "x", personal_first: "true" }).success).toBe(true);
		expect(schema.safeParse({ query: "x", personal_first: 3 }).success).toBe(false);
		expect(schema.shape.query.description).toBe("Search query");

		const remember = loadMemoryToolContracts().find((c) => c.name === "memory_remember");
		const rememberSchema = tool.schema.object(convertObjectShape(tool.schema, remember.input));
		expect(rememberSchema.safeParse({ kind: "nope", title: "t", body: "b" }).success).toBe(false);
	});

	it("throws on schema keywords outside the supported subset", () => {
		const input = (property) => ({ type: "object", properties: { value: property } });
		expect(() => convertObjectShape(tool.schema, input({ type: "string", pattern: "^a" }))).toThrow(
			"Unsupported memory tool schema keyword at input.value: pattern",
		);
		expect(() => convertObjectShape(tool.schema, input({ type: "null" }))).toThrow(
			"Unsupported memory tool schema type",
		);
		expect(() =>
			convertObjectShape(tool.schema, { type: "object", properties: {}, required: ["missing"] }),
		).toThrow("requires unknown property missing");
		expect(() =>
			convertObjectShape(tool.schema, {
				type: "object",
				properties: {},
				additionalProperties: false,
			}),
		).toThrow("additionalProperties");
	});
});

describe("memory tool executor: viewer transport", () => {
	it("posts unchanged arguments with the caller context to a proven viewer", async () => {
		const fetchImpl = makeFetch({
			post: async () => jsonResponse({ ok: true, result: { items: [1] } }),
		});
		const { executor, runCli } = makeExecutor({ fetchImpl });
		const args = { query: "auth", limit: 3 };

		const outcome = await executor.execute("memory_search", args, context);

		expect(outcome).toEqual({ ok: true, result: { items: [1] }, transport: "viewer" });
		expect(runCli).not.toHaveBeenCalled();
		const [[url, init]] = postCalls(fetchImpl);
		expect(url).toBe(`${BASE_URL}/api/memory-tools/memory_search`);
		expect(JSON.parse(init.body)).toEqual({
			arguments: { query: "auth", limit: 3 },
			caller: {
				directory: DIRECTORY,
				env_project: "env-project",
				session_id: "ses_1",
				request_id: "call_1",
			},
			db_path: DB_PATH,
			identity_target: IDENTITY,
		});
	});

	it("omits the request ID without a session and uses null for a blank env project", async () => {
		const fetchImpl = makeFetch({ post: async () => jsonResponse({ ok: true, result: {} }) });
		const { executor } = makeExecutor({ fetchImpl, readEnvProject: () => "   " });

		await executor.execute("memory_recent", {}, { directory: DIRECTORY, callID: "call_1" });

		const [[, init]] = postCalls(fetchImpl);
		expect(JSON.parse(init.body).caller).toEqual({ directory: DIRECTORY, env_project: null });
	});
});

describe("memory tool executor: viewer proof", () => {
	it("caches the viewer proof and re-proves after a 409", async () => {
		let status = 200;
		const fetchImpl = makeFetch({
			post: async () =>
				status === 200 ? jsonResponse({ ok: true, result: {} }) : jsonResponse({}, status),
		});
		const { executor, runCli } = makeExecutor({ fetchImpl });
		const profileGets = () =>
			fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/prompt-pack-profile")).length;

		await executor.execute("memory_recent", {}, context);
		await executor.execute("memory_recent", {}, context);
		expect(profileGets()).toBe(1);

		status = 409;
		const outcome = await executor.execute("memory_recent", {}, context);
		expect(outcome.transport).toBe("cli");
		expect(runCli).toHaveBeenCalledOnce();

		status = 200;
		await executor.execute("memory_recent", {}, context);
		expect(profileGets()).toBe(2);
	});

	it("re-proves after the proof expires", async () => {
		let clock = 0;
		const fetchImpl = makeFetch({ post: async () => jsonResponse({ ok: true, result: {} }) });
		const { executor } = makeExecutor({ fetchImpl, now: () => clock });

		await executor.execute("memory_recent", {}, context);
		clock = 31_000;
		await executor.execute("memory_recent", {}, context);

		expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("-profile"))).toHaveLength(
			2,
		);
	});

	it("returns the tool's own error without falling back", async () => {
		const fetchImpl = makeFetch({
			post: async () =>
				jsonResponse({
					ok: false,
					error: "memory not found",
					result: { error: "memory not found" },
				}),
		});
		const { executor, runCli } = makeExecutor({ fetchImpl });

		const outcome = await executor.execute("memory_forget", { memory_id: 9 }, context);

		expect(outcome).toEqual({
			ok: false,
			error: "memory not found",
			result: { error: "memory not found" },
			transport: "viewer",
		});
		expect(runCli).not.toHaveBeenCalled();
	});
});

describe("memory tool executor: CLI fallback", () => {
	it.each([
		["the capability is missing", { profileBody: profile([]) }],
		["the viewer serves another database", { profileBody: { ...profile(), db_path: "/other" } }],
		["the viewer refuses connections", { profileError: connectionError("ECONNREFUSED") }],
	])("runs the CLI when %s", async (_label, fetchOptions) => {
		const post = vi.fn();
		const fetchImpl = makeFetch({ ...fetchOptions, post });
		const { executor, runCli } = makeExecutor({ fetchImpl });
		const args = { query: "auth" };

		const outcome = await executor.execute("memory_search", args, context);

		expect(post).not.toHaveBeenCalled();
		expect(outcome).toEqual({ ok: true, result: { items: ["cli"] }, transport: "cli" });
		expectCliCall(runCli, "memory_search", args);
	});

	it("runs the CLI when the viewer is disabled", async () => {
		const fetchImpl = vi.fn();
		const { executor, runCli } = makeExecutor({ fetchImpl, viewerEnabled: false });

		await executor.execute("memory_remember", { kind: "change", title: "t", body: "b" }, context);

		expect(fetchImpl).not.toHaveBeenCalled();
		expectCliCall(runCli, "memory_remember", { kind: "change", title: "t", body: "b" });
	});

	it.each([
		[404, "memory_remember"],
		[409, "memory_forget"],
	])("runs the CLI after HTTP %i, even for writes", async (status, name) => {
		const fetchImpl = makeFetch({ post: async () => jsonResponse({}, status) });
		const { executor, runCli } = makeExecutor({ fetchImpl });

		const outcome = await executor.execute(name, { memory_id: 1 }, context);

		expect(outcome.transport).toBe("cli");
		expectCliCall(runCli, name, { memory_id: 1 });
	});

	it("runs the CLI when the tool POST cannot connect", async () => {
		const fetchImpl = makeFetch({
			post: async () => {
				throw connectionError("ECONNREFUSED");
			},
		});
		const { executor, runCli } = makeExecutor({ fetchImpl });

		await executor.execute("memory_remember", { kind: "change", title: "t", body: "b" }, context);

		expect(runCli).toHaveBeenCalledOnce();
	});
});

describe("memory tool executor: unsettled viewer calls", () => {
	it.each([
		["a 5xx", async () => jsonResponse({ error: { message: "boom" } }, 500)],
		[
			"a dropped connection",
			async () => {
				throw connectionError("ECONNRESET");
			},
		],
	])("does not retry a write through the CLI after %s", async (_label, post) => {
		const fetchImpl = makeFetch({ post });
		const { executor, runCli } = makeExecutor({ fetchImpl });

		const outcome = await executor.execute(
			"memory_remember",
			{ kind: "change", title: "t", body: "b" },
			context,
		);

		expect(runCli).not.toHaveBeenCalled();
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("the write may have completed");
	});

	it("does not retry a write through the CLI after a viewer timeout", async () => {
		vi.useFakeTimers();
		const fetchImpl = makeFetch({
			post: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new Error("aborted")));
				}),
		});
		const { executor, runCli } = makeExecutor({ fetchImpl });

		const pending = executor.execute("memory_forget", { memory_id: 1 }, context);
		await vi.advanceTimersByTimeAsync(30_000);
		const outcome = await pending;

		expect(runCli).not.toHaveBeenCalled();
		expect(outcome).toMatchObject({ ok: false, transport: "viewer" });
		expect(outcome.error).toContain("timed out in the viewer");
	});

	it("retries a read through the CLI after a 5xx", async () => {
		const fetchImpl = makeFetch({ post: async () => jsonResponse({}, 503) });
		const { executor, runCli } = makeExecutor({ fetchImpl });

		const outcome = await executor.execute("memory_search", { query: "q" }, context);

		expect(outcome.transport).toBe("cli");
		expectCliCall(runCli, "memory_search", { query: "q" });
		// Both transports carry the same call ID, so the ledger counts one attempt.
		const [, init] = postCalls(fetchImpl)[0];
		expect(JSON.parse(init.body).caller.request_id).toBe("call_1");
	});
});

describe("memory tool executor: CLI results", () => {
	it("gives memory_pack and memory_distill_candidates longer budgets", async () => {
		const { executor, runCli } = makeExecutor({ viewerEnabled: false, fetchImpl: vi.fn() });

		await executor.execute("memory_pack", { context: "x" }, context);
		await executor.execute("memory_distill_candidates", {}, context);
		await executor.execute("memory_search", { query: "x" }, context);

		const budgets = runCli.mock.calls.map(([, options]) => options.timeoutMs);
		expect(budgets[0]).toBeGreaterThanOrEqual(120_000);
		expect(budgets[1]).toBeGreaterThanOrEqual(120_000);
		expect(budgets[2]).toBeLessThan(budgets[0]);
	});

	it("reports CLI invocation failures and timeouts as errors", async () => {
		const runCli = vi
			.fn()
			.mockResolvedValueOnce({
				exitCode: 1,
				stdout: '{"ok":false,"error":"invalid_arguments","message":"bad json"}\n',
				stderr: "",
			})
			.mockResolvedValueOnce({ exitCode: null, stdout: "", stderr: "timeout" });
		const { executor } = makeExecutor({ viewerEnabled: false, fetchImpl: vi.fn(), runCli });

		await expect(executor.execute("memory_search", {}, context)).resolves.toEqual({
			ok: false,
			error: "bad json",
			transport: "cli",
		});
		const timedOut = await executor.execute("memory_remember", {}, context);
		expect(timedOut.error).toContain("the write may have completed");
	});
});

describe("memory tool executor: cancellation", () => {
	it("aborts the viewer request and does not fall back", async () => {
		const controller = new AbortController();
		let postSignal;
		const fetchImpl = makeFetch({
			post: (_url, init) => {
				postSignal = init.signal;
				return new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new Error("aborted")));
					controller.abort();
				});
			},
		});
		const { executor, runCli } = makeExecutor({ fetchImpl });

		await expect(
			executor.execute("memory_search", { query: "q" }, { ...context, signal: controller.signal }),
		).rejects.toThrow();

		expect(postSignal.aborted).toBe(true);
		expect(runCli).not.toHaveBeenCalled();
	});

	it("passes the abort signal to the CLI and rejects once it fires", async () => {
		const controller = new AbortController();
		const runCli = vi.fn(async (_args, options) => {
			controller.abort();
			expect(options.signal.aborted).toBe(true);
			return { exitCode: null, stdout: "", stderr: "aborted", aborted: true };
		});
		const { executor } = makeExecutor({ viewerEnabled: false, fetchImpl: vi.fn(), runCli });

		await expect(
			executor.execute("memory_remember", {}, { ...context, signal: controller.signal }),
		).rejects.toThrow();
		expect(runCli.mock.calls[0][1].signal).toBe(controller.signal);
	});

	it("does nothing when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn();
		const { executor, runCli } = makeExecutor({ fetchImpl });

		await expect(
			executor.execute("memory_search", {}, { ...context, signal: controller.signal }),
		).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
		expect(runCli).not.toHaveBeenCalled();
	});
});

describe("memory tool results", () => {
	it("returns the MCP JSON text and keeps the CLI note separate", () => {
		expect(formatMemoryToolOutcome({ ok: true, result: { a: 1 }, transport: "viewer" })).toEqual({
			isError: false,
			text: '{"a":1}',
			note: null,
		});
		expect(formatMemoryToolOutcome({ ok: true, result: { a: 1 }, transport: "cli" })).toEqual({
			isError: false,
			text: '{"a":1}',
			note: CLI_FALLBACK_NOTE,
		});
	});

	it("matches MCP error text", () => {
		expect(
			formatMemoryToolOutcome({
				ok: false,
				error: "x",
				result: { error: "x" },
				transport: "viewer",
			}).text,
		).toBe('{"error":"x"}');
		expect(
			formatMemoryToolOutcome({
				ok: false,
				error: "MCP error -32602: bad",
				result: "MCP error -32602: bad",
			}).text,
		).toBe("MCP error -32602: bad");
		expect(formatMemoryToolOutcome({ ok: false, error: "timed out" })).toEqual({
			isError: true,
			text: '{"error":"timed out"}',
			note: null,
		});
	});
});
