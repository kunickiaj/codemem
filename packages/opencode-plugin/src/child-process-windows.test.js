import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";

const childProcess = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal()),
	execFile: childProcess.execFile,
	spawn: childProcess.spawn,
}));

const { probeCliCandidate } = await import("../.opencode/lib/cached-cli-runner.js");
const { runChildCommand } = await import("../.opencode/lib/child-command.js");

const roots = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("hides the console window for installed CLI version probes", async () => {
	// Arrange
	const root = mkdtempSync(join(tmpdir(), "codemem-window-probe-"));
	roots.push(root);
	const bin = join(root, "bin");
	const pkg = join(root, "node_modules", "codemem");
	mkdirSync(bin);
	mkdirSync(pkg, { recursive: true });
	writeFileSync(
		join(pkg, "package.json"),
		JSON.stringify({ name: "codemem", version: "1.2.3", bin: { codemem: "cli.js" } }),
	);
	writeFileSync(join(pkg, "cli.js"), "");
	symlinkSync(join(pkg, "cli.js"), join(bin, "codemem"));
	childProcess.execFile.mockImplementation((_command, _args, _options, callback) =>
		callback(new Error("probe unavailable")),
	);
	// Act
	await probeCliCandidate({ path: bin, nodePath: process.execPath, bootstrap: true });
	// Assert
	expect(childProcess.execFile).toHaveBeenCalledWith(
		process.execPath,
		expect.arrayContaining(["--version"]),
		expect.objectContaining({ windowsHide: true }),
		expect.any(Function),
	);
});

test("hides the console window for plugin child commands", async () => {
	// Arrange
	const proc = new EventEmitter();
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = { end: vi.fn(), on: vi.fn(), write: vi.fn() };
	proc.kill = vi.fn();
	childProcess.spawn.mockImplementation(() => {
		queueMicrotask(() => proc.emit("exit", 0));
		return proc;
	});
	// Act
	await runChildCommand(["codemem", "stats"], { cwd: "/workspace", env: { PATH: "/bin" } });
	// Assert
	expect(childProcess.spawn).toHaveBeenCalledWith("codemem", ["stats"], {
		cwd: "/workspace",
		env: { PATH: "/bin" },
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
});
