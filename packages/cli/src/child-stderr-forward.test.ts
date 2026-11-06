import { spawn } from "node:child_process";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { forwardChildStderr } from "./child-stderr-forward.js";

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("forwardChildStderr", () => {
	it("prefixes each line, including lines split across chunks and a final unterminated line", async () => {
		// Arrange
		const source = new PassThrough();
		const written: string[] = [];
		forwardChildStderr(source, { prefix: "[worker] ", write: (text) => written.push(text) });

		// Act
		source.write("Warning: first\nWarning: sec");
		source.write("ond\r\nlast without newline");
		source.end();
		await once(source, "end");
		await flush();

		// Assert
		expect(written).toEqual([
			"[worker] Warning: first\n",
			"[worker] Warning: second\n",
			"[worker] last without newline\n",
		]);
	});

	it("keeps forwarding after the destination throws", async () => {
		// Arrange
		const source = new PassThrough();
		const written: string[] = [];
		let calls = 0;
		forwardChildStderr(source, {
			prefix: "",
			write: (text) => {
				calls += 1;
				if (calls === 1) throw new Error("EPIPE");
				written.push(text);
			},
		});

		// Act
		source.end("dropped\nkept\n");
		await once(source, "end");
		await flush();

		// Assert
		expect(written).toEqual(["kept\n"]);
	});

	it("ignores errors on the child's pipe instead of crashing the parent", async () => {
		// Arrange
		const source = new PassThrough();
		forwardChildStderr(source, { prefix: "", write: () => undefined });

		// Act + Assert: an unhandled stream error would throw here.
		expect(() => source.emit("error", new Error("pipe broke"))).not.toThrow();
	});

	it("forwards a real child process's stderr", async () => {
		// Arrange
		const child = spawn(process.execPath, ["-e", "console.error('vector catch-up failed')"], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		const written: string[] = [];
		if (!child.stderr) throw new Error("expected a stderr pipe");
		forwardChildStderr(child.stderr, {
			prefix: "[maintenance-worker] ",
			write: (text) => written.push(text),
		});

		// Act
		await once(child, "close");

		// Assert
		expect(written).toEqual(["[maintenance-worker] vector catch-up failed\n"]);
	});
});
