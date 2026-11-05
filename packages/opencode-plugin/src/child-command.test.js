import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChildCommand } from "../.opencode/lib/child-command.js";

const NODE = process.execPath;
let root;

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

describe("runChildCommand", () => {
	it("runs in the given cwd and passes stdin through", async () => {
		root = mkdtempSync(join(tmpdir(), "codemem-child-command-"));
		const script =
			"let input = ''; process.stdin.on('data', (c) => { input += c; });" +
			"process.stdin.on('end', () => console.log(JSON.stringify({ cwd: process.cwd(), input })));";

		const result = await runChildCommand([NODE, "-e", script], { cwd: root, stdinText: "hello" });

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ cwd: realpathSync(root), input: "hello" });
	});

	it("uses defaults for cwd and timeout when options leave them unset", async () => {
		root = mkdtempSync(join(tmpdir(), "codemem-child-command-"));

		const result = await runChildCommand(
			[NODE, "-e", "console.log(process.cwd())"],
			{ cwd: undefined },
			{ cwd: root, timeoutMs: 10_000 },
		);

		expect(result.stdout.trim()).toBe(realpathSync(root));
	});

	it("kills the child on abort and reports it", async () => {
		const controller = new AbortController();
		const pending = runChildCommand([NODE, "-e", "setTimeout(() => {}, 30_000)"], {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 100);

		await expect(pending).resolves.toEqual({
			exitCode: null,
			stdout: "",
			stderr: "aborted",
			aborted: true,
		});
	});

	it("does not spawn when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			runChildCommand(["/nonexistent/command"], { signal: controller.signal }),
		).resolves.toMatchObject({ exitCode: null, aborted: true });
	});

	it("reports a timeout with a null exit code", async () => {
		const result = await runChildCommand([NODE, "-e", "setTimeout(() => {}, 30_000)"], {
			timeoutMs: 100,
		});

		expect(result).toEqual({ exitCode: null, stdout: "", stderr: "timeout" });
	});
});
