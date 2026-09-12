import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(packageRoot, ".opencode", "plugins");
const helperRoot = path.join(packageRoot, ".opencode", "lib");

const readPluginFile = (name: string) => readFile(path.join(pluginRoot, name), "utf8");
const readHelperFile = (name: string) => readFile(path.join(helperRoot, name), "utf8");

async function createRuntimeFixture(options: { rawEvents?: boolean; homeDir?: string } = {}) {
	vi.stubEnv("CODEMEM_RAW_EVENTS", options.rawEvents ? "1" : "0");
	if (options.homeDir) vi.stubEnv("HOME", options.homeDir);
	vi.stubEnv("CODEMEM_VIEWER", "0");
	vi.stubEnv("CODEMEM_VIEWER_AUTO", "0");
	vi.stubEnv("CODEMEM_BACKEND_UPDATE_POLICY", "off");
	vi.stubEnv("CODEMEM_RUNNER", "/usr/bin/true");
	const runtimeUrl = pathToFileURL(path.join(helperRoot, "runtime.js")).href;
	const { createCodememRuntime } = await import(runtimeUrl);
	const runtime = await createCodememRuntime({
		location: {
			project: { name: "runtime-boundary", root: packageRoot },
			directory: packageRoot,
			worktree: packageRoot,
		},
		host: { log: async () => undefined, notify: null },
	});
	if (!runtime) throw new Error("Expected runtime fixture to activate");
	return runtime;
}

const userMessage = (messageID: string, sessionID = "session-1") => ({
	type: "message.updated",
	sessionID,
	messageInfo: { id: messageID, role: "user", sessionID },
});

const textPart = (messageID: string, id: string, text: string, sessionID = "session-1") => ({
	type: "message.part.updated",
	sessionID,
	part: { id, messageID, sessionID, type: "text", text },
});

const assistantBoundary = (messageID: string, sessionID = "session-1") => ({
	type: "message.updated",
	sessionID,
	messageInfo: { id: messageID, role: "assistant", sessionID },
});

async function addPrompt(
	runtime: Awaited<ReturnType<typeof createRuntimeFixture>>,
	messageID: string,
) {
	await runtime.handleEvent(userMessage(messageID));
	await runtime.handleEvent(textPart(messageID, `${messageID}-part-1`, "First"));
	await runtime.handleEvent(textPart(messageID, `${messageID}-part-2`, " second"));
}

describe("shared runtime boundary", () => {
	it("keeps helper modules outside OpenCode's auto-load directory", async () => {
		const [pluginFiles, helperFiles] = await Promise.all([
			readdir(pluginRoot),
			readdir(helperRoot),
		]);

		expect(pluginFiles.filter((name) => /\.(?:js|ts)$/u.test(name)).sort()).toEqual(["codemem.js"]);
		expect(helperFiles).toEqual(expect.arrayContaining(["host-contract.js", "runtime.js"]));
	});

	it("keeps the OpenCode SDK import in the V1 adapter", async () => {
		const [adapter, runtime, contract] = await Promise.all([
			readPluginFile("codemem.js"),
			readHelperFile("runtime.js"),
			readHelperFile("host-contract.js"),
		]);

		expect(adapter).toContain('from "@opencode-ai/plugin"');
		expect(runtime).not.toMatch(/@opencode(?:-ai)?\/plugin/);
		expect(contract).not.toMatch(/@opencode(?:-ai)?\/plugin/);
	});

	it("exports one named host-neutral runtime constructor", async () => {
		const runtimeUrl = pathToFileURL(path.join(helperRoot, "runtime.js")).href;
		const runtime = await import(runtimeUrl);

		expect(typeof runtime.createCodememRuntime).toBe("function");
	});
});

describe("shared runtime prompt capture", () => {
	it("releases buffered prompt parts at an execution boundary", async () => {
		const runtime = await createRuntimeFixture();

		try {
			await addPrompt(runtime, "message-1");

			expect(runtime.inspectBufferedPromptPartCount()).toBe(2);
			await runtime.handleEvent({ type: "session.idle", sessionID: "session-1" });
			expect(runtime.inspectBufferedPromptPartCount()).toBe(0);
			expect(runtime.inspectCapturedPromptCount()).toBe(1);
		} finally {
			await runtime.dispose();
			vi.unstubAllEnvs();
		}
	});

	it("captures multipart OpenCode 1 messages once with their complete text", async () => {
		const runtime = await createRuntimeFixture();
		const adapterUrl = pathToFileURL(path.join(pluginRoot, "codemem.js")).href;
		const adapter = await import(adapterUrl);

		try {
			await runtime.handleEvent(
				adapter.__v1AdapterTestUtils.translateV1Event({
					type: "message.updated",
					properties: { info: userMessage("message-1").messageInfo },
				}),
			);
			for (const [id, text] of [
				["part-1", "First"],
				["part-2", " second"],
			] as const) {
				await runtime.handleEvent(
					adapter.__v1AdapterTestUtils.translateV1Event({
						type: "message.part.updated",
						properties: { part: textPart("message-1", id, text).part },
					}),
				);
			}
			await runtime.handleEvent(assistantBoundary("message-2"));

			expect(runtime.inspectQueuedPrompts()).toEqual([{ number: 1, text: "First second" }]);
		} finally {
			await runtime.dispose();
			vi.unstubAllEnvs();
		}
	});
});

describe("shared runtime prompt boundaries", () => {
	it("captures pending prompts before tool results", async () => {
		const runtime = await createRuntimeFixture();
		try {
			await addPrompt(runtime, "message-1");
			await runtime.handleToolResult(
				{ sessionID: "session-1", tool: "read", args: {} },
				{ output: "ok", error: null },
			);

			expect(runtime.inspectQueuedEventTypes()).toEqual(["user_prompt", "tool.execute.after"]);
		} finally {
			await runtime.dispose();
			vi.unstubAllEnvs();
		}
	});

	it("numbers two multipart prompts once each", async () => {
		const runtime = await createRuntimeFixture();
		try {
			await addPrompt(runtime, "message-1");
			await runtime.handleEvent(assistantBoundary("assistant-1"));
			await addPrompt(runtime, "message-2");
			await runtime.handleEvent(assistantBoundary("assistant-2"));

			expect(runtime.inspectQueuedPrompts()).toEqual([
				{ number: 1, text: "First second" },
				{ number: 2, text: "First second" },
			]);
		} finally {
			await runtime.dispose();
			vi.unstubAllEnvs();
		}
	});

	it("captures a /new prompt once across concurrent V1 boundaries", async () => {
		const runtime = await createRuntimeFixture();
		try {
			await runtime.handleEvent(userMessage("message-1"));
			await runtime.handleEvent(textPart("message-1", "part-1", "/new"));

			await Promise.all([
				runtime.handleEvent(assistantBoundary("assistant-1")),
				runtime.handleToolResult(
					{ sessionID: "session-1", tool: "read", args: {} },
					{ output: "ok", error: null },
				),
			]);

			expect(runtime.inspectQueuedPrompts()).toEqual([{ number: 1, text: "/new" }]);
		} finally {
			await runtime.dispose();
			vi.unstubAllEnvs();
		}
	});

	it("captures a pending prompt during disposal", async () => {
		const runtime = await createRuntimeFixture();
		try {
			await addPrompt(runtime, "message-1");
			await runtime.dispose();

			expect(runtime.inspectQueuedPrompts()).toEqual([{ number: 1, text: "First second" }]);
		} finally {
			await runtime.dispose();
			vi.unstubAllEnvs();
		}
	});
});

describe("shared runtime disposal durability", () => {
	it("durably spools a pending prompt before disposal completes", async () => {
		const homeDir = await mkdtemp(path.join(tmpdir(), "codemem-runtime-disposal-"));
		const fetchMock = vi.fn(async () => new Promise<Response>(() => {}));
		vi.stubGlobal("fetch", fetchMock);
		const runtime = await createRuntimeFixture({ rawEvents: true, homeDir });
		const spoolUrl = pathToFileURL(path.join(helperRoot, "raw-event-spool.js")).href;
		const { loadRawEventSpoolEntries } = await import(spoolUrl);

		try {
			await addPrompt(runtime, "message-1");
			await runtime.dispose();

			expect(fetchMock).not.toHaveBeenCalled();
			const spool = await loadRawEventSpoolEntries({ homeDir });
			expect(
				spool.entries.some(
					(entry: { envelope: { event_type?: string } }) =>
						entry.envelope.event_type === "user_prompt",
				),
			).toBe(true);
		} finally {
			await runtime.dispose();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("shared runtime deactivation", () => {
	it("makes in-flight capture continuations inert after deactivation", async () => {
		const runtime = await createRuntimeFixture();
		try {
			await addPrompt(runtime, "message-1");
			runtime.deactivate();
			await runtime.handleEvent(assistantBoundary("assistant-1"));
			await runtime.handleToolResult(
				{ sessionID: "session-1", tool: "read", args: {} },
				{ output: "late", error: null },
			);
			await runtime.dispose();

			expect(runtime.inspectQueuedEventTypes()).toEqual(["user_prompt"]);
		} finally {
			await runtime.dispose();
			vi.unstubAllEnvs();
		}
	});

	it("spools an in-flight raw-event batch when deactivation aborts transport", async () => {
		const homeDir = await mkdtemp(path.join(tmpdir(), "codemem-runtime-boundary-"));
		const postSignals: AbortSignal[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				if (init?.method === "GET") {
					return new Response(JSON.stringify({ ingest: { available: true } }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				const signal = init?.signal;
				if (!signal) throw new Error("Expected raw-event POST abort signal");
				postSignals.push(signal);
				return new Promise<Response>((_resolve, reject) => {
					signal.addEventListener(
						"abort",
						() => reject(new DOMException("aborted", "AbortError")),
						{ once: true },
					);
				});
			}),
		);
		const runtime = await createRuntimeFixture({ rawEvents: true, homeDir });
		const spoolUrl = pathToFileURL(path.join(helperRoot, "raw-event-spool.js")).href;
		const { loadRawEventSpoolEntries } = await import(spoolUrl);

		try {
			await addPrompt(runtime, "message-1");
			const idleTask = runtime.handleEvent({ type: "session.idle", sessionID: "session-1" });
			await vi.waitFor(() => expect(postSignals.length).toBeGreaterThan(0));

			runtime.deactivate();
			await runtime.dispose();
			await idleTask;

			await vi.waitFor(async () => {
				const spool = await loadRawEventSpoolEntries({ homeDir });
				expect(
					spool.entries.some(
						(entry: { envelope: { event_type?: string } }) =>
							entry.envelope.event_type === "user_prompt",
					),
				).toBe(true);
			});
		} finally {
			await runtime.dispose();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			await rm(homeDir, { recursive: true, force: true });
		}
	});
});

describe("shared runtime boundary adapters", () => {
	it("translates OpenCode 1 events into the runtime contract", async () => {
		const adapterUrl = pathToFileURL(path.join(pluginRoot, "codemem.js")).href;
		const adapter = await import(adapterUrl);
		const part = { id: "part-1", sessionID: "session-1", type: "text" };
		const event = { type: "message.part.updated", properties: { part } };

		expect(adapter.__v1AdapterTestUtils.translateV1Event(event)).toEqual({
			type: "message.part.updated",
			sessionID: "session-1",
			messageInfo: null,
			part,
			usage: null,
			raw: event,
		});
	});

	it("rejects runtime tool argument types unsupported by OpenCode 1", async () => {
		const adapterUrl = pathToFileURL(path.join(pluginRoot, "codemem.js")).href;
		const adapter = await import(adapterUrl);

		expect(() =>
			adapter.__v1AdapterTestUtils.createV1Tool({
				description: "unsupported contract",
				args: { query: { type: "string", optional: true } },
				execute: async () => "unused",
			}),
		).toThrow("Unsupported OpenCode 1 tool argument: query:string");
	});

	it("keeps checkout wrappers as re-exports of the canonical V1 adapter", async () => {
		const repositoryRoot = path.resolve(packageRoot, "../..");
		const [repositoryWrapper, cliWrapper] = await Promise.all([
			readFile(path.join(repositoryRoot, ".opencode/plugins/codemem.js"), "utf8"),
			readFile(path.join(repositoryRoot, "packages/cli/.opencode/plugins/codemem.js"), "utf8"),
		]);

		expect(repositoryWrapper.trim()).toBe(
			'export { default } from "../../packages/opencode-plugin/.opencode/plugins/codemem.js";',
		);
		const version = cliWrapper.match(/^const PINNED_BACKEND_VERSION = "([^"]+)";/)?.[1];
		expect(version).toBeDefined();
		expect(cliWrapper.trim()).toBe(`const PINNED_BACKEND_VERSION = "${version}";

export {
	default,
	CodememPlugin,
	OpencodeMemPlugin,
	__testUtils,
	buildInjectionToastMessage,
} from "../../../opencode-plugin/.opencode/plugins/codemem.js";`);
		expect(repositoryWrapper).not.toContain("runtime.js");
		expect(cliWrapper).not.toContain("runtime.js");
	});
});
