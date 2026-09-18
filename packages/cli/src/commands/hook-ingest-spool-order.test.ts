import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { drainSpool, spoolPayload } from "./claude-hook-ingest-spool.js";

describe("hook ingest spool ordering", () => {
	let root: string;
	let queueDir: string;
	let logFile: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codemem-hook-spool-order-"));
		queueDir = join(root, "spool");
		logFile = join(root, "plugin.log");
		for (const key of ["CODEMEM_CLAUDE_HOOK_SPOOL_DIR", "CODEMEM_PLUGIN_LOG_PATH"]) {
			savedEnv[key] = process.env[key];
		}
		process.env.CODEMEM_CLAUDE_HOOK_SPOOL_DIR = queueDir;
		process.env.CODEMEM_PLUGIN_LOG_PATH = logFile;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("stops at the first transient failure without reordering retained entries", async () => {
		mkdirSync(queueDir, { recursive: true });
		writeFileSync(join(queueDir, "hook-0001.json"), JSON.stringify({ tag: "first" }), "utf8");
		writeFileSync(join(queueDir, "hook-0002.json"), JSON.stringify({ tag: "second" }), "utf8");
		const seen: string[] = [];
		const result = await drainSpool(async (payload) => {
			seen.push(String(payload.tag));
			return false;
		});
		expect(result).toEqual({ processed: 0, failed: 1 });
		expect(seen).toEqual(["first"]);
		expect(readdirSync(queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
	});

	it("logs spool timing without exposing its path", () => {
		expect(spoolPayload({ hook_event_name: "Stop" })).toBe(true);
		const logged = readFileSync(logFile, "utf8");
		expect(logged).toContain("elapsed_ms=");
		expect(logged).not.toContain(queueDir);
	});
});
