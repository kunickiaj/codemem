import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ingestClaudeHookPayload } from "./claude-hook-ingest.js";

let root: string;
let queueDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-claude-spool-recovery-"));
	queueDir = join(root, "spool");
	for (const [key, value] of Object.entries({
		CODEMEM_CLAUDE_HOOK_CONTEXT_DIR: join(root, "context"),
		CODEMEM_CLAUDE_HOOK_LOCK_DIR: join(root, "lock"),
		CODEMEM_CLAUDE_HOOK_SPOOL_DIR: queueDir,
		CODEMEM_PLUGIN_LOG_PATH: join(root, "plugin.log"),
	})) {
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

function seedSpool(name: string, payload: Record<string, unknown>): void {
	mkdirSync(queueDir, { recursive: true });
	writeFileSync(join(queueDir, name), JSON.stringify(payload), "utf8");
}

it("retains the backlog and current payload when HTTP remains down", async () => {
	seedSpool("hook-0001.json", { hook_event_name: "Stop", session_id: "queued-1", tag: "queued-1" });
	seedSpool("hook-0002.json", { hook_event_name: "Stop", session_id: "queued-2", tag: "queued-2" });
	const httpCalls: Array<Record<string, unknown>> = [];
	const directCalls: Array<Record<string, unknown>> = [];
	const result = await ingestClaudeHookPayload(
		{ hook_event_name: "Stop", session_id: "fresh", tag: "fresh" },
		{ host: "127.0.0.1", port: 38888 },
		{
			httpIngest: async (payload) => {
				httpCalls.push(payload);
				return { ok: false, inserted: 0, skipped: 0 };
			},
			directIngest: (payload) => {
				directCalls.push(payload);
				return { inserted: 1, skipped: 0 };
			},
			resolveDb: () => "/tmp/test.sqlite",
		},
	);
	expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
	expect(httpCalls.map((payload) => payload.tag)).toEqual(["queued-1"]);
	expect(directCalls).toEqual([]);
	expect(readdirSync(queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(3);
});

it("queues retained events before the current boundary", async () => {
	seedSpool("hook-0001.json", {
		hook_event_name: "Stop",
		session_id: "queued-before-flush",
		tag: "queued",
	});
	const events: string[] = [];
	const result = await ingestClaudeHookPayload(
		{ hook_event_name: "SessionEnd", session_id: "sess-end", tag: "fresh" },
		{ host: "127.0.0.1", port: 38888 },
		{
			httpIngest: async (payload) => {
				events.push(`http:${String(payload.tag ?? "")}`);
				return { ok: true, inserted: 0, skipped: 0 };
			},
			directIngest: (payload) => {
				events.push(`direct:${String(payload.tag ?? "")}`);
				return { inserted: 1, skipped: 0 };
			},
			boundaryFlush: (payload) => {
				events.push(`flush:${String(payload.tag ?? "")}`);
			},
			resolveDb: () => "/tmp/test.sqlite",
		},
	);
	expect(result.via).toBe("http");
	expect(events).toEqual(["http:queued", "http:fresh"]);
	expect(readdirSync(queueDir)).toHaveLength(0);
});
