import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();
const execSyncMock = vi.fn(() => "test-version");

vi.mock("node:child_process", () => ({
	spawn: (...args) => spawnMock(...args),
	execSync: (...args) => execSyncMock(...args),
}));

const makeProcess = ({ stdout = "", stderr = "", exitCode = 0 }) => {
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = {
		write: vi.fn(),
		end: vi.fn(),
	};
	queueMicrotask(() => {
		if (stdout) proc.stdout.emit("data", stdout);
		if (stderr) proc.stderr.emit("data", stderr);
		proc.emit("exit", exitCode);
	});
	return proc;
};

describe("experimental.chat.system.transform", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		vi.resetModules();
		spawnMock.mockReset();
		execSyncMock.mockClear();
		process.env = {
			...originalEnv,
			CODEMEM_VIEWER: "0",
			CODEMEM_PLUGIN_DEBUG: "1",
			CODEMEM_PLUGIN_LOG: "0",
			CODEMEM_INJECT_CONTEXT: "1",
		};
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("appends built memory pack to output.system", async () => {
		spawnMock.mockImplementation((_command, args) => {
			if (Array.isArray(args) && args.includes("pack")) {
				return makeProcess({
					stdout: JSON.stringify({
						pack_text: "## Summary\n[1] (feature) Titanic artifact client shipped",
						metrics: { items: 1, pack_tokens: 42 },
					}),
				});
			}
			return makeProcess({ stdout: "" });
		});

		const { OpencodeMemPlugin } = await import("../plugins/codemem.js");
		const hooks = await OpencodeMemPlugin({
			project: { name: "greenroom" },
			client: {
				app: { log: vi.fn().mockResolvedValue(undefined) },
				tui: {},
			},
			directory: "/tmp/greenroom",
			worktree: "/tmp/greenroom",
		});

		expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");

		const output = { system: ["base system prompt"] };
		await hooks["experimental.chat.system.transform"](
			{ sessionID: "sess-1", model: {} },
			output,
		);

		expect(output.system).toEqual([
			"base system prompt",
			"[codemem context]\n## Summary\n[1] (feature) Titanic artifact client shipped",
		]);
		expect(spawnMock).toHaveBeenCalledTimes(1);
	});
});
