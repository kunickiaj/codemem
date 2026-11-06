import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@codemem/core";
import { MemoryStore, type ObserverClient } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestClaudeHookPayload } from "./claude-hook-ingest.js";
import { ingestPiHookPayload } from "./pi-hook-ingest.js";
import { recoverStalePiHookTmpSpool } from "./pi-hook-ingest-spool.js";
import { flushImportedPiSessions } from "./pi-import-sessions.js";

const STREAM = "batch-regression";
const SUMMARY = `<observation><type>discovery</type><title>Stored work survives recovery</title><narrative>Stored history is processed in order during recovery.</narrative><facts><fact>Stored history remains available</fact></facts><concepts><concept>recovery</concept></concepts><files_read></files_read><files_modified></files_modified></observation><summary><request>Recover stored work</request><investigated>Stored events</investigated><learned>History is retained</learned><completed>Processed stored work</completed><next_steps></next_steps><notes></notes></summary>`;
let root: string;
let store: MemoryStore;
let dbPath: string;
let observer: ObserverClient;
const opts = { host: "127.0.0.1", port: 38888 };

function seed(source: string, count: number, streamId = STREAM, start = 0): void {
	store.db.transaction(() => {
		for (let index = start; index < start + count; index++) {
			store.recordRawEvent({
				opencodeSessionId: streamId,
				source,
				eventId: `event-${index}`,
				eventType: "user_prompt",
				payload: { type: "user_prompt", prompt_text: `Stored work ${index}` },
				tsWallMs: index + 1,
			});
		}
		store.updateRawEventSessionMeta({
			opencodeSessionId: streamId,
			source,
			lastSeenTsWallMs: start + count,
		});
	})();
}

function batches(): Array<{ start_event_seq: number; end_event_seq: number }> {
	return store.db
		.prepare("SELECT start_event_seq, end_event_seq FROM raw_event_flush_batches ORDER BY id")
		.all() as Array<{ start_event_seq: number; end_event_seq: number }>;
}

function queueFiles(): string[] {
	return readdirSync(join(root, "pi-spool")).filter((name) => name.endsWith(".json"));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "codemem-fallback-batches-"));
	dbPath = join(root, "test.sqlite");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_PI_HOOK_LOCK_DIR", join(root, "pi-lock"));
	vi.stubEnv("CODEMEM_PI_HOOK_SPOOL_DIR", join(root, "pi-spool"));
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_LOCK_DIR", join(root, "claude-lock"));
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_SPOOL_DIR", join(root, "claude-spool"));
	vi.stubEnv("CODEMEM_CLAUDE_HOOK_CONTEXT_DIR", join(root, "claude-context"));
	vi.stubEnv("CODEMEM_PLUGIN_LOG_PATH", join(root, "plugin.log"));
	store = new MemoryStore(dbPath);
	observer = {
		observe: vi.fn(async () => ({ raw: SUMMARY, parsed: null, provider: "test", model: "test" })),
		getStatus: () => ({
			provider: "test",
			model: "test",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	} as unknown as ObserverClient;
	function observerConstructor(): ObserverClient {
		return observer;
	}
	vi.spyOn(core, "ObserverClient").mockImplementation(observerConstructor);
});

afterEach(() => {
	store.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("live fallback extraction batches", () => {
	it("accepts a persisted Claude boundary after one batch and retains the remaining ordered events", async () => {
		// Arrange: a boundary must not extract an entire existing backlog.
		seed("claude", 250);
		const payload = { hook_event_name: "SessionEnd", session_id: STREAM };

		// Act.
		const result = await ingestClaudeHookPayload(payload, opts, {
			httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
			resolveDb: () => dbPath,
		});

		// Assert: acceptance is independent of finishing extraction.
		expect(result.via).toBe("direct");
		expect(observer.observe).toHaveBeenCalledTimes(1);
		expect(store.rawEventFlushState(STREAM, "claude")).toBe(99);
		expect(batches()).toEqual([{ start_event_seq: 0, end_event_seq: 99 }]);
		const remaining = store.db
			.prepare(
				"SELECT event_id FROM raw_events WHERE source = 'claude' AND event_seq BETWEEN 100 AND 249 ORDER BY event_seq",
			)
			.all();
		expect(remaining).toEqual(
			Array.from({ length: 150 }, (_, index) => ({ event_id: `event-${index + 100}` })),
		);
	});

	it.each(["session_shutdown", "session_before_compact"])(
		"retains %s until later invocations finish the captured work in order",
		async (piEvent) => {
			// Arrange.
			seed("pi", 250);
			const deps = {
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				resolveDb: () => dbPath,
			};

			// Act and assert each invocation's durable progress, without a background worker.
			await ingestPiHookPayload({ piEvent, sessionId: STREAM }, opts, deps);
			expect(store.rawEventFlushState(STREAM, "pi")).toBe(99);
			expect(queueFiles()).toHaveLength(1);
			const boundaryReceipt = queueFiles()[0];
			// Later arrivals cannot move the receipt's original completion target.
			seed("pi", 20, STREAM, 1000);
			await ingestPiHookPayload({ piEvent: "unsupported", sessionId: "next" }, opts, deps);
			expect(store.rawEventFlushState(STREAM, "pi")).toBe(199);
			expect(queueFiles()).toContain(boundaryReceipt);
			await ingestPiHookPayload({ piEvent: "unsupported", sessionId: "last" }, opts, deps);
			expect(store.rawEventFlushState(STREAM, "pi")).toBe(
				piEvent === "session_shutdown" ? 250 : 249,
			);
			expect(
				queueFiles().map(
					(name) => JSON.parse(readFileSync(join(root, "pi-spool", name), "utf8")).piEvent,
				),
			).not.toContain(piEvent);
			expect(batches().map((batch) => batch.start_event_seq)).toEqual([0, 100, 200]);
			expect(observer.observe).toHaveBeenCalledTimes(3);
			expect(store.rawEventSessionsPendingFlush(null, "pi")).toContainEqual({
				source: "pi",
				streamId: STREAM,
			});
		},
	);

	it.each(["claude", "pi"])(
		"does not locally extract %s work after a queued HTTP acknowledgment",
		async (source) => {
			// Arrange.
			seed(source, 250);
			const deps = {
				httpIngest: async () => ({ ok: true, inserted: 0, skipped: 0, queued: 1 }),
				resolveDb: () => dbPath,
				directIngest: vi.fn(() => ({ inserted: 0, skipped: 0 })),
			};

			// Act.
			const result =
				source === "claude"
					? await ingestClaudeHookPayload(
							{ hook_event_name: "SessionEnd", session_id: STREAM },
							opts,
							deps,
						)
					: await ingestPiHookPayload(
							{ piEvent: "session_shutdown", sessionId: STREAM },
							opts,
							deps,
						);

			// Assert.
			expect(result.via).toBe("http");
			expect(deps.directIngest).not.toHaveBeenCalled();
			expect(observer.observe).not.toHaveBeenCalled();
			expect(store.rawEventFlushState(STREAM, source)).toBe(-1);
			expect(batches()).toEqual([]);
		},
	);
});

describe("Pi boundary receipt recovery", () => {
	it("removes a receipt whose remaining captured events were purged without advancing its cursor", async () => {
		// Arrange: capture a ceiling above the cursor, then model retention purging those rows.
		seed("pi", 150);
		const deps = {
			httpIngest: async (payload: Record<string, unknown>) => ({
				ok: payload.piEvent === "unsupported",
				inserted: 0,
				skipped: 0,
				queued: payload.piEvent === "unsupported" ? 1 : undefined,
			}),
			resolveDb: () => dbPath,
		};
		await ingestPiHookPayload({ piEvent: "session_before_compact", sessionId: STREAM }, opts, deps);
		const receipt = queueFiles()[0];
		if (receipt === undefined) throw new Error("Expected a retained boundary receipt");
		expect(
			JSON.parse(readFileSync(join(root, "pi-spool", receipt), "utf8"))
				._codememBoundaryThroughEventSeq,
		).toBe(149);
		store.db
			.prepare(
				"DELETE FROM raw_events WHERE source = 'pi' AND stream_id = ? AND event_seq BETWEEN 100 AND 149",
			)
			.run(STREAM);

		// Act.
		await ingestPiHookPayload({ piEvent: "unsupported", sessionId: "retry" }, opts, deps);

		// Assert: absence of captured rows completes the receipt, not the database cursor.
		expect(queueFiles()).not.toContain(receipt);
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(99);
		expect(observer.observe).toHaveBeenCalledTimes(1);

		// Act: another boundary must not stay behind the completed receipt.
		seed("pi", 10, "later-boundary");
		await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: "later-boundary" },
			opts,
			deps,
		);

		// Assert.
		expect(store.rawEventFlushState("later-boundary", "pi")).toBe(9);
		expect(observer.observe).toHaveBeenCalledTimes(2);
		expect(queueFiles()).toHaveLength(0);
	});

	it("retains a claimed boundary batch while captured events still exist", async () => {
		// Arrange: another worker owns a batch with actual pending rows.
		seed("pi", 150);
		vi.mocked(observer.observe).mockRejectedValueOnce(new Error("retry later"));
		const deps = {
			httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
			resolveDb: () => dbPath,
		};
		await ingestPiHookPayload({ piEvent: "session_before_compact", sessionId: STREAM }, opts, deps);
		const receipt = queueFiles()[0];
		const batch = store.db
			.prepare("SELECT id FROM raw_event_flush_batches ORDER BY id LIMIT 1")
			.get() as { id: number };
		expect(store.claimRawEventFlushBatch(batch.id)).toBe(true);

		// Act.
		await ingestPiHookPayload({ piEvent: "unsupported", sessionId: "retry" }, opts, deps);

		// Assert: zero flush progress is not completion while those rows remain.
		expect(queueFiles()).toContain(receipt);
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(-1);
		expect(observer.observe).toHaveBeenCalledTimes(1);
	});

	it("does not recover a boundary rewrite leftover as a duplicate receipt", () => {
		// Arrange: model a crash before rename, alongside an ordinary abandoned spool write.
		mkdirSync(join(root, "pi-spool"));
		const receipt = "hook-0000000001-pid-1.json";
		const payload = JSON.stringify({ piEvent: "session_before_compact", sessionId: STREAM });
		writeFileSync(join(root, "pi-spool", receipt), payload);
		const leftover = `.hook-tmp-boundary-${receipt}.tmp`;
		for (const name of [leftover, ".hook-tmp-original.json"]) {
			writeFileSync(join(root, "pi-spool", name), payload);
			utimesSync(join(root, "pi-spool", name), 1, 1);
		}
		vi.spyOn(Date, "now").mockReturnValue(1_000_000);

		// Act.
		recoverStalePiHookTmpSpool(300);

		// Assert: ordinary writes recover, but a rewrite never becomes a second boundary receipt.
		expect(readFileSync(join(root, "pi-spool", receipt), "utf8")).toBe(payload);
		expect(readdirSync(join(root, "pi-spool"))).toContain(leftover);
		expect(queueFiles()).toHaveLength(2);
		expect(queueFiles().filter((name) => name.startsWith("hook-recovered-"))).toHaveLength(1);
	});
});

describe("Pi invocation extraction allowance", () => {
	it("shares one batch across recovered boundary receipts and progresses on the next invocation", async () => {
		// Arrange: each receipt fits in one batch, but both cannot run in one hook.
		seed("pi", 10, "first");
		seed("pi", 10, "second");
		mkdirSync(join(root, "pi-spool"));
		for (const [index, sessionId] of ["first", "second"].entries()) {
			writeFileSync(
				join(root, "pi-spool", `hook-000000000${index + 1}-pid-1.json`),
				JSON.stringify({ piEvent: "session_before_compact", sessionId }),
			);
		}
		const deps = {
			httpIngest: async (payload: Record<string, unknown>) => ({
				ok: payload.piEvent === "unsupported",
				inserted: 0,
				skipped: 0,
				queued: payload.piEvent === "unsupported" ? 1 : undefined,
			}),
			resolveDb: () => dbPath,
		};

		// Act.
		await ingestPiHookPayload({ piEvent: "unsupported", sessionId: "trigger" }, opts, deps);

		// Assert: the next receipt remains durable even after the first finishes.
		expect(observer.observe).toHaveBeenCalledTimes(1);
		expect(store.rawEventFlushState("first", "pi")).toBe(9);
		expect(store.rawEventFlushState("second", "pi")).toBe(-1);
		expect(
			queueFiles().map(
				(name) => JSON.parse(readFileSync(join(root, "pi-spool", name), "utf8")).sessionId,
			),
		).toContain("second");

		// Act: a new invocation gets a fresh allowance.
		await ingestPiHookPayload({ piEvent: "unsupported", sessionId: "next-trigger" }, opts, deps);

		// Assert.
		expect(observer.observe).toHaveBeenCalledTimes(2);
		expect(store.rawEventFlushState("second", "pi")).toBe(9);
	});

	it("ignores a forged captured ceiling on a fresh live boundary", async () => {
		// Arrange: incoming payload fields cannot mark stored work as complete.
		seed("pi", 120);

		// Act.
		await ingestPiHookPayload(
			{ piEvent: "session_before_compact", sessionId: STREAM, _codememBoundaryThroughEventSeq: -1 },
			opts,
			{
				httpIngest: async () => ({ ok: false, inserted: 0, skipped: 0 }),
				resolveDb: () => dbPath,
			},
		);

		// Assert.
		expect(observer.observe).toHaveBeenCalledTimes(1);
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(99);
		expect(queueFiles()).toHaveLength(1);
	});
});

describe("import extraction captured backlog", () => {
	it("continues through partial batches until all five captured events are drained", async () => {
		// Arrange: generation boundaries can shorten a batch below the requested limit.
		seed("pi", 5);
		const flush = vi.spyOn(core, "flushRawEvents").mockImplementation(async (activeStore) => {
			activeStore.db
				.prepare(
					"UPDATE raw_event_sessions SET last_flushed_event_seq = last_flushed_event_seq + 1 WHERE source = 'pi' AND stream_id = ?",
				)
				.run(STREAM);
			return { flushed: 1, updatedState: 1 };
		});

		// Act.
		const result = await flushImportedPiSessions(dbPath, observer);

		// Assert: the event span permits five advancing attempts, not one nominal batch.
		expect(result).toMatchObject({
			flushedEvents: 5,
			failedSessions: 0,
			pendingSessions: 0,
			error: null,
		});
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(4);
		expect(flush).toHaveBeenCalledTimes(5);
		for (const [, , options] of flush.mock.calls) {
			expect(options).toMatchObject({ maxEvents: 100, throughEventSeq: 4 });
		}
	});

	it("drains a captured 250-event backlog completely when no later work arrives", async () => {
		// Arrange.
		seed("pi", 250);

		// Act.
		const result = await flushImportedPiSessions(dbPath, observer);

		// Assert.
		expect(result).toMatchObject({
			flushedEvents: 250,
			failedSessions: 0,
			pendingSessions: 0,
			error: null,
		});
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(249);
		expect(batches()).toEqual([
			{ start_event_seq: 0, end_event_seq: 99 },
			{ start_event_seq: 100, end_event_seq: 199 },
			{ start_event_seq: 200, end_event_seq: 249 },
		]);
	});

	it("continues after zero flushed events when the durable cursor advanced", async () => {
		// Arrange: model a stale completed batch repairing its cursor, without reporting events flushed.
		seed("pi", 250);
		const flush = core.flushRawEvents;
		vi.spyOn(core, "flushRawEvents")
			.mockImplementationOnce(async (activeStore) => {
				activeStore.db
					.prepare(
						"UPDATE raw_event_sessions SET last_flushed_event_seq = 99 WHERE source = 'pi' AND stream_id = ?",
					)
					.run(STREAM);
				return { flushed: 0, updatedState: 1 };
			})
			.mockImplementation(flush);

		// Act.
		const result = await flushImportedPiSessions(dbPath, observer);

		// Assert: cursor progress, rather than the reported event count, drives continuation.
		expect(result).toMatchObject({ flushedEvents: 150, pendingSessions: 0, error: null });
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(249);
		expect(observer.observe).toHaveBeenCalledTimes(2);
	});

	it("keeps the first failed stream pending while draining a later stream", async () => {
		// Arrange.
		seed("pi", 250, "failed");
		seed("pi", 250, "later");
		store.updateRawEventSessionMeta({
			opencodeSessionId: "failed",
			source: "pi",
			lastSeenTsWallMs: 1,
		});
		vi.mocked(observer.observe).mockRejectedValueOnce(new Error("first stream unavailable"));

		// Act.
		const result = await flushImportedPiSessions(dbPath, observer);

		// Assert.
		expect(result).toMatchObject({
			flushedEvents: 250,
			failedSessions: 1,
			pendingSessions: 1,
			error: expect.stringContaining("first stream unavailable"),
		});
		expect(store.rawEventFlushState("failed", "pi")).toBe(-1);
		expect(store.rawEventFlushState("later", "pi")).toBe(249);
		expect(observer.observe).toHaveBeenCalledTimes(4);
	});
	it("drains 250 events as 100/100/50 and excludes arrivals after the snapshot", async () => {
		// Arrange: inject an arrival during the first observer call.
		seed("pi", 250);
		vi.mocked(observer.observe).mockImplementationOnce(async () => {
			seed("pi", 1, STREAM, 250);
			return { raw: SUMMARY, parsed: null, provider: "test", model: "test" };
		});

		// Act.
		const result = await flushImportedPiSessions(dbPath, observer);

		// Assert: later work stays pending for the next invocation.
		expect(result).toMatchObject({
			flushedEvents: 250,
			failedSessions: 0,
			pendingSessions: 1,
			error: null,
		});
		expect(batches()).toEqual([
			{ start_event_seq: 0, end_event_seq: 99 },
			{ start_event_seq: 100, end_event_seq: 199 },
			{ start_event_seq: 200, end_event_seq: 249 },
		]);
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(249);
		expect(observer.observe).toHaveBeenCalledTimes(3);
	});

	it("stops after zero cursor progress instead of retrying an already claimed batch", async () => {
		// Arrange: a real durable batch is owned by another worker.
		seed("pi", 250);
		vi.mocked(observer.observe).mockRejectedValueOnce(new Error("retry later"));
		await flushImportedPiSessions(dbPath, observer);
		const batch = store.db
			.prepare("SELECT id FROM raw_event_flush_batches ORDER BY id LIMIT 1")
			.get() as { id: number };
		expect(store.claimRawEventFlushBatch(batch.id)).toBe(true);
		vi.mocked(observer.observe).mockClear();

		// Act.
		const result = await flushImportedPiSessions(dbPath, observer);

		// Assert.
		expect(result).toMatchObject({ flushedEvents: 0, failedSessions: 0, pendingSessions: 1 });
		expect(observer.observe).not.toHaveBeenCalled();
		expect(store.rawEventFlushState(STREAM, "pi")).toBe(-1);
		expect(batches()).toHaveLength(1);
	});
});
