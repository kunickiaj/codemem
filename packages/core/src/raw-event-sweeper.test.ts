import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	beforeEach(() => {
		prevAutoFlush = process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH;
		prevDebounce = process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS;
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

	it("debounced auto flush advances flush state when enabled", async () => {
		process.env.CODEMEM_RAW_EVENTS_AUTO_FLUSH = "1";
		process.env.CODEMEM_RAW_EVENTS_DEBOUNCE_MS = "0";
		seedSession("sess-auto");
		const sweeper = new RawEventSweeper(store, ingestOpts);

		sweeper.nudge("sess-auto");
		await sleep(100);

		expect(store.rawEventFlushState("sess-auto")).toBe(1);
	});

	it("advances flush cursor when observer output has no storable memories", async () => {
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
		expect(store.latestRawEventFlushFailure("opencode")).toBeNull();
	});
});
