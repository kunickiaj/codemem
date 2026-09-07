import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "./db.js";
import type { IngestOptions } from "./ingest-pipeline.js";
import { RawEventSweeper } from "./raw-event-sweeper.js";
import { MemoryStore } from "./store.js";
import { initTestSchema } from "./test-utils.js";

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("RawEventSweeper auto flush", () => {
	let tmpDir: string;
	let dbPath: string;
	let store: MemoryStore;
	let prevAutoFlush: string | undefined;
	let prevDebounce: string | undefined;
	let prevWorkerMaxEvents: string | undefined;
	let prevSweeper: string | undefined;

	beforeEach(() => {
		prevAutoFlush = process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		prevDebounce = process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS;
		prevWorkerMaxEvents = process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS;
		prevSweeper = process.env.CODEMEM_RAW_EVENTS_SWEEPER;
		tmpDir = mkdtempSync(join(tmpdir(), "codemem-raw-event-sweeper-test-"));
		dbPath = join(tmpDir, "test.sqlite");
		const db = connect(dbPath);
		initTestSchema(db);
		db.close();
		store = new MemoryStore(dbPath);
	});

	afterEach(() => {
		store.close();
		if (prevAutoFlush == null) delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		else process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = prevAutoFlush;
		if (prevDebounce == null) delete process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS;
		else process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = prevDebounce;
		if (prevWorkerMaxEvents == null) delete process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS;
		else process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS = prevWorkerMaxEvents;
		if (prevSweeper == null) delete process.env.CODEMEM_RAW_EVENTS_SWEEPER;
		else process.env.CODEMEM_RAW_EVENTS_SWEEPER = prevSweeper;
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function seedSession(sessionId: string) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-0",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "Hello from auto flush" },
			tsWallMs: 100,
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-1",
			eventType: "tool.execute.after",
			payload: {
				type: "tool.execute.after",
				tool: "read",
				args: { filePath: "x" },
			},
			tsWallMs: 200,
		});
		store.updateRawEventSessionMeta({
			opencodeSessionId: sessionId,
			cwd: tmpDir,
			project: "codemem",
			startedAt: "2026-01-01T00:00:00Z",
			lastSeenTsWallMs: 200,
		});
	}

	function seedLifecycleOnlySession(sessionId: string) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-0",
			eventType: "session.started",
			payload: { type: "session.started" },
			tsWallMs: 100,
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-1",
			eventType: "session.idle",
			payload: { type: "session.idle" },
			tsWallMs: 150,
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			eventId: "evt-2",
			eventType: "session.ended",
			payload: { type: "session.ended" },
			tsWallMs: 200,
		});
		store.updateRawEventSessionMeta({
			opencodeSessionId: sessionId,
			cwd: tmpDir,
			project: "codemem",
			startedAt: "2026-01-01T00:00:00Z",
			lastSeenTsWallMs: 200,
		});
	}

	function seedAdapterPromptSession(sessionId: string) {
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			source: "claude",
			eventId: "evt-0",
			eventType: "claude.hook",
			payload: {
				type: "claude.hook",
				_adapter: {
					schema_version: "1.0",
					source: "claude",
					session_id: sessionId,
					event_id: "evt-0",
					event_type: "prompt",
					payload: { text: "Investigate a real issue", prompt_number: 1 },
					ts: "2026-01-01T00:00:00Z",
				},
			},
			tsWallMs: 100,
		});
		store.recordRawEvent({
			opencodeSessionId: sessionId,
			source: "claude",
			eventId: "evt-1",
			eventType: "claude.hook",
			payload: {
				type: "claude.hook",
				_adapter: {
					schema_version: "1.0",
					source: "claude",
					session_id: sessionId,
					event_id: "evt-1",
					event_type: "assistant",
					payload: { text: "I found the likely root cause." },
					ts: "2026-01-01T00:00:01Z",
				},
			},
			tsWallMs: 150,
		});
		store.updateRawEventSessionMeta({
			opencodeSessionId: sessionId,
			source: "claude",
			cwd: tmpDir,
			project: "codemem",
			startedAt: "2026-01-01T00:00:00Z",
			lastSeenTsWallMs: 150,
		});
	}

	const ingestOpts: IngestOptions = {
		observer: {
			observe: async () => ({
				raw: `<summary>
  <request>Auto flush request</request>
  <completed>Flushed debounced raw events</completed>
</summary>`,
				parsed: null,
				provider: "test",
				model: "test",
			}),
			getStatus: () => ({
				provider: "test",
				model: "test",
				runtime: "api_http",
				auth: { source: "test", type: "api_direct", hasToken: true },
			}),
		} as never,
	};
	it("suppresses auto flush during auth backoff after an auth failure", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-auth");
		let calls = 0;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					calls += 1;
					const { ObserverAuthError } = await import("./observer-client.js");
					throw new ObserverAuthError("auth failed");
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-auth");
		await sleep(50);
		sweeper.nudge("sess-auth");
		await sleep(50);

		expect(calls).toBe(1);
	});

	it("waits for active auto flush work during stop", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-stop");
		let resolved = false;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					await sleep(80);
					resolved = true;
					return {
						raw: `<summary><request>stop</request><completed>done</completed></summary>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-stop");
		await sweeper.stop();

		expect(resolved).toBe(true);
		expect(store.rawEventFlushState("sess-stop")).toBe(1);
	});

	it("does not reschedule pending auto flush work after stop begins", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-stop-pending");
		let releaseFirst: (() => void) | undefined;
		let observeCalls = 0;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					observeCalls += 1;
					if (observeCalls === 1) {
						await new Promise<void>((resolve) => {
							releaseFirst = resolve;
						});
					}
					return {
						raw: `<summary><request>stop pending</request><completed>done</completed></summary>
<observation><type>bugfix</type><title>Stop pending</title><narrative>Pending stop work completed.</narrative></observation>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-stop-pending");
		await vi.waitFor(() => expect(observeCalls).toBe(1));
		store.recordRawEvent({
			opencodeSessionId: "sess-stop-pending",
			eventId: "evt-pending",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "defer until restart" },
			tsWallMs: 300,
		});
		sweeper.nudge("sess-stop-pending");
		const stopping = sweeper.stop();
		releaseFirst?.();
		await stopping;
		await sleep(20);

		expect(observeCalls).toBe(1);
		expect(store.rawEventFlushState("sess-stop-pending")).toBe(1);
	});

	it("re-enables auto flush nudges after restart when the periodic sweeper is disabled", async () => {
		process.env.CODEMEM_RAW_EVENTS_SWEEPER = "0";
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-restart-auto");
		const sweeper = new RawEventSweeper(store, ingestOpts);

		await sweeper.stop();
		sweeper.start();
		sweeper.nudge("sess-restart-auto");
		await vi.waitFor(() => expect(store.rawEventFlushState("sess-restart-auto")).toBe(1));

		await sweeper.stop();
	});

	it("requeues activity that arrives during an active auto flush", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-rerun");
		let firstCall = true;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					if (firstCall) {
						firstCall = false;
						store.recordRawEvent({
							opencodeSessionId: "sess-rerun",
							eventId: "evt-2",
							eventType: "tool.execute.after",
							payload: {
								type: "tool.execute.after",
								tool: "read",
								args: { filePath: "y" },
							},
							tsWallMs: 300,
						});
						store.updateRawEventSessionMeta({
							opencodeSessionId: "sess-rerun",
							cwd: tmpDir,
							project: "codemem",
							startedAt: "2026-01-01T00:00:00Z",
							lastSeenTsWallMs: 300,
						});
						sweeper.nudge("sess-rerun");
						await sleep(60);
					}
					return {
						raw: `<summary><request>rerun</request><completed>done</completed></summary>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-rerun");
		await sleep(220);

		expect(store.rawEventFlushState("sess-rerun")).toBe(2);
	});

	it("does not auto flush when auto flush is disabled", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		seedSession("sess-disabled");
		const sweeper = new RawEventSweeper(store, ingestOpts);

		sweeper.nudge("sess-disabled");
		await sleep(150);

		expect(store.rawEventFlushState("sess-disabled")).toBe(-1);
	});

	it("awaits explicit boundary flushes even when auto flush is disabled", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		seedSession("sess-boundary");
		let releaseObserver: (() => void) | undefined;
		const observerBlocked = new Promise<void>((resolve) => {
			releaseObserver = resolve;
		});
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					await observerBlocked;
					return {
						raw: `<summary><request>boundary</request><completed>flushed</completed></summary>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		let completed = false;
		const flushing = sweeper.flushBoundary("sess-boundary").then(() => {
			completed = true;
		});
		await sleep(20);
		expect(completed).toBe(false);
		releaseObserver?.();
		await flushing;

		expect(store.rawEventFlushState("sess-boundary")).toBe(1);
	});

	it("drains every capped batch during an explicit boundary flush", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS = "2";
		seedSession("sess-boundary-batches");
		for (let index = 2; index < 5; index += 1) {
			store.recordRawEvent({
				opencodeSessionId: "sess-boundary-batches",
				eventId: `evt-${index}`,
				eventType: "assistant_message",
				payload: { type: "assistant_message", assistant_text: `message ${index}` },
				tsWallMs: (index + 1) * 100,
			});
		}

		const sweeper = new RawEventSweeper(store, ingestOpts);
		await sweeper.flushBoundary("sess-boundary-batches");

		expect(store.rawEventFlushState("sess-boundary-batches")).toBe(4);
	});

	it("stops draining after the event visible at the explicit boundary", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS = "2";
		seedSession("sess-boundary-snapshot");
		let observeCalls = 0;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					observeCalls += 1;
					if (observeCalls === 1) {
						store.recordRawEvent({
							opencodeSessionId: "sess-boundary-snapshot",
							eventId: "evt-after-boundary",
							eventType: "assistant_message",
							payload: { type: "assistant_message", assistant_text: "arrived later" },
							tsWallMs: 300,
						});
					}
					return {
						raw: `<summary><request>snapshot</request><completed>flushed</completed></summary>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		await sweeper.flushBoundary("sess-boundary-snapshot");

		expect(store.rawEventFlushState("sess-boundary-snapshot")).toBe(1);
		expect(store.rawEventsSinceBySeq("sess-boundary-snapshot", "opencode", 1)).toHaveLength(1);
	});

	it("waits for an in-flight boundary flush during shutdown", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		seedSession("sess-boundary-stop");
		let releaseObserver: (() => void) | undefined;
		const observerBlocked = new Promise<void>((resolve) => {
			releaseObserver = resolve;
		});
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					await observerBlocked;
					return {
						raw: `<summary><request>stop</request><completed>flushed</completed></summary>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		const boundary = sweeper.flushBoundary("sess-boundary-stop");
		await sleep(20);
		let stopped = false;
		const stopping = sweeper.stop().then(() => {
			stopped = true;
		});
		await sleep(20);
		expect(stopped).toBe(false);
		releaseObserver?.();
		await Promise.all([boundary, stopping]);

		expect(stopped).toBe(true);
		expect(store.rawEventFlushState("sess-boundary-stop")).toBe(1);
	});

	it("waits for an active sweep before flushing a newly arrived boundary event", async () => {
		delete process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		seedSession("sess-boundary-race");
		const releases: Array<() => void> = [];
		let observeCalls = 0;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					observeCalls += 1;
					const call = observeCalls;
					await new Promise<void>((resolve) => releases.push(resolve));
					return {
						raw: `<summary>
  <request>Boundary race request ${call}</request>
  <completed>Flushed boundary race ${call}</completed>
</summary>
<observation>
  <type>bugfix</type>
  <title>Boundary race ${call} preserved</title>
  <narrative>The per-session flush lock preserved the newly arrived event during pass ${call}.</narrative>
</observation>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		const tick = sweeper.tick();
		await vi.waitFor(() => expect(observeCalls).toBe(1));
		store.recordRawEvent({
			opencodeSessionId: "sess-boundary-race",
			eventId: "evt-boundary",
			eventType: "user_prompt",
			payload: {
				type: "user_prompt",
				prompt_text: "Investigate the raw event boundary flush race and preserve every event",
			},
			tsWallMs: 300,
		});
		let boundaryCompleted = false;
		const boundary = sweeper.flushBoundary("sess-boundary-race").then(() => {
			boundaryCompleted = true;
		});
		expect(boundaryCompleted).toBe(false);
		store.recordRawEvent({
			opencodeSessionId: "sess-boundary-race",
			eventId: "evt-after-boundary",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "arrived after the boundary" },
			tsWallMs: 400,
		});

		releases.shift()?.();
		await vi.waitFor(() => expect(observeCalls).toBe(2));
		expect(boundaryCompleted).toBe(false);
		releases.shift()?.();
		await Promise.all([tick, boundary]);

		expect(boundaryCompleted).toBe(true);
		expect(store.rawEventFlushState("sess-boundary-race")).toBe(2);
		expect(store.rawEventsSinceBySeq("sess-boundary-race", "opencode", 2)).toHaveLength(1);
	});

	it("prioritizes a waiting boundary over pending zero-debounce auto flush work", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-boundary-priority");
		const releases: Array<() => void> = [];
		let observeCalls = 0;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					observeCalls += 1;
					const call = observeCalls;
					await new Promise<void>((resolve) => releases.push(resolve));
					return {
						raw: `<summary><request>priority ${call}</request><completed>flushed</completed></summary>
<observation><type>bugfix</type><title>Priority ${call}</title><narrative>Boundary priority pass ${call} completed.</narrative></observation>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-boundary-priority");
		await vi.waitFor(() => expect(observeCalls).toBe(1));
		store.recordRawEvent({
			opencodeSessionId: "sess-boundary-priority",
			eventId: "evt-boundary",
			eventType: "user_prompt",
			payload: { type: "user_prompt", prompt_text: "Flush through this boundary" },
			tsWallMs: 300,
		});
		sweeper.nudge("sess-boundary-priority");
		let boundaryFlushState = -1;
		const boundary = sweeper.flushBoundary("sess-boundary-priority").then(() => {
			boundaryFlushState = store.rawEventFlushState("sess-boundary-priority");
		});
		store.recordRawEvent({
			opencodeSessionId: "sess-boundary-priority",
			eventId: "evt-after-boundary",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "arrived after the boundary" },
			tsWallMs: 400,
		});

		releases.shift()?.();
		await vi.waitFor(() => expect(observeCalls).toBe(2));
		releases.shift()?.();
		await boundary;

		expect(boundaryFlushState).toBe(2);
		await vi.waitFor(() => expect(observeCalls).toBe(3));
		releases.shift()?.();
		await sweeper.stop();
		expect(store.rawEventFlushState("sess-boundary-priority")).toBe(3);
	});

	it("debounced auto flush advances flush state when enabled", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-auto");
		const sweeper = new RawEventSweeper(store, ingestOpts);

		sweeper.nudge("sess-auto");
		await sleep(100);

		expect(store.rawEventFlushState("sess-auto")).toBe(1);
	});

	it("does not postpone debounced auto flush forever during continued activity", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "40";
		seedSession("sess-bounded-debounce");
		const sweeper = new RawEventSweeper(store, ingestOpts);

		sweeper.nudge("sess-bounded-debounce");
		await sleep(20);
		store.recordRawEvent({
			opencodeSessionId: "sess-bounded-debounce",
			eventId: "evt-2",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "still active" },
			tsWallMs: 300,
		});
		store.updateRawEventSessionMeta({
			opencodeSessionId: "sess-bounded-debounce",
			cwd: tmpDir,
			project: "codemem",
			startedAt: "2026-01-01T00:00:00Z",
			lastSeenTsWallMs: 300,
		});
		sweeper.nudge("sess-bounded-debounce");
		await sleep(70);

		expect(store.rawEventFlushState("sess-bounded-debounce")).toBeGreaterThanOrEqual(1);
	});

	it("flushes active sessions in smaller batches by default", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		process.env.CODEMEM_RAW_EVENTS_WORKER_MAX_EVENTS = "2";
		seedSession("sess-small-batches");
		store.recordRawEvent({
			opencodeSessionId: "sess-small-batches",
			eventId: "evt-2",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "a" },
			tsWallMs: 300,
		});
		store.recordRawEvent({
			opencodeSessionId: "sess-small-batches",
			eventId: "evt-3",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "b" },
			tsWallMs: 400,
		});
		store.recordRawEvent({
			opencodeSessionId: "sess-small-batches",
			eventId: "evt-4",
			eventType: "assistant_message",
			payload: { type: "assistant_message", assistant_text: "c" },
			tsWallMs: 500,
		});
		store.updateRawEventSessionMeta({
			opencodeSessionId: "sess-small-batches",
			cwd: tmpDir,
			project: "codemem",
			startedAt: "2026-01-01T00:00:00Z",
			lastSeenTsWallMs: 500,
		});

		const sweeper = new RawEventSweeper(store, ingestOpts);
		sweeper.nudge("sess-small-batches");
		await sleep(120);

		expect(store.rawEventFlushState("sess-small-batches")).toBe(1);
	});

	it("terminally completes low-signal skip_summary batches and advances the flush cursor", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-low-signal");

		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => ({
					raw: '<skip_summary reason="low-signal"/>',
					parsed: null,
					provider: "test",
					model: "test",
				}),
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-low-signal");
		await sleep(150);

		expect(store.rawEventFlushState("sess-low-signal")).toBe(1);
		expect(store.latestRawEventFlushFailure("opencode")?.stream_id).not.toBe("sess-low-signal");
	});

	it("records observer diagnostics for failed raw-event flushes", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-failed-diagnostics");

		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => ({
					raw: null,
					parsed: null,
					provider: "openai",
					model: "gpt-5.4-mini",
				}),
				getStatus: () => ({
					provider: "openai",
					model: "gpt-5.4-mini",
					runtime: "api_http",
					auth: { source: "oauth", type: "codex_consumer", hasToken: true },
					lastError: {
						code: "empty_response",
						message: "OpenAI returned 200 but response contained no extractable text.",
					},
				}),
			} as never,
		});

		sweeper.nudge("sess-failed-diagnostics");
		await sleep(150);

		const failure = store.latestRawEventFlushFailure("opencode");
		expect(failure?.stream_id).toBe("sess-failed-diagnostics");
		expect(failure).toMatchObject({
			observer_provider: "openai",
			observer_model: "gpt-5.4-mini",
			observer_runtime: "api_http",
			observer_auth_source: "oauth",
			observer_auth_type: "codex_consumer",
			observer_error_code: "empty_response",
			observer_error_message: "OpenAI returned 200 but response contained no extractable text.",
			error_message: "OpenAI returned no usable output for raw-event processing.",
		});
	});

	it("terminally skips tiny lifecycle-only sessions without calling the observer", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedLifecycleOnlySession("sess-lifecycle-only");

		let observerCalls = 0;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					observerCalls += 1;
					return {
						raw: '<skip_summary reason="low-signal"/>',
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-lifecycle-only");
		await sleep(150);

		expect(observerCalls).toBe(0);
		expect(store.rawEventFlushState("sess-lifecycle-only")).toBe(2);
		expect(store.latestRawEventFlushFailure("opencode")?.stream_id).not.toBe("sess-lifecycle-only");
	});

	it("resolves retentionMs: explicit config wins, legacy env only as absent-fallback", () => {
		const prevEnabled = process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED;
		const prevMaxAge = process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS;
		const prevLegacy = process.env.CODEMEM_RAW_EVENTS_RETENTION_MS;
		// Isolate from any developer config file influence.
		const prevConfig = process.env.CODEMEM_CONFIG;
		process.env.CODEMEM_CONFIG = join(tmpDir, "no-such-config.json");
		// Access the private retentionMs() for direct assertion.
		const retentionMs = (s: RawEventSweeper) =>
			(s as unknown as { retentionMs(): number }).retentionMs();
		const sweeper = new RawEventSweeper(store, ingestOpts);
		try {
			// 1. New config keys: enabled + max_age_days => days * 86_400_000.
			delete process.env.CODEMEM_RAW_EVENTS_RETENTION_MS;
			process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED = "1";
			process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS = "30";
			expect(retentionMs(sweeper)).toBe(30 * 86_400_000);

			// 2. New key ABSENT => fall back to the legacy CODEMEM_RAW_EVENTS_RETENTION_MS env var.
			delete process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED;
			delete process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS;
			process.env.CODEMEM_RAW_EVENTS_RETENTION_MS = "123456";
			expect(retentionMs(sweeper)).toBe(123456);

			// 2b. EXPLICIT disable (enabled=0) is authoritative over a stale legacy
			// env var: retention stays off rather than silently honoring the legacy value.
			process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED = "0";
			expect(retentionMs(sweeper)).toBe(0);
			delete process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED;

			// 3. Neither set => 0 (no retention).
			delete process.env.CODEMEM_RAW_EVENTS_RETENTION_MS;
			expect(retentionMs(sweeper)).toBe(0);
		} finally {
			if (prevEnabled == null) delete process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED;
			else process.env.CODEMEM_RAW_EVENTS_RETENTION_ENABLED = prevEnabled;
			if (prevMaxAge == null) delete process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS;
			else process.env.CODEMEM_RAW_EVENTS_RETENTION_MAX_AGE_DAYS = prevMaxAge;
			if (prevLegacy == null) delete process.env.CODEMEM_RAW_EVENTS_RETENTION_MS;
			else process.env.CODEMEM_RAW_EVENTS_RETENTION_MS = prevLegacy;
			if (prevConfig == null) delete process.env.CODEMEM_CONFIG;
			else process.env.CODEMEM_CONFIG = prevConfig;
		}
	});

	it("does not terminally skip adapter-wrapped prompt sessions", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedAdapterPromptSession("sess-adapter-prompt");

		let observerCalls = 0;
		const sweeper = new RawEventSweeper(store, {
			observer: {
				observe: async () => {
					observerCalls += 1;
					return {
						raw: `<summary><request>Investigate a real issue</request><completed>Captured adapter wrapped session.</completed></summary>`,
						parsed: null,
						provider: "test",
						model: "test",
					};
				},
				getStatus: () => ({
					provider: "test",
					model: "test",
					runtime: "api_http",
					auth: { source: "test", type: "api_direct", hasToken: true },
				}),
			} as never,
		});

		sweeper.nudge("sess-adapter-prompt", "claude");
		await sleep(150);

		expect(observerCalls).toBe(1);
		expect(store.rawEventFlushState("sess-adapter-prompt", "claude")).toBe(1);
	});
});
