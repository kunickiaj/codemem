/**
 * Durability-layer tests for pi-hook-ingest. Kept in their own file so the
 * measured describe bodies stay under the test-file line ratchet.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRawEventEnvelopeFromPiEvent, connect, initTestSchema } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestPiHookPayload } from "./pi-hook-ingest.js";
import { drainPiHookSpool, spoolPiHookPayload } from "./pi-hook-ingest-spool.js";

const SANDBOX_ENV_KEYS = [
	"CODEMEM_PI_HOOK_LOCK_DIR",
	"CODEMEM_PI_HOOK_SPOOL_DIR",
	"CODEMEM_PLUGIN_LOG_PATH",
	"CODEMEM_PLUGIN_LOG",
	"CODEMEM_PI_HOOK_LOCK_TTL_S",
	"CODEMEM_PI_HOOK_LOCK_GRACE_S",
];

function installPiIngestSandbox(): {
	sandboxDir: string;
	lockDir: string;
	queueDir: string;
	pluginLogPath: string;
	cleanup: () => void;
} {
	const sandboxDir = mkdtempSync(join(tmpdir(), "codemem-cli-pi-ingest-test-"));
	const saved: Record<string, string | undefined> = {};
	for (const key of SANDBOX_ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	const lockDir = join(sandboxDir, "lock");
	const queueDir = join(sandboxDir, "spool");
	const pluginLogPath = join(sandboxDir, "plugin.log");
	process.env.CODEMEM_PI_HOOK_LOCK_DIR = lockDir;
	process.env.CODEMEM_PI_HOOK_SPOOL_DIR = queueDir;
	process.env.CODEMEM_PLUGIN_LOG_PATH = pluginLogPath;
	return {
		sandboxDir,
		lockDir,
		queueDir,
		pluginLogPath,
		cleanup: () => {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			rmSync(sandboxDir, { recursive: true, force: true });
		},
	};
}

describe("pi-hook-ingest durability drain", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("drains spooled backlog on the HTTP-success path so a recovered viewer doesn't strand entries", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "previously-spooled",
				tag: "queued",
			}),
			"utf8",
		);

		const httpCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "fresh", tag: "fresh" },
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

		expect(result).toEqual({ inserted: 1, skipped: 0, via: "http" });
		expect(httpCalls.map((p) => p.tag)).toEqual(["queued", "fresh"]);
		expect(readdirSync(sandbox.queueDir)).toHaveLength(0);
	});

	it("skips backlog drain on HTTP success when spool is empty (no extra HTTP calls)", async () => {
		let httpCallCount = 0;
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "no-backlog" },
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
		expect(httpCallCount).toBe(1);
	});
});

describe("pi-hook-ingest durability spool", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("treats HTTP skipped as a successful no-op without direct fallback", async () => {
		let directCalls = 0;
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
				directIngest: () => {
					directCalls++;
					return { inserted: 0, skipped: 1 };
				},
				boundaryFlush: () => {},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result).toEqual({ inserted: 0, skipped: 1, via: "http" });
		expect(directCalls).toBe(1);
	});

	it("spools the payload when both HTTP and direct ingest fail", async () => {
		const result = await ingestPiHookPayload(
			{
				piEvent: "session_start",
				sessionId: "sess-spool",
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
		const queued = readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"));
		expect(queued).toHaveLength(1);
		expect(readFileSync(sandbox.pluginLogPath, "utf8")).toContain("spooled payload");
	});
});

describe("pi-hook-ingest durability queued drain", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("drains spooled payloads through the handler before processing the new payload", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "queued-1",
				tag: "queued-1",
			}),
			"utf8",
		);
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000002-pid-2.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "queued-2",
				tag: "queued-2",
			}),
			"utf8",
		);

		const httpCalls: Array<Record<string, unknown>> = [];
		const directCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{
				piEvent: "session_start",
				sessionId: "fresh",
				tag: "fresh",
			},
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
		expect(httpCalls.map((p) => p.tag)).toEqual(["queued-1"]);
		expect(directCalls).toEqual([]);
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(3);
	});
});

describe("pi-hook-ingest boundary replay on recovered spool", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		sandbox.cleanup();
	});

	it("replays the boundary flush when a spooled session_before_compact is drained later", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_799_712_000_000);
		// Original invocation: viewer down and DB down — boundary payload spools
		// without any flush (both flush writes fail).
		const spooled = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-recover", tag: "boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("db unavailable");
				},
				boundaryFlush: () => {
					throw new Error("flush unavailable");
				},
				resolveDb: () => "/tmp/unreachable.sqlite",
			},
		);
		expect(spooled.via).toBe("spool");

		// Later invocation: viewer still down, DB healthy — drain must deliver AND
		// replay the flush-only boundary, or the compact extraction is lost.
		const flushes: Array<Record<string, unknown>> = [];
		const directCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-later", tag: "later" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					flushes.push(payload);
				},
				resolveDb: () => "/tmp/healthy.sqlite",
			},
		);

		expect(result.via).toBe("spool");
		expect(readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
		expect(directCalls.map((p) => p.tag)).toEqual(["boundary"]);
		expect(flushes.map((p) => p.tag)).toEqual(["boundary"]);
	});

	it("replays direct write-through + flush when a spooled session_shutdown drains over HTTP", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({ piEvent: "session_shutdown", sessionId: "sess-shut", tag: "boundary" }),
			"utf8",
		);

		const flushes: Array<Record<string, unknown>> = [];
		const directCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-next", tag: "next" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					flushes.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.via).toBe("http");
		expect(readdirSync(sandbox.queueDir)).toHaveLength(0);
		// HTTP accepted the drained envelope; session_shutdown additionally gets
		// the promised synchronous direct write + flush replay. Delivery happ-
		// ened via HTTP so only the boundary write-through goes direct.
		expect(directCalls.map((p) => p.tag)).toEqual(["boundary"]);
		expect(flushes.map((p) => p.tag)).toEqual(["boundary"]);
	});

	it("keeps a recovered boundary spooled when the replayed flush fails, then flushes on a later drain", async () => {
		// Boundary spooled while everything was down.
		const spooled = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-keep", tag: "boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("db unavailable");
				},
				boundaryFlush: () => {
					throw new Error("flush unavailable");
				},
				resolveDb: () => "/tmp/unreachable.sqlite",
			},
		);
		expect(spooled.via).toBe("spool");

		// Recovery pass 1: delivery succeeds, but the default production
		// flushBoundaryRawEvents fails without throwing (store cannot open a directory).
		const notADb = join(sandbox.sandboxDir, "not-a-db");
		mkdirSync(notADb);
		await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-pass1", tag: "pass1" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => ({ inserted: 1, skipped: 0 }),
				resolveDb: () => notADb,
			},
		);
		expect(readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"))).toHaveLength(2);

		// Recovery pass 2: the legacy boundary fallback succeeds, then the
		// ordinary entries are accepted by the Viewer queue.
		const secondFlushAttempts: Array<Record<string, unknown>> = [];
		await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "sess-pass2", tag: "pass2" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (payload) =>
					payload.tag === "boundary"
						? { ok: false, inserted: 0, skipped: 0 }
						: { ok: true, inserted: 0, skipped: 0, queued: 1 },
				directIngest: () => ({ inserted: 1, skipped: 0 }),
				boundaryFlush: (payload) => {
					secondFlushAttempts.push(payload);
				},
				resolveDb: () => "/tmp/healthy.sqlite",
			},
		);
		expect(secondFlushAttempts.map((p) => p.tag)).toEqual(["boundary"]);
		expect(readdirSync(sandbox.queueDir).filter((n) => n.endsWith(".json"))).toHaveLength(0);
	});
});
describe("pi-hook-ingest durability boundary order", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("drains the backlog BEFORE the boundary flush on the HTTP-success path", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({
				piEvent: "session_start",
				sessionId: "queued-before-flush",
				tag: "queued",
			}),
			"utf8",
		);

		const events: string[] = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "sess-end", tag: "fresh" },
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
		expect(events).toEqual(["http:queued", "http:fresh", "direct:fresh", "flush:fresh"]);
		expect(readdirSync(sandbox.queueDir)).toHaveLength(0);
	});

	it("keeps a boundary queued behind an older failed entry", async () => {
		mkdirSync(sandbox.queueDir, { recursive: true });
		writeFileSync(
			join(sandbox.queueDir, "hook-0000000001-pid-1.json"),
			JSON.stringify({ piEvent: "session_start", sessionId: "blocked", tag: "blocked" }),
			"utf8",
		);
		const directCalls: Array<Record<string, unknown>> = [];
		const flushCalls: Array<Record<string, unknown>> = [];

		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "sess-end", tag: "boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: (payload) => {
					flushCalls.push(payload);
				},
				resolveDb: () => "/tmp/must-not-open.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
		expect(directCalls).toEqual([]);
		expect(flushCalls).toEqual([]);
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
	});

	it("force-flushes session_shutdown via direct ingest + boundary flush even when HTTP succeeded", async () => {
		const directCalls: Array<Record<string, unknown>> = [];
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "sess-end" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
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
		expect(directCalls).toHaveLength(1);
		expect(directCalls[0]?.piEvent).toBe("session_shutdown");
		expect(boundaryFlushCalls).toHaveLength(1);
		expect(boundaryFlushCalls[0]?.piEvent).toBe("session_shutdown");
	});
});

describe("pi-hook-ingest boundary retry identity", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("reuses a generated shutdown identity when a failed flush is retried", async () => {
		const directEventIds: string[] = [];
		let flushAttempts = 0;
		const directIngest = (payload: Record<string, unknown>) => {
			const envelope = buildRawEventEnvelopeFromPiEvent(payload);
			if (!envelope) throw new Error("expected shutdown envelope");
			directEventIds.push(envelope.event_id);
			return { inserted: 1, skipped: 0 };
		};

		const first = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "retry-stable", reason: "exit" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest,
				boundaryFlush: () => {
					flushAttempts += 1;
					return false;
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(first.via).toBe("spool");

		await ingestPiHookPayload(
			{ piEvent: "session_start", sessionId: "later" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async (payload) =>
					payload.piEvent === "session_shutdown"
						? { ok: false, inserted: 0, skipped: 0 }
						: { ok: true, inserted: 0, skipped: 0, queued: 1 },
				directIngest,
				boundaryFlush: () => {
					flushAttempts += 1;
					return true;
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(flushAttempts).toBe(2);
		expect(directEventIds).toHaveLength(2);
		expect(directEventIds[0]).not.toBe("");
		expect(directEventIds[1]).toBe(directEventIds[0]);
	});
});

describe("pi-hook-ingest durability boundary compact", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("force-flushes session_before_compact as observe-only boundary", async () => {
		const directCalls: Array<Record<string, unknown>> = [];
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 1 }),
				directIngest: (payload) => {
					directCalls.push(payload);
					return { inserted: 0, skipped: 1 };
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(result.via).toBe("http");
		expect(directCalls).toHaveLength(1);
		expect(boundaryFlushCalls).toHaveLength(1);
		expect(boundaryFlushCalls[0]?.piEvent).toBe("session_before_compact");
	});

	it("leaves a boundary queued when the ingest lock is busy", async () => {
		mkdirSync(sandbox.lockDir);
		writeFileSync(join(sandbox.lockDir, "pid"), String(process.pid), "utf8");
		writeFileSync(join(sandbox.lockDir, "ts"), String(Math.floor(Date.now() / 1000)), "utf8");
		writeFileSync(join(sandbox.lockDir, "owner"), "external-owner", "utf8");

		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact-busy" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => ({ inserted: 0, skipped: 1 }),
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.via).toBe("spool_lock_busy");
		expect(boundaryFlushCalls).toHaveLength(0);
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
	});
});

describe("pi-hook-ingest durability boundary spool", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("retains a boundary without flushing when its direct write fails", async () => {
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "sess-compact-spool" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				directIngest: () => {
					throw new Error("simulated db write failure");
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);

		expect(result.via).toBe("spool");
		expect(boundaryFlushCalls).toHaveLength(0);
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
	});

	it("does not boundary-flush ordinary transcript events", async () => {
		const boundaryFlushCalls: Array<Record<string, unknown>> = [];
		await ingestPiHookPayload(
			{
				piEvent: "message_end",
				sessionId: "sess-msg",
				role: "user",
				text: "hello",
				entryId: "e1",
			},
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 1, skipped: 0 }),
				directIngest: () => {
					throw new Error("direct should not run");
				},
				boundaryFlush: (payload) => {
					boundaryFlushCalls.push(payload);
				},
				resolveDb: () => "/tmp/test.sqlite",
			},
		);
		expect(boundaryFlushCalls).toHaveLength(0);
	});
});

describe("pi-hook-ingest durability viewer-down drain", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("retains queued spool entries without direct fallback when the viewer stays down", async () => {
		const dbPath = join(sandbox.sandboxDir, "fallback.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();

		expect(
			spoolPiHookPayload({
				piEvent: "session_start",
				sessionId: "queued-stream",
				timestamp: "2026-05-29T01:00:00Z",
			}),
		).toBe(true);

		const result = await ingestPiHookPayload(
			{
				piEvent: "message_end",
				sessionId: "current-stream",
				role: "user",
				text: "hello",
				entryId: "e-current",
				timestamp: "2026-05-29T01:01:00Z",
			},
			{ host: "127.0.0.1", port: 38888, db: dbPath },
			{ httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }) },
		);

		expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
		const verify = connect(dbPath);
		try {
			const count = verify.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as {
				count: number;
			};
			expect(count.count).toBe(0);
			const sources = verify
				.prepare("SELECT DISTINCT source AS source FROM raw_events")
				.all() as Array<{ source: string }>;
			expect(sources.map((r) => r.source)).toEqual([]);
		} finally {
			verify.close();
		}
	});
});

describe("pi-hook-ingest queue boundary races", () => {
	let sandbox: ReturnType<typeof installPiIngestSandbox>;
	beforeEach(() => {
		sandbox = installPiIngestSandbox();
	});
	afterEach(() => {
		sandbox.cleanup();
	});

	it("trusts a queued boundary without opening SQLite or flushing locally", async () => {
		const directCalls: string[] = [];
		const flushCalls: string[] = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "queued-boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 0, queued: 1 }),
				directIngest: () => {
					directCalls.push("direct");
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: () => {
					flushCalls.push("flush");
				},
				resolveDb: () => "/tmp/must-not-open.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 0, skipped: 0, via: "http" });
		expect(directCalls).toEqual([]);
		expect(flushCalls).toEqual([]);
		expect(existsSync(sandbox.queueDir)).toBe(false);
	});

	it("does not replay a boundary drained by an earlier lock waiter", async () => {
		expect(spoolPiHookPayload({ piEvent: "session_start", sessionId: "queued" })).toBe(true);
		const directCalls: string[] = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "current-boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => {
					throw new Error("the earlier waiter already drained this receipt");
				},
				directIngest: () => {
					directCalls.push("direct");
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: () => {},
				withLock: async (fn) => {
					await drainPiHookSpool(async () => true);
					return await fn();
				},
				resolveDb: () => "/tmp/must-not-open.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 0, skipped: 0, via: "spool" });
		expect(directCalls).toEqual([]);
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(0);
	});

	it("does not replay an accepted boundary when a concurrent receipt remains", async () => {
		expect(spoolPiHookPayload({ piEvent: "session_start", sessionId: "queued" })).toBe(true);
		let httpCalls = 0;
		const directCalls: string[] = [];
		const result = await ingestPiHookPayload(
			{ piEvent: "session_shutdown", sessionId: "current-boundary" },
			{ host: "127.0.0.1", port: 38888 },
			{
				httpIngest: async () => {
					httpCalls += 1;
					if (httpCalls === 2) {
						expect(spoolPiHookPayload({ piEvent: "session_start", sessionId: "concurrent" })).toBe(
							true,
						);
					}
					return { ok: true, inserted: 0, skipped: 0, queued: 1 };
				},
				directIngest: () => {
					directCalls.push("direct");
					return { inserted: 1, skipped: 0 };
				},
				boundaryFlush: () => {},
				resolveDb: () => "/tmp/must-not-open.sqlite",
			},
		);

		expect(result).toEqual({ inserted: 0, skipped: 0, via: "http" });
		expect(directCalls).toEqual([]);
		expect(readdirSync(sandbox.queueDir).filter((name) => name.endsWith(".json"))).toHaveLength(1);
	});
});
