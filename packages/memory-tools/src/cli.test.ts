import { describe, expect, it } from "vitest";
import { CliAbortedError, createCodememCliRunner, parseCliJson } from "./cli.js";

describe("parseCliJson", () => {
	it("returns null for empty output", () => {
		expect(parseCliJson("  \n")).toBeNull();
	});

	it("skips log lines before the JSON payload", () => {
		expect(parseCliJson('viewer: starting\n{"items":[{"id":1}]}')).toEqual({ items: [{ id: 1 }] });
	});

	it("parses nested top-level objects instead of the first inner brace", () => {
		expect(parseCliJson('{"items":[{"id":1}],"meta":{"n":1}}')).toEqual({
			items: [{ id: 1 }],
			meta: { n: 1 },
		});
	});

	it("returns the trimmed text when nothing parses", () => {
		expect(parseCliJson("  No memories found.  ")).toBe("No memories found.");
	});
});

describe("createCodememCliRunner", () => {
	// Drive `node -e` instead of the real CLI so the test is hermetic.
	const runNode = createCodememCliRunner({ command: process.execPath, prefixArgs: ["-e"] });

	it("returns stdout and stderr from a successful run", async () => {
		const result = await runNode(['process.stdout.write("out"); process.stderr.write("err");']);

		expect(result).toEqual({ stdout: "out", stderr: "err" });
	});

	it("pipes stdin to the child", async () => {
		const result = await runNode(
			['process.stdin.on("data", (chunk) => process.stdout.write(String(chunk).toUpperCase()));'],
			{ stdin: "hello" },
		);

		expect(result.stdout).toBe("HELLO");
	});

	it("rejects with stdout and stderr attached on a non-zero exit", async () => {
		await expect(
			runNode(['process.stdout.write("partial"); process.exit(3);']),
		).rejects.toMatchObject({ stdout: "partial" });
	});

	it("rejects immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			runNode(["setTimeout(() => {}, 10_000)"], { signal: controller.signal }),
		).rejects.toBeInstanceOf(CliAbortedError);
	});

	it("survives EPIPE when a child exits before draining a large stdin", async () => {
		const largeStdin = "x".repeat(256 * 1024);

		await expect(runNode(["process.exit(1)"], { stdin: largeStdin })).rejects.toMatchObject({
			code: 1,
		});
	});

	it("survives EPIPE when an abort kills a child that never reads stdin", async () => {
		const controller = new AbortController();
		const pending = runNode(["setTimeout(() => {}, 10_000)"], {
			stdin: "x".repeat(256 * 1024),
			signal: controller.signal,
			timeoutMs: 20_000,
		});
		setTimeout(() => controller.abort(), 200);

		await expect(pending).rejects.toBeInstanceOf(CliAbortedError);
	});

	it("reports a normal result when the abort lands after the child already exited", async () => {
		const controller = new AbortController();
		const result = await runNode(['process.stdout.write("done")'], { signal: controller.signal });
		controller.abort();

		expect(result.stdout).toBe("done");
	});

	it("rejects with a timeout kill when the child outlives timeoutMs", async () => {
		await expect(
			runNode(["setTimeout(() => {}, 10_000)"], { timeoutMs: 200 }),
		).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
	});

	it("kills a running child when the signal aborts", async () => {
		const controller = new AbortController();
		const pending = runNode(
			['process.stdout.write("started"); setTimeout(() => process.stdout.write("late"), 10_000);'],
			{ signal: controller.signal, timeoutMs: 20_000 },
		);
		setTimeout(() => controller.abort(), 100);

		await expect(pending).rejects.toBeInstanceOf(CliAbortedError);
	});
});
