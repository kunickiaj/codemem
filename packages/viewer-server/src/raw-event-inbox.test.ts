import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestRawEvents, MemoryStore } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import {
	createViewerRawEventInbox,
	FileRawEventInbox,
	RAW_EVENT_INBOX_FULL_CODE,
} from "./raw-event-inbox.js";
import { currentIdentityTarget } from "./routes/target-validation.js";

const cleanupDirectories: string[] = [];

function testDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "codemem-raw-event-inbox-"));
	cleanupDirectories.push(directory);
	return directory;
}

function postRawEvent(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
	return app.request("/api/raw-events", {
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:38888" },
		body: JSON.stringify(body),
	});
}

afterEach(() => {
	for (const directory of cleanupDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("FileRawEventInbox", () => {
	it("acknowledges the durable append before asynchronous processing", async () => {
		const processed: string[] = [];
		let releaseProcessing: (() => void) | undefined;
		const processingBlocked = new Promise<void>((resolve) => {
			releaseProcessing = resolve;
		});
		const inbox = new FileRawEventInbox({
			directory: testDirectory(),
			processEntry: async ({ request }) => {
				await processingBlocked;
				processed.push(String(request.event_id));
			},
		});

		await inbox.enqueue({ event_id: "event-1" });
		expect(processed).toEqual([]);
		expect(await inbox.status()).toMatchObject({ pending: 1, corrupt: 0 });

		releaseProcessing?.();
		await vi.waitFor(async () => expect((await inbox.status()).pending).toBe(0));
		expect(processed).toEqual(["event-1"]);
		await inbox.stop();
	});

	it("deduplicates identical queued requests", async () => {
		const processEntry = vi.fn().mockResolvedValue(undefined);
		const inbox = new FileRawEventInbox({
			directory: testDirectory(),
			processEntry,
		});
		const request = { event_id: "event-duplicate", payload: { text: "same" } };

		await inbox.enqueue(request);
		await inbox.enqueue(request);
		await vi.waitFor(() => expect(processEntry).toHaveBeenCalledOnce());
		await vi.waitFor(async () => expect((await inbox.status()).pending).toBe(0));
		await inbox.stop();
	});

	it("drains retained entries after restart", async () => {
		const directory = testDirectory();
		const firstProcess = vi.fn().mockResolvedValue(undefined);
		const first = new FileRawEventInbox({ directory, processEntry: firstProcess });
		await first.enqueue({ event_id: "event-restart" });
		await first.stop();
		expect(firstProcess).not.toHaveBeenCalled();
		expect((await first.status()).pending).toBe(1);

		const secondProcess = vi.fn().mockResolvedValue(undefined);
		const second = new FileRawEventInbox({ directory, processEntry: secondProcess });
		second.start();
		await vi.waitFor(() => expect(secondProcess).toHaveBeenCalledOnce());
		await vi.waitFor(async () => expect((await second.status()).pending).toBe(0));
		await second.stop();
	});

	it("preserves enqueue order when retained file timestamps collide", async () => {
		const directory = testDirectory();
		const writer = new FileRawEventInbox({
			directory,
			processEntry: vi.fn().mockResolvedValue(undefined),
		});
		await writer.stop();
		await writer.enqueue({ event_id: "event-second" });
		await writer.enqueue({ event_id: "event-first" });
		const restartedWriter = new FileRawEventInbox({
			directory,
			processEntry: vi.fn().mockResolvedValue(undefined),
		});
		await restartedWriter.stop();
		await restartedWriter.enqueue({ event_id: "event-third" });
		const sameTimestamp = new Date("2026-09-17T12:00:00.000Z");
		for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json"))) {
			utimesSync(join(directory, name), sameTimestamp, sameTimestamp);
		}

		const processed: string[] = [];
		const reader = new FileRawEventInbox({
			directory,
			processEntry: async ({ request }) => {
				processed.push(String(request.event_id));
			},
		});
		reader.start();

		await vi.waitFor(async () => expect((await reader.status()).pending).toBe(0));
		expect(processed).toEqual(["event-second", "event-first", "event-third"]);
		await reader.stop();
	});

	it("enforces the entry limit across concurrent appends", async () => {
		const inbox = new FileRawEventInbox({
			directory: testDirectory(),
			maxEntries: 1,
			processEntry: vi.fn().mockResolvedValue(undefined),
		});

		const results = await Promise.allSettled([
			inbox.enqueue({ event_id: "event-capacity-a" }),
			inbox.enqueue({ event_id: "event-capacity-b" }),
		]);

		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const rejected = results.find((result) => result.status === "rejected");
		expect(rejected).toMatchObject({
			status: "rejected",
			reason: { code: RAW_EVENT_INBOX_FULL_CODE },
		});
		expect((await inbox.status()).pending).toBe(1);
		await inbox.stop();
	});
});

describe("queue-first raw-event routes", () => {
	it("returns 202 after a durable append without waiting for SQLite ingestion", async () => {
		const root = testDirectory();
		const store = new MemoryStore(join(root, "mem.sqlite"));
		let releaseProcessing: (() => void) | undefined;
		const processingBlocked = new Promise<void>((resolve) => {
			releaseProcessing = resolve;
		});
		const inbox = new FileRawEventInbox({
			directory: join(root, "inbox"),
			processEntry: async ({ request }) => {
				await processingBlocked;
				ingestRawEvents(store, request);
			},
		});
		const app = createApp({ storeFactory: () => store, rawEventInbox: inbox });
		try {
			const response = await postRawEvent(app, {
				session_id: "session-queued",
				event_id: "event-queued",
				event_type: "prompt",
				payload: { text: "queued before SQLite" },
			});

			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({ accepted: 1, queued: 1 });
			expect((await inbox.status()).pending).toBe(1);
			releaseProcessing?.();
			await vi.waitFor(() => {
				const row = store.db.prepare("SELECT COUNT(*) AS count FROM raw_events").get() as {
					count: number;
				};
				expect(row.count).toBe(1);
			});
		} finally {
			releaseProcessing?.();
			await inbox.stop();
			store.close();
		}
	});

	it("serves queue readiness without opening SQLite", async () => {
		const storeFactory = vi.fn(() => {
			throw new Error("status probe must not open SQLite");
		});
		const inbox = { enqueue: vi.fn(), start: vi.fn(), status: vi.fn(), stop: vi.fn() };
		const app = createApp({ storeFactory, rawEventInbox: inbox });

		const response = await app.request("/api/raw-events/status?limit=0");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ingest: { available: true, mode: "durable_queue" },
		});
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it("validates targeted queue requests without opening SQLite", async () => {
		const storeFactory = vi.fn(() => {
			throw new Error("queued request must not open SQLite");
		});
		const inbox = {
			enqueue: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(),
			status: vi.fn(),
			stop: vi.fn(),
		};
		const app = createApp({
			storeFactory,
			rawEventInbox: inbox,
			rawEventTarget: {
				dbPath: "/expected/memory.sqlite",
				hasCurrentIdentity: () => true,
			},
		});

		const response = await postRawEvent(app, {
			db_path: "/expected/memory.sqlite",
			identity_target: currentIdentityTarget(),
			session_id: "session-targeted-queue",
			event_id: "event-targeted-queue",
			event_type: "prompt",
			payload: {
				text: "queued <private>secret text</private> without SQLite",
				api_key: "secret key",
			},
		});

		expect(response.status).toBe(202);
		expect(inbox.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: { text: "queued  without SQLite", api_key: "[REDACTED]" },
			}),
			{ flushBoundary: false },
		);
		expect(storeFactory).not.toHaveBeenCalled();
	});

	it.each([
		["raw_event_inbox_full", "raw_event_queue_full"],
		["EACCES", "raw_event_queue_write_failed"],
	])("returns a bounded queue error for %s", async (causeCode, responseCode) => {
		const sensitive = "/private/home/user/.codemem/viewer-raw-event-inbox";
		const error = Object.assign(new Error(`failed at ${sensitive}`), { code: causeCode });
		const inbox = {
			enqueue: vi.fn().mockRejectedValue(error),
			start: vi.fn(),
			status: vi.fn(),
			stop: vi.fn(),
		};
		const app = createApp({
			storeFactory: vi.fn(),
			rawEventInbox: inbox,
			rawEventTarget: {
				dbPath: "/expected/memory.sqlite",
				hasCurrentIdentity: () => true,
			},
		});

		const response = await postRawEvent(app, {
			session_id: "session-queue-error",
			event_id: "event-queue-error",
			event_type: "prompt",
			payload: { text: "private payload" },
		});
		const body = JSON.stringify(await response.json());

		expect(response.status).toBe(503);
		expect(body).toContain(responseCode);
		expect(body).not.toContain(sensitive);
		expect(body).not.toContain("private payload");
	});
});

describe("queued raw-event validation", () => {
	it("queues per-event streams when the unused request default is unusable", async () => {
		const inbox = {
			enqueue: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(),
			status: vi.fn(),
			stop: vi.fn(),
		};
		const app = createApp({
			storeFactory: vi.fn(),
			rawEventInbox: inbox,
			rawEventTarget: { dbPath: "/expected/memory.sqlite", hasCurrentIdentity: () => true },
		});

		const response = await postRawEvent(app, {
			session_id: "msg_request_default",
			events: [
				{
					session_id: "session-event-queue",
					event_id: "event-valid-queue",
					event_type: "prompt",
					payload: {},
				},
			],
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ accepted: 1, queued: 1 });
		expect(inbox.enqueue).toHaveBeenCalledOnce();
	});

	it("maps validation failures to a bounded 400 response", async () => {
		const inbox = {
			enqueue: vi.fn().mockResolvedValue(undefined),
			start: vi.fn(),
			status: vi.fn(),
			stop: vi.fn(),
		};
		const app = createApp({
			storeFactory: vi.fn(),
			rawEventInbox: inbox,
			rawEventTarget: { dbPath: "/expected/memory.sqlite", hasCurrentIdentity: () => true },
		});

		const response = await postRawEvent(app, {
			session_id: "session-invalid-queue",
			event_id: "event-invalid-queue",
			event_type: "prompt",
			payload: ["invalid"],
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "payload must be an object" });
		expect(inbox.enqueue).not.toHaveBeenCalled();
	});
});

describe("FileRawEventInbox recovery", () => {
	it("reports and clears a sustained backlog without exposing entries", async () => {
		let available = false;
		const onBacklog = vi.fn();
		const onBacklogRecovered = vi.fn();
		const inbox = new FileRawEventInbox({
			directory: testDirectory(),
			backlogWarningAgeMs: 1,
			backlogWarningEntries: 1,
			onBacklog,
			onBacklogRecovered,
			retryDelayMs: 10,
			processEntry: async () => {
				if (!available) throw new Error("database busy");
			},
		});
		await inbox.enqueue({ event_id: "private-backlog-event" });

		await vi.waitFor(() => expect(onBacklog).toHaveBeenCalledWith(1, expect.any(Number)));
		available = true;
		await vi.waitFor(() => expect(onBacklogRecovered).toHaveBeenCalledOnce());
		await inbox.stop();
	});

	it("retains entries and reports one degradation until processing recovers", async () => {
		let available = false;
		const onDrainError = vi.fn();
		const onDrainRecovered = vi.fn();
		const inbox = new FileRawEventInbox({
			directory: testDirectory(),
			retryDelayMs: 10,
			onDrainError,
			onDrainRecovered,
			processEntry: async () => {
				if (!available) throw new Error("database locked");
			},
		});

		await inbox.enqueue({ event_id: "event-retry" });
		await vi.waitFor(() => expect(onDrainError).toHaveBeenCalledOnce());
		expect((await inbox.status()).pending).toBe(1);
		available = true;
		await vi.waitFor(() => expect(onDrainRecovered).toHaveBeenCalledOnce());
		expect((await inbox.status()).pending).toBe(0);
		await inbox.stop();
	});

	it("retains and counts corrupt files without passing them to the processor", async () => {
		const directory = testDirectory();
		writeFileSync(join(directory, "invalid.json"), "private malformed payload", "utf8");
		const processEntry = vi.fn().mockResolvedValue(undefined);
		const onCorruptEntries = vi.fn();
		const inbox = new FileRawEventInbox({ directory, processEntry, onCorruptEntries });

		expect(await inbox.status()).toMatchObject({ pending: 0, corrupt: 1 });
		inbox.start();
		await vi.waitFor(() => expect(onCorruptEntries).toHaveBeenCalledWith(1));
		expect(processEntry).not.toHaveBeenCalled();
		await inbox.stop();
	});

	it("accepts promptly while SQLite is locked and drains after recovery", async () => {
		const root = testDirectory();
		const dbPath = join(root, "mem.sqlite");
		const onDrainError = vi.fn();
		const queue = createViewerRawEventInbox({
			dbPath,
			homeDir: root,
			onDrainError,
		});
		const lockStore = new MemoryStore(dbPath);
		lockStore.db.exec("BEGIN IMMEDIATE");
		queue.inbox.start();
		const startedAt = performance.now();

		await queue.inbox.enqueue({
			session_id: "session-locked",
			event_id: "event-locked",
			event_type: "prompt",
			payload: { text: "retained" },
		});

		expect(performance.now() - startedAt).toBeLessThan(500);
		await vi.waitFor(() => expect(onDrainError).toHaveBeenCalledOnce());
		expect((await queue.inbox.status()).pending).toBe(1);
		lockStore.db.exec("ROLLBACK");
		lockStore.close();
		await vi.waitFor(async () => expect((await queue.inbox.status()).pending).toBe(0), {
			timeout: 3_000,
		});
		await queue.stop();
		const verificationStore = new MemoryStore(dbPath);
		try {
			const row = verificationStore.db
				.prepare("SELECT COUNT(*) AS count FROM raw_events WHERE event_id = ?")
				.get("event-locked") as { count: number };
			expect(row.count).toBe(1);
		} finally {
			verificationStore.close();
		}
	});
});
