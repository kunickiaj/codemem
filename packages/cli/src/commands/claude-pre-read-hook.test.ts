import { type ChildProcess, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scriptUrl = new URL("../../../../plugins/claude/scripts/pre-read-hook.mjs", import.meta.url);
const promptUrl = new URL(
	"../../../../plugins/claude/scripts/user-prompt-hook.mjs",
	import.meta.url,
);
const hook = await import(scriptUrl.href);
const promptHook = await import(promptUrl.href);
type Body = Record<string, unknown>;
const capability = {
	file_context_transport: 1,
	visibility_enforced: true,
	deferred_delivery: true,
};
const contextOutput = {
	hookSpecificOutput: {
		hookEventName: "PreToolUse",
		permissionDecision: "allow",
		additionalContext: "Selected file context",
	},
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

function selected(body: Body, result: Body = contextOutput): Body {
	return {
		ok: true,
		attempt_id: body.attempt_id,
		request_id: body.request_id,
		delivery_pending: result.hookSpecificOutput !== undefined,
		result,
	};
}

let root: string;
let env: Record<string, string>;
let payload: Body;
let httpBodies: Body[];
let output: ReturnType<typeof vi.fn>;
let fetchImpl: ReturnType<typeof vi.fn>;
let runChild: ReturnType<typeof vi.fn>;
let statFile: ReturnType<typeof vi.fn>;
let uuid: ReturnType<typeof vi.fn>;

function profile(extra: Body = {}): Body {
	return {
		service: "codemem-viewer",
		protocol_version: 1,
		min_supported_protocol_version: 1,
		db_path: env.CODEMEM_DB,
		identity_target: promptHook.identityTarget(root, env),
		...extra,
	};
}

function run(extra: Body = {}, raw = JSON.stringify(payload)) {
	return hook.runClaudePreReadHook(raw, {
		env,
		fetchImpl,
		runChild,
		statFile,
		uuid,
		writeOutput: output,
		...extra,
	});
}

function installFallback() {
	runChild.mockImplementation(async (_command: string, args: string[], raw: string) => {
		if (args.includes("--transport-profile")) return JSON.stringify(capability);
		const body = JSON.parse(raw) as Body;
		if (body.action === "delivery") return JSON.stringify({ ok: true });
		return JSON.stringify(selected(body));
	});
}

function writeManifest(version: unknown) {
	mkdirSync(join(root, ".claude-plugin"), { recursive: true });
	writeFileSync(join(root, ".claude-plugin/plugin.json"), JSON.stringify({ version }));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-pre-read-"));
	env = {
		HOME: root,
		CODEMEM_DB: join(root, "never-open.sqlite"),
		CODEMEM_CONFIG: join(root, "never-read.json"),
		CLAUDE_PLUGIN_ROOT: root,
	};
	payload = {
		cwd: root,
		session_id: " client-session ",
		tool_input: { file_path: "src/feature.ts" },
	};
	httpBodies = [];
	output = vi.fn(async () => {});
	statFile = vi.fn(() => ({ size: 1500, mtimeMs: 1234 }));
	let nextId = 0;
	uuid = vi.fn(() => `uuid-${++nextId}`);
	runChild = vi.fn(async () => null);
	fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
		if (init.method === "GET") return jsonResponse(profile());
		const body = JSON.parse(String(init.body)) as Body;
		httpBodies.push(body);
		if (body.action === "delivery") return jsonResponse({ ok: true });
		return jsonResponse(selected(body));
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

describe("packaged pre-read profile fallback", () => {
	it.each(["malformed", "unavailable", "database", "identity", "protocol"])(
		"uses a capability-probed installed CLI for a %s profile",
		async (failure) => {
			// Arrange
			installFallback();
			const extras: Record<string, Body> = {
				database: { db_path: join(root, "other.sqlite") },
				identity: { identity_target: {} },
				protocol: { protocol_version: 2, min_supported_protocol_version: 2 },
			};
			if (failure === "unavailable") fetchImpl.mockRejectedValueOnce(new Error("ECONNREFUSED"));
			else if (failure === "malformed") fetchImpl.mockResolvedValueOnce(new Response("{"));
			else fetchImpl.mockResolvedValueOnce(jsonResponse(profile(extras[failure])));
			// Act
			await run();
			// Assert
			expect(runChild.mock.calls.map(([command, args]) => [command, args])).toEqual([
				["codemem", ["claude-hook-file-context", "--transport-profile"]],
				["codemem", ["claude-hook-file-context", "--transport"]],
				["codemem", ["claude-hook-file-context", "--transport"]],
			]);
			expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
			expect(fetchImpl).toHaveBeenCalledTimes(1);
		},
	);
});

describe("packaged pre-read lookup fallback", () => {
	it.each([
		"malformed",
		"oversized",
		"unavailable",
		"database",
		"identity",
		"wrong-attempt",
		"wrong-request",
		"invalid-result",
	])(
		"falls back only once after a %s lookup response and acknowledges only the emitted CLI attempt",
		async (failure) => {
			// Arrange
			installFallback();
			fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
				if (init.method === "GET") return jsonResponse(profile());
				const body = JSON.parse(String(init.body)) as Body;
				httpBodies.push(body);
				const failures: Record<string, () => Response> = {
					unavailable: () => {
						throw new Error("connection reset");
					},
					malformed: () => new Response("{"),
					oversized: () => new Response("x".repeat(65_537)),
					database: () => jsonResponse({ error: { code: "viewer_db_mismatch" } }, 409),
					identity: () => jsonResponse({ error: { code: "viewer_identity_mismatch" } }, 409),
					"wrong-attempt": () => jsonResponse({ ...selected(body), attempt_id: "unrelated" }),
					"wrong-request": () => jsonResponse({ ...selected(body), request_id: "unrelated" }),
					"invalid-result": () => jsonResponse({ ...selected(body), result: { continue: false } }),
				};
				return failures[failure]?.();
			});
			// Act
			await run();
			// Assert
			expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
			expect(httpBodies).toHaveLength(1);
			const cliLookup = JSON.parse(runChild.mock.calls[1]?.[2]);
			const cliAck = JSON.parse(runChild.mock.calls[2]?.[2]);
			expect(cliLookup.attempt_id).not.toBe(httpBodies[0]?.attempt_id);
			expect(cliLookup.request_id).not.toBe(httpBodies[0]?.request_id);
			expect(cliAck).toMatchObject({
				action: "delivery",
				attempt_id: cliLookup.attempt_id,
				delivery_status: "handed_off",
			});
		},
	);
});

describe("packaged pre-read failed delivery", () => {
	it.each(["http", "cli"])(
		"never acknowledges %s context after stdout rejects it",
		async (transport) => {
			// Arrange
			output.mockRejectedValue(new Error("EPIPE"));
			if (transport === "cli") {
				fetchImpl.mockRejectedValue(new Error("offline"));
				installFallback();
			}
			// Act
			await run();
			// Assert
			expect(output).toHaveBeenCalledTimes(1);
			expect(httpBodies.filter((body) => body.action === "delivery")).toEqual([]);
			expect(
				runChild.mock.calls.filter(([, , raw]) => raw && JSON.parse(raw).action === "delivery"),
			).toEqual([]);
		},
	);

	it("does not retry or fall back when acknowledgment fails after successful output", async () => {
		// Arrange
		fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
			if (init.method === "GET") return jsonResponse(profile());
			const body = JSON.parse(String(init.body)) as Body;
			if (body.action === "delivery") throw new Error("ack offline");
			return jsonResponse(selected(body));
		});
		// Act
		await run();
		// Assert
		expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
		expect(fetchImpl).toHaveBeenCalledTimes(3);
		expect(runChild).not.toHaveBeenCalled();
	});
});

describe("packaged pre-read fallback validation", () => {
	it.each([null, "{", "[]", JSON.stringify({ ...capability, visibility_enforced: false })])(
		"never sends context to an unverified npx candidate with profile %j",
		async (response) => {
			// Arrange
			writeManifest("1.2.3");
			fetchImpl.mockRejectedValue(new Error("offline"));
			runChild.mockResolvedValueOnce(null).mockResolvedValueOnce(response);
			// Act
			await run();
			// Assert
			expect(runChild.mock.calls.map(([, args]) => args.at(-1))).toEqual([
				"--transport-profile",
				"--transport-profile",
			]);
			expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		},
	);

	it.each([null, "{", JSON.stringify(contextOutput)])(
		"never emits or acknowledges failed/unframed child stdout %j",
		async (response) => {
			// Arrange: null represents a nonzero child exit even if it wrote stdout.
			fetchImpl.mockRejectedValue(new Error("offline"));
			runChild.mockResolvedValueOnce(JSON.stringify(capability)).mockResolvedValueOnce(response);
			// Act
			await run();
			// Assert
			expect(runChild).toHaveBeenCalledTimes(2);
			expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		},
	);

	it("accepts a valid empty CLI result without trying npx or acknowledging delivery", async () => {
		// Arrange
		writeManifest("1.2.3");
		fetchImpl.mockRejectedValue(new Error("offline"));
		runChild.mockImplementation(async (_command: string, args: string[], raw: string) => {
			if (args.includes("--transport-profile")) return JSON.stringify(capability);
			return JSON.stringify(selected(JSON.parse(raw), { continue: true }));
		});
		// Act
		await run();
		// Assert
		expect(runChild).toHaveBeenCalledTimes(2);
		expect(runChild.mock.calls.every(([command]) => command === "codemem")).toBe(true);
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
	});
});

describe("packaged pre-read stalled profile", () => {
	it.each(["fetch", "body"])(
		"times out a stalled profile %s before falling back",
		async (stage) => {
			// Arrange
			vi.useFakeTimers();
			installFallback();
			let signal: AbortSignal | undefined;
			fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
				signal = init.signal as AbortSignal;
				if (stage === "fetch") return new Promise(() => {});
				return new Response(
					new ReadableStream({
						start(controller) {
							signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
						},
					}),
				);
			});
			// Act
			const pending = run({ now: () => 0 });
			await vi.advanceTimersByTimeAsync(751);
			await pending;
			// Assert
			expect(signal?.aborted).toBe(true);
			expect(fetchImpl).toHaveBeenCalledTimes(1);
			expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
			expect(runChild).toHaveBeenCalledTimes(3);
		},
	);
});

describe("packaged pre-read shared deadline", () => {
	it("gives timed-out HTTP selection and fallback separate IDs and only acknowledges fallback", async () => {
		// Arrange
		vi.useFakeTimers();
		installFallback();
		let timeoutSignal: AbortSignal | undefined;
		fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
			if (init.method === "GET") return jsonResponse(profile());
			httpBodies.push(JSON.parse(String(init.body)));
			timeoutSignal = init.signal as AbortSignal;
			return new Promise(() => {});
		});
		// Act
		const pending = run({ now: () => 0 });
		await vi.advanceTimersByTimeAsync(751);
		await pending;
		// Assert
		expect(timeoutSignal?.aborted).toBe(true);
		expect(httpBodies).toHaveLength(1);
		const lookup = JSON.parse(runChild.mock.calls[1]?.[2]);
		const ack = JSON.parse(runChild.mock.calls[2]?.[2]);
		expect(lookup.attempt_id).not.toBe(httpBodies[0]?.attempt_id);
		expect(lookup.request_id).not.toBe(httpBodies[0]?.request_id);
		expect(ack.attempt_id).toBe(lookup.attempt_id);
		expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
	});

	it("subtracts stdin and HTTP time from the one child and delivery deadline", async () => {
		// Arrange: the outer entrypoint already spent 600ms reading stdin.
		let elapsed = 600;
		env.CODEMEM_FILE_CONTEXT_TIMEOUT_MS = "1000";
		fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
			elapsed += 50;
			if (init.method === "GET") return jsonResponse(profile());
			throw new Error("offline");
		});
		runChild.mockImplementation(
			async (_command: string, args: string[], raw: string, options: { timeoutMs: number }) => {
				if (options.timeoutMs <= 0) return null;
				elapsed += 25;
				if (args.includes("--transport-profile")) return JSON.stringify(capability);
				const body = JSON.parse(raw) as Body;
				if (body.action === "delivery") return JSON.stringify({ ok: true });
				return JSON.stringify(selected(body));
			},
		);
		// Act
		await run({ now: () => elapsed, deadline: 1000 });
		// Assert
		// 300ms remains after HTTP; the probe gets 50ms after its 250ms reserve.
		// After the probe, 275ms cannot fund lookup plus its 1500ms delivery reserve.
		expect(runChild.mock.calls.map(([, , , options]) => options.timeoutMs)).toEqual([50, 0]);
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
	});

	it("does not start a fallback child after the shared deadline is exhausted", async () => {
		// Arrange
		let elapsed = 0;
		fetchImpl.mockImplementation(async () => {
			elapsed = 1000;
			throw new Error("offline");
		});
		// Act
		await run({ now: () => elapsed, deadline: 1000 });
		// Assert: a zero allowance cannot start runBoundedChild's executable.
		expect(runChild.mock.calls.every(([, , , options]) => options.timeoutMs === 0)).toBe(true);
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
	});
});

function simulateCliStartup(options: {
	transport?: "installed" | "npx";
	deliveryMs: number;
	lookupMs?: number;
}) {
	const events: string[] = [];
	runChild.mockImplementation(
		async (command: string, args: string[], raw: string, childOptions: { timeoutMs: number }) => {
			if (options.transport === "npx" && command === "codemem") return null;
			if (childOptions.timeoutMs <= 0) return null;
			const body = raw ? (JSON.parse(raw) as Body) : null;
			const stage = args.includes("--transport-profile") ? "probe" : String(body?.action);
			let duration = 400;
			if (stage === "lookup") duration = options.lookupMs ?? 400;
			if (stage === "delivery") duration = options.deliveryMs;
			events.push(`${stage}:started`);
			return new Promise((resolve) =>
				setTimeout(
					() => {
						if (duration > childOptions.timeoutMs) {
							events.push(`${stage}:timed_out`);
							resolve(null);
							return;
						}
						events.push(`${stage}:completed`);
						if (stage === "probe") resolve(JSON.stringify(capability));
						else if (stage === "delivery") resolve(JSON.stringify({ ok: true }));
						else resolve(JSON.stringify(selected(body ?? {})));
					},
					Math.min(duration, childOptions.timeoutMs),
				),
			);
		},
	);
	return events;
}

describe("packaged pre-read CLI delivery startup budget", () => {
	it.each(["installed", "npx"] as const)(
		"finishes a slow %s acknowledgment after stdout",
		async (transport) => {
			// Arrange: both startup times exceed the previous 250ms acknowledgment cap.
			for (const deliveryMs of [400, 1000]) {
				vi.useFakeTimers();
				vi.setSystemTime(0);
				output.mockClear();
				runChild.mockClear();
				writeManifest("1.2.3");
				fetchImpl.mockRejectedValue(new Error("synthetic offline"));
				const events = simulateCliStartup({ transport, deliveryMs });
				output.mockImplementation(async () => {
					events.push("stdout");
				});
				// Act
				const pending = run({ now: () => Date.now() });
				await vi.runAllTimersAsync();
				await pending;
				// Assert
				expect(events).toEqual([
					"probe:started",
					"probe:completed",
					"lookup:started",
					"lookup:completed",
					"stdout",
					"delivery:started",
					"delivery:completed",
				]);
				expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
				const candidateCalls = runChild.mock.calls.filter(
					([command]) => command === (transport === "npx" ? "npx" : "codemem"),
				);
				expect(candidateCalls.map(([, , , options]) => options.timeoutMs)).toEqual([
					transport === "npx" ? 1500 : 750,
					6100,
					1500,
				]);
				expect(Date.now()).toBe(800 + deliveryMs);
			}
		},
	);

	it("reserves delivery startup time even when lookup consumes most of the eight-second budget", async () => {
		// Arrange: a 400ms probe plus a 6000ms lookup leaves 1600ms for acknowledgment.
		vi.useFakeTimers();
		vi.setSystemTime(0);
		fetchImpl.mockRejectedValue(new Error("synthetic offline"));
		const events = simulateCliStartup({ deliveryMs: 1000, lookupMs: 6000 });
		// Act
		const pending = run({ now: () => Date.now() });
		await vi.runAllTimersAsync();
		await pending;
		// Assert
		expect(runChild.mock.calls.map(([, , , options]) => options.timeoutMs)).toEqual([
			750, 6100, 1500,
		]);
		expect(events.at(-1)).toBe("delivery:completed");
		expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
		expect(Date.now()).toBe(7400);
	});

	it("does not emit or acknowledge a lookup that overruns its reserved delivery budget", async () => {
		// Arrange
		vi.useFakeTimers();
		vi.setSystemTime(0);
		fetchImpl.mockRejectedValue(new Error("synthetic offline"));
		const events = simulateCliStartup({ deliveryMs: 1000, lookupMs: 7000 });
		// Act
		const pending = run({ now: () => Date.now() });
		await vi.runAllTimersAsync();
		await pending;
		// Assert
		expect(events.at(-1)).toBe("lookup:timed_out");
		expect(runChild).toHaveBeenCalledTimes(2);
		expect(output).toHaveBeenCalledExactlyOnceWith('{"continue":true}');
		expect(Date.now()).toBe(6500);
	});
});

describe("packaged pre-read shortened delivery deadline", () => {
	it.each([
		{ stdoutMs: 500, deliveryBudget: 1100, result: "completed", finishedAt: 2100 },
		{ stdoutMs: 700, deliveryBudget: 900, result: "timed_out", finishedAt: 2200 },
	])(
		"caps delivery by remaining time after $stdoutMs ms stdout",
		async ({ stdoutMs, deliveryBudget, result, finishedAt }) => {
			// Arrange: stdout can consume some of the reserved delivery allowance.
			vi.useFakeTimers();
			vi.setSystemTime(0);
			env.CODEMEM_FILE_CONTEXT_TIMEOUT_MS = "2200";
			fetchImpl.mockRejectedValue(new Error("synthetic offline"));
			const events = simulateCliStartup({ deliveryMs: 1000, lookupMs: 200 });
			output.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, stdoutMs)));
			// Act
			const pending = run({ now: () => Date.now() });
			await vi.runAllTimersAsync();
			await pending;
			// Assert
			expect(runChild.mock.calls.map(([, , , options]) => options.timeoutMs)).toEqual([
				750,
				300,
				deliveryBudget,
			]);
			expect(events.at(-1)).toBe(`delivery:${result}`);
			expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
			expect(Date.now()).toBe(finishedAt);
		},
	);
});

describe("packaged pre-read HTTP delivery deadline", () => {
	it("keeps the HTTP acknowledgment at 250ms without starting a CLI after host output", async () => {
		// Arrange: the larger CLI startup allowance must not extend HTTP delivery.
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let deliverySignal: AbortSignal | undefined;
		fetchImpl.mockImplementation(async (_url: string, init: RequestInit) => {
			if (init.method === "GET") return jsonResponse(profile());
			const body = JSON.parse(String(init.body)) as Body;
			if (body.action !== "delivery") return jsonResponse(selected(body));
			deliverySignal = init.signal as AbortSignal;
			return new Promise(() => {});
		});
		// Act
		const pending = run({ now: () => Date.now() });
		await vi.runAllTimersAsync();
		await pending;
		// Assert
		expect(deliverySignal?.aborted).toBe(true);
		expect(Date.now()).toBe(250);
		expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify(contextOutput));
		expect(runChild).not.toHaveBeenCalled();
	});
});

function executable(name: string, source: string): string {
	const path = join(root, name);
	writeFileSync(path, `#!${process.execPath}\n${source}`, { mode: 0o755 });
	return path;
}

function preload(mode: "healthy" | "empty" | "offline"): string {
	const path = join(root, "fetch-fixture.mjs");
	writeFileSync(
		path,
		`
import { identityTarget } from ${JSON.stringify(promptUrl.href)};
globalThis.fetch = async (_url, init) => {
  if (${JSON.stringify(mode)} === "offline") throw new Error("synthetic offline");
  if (init.method === "GET") return Response.json({service:"codemem-viewer", protocol_version:1, db_path:process.env.CODEMEM_DB, identity_target:identityTarget(process.cwd(), process.env)});
  const request = JSON.parse(init.body);
  const result = ${JSON.stringify(mode === "empty" ? { continue: true } : contextOutput)};
  return Response.json({ok:true, attempt_id:request.attempt_id, request_id:request.request_id, delivery_pending:false, result});
};
`,
	);
	return path;
}

async function packaged(options: {
	raw?: string;
	holdStdin?: boolean;
	preload: string;
	script?: string;
	shellShim?: boolean;
}) {
	const processEnv = { ...env, PATH: root };
	const script = options.script ?? fileURLToPath(scriptUrl);
	let args = ["--import", options.preload, script];
	if (options.shellShim) {
		args = [script];
		Object.assign(processEnv, { NODE_OPTIONS: `--import=${options.preload}` });
	}
	const child = spawn(options.shellShim ? "/bin/sh" : process.execPath, args, {
		cwd: root,
		env: processEnv,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout.on("data", (data) => stdout.push(data));
	child.stderr.on("data", (data) => stderr.push(data));
	child.stdin.on("error", () => {});
	const watchdog = setTimeout(() => child.kill("SIGKILL"), 5000);
	if (!options.holdStdin) child.stdin.end(options.raw ?? "{}");
	return new Promise<{ status: number | null; stdout: string; stderr: string }>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("close", (status) => {
				clearTimeout(watchdog);
				resolve({
					status,
					stdout: Buffer.concat(stdout).toString(),
					stderr: Buffer.concat(stderr).toString(),
				});
			});
		},
	);
}

describe("packaged pre-read symlink activation", () => {
	it.each(["node", "shell-shim"])(
		"runs through a symlinked plugin parent using %s",
		async (entrypoint) => {
			// Arrange: Node canonicalizes import.meta.url but retains the logical argv path.
			const pluginLink = join(root, "plugin-cache");
			symlinkSync(fileURLToPath(new URL("../", scriptUrl)), pluginLink, "dir");
			const shellShim = entrypoint === "shell-shim";
			if (shellShim) {
				symlinkSync(process.execPath, join(root, "node"));
				symlinkSync("/usr/bin/dirname", join(root, "dirname"));
			}
			writeFileSync(join(root, "feature.ts"), "x".repeat(1500));
			const raw = JSON.stringify({ cwd: root, tool_input: { file_path: "feature.ts" } });
			const script = join(
				pluginLink,
				"scripts",
				shellShim ? "pre-read-hook.sh" : "pre-read-hook.mjs",
			);
			// Act
			const result = await packaged({ raw, script, shellShim, preload: preload("healthy") });
			// Assert
			expect(result).toEqual({
				status: 0,
				stdout: `${JSON.stringify(contextOutput)}\n`,
				stderr: "",
			});
			expect(existsSync(String(env.CODEMEM_DB))).toBe(false);
		},
	);

	it("reproduces the old lexical main-module comparison losing stdout through a symlink", async () => {
		// Arrange: this fixture preserves the exact old entrypoint comparison.
		const legacy = join(root, "legacy-main.mjs");
		writeFileSync(
			legacy,
			`
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify({continue:true}));
}
`,
		);
		const linkedParent = join(root, "linked-parent");
		symlinkSync(root, linkedParent, "dir");
		const syntheticFetch = preload("offline");
		// Act
		// macOS's temporary directory can itself be reached through /var -> /private/var.
		const direct = await packaged({ script: realpathSync(legacy), preload: syntheticFetch });
		const linked = await packaged({
			script: join(linkedParent, "legacy-main.mjs"),
			preload: syntheticFetch,
		});
		// Assert
		expect(direct).toEqual({ status: 0, stdout: '{"continue":true}\n', stderr: "" });
		expect(linked).toEqual({ status: 0, stdout: "", stderr: "" });
	});

	it("matches real module identity while rejecting unrelated, absent, and unreadable entrypoints", () => {
		// Arrange
		const alias = join(root, "linked-module.mjs");
		symlinkSync(fileURLToPath(scriptUrl), alias);
		// Act
		const matches = [
			promptHook.isMainModule(alias, fileURLToPath(scriptUrl)),
			promptHook.isMainModule(fileURLToPath(promptUrl)),
			promptHook.isMainModule(alias),
			promptHook.isMainModule(""),
			promptHook.isMainModule(join(root, "absent.mjs")),
		];
		// Assert
		expect(matches).toEqual([true, true, false, false, false]);
	});

	it("imports the shared main-module helper without executing the user-prompt hook or reading stdin", async () => {
		// Arrange: stdin remains open so accidental hook activation would hang.
		const importer = join(root, "import-helper.mjs");
		writeFileSync(
			importer,
			`
import { isMainModule } from ${JSON.stringify(promptUrl.href)};
console.log(JSON.stringify({ownMain:isMainModule(), preReadMain:isMainModule(process.argv[1], ${JSON.stringify(fileURLToPath(scriptUrl))})}));
`,
		);
		// Act
		const result = await packaged({
			script: importer,
			holdStdin: true,
			preload: preload("offline"),
		});
		// Assert
		expect(result).toEqual({
			status: 0,
			stdout: '{"ownMain":false,"preReadMain":false}\n',
			stderr: "",
		});
	});
});

describe("packaged pre-read stdin/stdout", () => {
	it.each(["healthy", "empty"] as const)(
		"runs the real stdin/stdout entrypoint with %s HTTP and zero CLI spawns",
		async (mode) => {
			// Arrange
			const marker = join(root, "unexpected-child");
			for (const name of ["codemem", "npx"])
				executable(name, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned");`);
			writeFileSync(join(root, "feature.ts"), "x".repeat(1500));
			const raw = JSON.stringify({
				cwd: root,
				session_id: "fixture-session",
				tool_input: { file_path: "feature.ts" },
			});
			// Act
			const result = await packaged({ raw, preload: preload(mode) });
			// Assert
			expect(result).toEqual({
				status: 0,
				stdout: `${JSON.stringify(mode === "empty" ? { continue: true } : contextOutput)}\n`,
				stderr: "",
			});
			expect(existsSync(marker)).toBe(false);
			expect(existsSync(String(env.CODEMEM_DB))).toBe(false);
		},
	);

	it("uses synthetic installed executable stdin/stdout without shell expansion or bootstrap", async () => {
		// Arrange
		const log = join(root, "requests.jsonl");
		executable(
			"codemem",
			`
const fs = require("node:fs");
const args = process.argv.slice(2);
const raw = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, raw}) + "\\n");
if (args.includes("--transport-profile")) { console.log(${JSON.stringify(JSON.stringify(capability))}); }
else { const body = JSON.parse(raw); console.log(JSON.stringify(body.action === "delivery" ? {ok:true} : {ok:true, attempt_id:body.attempt_id, request_id:body.request_id, delivery_pending:true, result:${JSON.stringify(contextOutput)}})); }
`,
		);
		writeFileSync(join(root, "a;touch not-a-command.ts"), "x".repeat(1500));
		const raw = JSON.stringify({
			cwd: root,
			session_id: "fixture-session",
			tool_input: { file_path: "a;touch not-a-command.ts" },
		});
		// Act
		const result = await packaged({ raw, preload: preload("offline") });
		// Assert
		expect(result).toEqual({ status: 0, stdout: `${JSON.stringify(contextOutput)}\n`, stderr: "" });
		const calls = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(calls.map((call) => call.args)).toEqual([
			["claude-hook-file-context", "--transport-profile"],
			["claude-hook-file-context", "--transport"],
			["claude-hook-file-context", "--transport"],
		]);
		expect(JSON.parse(calls[1].raw)).toMatchObject({
			relative_path: "a;touch not-a-command.ts",
			source_session_id: "fixture-session",
		});
		expect(JSON.parse(calls[2].raw)).toMatchObject({
			action: "delivery",
			delivery_status: "handed_off",
			attempt_id: JSON.parse(calls[1].raw).attempt_id,
		});
		expect(existsSync(join(root, "not-a-command.ts"))).toBe(false);
		expect(existsSync(String(env.CODEMEM_DB))).toBe(false);
	});
});

describe("packaged pre-read child success and failure", () => {
	it.each(["stalled", "oversized"])("bounds %s stdin within the real hook budget", async (mode) => {
		// Arrange
		env.CODEMEM_FILE_CONTEXT_TIMEOUT_MS = "150";
		// Act: the 5s parent watchdog is only a hang detector, not a timing assertion.
		const result = await packaged({
			holdStdin: mode === "stalled",
			raw: "x".repeat(65_537),
			preload: preload("offline"),
		});
		// Assert
		expect(result).toEqual({ status: 0, stdout: '{"continue":true}\n', stderr: "" });
	});

	it("returns successful child stdout exactly and always disables the shell", async () => {
		// Arrange
		const command = executable("echo-fixture", "process.stdin.pipe(process.stdout);");
		const spawnImpl = vi.fn(spawn);
		const raw = '{"file":"a;echo unsafe"}';
		// Act
		const result = await hook.runBoundedChild(command, [], raw, {
			env,
			cwd: root,
			timeoutMs: 3000,
			spawnImpl,
		});
		// Assert
		expect(result).toBe(raw);
		expect(spawnImpl).toHaveBeenCalledExactlyOnceWith(
			command,
			[],
			expect.objectContaining({
				shell: false,
				cwd: root,
				env,
				detached: process.platform !== "win32",
			}),
		);
	});

	it.each(["failed", "missing", "epipe"])(
		"returns null for a %s child without leaking its stdout",
		async (mode) => {
			// Arrange
			let command = join(root, "missing-executable");
			if (mode === "failed")
				command = executable("failure", 'process.stdout.write("untrusted"); process.exitCode = 1;');
			if (mode === "epipe")
				command = executable("closed-stdin", "process.stdin.destroy(); process.exit(1);");
			// Act
			const result = await hook.runBoundedChild(command, [], "x".repeat(65_536), {
				env,
				cwd: root,
				timeoutMs: 3000,
			});
			// Assert
			expect(result).toBeNull();
		},
	);

	it("does not spawn a child when there is no remaining allowance", async () => {
		// Arrange
		const spawnImpl = vi.fn();
		// Act
		const result = await hook.runBoundedChild("codemem", [], "{}", {
			env,
			cwd: root,
			timeoutMs: 0,
			spawnImpl,
		});
		// Assert
		expect(result).toBeNull();
		expect(spawnImpl).not.toHaveBeenCalled();
	});
});

describe("packaged pre-read child termination", () => {
	it.each(["stdout", "stderr", "combined", "timeout"])(
		"kills only its own child group for %s limits",
		async (mode) => {
			// Arrange
			let source = "setInterval(() => {}, 1000);";
			if (mode === "stdout") source += 'process.stdout.write("x".repeat(65537));';
			if (mode === "stderr") source += 'process.stderr.write("x".repeat(65537));';
			if (mode === "combined")
				source +=
					'process.stdout.write("x".repeat(40000)); process.stderr.write("x".repeat(40000));';
			const command = executable("limit-fixture", source);
			let child: ChildProcess | undefined;
			let closed: Promise<unknown> | undefined;
			const spawnImpl = (...args: Parameters<typeof spawn>) => {
				child = spawn(...args);
				closed = new Promise((resolve) =>
					child?.once("close", (code, signal) => resolve({ code, signal })),
				);
				return child;
			};
			const kill = vi.spyOn(process, "kill");
			// Act
			const result = await hook.runBoundedChild(command, [], "", {
				env,
				cwd: root,
				timeoutMs: mode === "timeout" ? 150 : 3000,
				spawnImpl,
			});
			await closed;
			// Assert
			expect(result).toBeNull();
			if (process.platform !== "win32")
				expect(kill.mock.calls).toEqual([[-Number(child?.pid), "SIGKILL"]]);
			expect(child?.signalCode).toBe("SIGKILL");
		},
	);
});
