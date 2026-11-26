import { describe, expect, it } from "vitest";
import { testWorkerExecArgv } from "../test-worker-v8-flags.js";

describe("Vitest worker V8 flags", () => {
	it("turns off WebAssembly code GC only on Node 24", () => {
		expect(testWorkerExecArgv("24.22.3")).toEqual(["--no-wasm-code-gc"]);
		expect(testWorkerExecArgv("26.13.1")).toEqual([]);
		expect(testWorkerExecArgv("25.0.0")).toEqual([]);
	});

	it("starts this worker with the flag for its Node version", () => {
		// The Core project's config passes these to every test fork.
		for (const flag of testWorkerExecArgv()) expect(process.execArgv).toContain(flag);
	});
});
