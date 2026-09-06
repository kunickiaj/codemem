import { describe, expect, it } from "vitest";
import { probeRequiredNativeRuntime } from "./native-runtime.js";

describe("probeRequiredNativeRuntime", () => {
	it("opens and closes an in-memory better-sqlite3 database", () => {
		expect(() => probeRequiredNativeRuntime()).not.toThrow();
	});

	it("propagates native binding load failures", () => {
		expect(() =>
			probeRequiredNativeRuntime(() => {
				throw new Error("binding missing");
			}),
		).toThrow("binding missing");
	});
});
