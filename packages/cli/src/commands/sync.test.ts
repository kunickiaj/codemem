import { describe, expect, it } from "vitest";
import {
	buildServeLifecycleArgs,
	formatSyncAttempt,
	formatSyncOnceResult,
} from "./sync-helpers.js";

describe("formatSyncAttempt", () => {
	it("matches the compact Python-era output shape", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-1",
				ok: 1,
				ops_in: 3,
				ops_out: 5,
				error: null,
				finished_at: "2026-03-18T20:00:00Z",
			}),
		).toBe("peer-1|ok|in=3|out=5|2026-03-18T20:00:00Z");
	});

	it("includes the error suffix when present", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-2",
				ok: 0,
				ops_in: 0,
				ops_out: 1,
				error: "timeout",
				finished_at: "2026-03-18T21:00:00Z",
			}),
		).toBe("peer-2|error|in=0|out=1|2026-03-18T21:00:00Z | timeout");
	});

	it("builds sync start as a background serve invocation using the current runner", () => {
		expect(
			buildServeLifecycleArgs(
				"start",
				{ dbPath: "/tmp/test.sqlite", host: "127.0.0.1", port: "7337" },
				"/repo/packages/cli/src/index.ts",
				["--conditions", "source"],
			),
		).toEqual([
			"--conditions",
			"source",
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
			"--host",
			"127.0.0.1",
			"--port",
			"7337",
		]);
	});

	it("builds sync restart as a serve restart invocation", () => {
		expect(
			buildServeLifecycleArgs(
				"restart",
				{ dbPath: "/tmp/test.sqlite" },
				"/repo/packages/cli/src/index.ts",
				[],
			),
		).toEqual([
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
		]);
	});

	it("formats sync once success output like the Python command", () => {
		expect(formatSyncOnceResult("peer-1", { ok: true })).toBe("- peer-1: ok");
	});

	it("formats sync once error output like the Python command", () => {
		expect(formatSyncOnceResult("peer-2", { ok: false, error: "timeout" })).toBe(
			"- peer-2: error: timeout",
		);
	});
});
