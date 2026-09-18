import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	claudeHookIngestCommand,
	directEnqueue,
	ingestClaudeHookPayload,
} from "./claude-hook-ingest.js";
import { spoolPayload } from "./claude-hook-ingest-spool.js";

function createTempDbPath(): { dbPath: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "codemem-cli-claude-hook-"));
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return {
		dbPath,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

let sandboxDir: string;
let stateDir: string;
let lockDir: string;
let queueDir: string;
let pluginLogPath: string;
const savedEnv: Record<string, string | undefined> = {};

async function verifyCurrentPayloadIsSpooledBeforeRecovery(): Promise<void> {
	expect(spoolPayload({ hook_event_name: "SessionStart", session_id: "previously-spooled" })).toBe(
		true,
	);
	let releaseBacklog: (() => void) | undefined;
	let calls = 0;
	const pending = ingestClaudeHookPayload(
		{ hook_event_name: "SessionStart", session_id: "current" },
		{ host: "127.0.0.1", port: 38888 },
		{
			httpIngest: async () => {
				calls += 1;
				if (calls === 1) {
					await new Promise<void>((resolve) => {
						releaseBacklog = resolve;
					});
				}
				return { ok: true, inserted: 1, skipped: 0 };
			},
			resolveDb: () => join(sandboxDir, "fallback.sqlite"),
			directIngest: () => ({ inserted: 1, skipped: 0 }),
			boundaryFlush: () => {},
		},
	);

	expect(readdirSync(queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
	releaseBacklog?.();
	await expect(pending).resolves.toMatchObject({ via: "http" });
	expect(readdirSync(queueDir)).toHaveLength(0);
}

const sandboxedEnvKeys = [
	"CODEMEM_CLAUDE_HOOK_CONTEXT_DIR",
	"CODEMEM_CLAUDE_HOOK_LOCK_DIR",
	"CODEMEM_CLAUDE_HOOK_SPOOL_DIR",
	"CODEMEM_PLUGIN_LOG_PATH",
	"CODEMEM_PLUGIN_LOG",
	"CODEMEM_CLAUDE_HOOK_FLUSH",
	"CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP",
	"CODEMEM_CLAUDE_HOOK_LOCK_TTL_S",
	"CODEMEM_CLAUDE_HOOK_LOCK_GRACE_S",
];

beforeEach(() => {
	sandboxDir = mkdtempSync(join(tmpdir(), "codemem-cli-ingest-test-"));
	stateDir = join(sandboxDir, "state");
	lockDir = join(sandboxDir, "lock");
	queueDir = join(sandboxDir, "spool");
	pluginLogPath = join(sandboxDir, "plugin.log");
	for (const key of sandboxedEnvKeys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	process.env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR = stateDir;
	process.env.CODEMEM_CLAUDE_HOOK_LOCK_DIR = lockDir;
	process.env.CODEMEM_CLAUDE_HOOK_SPOOL_DIR = queueDir;
	process.env.CODEMEM_PLUGIN_LOG_PATH = pluginLogPath;
});

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(sandboxDir, { recursive: true, force: true });
});

it("registers expected options and help text", () => {
	const longs = claudeHookIngestCommand.options.map((option) => option.long);
	expect(longs).toContain("--db");
	expect(longs).toContain("--db-path");
	expect(longs).toContain("--host");
	expect(longs).toContain("--port");

	const help = claudeHookIngestCommand.helpInformation();
	expect(help).toContain("durable HTTP queue");
	expect(help).toContain("local spool fallback");
});

it("returns HTTP result when viewer ingest succeeds", async () => {
	let httpPayload: Record<string, unknown> | undefined;
	const result = await ingestClaudeHookPayload(
		{ hook_event_name: "SessionStart", session_id: "sess-http", cwd: "/tmp/demo" },
		{ host: "127.0.0.1", port: 38888 },
		{
			httpIngest: async (request) => {
				httpPayload = request;
				return { ok: true, inserted: 2, skipped: 1 };
			},
			directIngest: () => {
				throw new Error("direct ingest should not be called");
			},
			resolveDb: () => "/tmp/resolved.sqlite",
		},
	);

	expect(result).toEqual({ inserted: 2, skipped: 1, via: "http" });
	expect(httpPayload).toMatchObject({
		db_path: "/tmp/resolved.sqlite",
		identity_target: expect.any(Object),
	});
});

it("spools immediately when the Viewer target mismatches", async () => {
	mkdirSync(queueDir, { recursive: true });
	writeFileSync(
		join(queueDir, "hook-0000000001-pid-1.json"),
		JSON.stringify({ hook_event_name: "Stop", session_id: "queued", tag: "queued" }),
		"utf8",
	);
	let httpCalls = 0;
	const directCalls: Array<Record<string, unknown>> = [];
	const result = await ingestClaudeHookPayload(
		{
			hook_event_name: "SessionStart",
			session_id: "sess-mismatch",
			cwd: "/tmp/demo",
			tag: "fresh",
		},
		{ host: "127.0.0.1", port: 38888, db: "/tmp/custom.sqlite" },
		{
			httpIngest: async () => {
				httpCalls += 1;
				return { ok: false, inserted: 0, skipped: 0, targetMismatch: true };
			},
			directIngest: (payload) => {
				directCalls.push(payload);
				return { inserted: 1, skipped: 0 };
			},
			resolveDb: () => "/tmp/resolved.sqlite",
		},
	);

	expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
	expect(httpCalls).toBe(1);
	expect(directCalls).toEqual([]);
	expect(readdirSync(queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
});

it("direct enqueue inserts once and then deduplicates event_id", () => {
	const { dbPath, cleanup } = createTempDbPath();
	try {
		const payload = {
			hook_event_name: "SessionStart",
			session_id: "sess-dedup",
			timestamp: "2026-01-01T00:00:00Z",
			cwd: "/tmp/demo",
		};

		const first = directEnqueue(payload, dbPath);
		const second = directEnqueue(payload, dbPath);

		expect(first).toEqual({ inserted: 1, skipped: 0 });
		expect(second).toEqual({ inserted: 0, skipped: 1 });

		const db = connect(dbPath);
		try {
			const rawCount = db.prepare("SELECT COUNT(*) AS c FROM raw_events").get() as { c: number };
			const sessionCount = db.prepare("SELECT COUNT(*) AS c FROM raw_event_sessions").get() as {
				c: number;
			};
			expect(rawCount.c).toBe(1);
			expect(sessionCount.c).toBe(1);
			const row = db.prepare("SELECT event_seq FROM raw_events").get() as {
				event_seq: number;
			};
			expect(row.event_seq).toBe(0);
		} finally {
			db.close();
		}
	} finally {
		cleanup();
	}
});

it("direct enqueue skips unsupported hook payloads gracefully", () => {
	const { dbPath, cleanup } = createTempDbPath();
	try {
		const result = directEnqueue({ hook_event_name: "UnknownEvent", session_id: "sess-x" }, dbPath);
		expect(result).toEqual({ inserted: 0, skipped: 1 });
	} finally {
		cleanup();
	}
});

it("direct enqueue bootstraps fresh databases on demand", () => {
	// Fresh path without initTestSchema() — the failure mode Cowork sandbox
	// VMs hit when the hook fires before the MCP server finishes its own
	// MemoryStore construction. Without ensureSchemaBootstrapped this call
	// would throw "no such table: raw_events".
	const dir = mkdtempSync(join(tmpdir(), "codemem-cli-direct-bootstrap-"));
	const dbPath = join(dir, "fresh.sqlite");
	try {
		const result = directEnqueue(
			{
				hook_event_name: "SessionStart",
				session_id: "sess-fresh-bootstrap",
				timestamp: "2026-01-01T00:00:00Z",
				cwd: "/tmp/demo",
			},
			dbPath,
		);
		expect(result).toEqual({ inserted: 1, skipped: 0 });

		// Re-open through a plain connect() and verify the raw event actually
		// landed in the auto-bootstrapped schema.
		const db = connect(dbPath);
		try {
			const rawCount = db.prepare("SELECT COUNT(*) AS c FROM raw_events").get() as {
				c: number;
			};
			expect(rawCount.c).toBe(1);
		} finally {
			db.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("durability layer", () => {
	it("drains spooled backlog before the current event on the HTTP-success path", async () => {
		// Pre-seed a payload from a previous failed run.
		mkdirSync(queueDir, { recursive: true });
		writeFileSync(
			join(queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({
				hook_event_name: "Stop",
				session_id: "previously-spooled",
				tag: "queued",
			}),
			"utf8",
		);

		const httpCalls: Array<Record<string, unknown>> = [];
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "Stop", session_id: "fresh", tag: "fresh" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (payload) => {
					httpCalls.push(payload);
					return { ok: true, inserted: 1, skipped: 0 };
				},
				directIngest: () => {
					throw new Error("direct ingest should not be called when HTTP succeeds");
				},
				boundaryFlush: () => {},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		// Fresh payload still routed via HTTP.
		expect(result).toEqual({ inserted: 1, skipped: 0, via: "http" });
		// httpIngest is called for the retained payload first, then the
		// current payload.
		expect(httpCalls.map((p) => p.tag)).toEqual(["queued", "fresh"]);
		// Backlog entry consumed by the drainer.
		expect(readdirSync(queueDir)).toHaveLength(0);
	});

	it("persists the current payload before awaiting backlog recovery", async () => {
		await verifyCurrentPayloadIsSpooledBeforeRecovery();
	});

	it("skips backlog drain on HTTP success when spool is empty (no extra HTTP calls)", async () => {
		let httpCallCount = 0;
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "Stop", session_id: "no-backlog" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => {
					httpCallCount++;
					return { ok: true, inserted: 1, skipped: 0 };
				},
				directIngest: () => {
					throw new Error("direct ingest should not be called");
				},
				boundaryFlush: () => {},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result.via).toBe("http");
		// Empty spool → exactly one httpIngest call (no drain pass).
		expect(httpCallCount).toBe(1);
	});

	it("treats HTTP `skipped > 0` (deterministic null envelope) as a successful no-op", async () => {
		// The viewer only returns {inserted:0, skipped:1} when
		// buildRawEventEnvelopeFromHook produces a null envelope — a
		// deterministic decision for payloads like a Stop event with no
		// assistant text. Retrying via the direct path would produce the
		// same null envelope and the same skip, so the ingest command
		// accepts this as a no-op success instead of triggering the
		// durability fallback.
		let directCalls = 0;
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "Stop", session_id: "sess-no-text" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
				directIngest: () => {
					directCalls++;
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: () => {
					throw new Error("boundary flush should not run for Stop without flush envs");
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result).toEqual({ inserted: 0, skipped: 1, via: "http" });
		expect(directCalls).toBe(0);
	});

	it("spools the payload when both HTTP and direct ingest fail", async () => {
		const result = await ingestClaudeHookPayload(
			{
				hook_event_name: "Stop",
				session_id: "sess-spool",
				timestamp: "2026-04-09T00:00:00Z",
			},
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("simulated direct ingest failure");
				},
				resolveDb: () => "/tmp/never-used.sqlite",
			},
		);
		expect(result.via).toBe("spool");
		// One file landed in the spool dir.
		const queued = readdirSync(queueDir).filter((n) => n.endsWith(".json"));
		expect(queued).toHaveLength(1);
		// Plugin log captured the failure path.
		const logged = readFileSync(pluginLogPath, "utf8");
		expect(logged).toContain("spooled payload");
	});

	it("delegates SessionEnd boundary flush to the durable HTTP queue", async () => {
		const directCalls: Array<Record<string, unknown>> = [];
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const httpOptions: Array<{ flushBoundary?: boolean } | undefined> = [];
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionEnd", session_id: "sess-end" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (_payload, _host, _port, options) => {
					httpOptions.push(options);
					return { ok: true, inserted: 0, skipped: 0, queued: 1 };
				},
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result.via).toBe("http");
		expect(httpOptions).toEqual([{ flushBoundary: true }]);
		expect(directCalls).toEqual([]);
		expect(boundaryFlushCalls).toEqual([]);
	});
});

describe("boundary fallback after backlog recovery", () => {
	it("removes the live spool only after direct ingest succeeds", async () => {
		expect(spoolPayload({ hook_event_name: "SessionStart", session_id: "queued" })).toBe(true);
		const actions: string[] = [];
		let httpCalls = 0;
		const result = await ingestClaudeHookPayload(
			{ hook_event_name: "SessionEnd", session_id: "current-boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => {
					httpCalls += 1;
					return httpCalls === 1
						? { ok: true, inserted: 1, skipped: 0 }
						: { ok: false, inserted: 0, skipped: 0 };
				},
				directIngest: () => {
					actions.push("direct");
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: () => {
					actions.push("flush");
				},
				resolveDb: () => join(sandboxDir, "fallback.sqlite"),
			},
		);

		expect(result).toEqual({ inserted: 1, skipped: 0, via: "direct" });
		expect(actions).toEqual(["direct", "flush"]);
		expect(readdirSync(queueDir)).toHaveLength(0);
	});
});
