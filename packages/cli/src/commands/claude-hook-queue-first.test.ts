import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestClaudeHookPayload } from "./claude-hook-ingest.js";

describe("Claude queue-first fallback", () => {
	let root: string;
	const savedEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codemem-claude-queue-first-"));
		const env = {
			CODEMEM_CLAUDE_HOOK_CONTEXT_DIR: join(root, "context"),
			CODEMEM_CLAUDE_HOOK_LOCK_DIR: join(root, "lock"),
			CODEMEM_CLAUDE_HOOK_SPOOL_DIR: join(root, "spool"),
			CODEMEM_PLUGIN_LOG_PATH: join(root, "plugin.log"),
		};
		for (const [key, value] of Object.entries(env)) {
			savedEnv[key] = process.env[key];
			process.env[key] = value;
		}
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	it("spools ordinary failures without direct SQLite", async () => {
		let directCalls = 0;
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionStart", session_id: "sess-direct", cwd: "/tmp/demo" },
			{ host: "127.0.0.1", port: 38888, db: "/tmp/custom.sqlite" },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					directCalls += 1;
					return { inserted: 1, skipped: 0 };
				},
				resolveDb: () => "/tmp/resolved.sqlite",
			},
		);
		expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
		expect(directCalls).toBe(0);
	});

	it("uses direct ingest and flush only for an unreachable boundary", async () => {
		const events: string[] = [];
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionEnd", session_id: "sess-boundary-fallback" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					events.push("direct");
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: () => {
					events.push("flush");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
		expect(events).toEqual(["direct", "flush"]);
	});
});

it("marks Stop as a boundary only when both flush settings are enabled", async () => {
	const previousFlush = process.env.CODEMEM_CLAUDE_HOOK_FLUSH;
	const previousStop = process.env.CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP;
	const markers: Array<boolean | undefined> = [];
	const ingest = () =>
		ingestClaudeHookPayload(
			{ hook_event_name: "Stop" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (_payload, _host, _port, options) => {
					markers.push(options?.flushBoundary);
					return { ok: true, inserted: 0, skipped: 0 };
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
	try {
		delete process.env.CODEMEM_CLAUDE_HOOK_FLUSH;
		delete process.env.CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP;
		await ingest();
		process.env.CODEMEM_CLAUDE_HOOK_FLUSH = "1";
		await ingest();
		delete process.env.CODEMEM_CLAUDE_HOOK_FLUSH;
		process.env.CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP = "1";
		await ingest();
		process.env.CODEMEM_CLAUDE_HOOK_FLUSH = "1";
		await ingest();
		expect(markers).toEqual([false, false, false, true]);
	} finally {
		if (previousFlush === undefined) delete process.env.CODEMEM_CLAUDE_HOOK_FLUSH;
		else process.env.CODEMEM_CLAUDE_HOOK_FLUSH = previousFlush;
		if (previousStop === undefined) delete process.env.CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP;
		else process.env.CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP = previousStop;
	}
});
