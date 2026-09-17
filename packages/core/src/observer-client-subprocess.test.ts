import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { codexCliAvailable, ObserverClient } from "./observer-client.js";

const childProcessMocks = vi.hoisted(() => {
	const execFile = vi.fn();
	const execFileAsync = vi.fn();
	Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), {
		value: execFileAsync,
	});
	return {
		execFile,
		execFileAsync,
		execFileSync: vi.fn(),
		spawn: vi.fn(),
	};
});

vi.mock("node:child_process", () => ({
	execFile: childProcessMocks.execFile,
	execFileSync: childProcessMocks.execFileSync,
	spawn: childProcessMocks.spawn,
}));

function makeSidecarClient(runtime: "claude_sidecar" | "codex_sidecar"): ObserverClient {
	return new ObserverClient({
		observerProvider: runtime === "claude_sidecar" ? "anthropic" : "openai",
		observerModel: runtime === "claude_sidecar" ? "claude-haiku-4-5" : "gpt-5.1-codex",
		observerRuntime: runtime,
		observerApiKey: null,
		observerBaseUrl: null,
		observerMaxChars: 12_000,
		observerMaxTokens: 4_000,
		observerHeaders: {},
		observerAuthSource: "auto",
		observerAuthFile: null,
		observerAuthCommand: [],
		observerAuthTimeoutMs: 1500,
		observerAuthCacheTtlS: 300,
	});
}

describe("observer subprocess options", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("hides the executable discovery process without changing ignored stdio", () => {
		childProcessMocks.execFileSync.mockReturnValue(Buffer.alloc(0));

		expect(codexCliAvailable("codex")).toBe(true);
		expect(childProcessMocks.execFileSync).toHaveBeenCalledWith(
			process.platform === "win32" ? "where" : "which",
			["codex"],
			{ stdio: "ignore", windowsHide: true },
		);
	});

	it("hides Claude sidecars while preserving timeout and output capture", async () => {
		childProcessMocks.execFileAsync.mockResolvedValue({
			stdout: JSON.stringify({ type: "result", result: "sidecar output", is_error: false }),
			stderr: "",
		});
		const client = makeSidecarClient("claude_sidecar");
		const invokeSidecar = (
			client as unknown as {
				_invokeSidecar: (prompt: string, useModel: boolean) => Promise<{ output: string | null }>;
			}
		)._invokeSidecar.bind(client);

		await expect(invokeSidecar("prompt", true)).resolves.toMatchObject({
			output: "sidecar output",
		});
		expect(childProcessMocks.execFileAsync).toHaveBeenCalledOnce();
		const call = childProcessMocks.execFileAsync.mock.calls[0];
		expect(call).toBeDefined();
		if (!call) return;
		const [executable, args, options] = call;
		expect(executable).toBe("claude");
		expect(args).toEqual(expect.arrayContaining(["-p", "--output-format", "json", "prompt"]));
		expect(options).toMatchObject({
			timeout: 120_000,
			maxBuffer: 10 * 1024 * 1024,
			windowsHide: true,
		});
		expect(options).not.toHaveProperty("stdio");
	});

	it("hides Codex sidecars while preserving piped stdio", async () => {
		const child = new EventEmitter();
		const stdin = Object.assign(new EventEmitter(), {
			write: vi.fn(() => true),
			end: vi.fn(() => {
				queueMicrotask(() => child.emit("close", 0));
			}),
		});
		const fakeChild = Object.assign(child, {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			stdin,
			kill: vi.fn(() => true),
		});
		childProcessMocks.spawn.mockReturnValue(fakeChild);
		const client = makeSidecarClient("codex_sidecar");
		const spawnCodex = (
			client as unknown as {
				_spawnCodex: (
					executable: string,
					args: string[],
					env: NodeJS.ProcessEnv,
					stdinPayload: string,
				) => Promise<{ code: number | null }>;
			}
		)._spawnCodex.bind(client);
		const env = { TEST_MARKER: "1" };

		await expect(spawnCodex("codex", ["exec"], env, "prompt")).resolves.toMatchObject({
			code: 0,
		});
		expect(childProcessMocks.spawn).toHaveBeenCalledWith("codex", ["exec"], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		expect(fakeChild.stdin.write).toHaveBeenCalledWith("prompt");
		expect(fakeChild.kill).not.toHaveBeenCalled();
	});
});
