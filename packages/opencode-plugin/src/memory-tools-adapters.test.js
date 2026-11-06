import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CLI_FALLBACK_NOTE,
	createNativeMemoryTools,
	loadMemoryToolContracts,
	MCP_PREFERRED_MESSAGE,
	MEMORY_TOOL_NAMESPACE,
} from "../.opencode/lib/memory-tools.js";
import { createOpenCodeV2Adapter } from "../.opencode/lib/opencode-v2-adapter.js";
import { CodememPlugin } from "../.opencode/plugins/codemem.js";

const REGISTRATIONS_KEY = Symbol.for("codemem.opencode-plugin.registrations");
const MEMORY_TOOL_IDS = loadMemoryToolContracts().map((contract) => `codemem_${contract.name}`);

// Records its invocation and prints one memory-tool result line, like `codemem memory-tool`.
const RUNNER_SCRIPT = `#!/bin/sh
record="$CODEMEM_TEST_RECORD"
pwd -P > "$record/cwd"
printf '%s\\n' "$@" > "$record/args"
cat > "$record/stdin"
echo $$ > "$record/pid"
if [ "$2" = "memory_pack" ]; then exec sleep 30; fi
echo '{"ok":true,"result":{"via":"cli"}}'
`;

let root;
let record;
let directory;

function stubRuntimeEnv({ nativeTools }) {
	root = mkdtempSync(join(tmpdir(), "codemem-native-tools-"));
	record = join(root, "record");
	directory = join(root, "project");
	for (const dir of [record, directory, join(root, "home")]) mkdirSync(dir, { recursive: true });
	const runner = join(root, "codemem-runner.sh");
	writeFileSync(runner, RUNNER_SCRIPT);
	chmodSync(runner, 0o755);
	vi.stubEnv("HOME", join(root, "home"));
	vi.stubEnv("CODEMEM_RAW_EVENTS", "0");
	vi.stubEnv("CODEMEM_VIEWER", "0");
	vi.stubEnv("CODEMEM_VIEWER_AUTO", "0");
	vi.stubEnv("CODEMEM_INJECT_CONTEXT", "0");
	vi.stubEnv("CODEMEM_BACKEND_UPDATE_POLICY", "off");
	vi.stubEnv("CODEMEM_RUNNER", runner);
	vi.stubEnv("CODEMEM_TEST_RECORD", record);
	vi.stubEnv("CODEMEM_OPENCODE_NATIVE_TOOLS", nativeTools ? "1" : "0");
}

function makeV1Client({ mcp = {}, configError } = {}) {
	return {
		app: { log: vi.fn(async () => undefined) },
		tui: { showToast: vi.fn(async () => undefined) },
		config: {
			get: vi.fn(async () => {
				if (configError) throw configError;
				return { data: { mcp } };
			}),
		},
	};
}

const nativeToolIds = (hooks) => Object.keys(hooks.tool).filter((id) => !id.startsWith("mem-"));
const LOCAL_MCP = { type: "local", command: ["codemem", "mcp"] };

function createV1Plugin(client) {
	return CodememPlugin({
		project: { name: "native-tools" },
		client,
		directory,
		worktree: directory,
	});
}

const readRecord = (name) => readFileSync(join(record, name), "utf8");

const isRunning = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

beforeEach(() => {
	Reflect.deleteProperty(globalThis, REGISTRATIONS_KEY);
});

afterEach(() => {
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("OpenCode 1 native memory tool call IDs", () => {
	it("generates a fresh call ID for each execution", async () => {
		stubRuntimeEnv({ nativeTools: true });
		const hooks = await createV1Plugin(makeV1Client());
		const requestId = async () => {
			await hooks.tool.codemem_memory_search.execute(
				{ query: "auth" },
				{ directory, sessionID: "ses_v1", abort: new AbortController().signal },
			);
			const args = readRecord("args").trim().split("\n");
			return args[args.indexOf("--request-id") + 1];
		};
		try {
			const first = await requestId();
			const second = await requestId();
			expect(first).toBeTruthy();
			expect(second).not.toBe(first);
		} finally {
			await hooks.dispose();
		}
	});
});

describe("OpenCode 1 native memory tools", () => {
	it("registers nothing new while the flag is off", async () => {
		stubRuntimeEnv({ nativeTools: false });
		const client = makeV1Client();
		const hooks = await createV1Plugin(client);
		try {
			expect(Object.keys(hooks.tool).sort()).toEqual(["mem-recent", "mem-stats", "mem-status"]);
			expect(client.config.get).not.toHaveBeenCalled();
		} finally {
			await hooks.dispose();
		}
	});

	it("registers all fourteen tools under codemem_memory_ IDs", async () => {
		stubRuntimeEnv({ nativeTools: true });
		const hooks = await createV1Plugin(makeV1Client());
		try {
			expect(nativeToolIds(hooks).sort()).toEqual([...MEMORY_TOOL_IDS].sort());
			expect(hooks.tool.codemem_memory_search.description).toBe(
				loadMemoryToolContracts()[0].description,
			);
			expect(Object.keys(hooks.tool.codemem_memory_search.args)).toContain("query");
		} finally {
			await hooks.dispose();
		}
	});

	it("runs the CLI fallback in the session directory with arguments on stdin", async () => {
		stubRuntimeEnv({ nativeTools: true });
		const hooks = await createV1Plugin(makeV1Client());
		try {
			const output = await hooks.tool.codemem_memory_search.execute(
				{ query: "auth", limit: 3 },
				{ directory, sessionID: "ses_v1", abort: new AbortController().signal },
			);

			expect(output).toBe(`{"via":"cli"}\n${CLI_FALLBACK_NOTE}`);
			// --db-path pins the database the viewer proof uses, independent of the CLI's cwd.
			const args = readRecord("args").trim().split("\n");
			expect(args.slice(0, 6)).toEqual([
				"memory-tool",
				"memory_search",
				"--db-path",
				join(root, "home", ".codemem", "mem.sqlite"),
				"--session-id",
				"ses_v1",
			]);
			// OpenCode 1 has no call ID; the plugin generates one per execution.
			expect(args[6]).toBe("--request-id");
			expect(args[7]).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(readRecord("cwd").trim()).toBe(realpathSync(directory));
			expect(JSON.parse(readRecord("stdin"))).toEqual({ query: "auth", limit: 3 });
		} finally {
			await hooks.dispose();
		}
	});
});

describe("OpenCode 1 native memory tools: execution and MCP precedence", () => {
	it("kills the CLI child when the call is aborted", async () => {
		stubRuntimeEnv({ nativeTools: true });
		const hooks = await createV1Plugin(makeV1Client());
		try {
			const controller = new AbortController();
			const pending = hooks.tool.codemem_memory_pack.execute(
				{ context: "x" },
				{ directory, sessionID: "ses_v1", abort: controller.signal },
			);
			await vi.waitFor(() => expect(existsSync(join(record, "pid"))).toBe(true));
			const pid = Number(readRecord("pid"));
			await vi.waitFor(() => expect(isRunning(pid)).toBe(true));

			controller.abort();

			await expect(pending).rejects.toThrow();
			await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
		} finally {
			await hooks.dispose();
		}
	});

	it("leaves memory tools to a configured codemem MCP server", async () => {
		stubRuntimeEnv({ nativeTools: true });
		const client = makeV1Client({ mcp: { codemem: LOCAL_MCP, other: LOCAL_MCP } });
		const hooks = await createV1Plugin(client);
		try {
			expect(nativeToolIds(hooks)).toEqual([]);
			expect(client.tui.showToast).toHaveBeenCalledOnce();
			expect(client.tui.showToast).toHaveBeenCalledWith({
				body: { message: MCP_PREFERRED_MESSAGE, variant: "warning" },
			});
			const warnings = client.app.log.mock.calls.filter(
				([{ body }]) => body.message === MCP_PREFERRED_MESSAGE,
			);
			expect(warnings).toHaveLength(1);
		} finally {
			await hooks.dispose();
		}
	});

	it.each([
		["the codemem MCP server is disabled", { mcp: { codemem: { ...LOCAL_MCP, enabled: false } } }],
		["the config cannot be read", { configError: new Error("boom") }],
	])("registers memory tools when %s", async (_label, clientOptions) => {
		stubRuntimeEnv({ nativeTools: true });
		const client = makeV1Client(clientOptions);
		const hooks = await createV1Plugin(client);
		try {
			expect(nativeToolIds(hooks)).toHaveLength(14);
			expect(client.tui.showToast).not.toHaveBeenCalled();
		} finally {
			await hooks.dispose();
		}
	});

	it("does not capture codemem memory tool results", async () => {
		stubRuntimeEnv({ nativeTools: true });
		const hooks = await createV1Plugin(makeV1Client());
		try {
			const capture = hooks["tool.execute.after"];
			for (const tool of ["codemem_memory_search", "codemem.memory_recent"]) {
				expect(capture({ sessionID: "ses_v1", tool, args: {} }, { output: "{}" })).toBeUndefined();
			}
			await expect(
				capture({ sessionID: "ses_v1", tool: "read", args: {} }, { output: "{}" }),
			).resolves.toBeUndefined();
		} finally {
			await hooks.dispose();
		}
	});
});

describe("OpenCode 1 capture with native tools off", () => {
	it("keeps capturing codemem-named tool results when native tools are off", async () => {
		stubRuntimeEnv({ nativeTools: false });
		const hooks = await createV1Plugin(makeV1Client());
		try {
			const captured = hooks["tool.execute.after"](
				{ sessionID: "ses_v1", tool: "codemem_memory_search", args: {} },
				{ output: "{}" },
			);
			// The capture path returns a promise; the skip path returns undefined.
			expect(captured).toBeInstanceOf(Promise);
			await captured;
		} finally {
			await hooks.dispose();
		}
	});
});

function makeV2Context({ mcpServers = [], mcpError } = {}) {
	const editor = { namespace: vi.fn(), add: vi.fn() };
	const hooks = {};
	const context = {
		location: {
			directory: "/repo/worktree/nested",
			project: { id: "project", directory: "/repo/worktree", canonical: "/repo" },
		},
		event: {
			subscribe: async function* ({ signal }) {
				await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			},
		},
		session: { hook: vi.fn(async () => ({ dispose: async () => undefined })) },
		tool: {
			hook: vi.fn(async (_name, callback) => {
				hooks.toolAfter = callback;
				return { dispose: async () => undefined };
			}),
			transform: vi.fn(async (callback) => {
				hooks.toolTransform = callback;
				callback(editor);
				return { dispose: async () => undefined };
			}),
			reload: vi.fn(async () => undefined),
		},
		mcp: {
			list: vi.fn(async () => {
				if (mcpError) throw mcpError;
				return { data: mcpServers };
			}),
			transform: vi.fn(async (callback) => {
				hooks.mcpTransform = callback;
				return { dispose: async () => undefined };
			}),
		},
	};
	return { context, editor, hooks };
}

function makeV2Runtime(execute) {
	const log = vi.fn(async () => undefined);
	const notify = vi.fn(async () => undefined);
	return {
		log,
		notify,
		deactivate: vi.fn(),
		dispose: vi.fn(async () => undefined),
		handleEvent: vi.fn(async () => undefined),
		handleToolResult: vi.fn(async () => undefined),
		reportDiagnostic: vi.fn(async () => undefined),
		transformMessages: vi.fn(async () => ({ applied: false, surface: "message" })),
		tools: {},
		memoryTools: createNativeMemoryTools({ executor: { execute }, log, notify }),
	};
}

async function setupV2(execute, options) {
	const runtime = makeV2Runtime(execute);
	const fixture = makeV2Context(options);
	const cleanup = await createOpenCodeV2Adapter({ createRuntime: async () => runtime })(
		fixture.context,
	);
	const tools = new Map(fixture.editor.add.mock.calls.map(([tool]) => [tool.name, tool]));
	return { ...fixture, cleanup, runtime, tools };
}

const v2CallContext = (signal = new AbortController().signal) => ({
	sessionID: "ses_v2",
	id: "call_v2",
	agent: "build",
	messageID: "msg_1",
	signal,
	progress: async () => undefined,
});

describe("OpenCode 2 native memory tools", () => {
	it("registers every contract in the codemem namespace with Code Mode", async () => {
		const { cleanup, editor, tools } = await setupV2(vi.fn());
		try {
			expect(editor.namespace).toHaveBeenCalledOnce();
			expect(editor.namespace.mock.calls[0][0].name).toBe(MEMORY_TOOL_NAMESPACE);
			expect([...tools.keys()]).toEqual(loadMemoryToolContracts().map((c) => c.name));
			for (const contract of loadMemoryToolContracts()) {
				const tool = tools.get(contract.name);
				expect(tool.options).toEqual({ namespace: "codemem", codemode: true });
				expect(tool.input).toEqual(contract.input);
				expect(tool.description).toBe(contract.description);
				// OpenCode joins namespace and name with "_" for the effective tool ID.
				expect(`${tool.options.namespace}_${tool.name}`).toMatch(/^codemem_memory_/);
			}
		} finally {
			await cleanup();
		}
	});

	it("registers no memory tools when the runtime has them disabled", async () => {
		const runtime = { ...makeV2Runtime(vi.fn()), memoryTools: null };
		const fixture = makeV2Context();
		const cleanup = await createOpenCodeV2Adapter({ createRuntime: async () => runtime })(
			fixture.context,
		);
		try {
			expect(fixture.editor.namespace).not.toHaveBeenCalled();
			expect(fixture.editor.add).not.toHaveBeenCalled();
			expect(fixture.context.mcp.list).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("keeps capturing codemem-named tool results when native tools are off", async () => {
		// With the flag off, codemem tools come from the MCP server and keep the
		// existing capture path (activity, tool counts, flush timing).
		const runtime = { ...makeV2Runtime(vi.fn()), memoryTools: null };
		const fixture = makeV2Context();
		const cleanup = await createOpenCodeV2Adapter({ createRuntime: async () => runtime })(
			fixture.context,
		);
		try {
			await fixture.hooks.toolAfter({
				status: "completed",
				id: "call_1",
				sessionID: "ses_v2",
				tool: "codemem_memory_search",
				input: {},
				result: { content: "{}" },
			});
			expect(runtime.handleToolResult).toHaveBeenCalledOnce();
		} finally {
			await cleanup();
		}
	});
});

describe("OpenCode 2 native memory tools: execution", () => {
	it("executes with the plugin location directory, session, call ID, and signal", async () => {
		const execute = vi.fn(async () => ({ ok: true, result: { items: [] }, transport: "viewer" }));
		const { cleanup, tools } = await setupV2(execute);
		try {
			const callContext = v2CallContext();
			const result = await tools.get("memory_search").execute({ query: "q" }, callContext);

			expect(result).toEqual({ content: [{ type: "text", text: '{"items":[]}' }] });
			expect(execute).toHaveBeenCalledWith(
				"memory_search",
				{ query: "q" },
				{
					directory: "/repo/worktree/nested",
					sessionID: "ses_v2",
					callID: "call_v2",
					signal: callContext.signal,
				},
			);
		} finally {
			await cleanup();
		}
	});

	it("adds the CLI note as a separate text part", async () => {
		const execute = vi.fn(async () => ({ ok: true, result: { a: 1 }, transport: "cli" }));
		const { cleanup, tools } = await setupV2(execute);
		try {
			await expect(tools.get("memory_recent").execute({}, v2CallContext())).resolves.toEqual({
				content: [
					{ type: "text", text: '{"a":1}' },
					{ type: "text", text: CLI_FALLBACK_NOTE },
				],
			});
		} finally {
			await cleanup();
		}
	});

	it("reports tool errors as Tool.Error with the MCP error text", async () => {
		const execute = vi.fn(async () => ({ ok: false, error: "nope", transport: "viewer" }));
		const { cleanup, tools } = await setupV2(execute);
		try {
			const error = await tools
				.get("memory_forget")
				.execute({ memory_id: 1 }, v2CallContext())
				.catch((caught) => caught);
			expect(error._tag).toBe("Tool.Error");
			expect(error.message).toBe('{"error":"nope"}');
		} finally {
			await cleanup();
		}
	});

	it("does not capture codemem memory tool results", async () => {
		const { cleanup, hooks, runtime } = await setupV2(vi.fn());
		try {
			const result = (tool) => ({
				status: "completed",
				id: "call_1",
				sessionID: "ses_v2",
				tool,
				input: {},
				result: { content: "{}" },
			});
			await hooks.toolAfter(result("codemem_memory_search"));
			await hooks.toolAfter(result("codemem.memory_get"));
			expect(runtime.handleToolResult).not.toHaveBeenCalled();
			await hooks.toolAfter(result("read"));
			expect(runtime.handleToolResult).toHaveBeenCalledOnce();
		} finally {
			await cleanup();
		}
	});
});

describe("OpenCode 2 native memory tools: MCP config after setup", () => {
	it("withdraws the tools when a codemem MCP server appears after setup", async () => {
		// OpenCode 2 lists MCP servers only after plugin setup; the config arrives
		// later through the MCP registry rebuild.
		vi.useFakeTimers();
		const { cleanup, context, editor, hooks, runtime } = await setupV2(vi.fn());
		try {
			expect(editor.add).toHaveBeenCalled();
			hooks.mcpTransform({ get: (name) => (name === "codemem" ? { type: "local" } : undefined) });
			await vi.runAllTimersAsync();
			expect(context.tool.reload).toHaveBeenCalledOnce();
			expect(runtime.log).toHaveBeenCalledWith("warn", MCP_PREFERRED_MESSAGE);

			editor.add.mockClear();
			hooks.toolTransform(editor);
			const memoryToolAdds = editor.add.mock.calls.filter(([tool]) =>
				tool.name.startsWith("memory_"),
			);
			expect(memoryToolAdds).toHaveLength(0);
		} finally {
			vi.useRealTimers();
			await cleanup();
		}
	});

	it("restores the tools when the codemem MCP server is removed again", async () => {
		vi.useFakeTimers();
		const { cleanup, context, editor, hooks } = await setupV2(vi.fn());
		const memoryToolCount = () => {
			editor.add.mockClear();
			hooks.toolTransform(editor);
			return editor.add.mock.calls.filter(([tool]) => tool.name.startsWith("memory_")).length;
		};
		try {
			expect(memoryToolCount()).toBe(14);
			hooks.mcpTransform({ get: () => ({ type: "local" }) });
			await vi.runAllTimersAsync();
			expect(memoryToolCount()).toBe(0);

			hooks.mcpTransform({ get: () => undefined });
			await vi.runAllTimersAsync();
			expect(context.tool.reload).toHaveBeenCalledTimes(2);
			expect(memoryToolCount()).toBe(14);
		} finally {
			vi.useRealTimers();
			await cleanup();
		}
	});

	it("keeps the tools when the configured codemem MCP server is disabled", async () => {
		vi.useFakeTimers();
		const { cleanup, context, hooks } = await setupV2(vi.fn());
		try {
			hooks.mcpTransform({ get: () => ({ type: "local", disabled: true }) });
			await vi.runAllTimersAsync();
			expect(context.tool.reload).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
			await cleanup();
		}
	});
});

describe("OpenCode 2 native memory tools: Code Mode capture", () => {
	it("skips an execute result whose inner calls include a memory tool", async () => {
		const { cleanup, hooks, runtime } = await setupV2(vi.fn());
		try {
			// Code Mode reports one outer execute call; inner calls are in result metadata.
			await hooks.toolAfter({
				status: "completed",
				id: "call_1",
				sessionID: "ses_v2",
				tool: "execute",
				input: {},
				result: {
					content: "{}",
					metadata: { toolCalls: [{ tool: "read" }, { tool: "codemem.memory_search" }] },
				},
			});
			expect(runtime.handleToolResult).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});
});

describe("OpenCode 2 native memory tools: MCP precedence", () => {
	it("leaves memory tools to a configured codemem MCP server", async () => {
		const { cleanup, context, editor, runtime } = await setupV2(vi.fn(), {
			mcpServers: [{ name: "codemem", status: { status: "connected" } }],
		});
		try {
			expect(context.mcp.list).toHaveBeenCalledOnce();
			expect(editor.namespace).not.toHaveBeenCalled();
			expect(editor.add).not.toHaveBeenCalled();
			expect(runtime.notify).toHaveBeenCalledOnce();
			expect(runtime.notify).toHaveBeenCalledWith({
				message: MCP_PREFERRED_MESSAGE,
				variant: "warning",
			});
			expect(runtime.log).toHaveBeenCalledWith("warn", MCP_PREFERRED_MESSAGE);
		} finally {
			await cleanup();
		}
	});

	it.each([
		[
			"the codemem MCP server is disabled",
			{ mcpServers: [{ name: "codemem", status: { status: "disabled" } }] },
		],
		["listing MCP servers fails", { mcpError: new Error("boom") }],
	])("registers memory tools when %s", async (_label, options) => {
		const { cleanup, runtime, tools } = await setupV2(vi.fn(), options);
		try {
			expect(tools.size).toBe(14);
			expect(runtime.notify).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("registers memory tools and logs when the host has no MCP API", async () => {
		const runtime = makeV2Runtime(vi.fn());
		const fixture = makeV2Context();
		delete fixture.context.mcp;
		const cleanup = await createOpenCodeV2Adapter({ createRuntime: async () => runtime })(
			fixture.context,
		);
		try {
			expect(fixture.editor.add).toHaveBeenCalledTimes(14);
			expect(runtime.log).toHaveBeenCalledWith(
				"warn",
				expect.stringContaining("could not check for a codemem MCP server"),
			);
		} finally {
			await cleanup();
		}
	});

	it("logs the error when listing MCP servers fails", async () => {
		const { cleanup, runtime } = await setupV2(vi.fn(), { mcpError: new Error("boom") });
		try {
			expect(runtime.log).toHaveBeenCalledWith(
				"warn",
				expect.stringContaining("MCP server check failed"),
				{ error: "boom" },
			);
		} finally {
			await cleanup();
		}
	});
});
