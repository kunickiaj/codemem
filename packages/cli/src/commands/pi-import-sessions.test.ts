/**
 * Tests for codemem pi-import-sessions (tasks 5.2 + 6.1).
 *
 * - fresh import / idempotent re-run: core importPiSessions through the CLI
 *   wrapper (per-file progress, summary line, persisted size/mtime state).
 * - extraction opt-in: --extract drains imported pi sessions through the
 *   STANDARD flush path (flushRawEvents — the sweeper's own function, stubbed
 *   observer at the existing IngestOptions seam) and extracted memories carry
 *   pi attribution like live sessions.
 * - default (no --extract): events are stored searchable only — no memories.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import * as core from "@codemem/core";
import { MemoryStore, type ObserverClient } from "@codemem/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	formatPiImportHuman,
	type PiImportRunResult,
	piImportSessionsCommand,
	runPiImportSessions,
} from "./pi-import-sessions.js";

const SESSION_ID = "01a09a64-import-cli-test";
const USER_TEXT = "backfill the lighthouse notes";
const ASSISTANT_TEXT = "Lighthouse history restored from the session file.";

function fixtureJsonl(): string {
	return [
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-09-13T10:51:14.303Z",
			cwd: "/tmp/repo",
		}),
		JSON.stringify({
			type: "message",
			id: "b413a3f3",
			timestamp: "2026-09-13T10:51:16.455Z",
			message: {
				role: "user",
				content: [{ type: "text", text: USER_TEXT }],
				timestamp: 1789296676453,
			},
		}),
		JSON.stringify({
			type: "message",
			id: "4a97ad4d",
			timestamp: "2026-09-13T10:51:25.596Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: ASSISTANT_TEXT }],
				timestamp: 1789296685457,
			},
		}),
	].join("\n");
}

const cleanupDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupDirs.push(dir);
	return dir;
}

interface Fixture {
	dbPath: string;
	agentDir: string;
}

function makeFixture(): Fixture {
	const root = makeTempDir("codemem-pi-import-cli-");
	const agentDir = join(root, "agent");
	const sessionsDir = join(agentDir, "sessions", "--tmp-repo--");
	mkdirSync(sessionsDir, { recursive: true });
	writeFileSync(join(sessionsDir, "session.jsonl"), fixtureJsonl());
	return { dbPath: join(root, "test.sqlite"), agentDir };
}

let savedAgentDir: string | undefined;
beforeEach(() => {
	// Point import at the fixture agent dir via the spec's documented env seam
	// ("Non-default pi directory" scenario) — no --agent-dir CLI flag by design.
	savedAgentDir = process.env.PI_CODING_AGENT_DIR;
});
afterEach(() => {
	if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
});

function useFixtureAgentDir(fixture: Fixture): void {
	process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
}

/** Hermetic observer stub at the IngestOptions seam (raw-event-flush.test.ts pattern). */
function fakeObserver(raw: string): ObserverClient {
	return {
		observe: async () => ({ raw, parsed: null, provider: "test", model: "test-model" }),
		getStatus: () => ({
			provider: "test",
			model: "test-model",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	} as unknown as ObserverClient;
}

function mockObserverClient(observer: ObserverClient | Error): void {
	function observerConstructor(): ObserverClient {
		if (observer instanceof Error) throw observer;
		return observer;
	}
	vi.spyOn(core, "ObserverClient").mockImplementation(observerConstructor);
}

const OBSERVATION_XML = `<observation>
	<type>discovery</type>
	<title>Restored lighthouse history</title>
	<narrative>The imported session describes the lighthouse retrofit</narrative>
	<facts><fact>Lighthouse notes were backfilled</fact></facts>
	<concepts><concept>lighthouse</concept></concepts>
	<files_read></files_read>
	<files_modified></files_modified>
</observation>
<summary>
	<request>Backfill lighthouse notes</request>
	<investigated>Session history import</investigated>
	<learned>Lighthouse retrofit details</learned>
	<completed>History restored</completed>
	<next_steps></next_steps>
	<notes></notes>
</summary>`;

let savedEmbeddingDisabled: string | undefined;
beforeAll(() => {
	// Hermetic: no embedding model downloads on the store path. Save/restore so
	// sibling suites in a shared worker are unaffected.
	savedEmbeddingDisabled = process.env.CODEMEM_EMBEDDING_DISABLED;
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
});
afterAll(() => {
	if (savedEmbeddingDisabled === undefined) delete process.env.CODEMEM_EMBEDDING_DISABLED;
	else process.env.CODEMEM_EMBEDDING_DISABLED = savedEmbeddingDisabled;
});
afterEach(() => {
	process.exitCode = undefined;
	vi.restoreAllMocks();
	for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Run the command, capturing output (--json uses console.log; human uses p.log.*). */
async function runCli(args: string[]): Promise<string[]> {
	const logs: string[] = [];
	const push = (line: unknown) => {
		logs.push(String(line));
	};
	const capture = (method: "info" | "warn" | "message") =>
		vi.spyOn(p.log, method).mockImplementation(push);
	const spies = [
		capture("info"),
		capture("warn"),
		capture("message"),
		vi.spyOn(console, "log").mockImplementation(push),
	];
	try {
		await piImportSessionsCommand.parseAsync(["node", "pi-import-sessions", ...args], {
			from: "node",
		});
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	return logs;
}

describe("codemem pi-import-sessions", () => {
	it("fresh import: prints per-file progress + summary and stores pi events", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const logs = await runCli(["--db-path", fixture.dbPath]);

		expect(logs.join("\n")).toContain("imported");
		expect(logs.join("\n")).toContain("session.jsonl");
		expect(logs.join("\n")).toContain("1 imported");
		expect(logs.join("\n")).toContain("2 events inserted");

		const store = new MemoryStore(fixture.dbPath);
		try {
			const rows = store.db.prepare("SELECT source, stream_id FROM raw_events").all() as Array<{
				source: string;
				stream_id: string;
			}>;
			expect(rows).toHaveLength(2);
			for (const row of rows) {
				expect(row.source).toBe("pi");
				expect(row.stream_id).toBe(SESSION_ID);
			}
			// Default (no --extract): events only, no memories.
			const memories = store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as {
				n: number;
			};
			expect(memories.n).toBe(0);
		} finally {
			store.close();
		}
	});

	it("idempotent re-run: unchanged file is a no-op (size/mtime state)", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		await runCli(["--db-path", fixture.dbPath]);
		const logs = await runCli(["--db-path", fixture.dbPath]);

		expect(logs.join("\n")).toContain("unchanged");
		expect(logs.join("\n")).toContain("0 imported");
		expect(logs.join("\n")).toContain("1 unchanged");

		const store = new MemoryStore(fixture.dbPath);
		try {
			const rows = store.db.prepare("SELECT COUNT(*) AS n FROM raw_events").get() as { n: number };
			expect(rows.n).toBe(2);
		} finally {
			store.close();
		}
	});

	it("--json preserves the import summary and marks extraction as not requested", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const logs = await runCli(["--db-path", fixture.dbPath, "--json"]);
		const summary = JSON.parse(logs.join("\n")) as Record<string, unknown>;
		expect(summary).toEqual({
			filesScanned: 1,
			filesImported: 1,
			filesUnchanged: 0,
			filesEmpty: 0,
			filesErrored: 0,
			inserted: 2,
			skipped: 0,
			extraction: {
				requested: false,
				flushedEvents: 0,
				failedSessions: 0,
				pendingSessions: null,
				error: null,
			},
		});
	});
});

describe("codemem pi-import-sessions extraction wiring (6.1)", () => {
	it("default (no --extract): runPiImportSessions adds events only, no extraction", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const result: PiImportRunResult = await runPiImportSessions(
			{ dbPath: fixture.dbPath },
			{ observer: fakeObserver(OBSERVATION_XML) },
		);
		expect(result.extraction).toEqual({
			requested: false,
			flushedEvents: 0,
			failedSessions: 0,
			pendingSessions: null,
			error: null,
		});
		expect(result.summary.inserted).toBe(2);

		const store = new MemoryStore(fixture.dbPath);
		try {
			const events = store.db.prepare("SELECT COUNT(*) AS n FROM raw_events").get() as {
				n: number;
			};
			expect(events.n).toBe(2);
			const memories = store.db.prepare("SELECT COUNT(*) AS n FROM memory_items").get() as {
				n: number;
			};
			expect(memories.n).toBe(0);
		} finally {
			store.close();
		}
	});

	it("--extract: standard flush runs the observer and extracted memories carry pi attribution", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const result: PiImportRunResult = await runPiImportSessions(
			{ dbPath: fixture.dbPath, extract: true },
			{ observer: fakeObserver(OBSERVATION_XML) },
		);
		expect(result.summary.inserted).toBe(2);
		expect(result.extraction.flushedEvents).toBe(2);

		const store = new MemoryStore(fixture.dbPath);
		try {
			// Extracted memories exist.
			const memories = store.db
				.prepare("SELECT id, session_id, title FROM memory_items ORDER BY id")
				.all() as Array<{ id: number; session_id: number; title: string }>;
			expect(memories.length).toBeGreaterThan(0);

			// Pi attribution, same as live: the owning session is the
			// (source "pi", stream_id = fixture session) stream.
			const mapping = store.db
				.prepare("SELECT session_id FROM opencode_sessions WHERE source = 'pi' AND stream_id = ?")
				.get(SESSION_ID) as { session_id: number } | undefined;
			expect(mapping).toBeDefined();
			for (const memory of memories) {
				expect(memory.session_id).toBe(mapping?.session_id);
			}

			// The flushed session is fully drained (flush state advanced).
			const pending = store
				.rawEventSessionsPendingFlush()
				.filter((session) => session.source === "pi");
			expect(pending).toEqual([]);
		} finally {
			store.close();
		}
	});

	it("human format: summary line and extraction line", () => {
		const human = formatPiImportHuman({
			summary: {
				filesScanned: 3,
				filesImported: 1,
				filesUnchanged: 1,
				filesEmpty: 1,
				filesErrored: 0,
				inserted: 2,
				skipped: 0,
			},
			extraction: {
				requested: true,
				flushedEvents: 2,
				failedSessions: 0,
				pendingSessions: 0,
				error: null,
			},
		});
		expect(human).toContain("Scanned 3 files: 1 imported, 1 unchanged, 1 empty, 0 errored");
		expect(human).toContain("2 events inserted, 0 skipped");
		expect(human).toContain("Extraction: observer flushed 2 events into memories.");
	});
});

describe("Pi extraction mixed-source backlog", () => {
	it("selects Pi sessions before the pending-page limit without flushing other sources", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const store = new MemoryStore(fixture.dbPath);
		try {
			for (let index = 0; index < 25; index++) {
				const streamId = `opencode-backlog-${index}`;
				store.recordRawEventsBatch(streamId, [
					{ event_id: "pending", event_type: "assistant", payload: {} },
				]);
				store.updateRawEventSessionMeta({
					opencodeSessionId: streamId,
					lastSeenTsWallMs: index + 1,
				});
			}
		} finally {
			store.close();
		}
		await runPiImportSessions({ dbPath: fixture.dbPath });
		const imported = new MemoryStore(fixture.dbPath);
		try {
			expect(imported.rawEventSessionsPendingFlush()).toHaveLength(25);
			expect(imported.rawEventSessionsPendingFlush(25, "pi")).toEqual([
				{ source: "pi", streamId: SESSION_ID },
			]);
		} finally {
			imported.close();
		}
		const result = await runPiImportSessions(
			{ dbPath: fixture.dbPath, extract: true },
			{ observer: fakeObserver(OBSERVATION_XML) },
		);
		expect(result.extraction.flushedEvents).toBe(2);
		const drained = new MemoryStore(fixture.dbPath);
		try {
			expect(drained.rawEventSessionsPendingFlush(100)).toHaveLength(25);
			expect(
				drained.rawEventSessionsPendingFlush(100).every((session) => session.source === "opencode"),
			).toBe(true);
		} finally {
			drained.close();
		}
	});
});

describe("Pi extraction failed-page backlog", () => {
	it("attempts the later Pi session even when the oldest 25 sessions fail", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const sessionsDir = join(fixture.agentDir, "sessions", "--tmp-repo--");
		for (let index = 0; index < 25; index++) {
			writeFileSync(
				join(sessionsDir, `failed-${index}.jsonl`),
				fixtureJsonl().replace(SESSION_ID, `failed-${index}`),
			);
		}
		await runPiImportSessions({ dbPath: fixture.dbPath });
		const store = new MemoryStore(fixture.dbPath);
		try {
			for (let index = 0; index < 25; index++) {
				store.db
					.prepare(
						"UPDATE raw_event_sessions SET last_seen_ts_wall_ms = ? WHERE source = 'pi' AND stream_id = ?",
					)
					.run(index + 1, `failed-${index}`);
			}
		} finally {
			store.close();
		}
		vi.spyOn(p.log, "warn").mockImplementation(() => {});
		const observer = fakeObserver(OBSERVATION_XML);
		const observe = vi.spyOn(observer, "observe");
		for (let index = 0; index < 25; index++) {
			observe.mockRejectedValueOnce(new Error("observer unavailable"));
		}
		const result = await runPiImportSessions(
			{ dbPath: fixture.dbPath, extract: true },
			{ observer },
		);
		expect(result.extraction.flushedEvents).toBe(2);
		expect(result.extraction.failedSessions).toBe(25);
		expect(result.extraction.pendingSessions).toBe(25);
		const pending = new MemoryStore(fixture.dbPath);
		try {
			const sessions = pending.rawEventSessionsPendingFlush(100);
			expect(sessions).toHaveLength(25);
			expect(sessions.some((session) => session.streamId === SESSION_ID)).toBe(false);
		} finally {
			pending.close();
		}
	});
});

describe("Pi extraction JSON failures", () => {
	it("reports observer initialization failure as JSON with pending sessions and a failure exit", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		mockObserverClient(new Error("observer init unavailable"));
		const logs = await runCli(["--db-path", fixture.dbPath, "--extract", "--json"]);
		expect(() => JSON.parse(logs.join("\n"))).not.toThrow();
		const output = JSON.parse(logs.join("\n"));
		expect(output.inserted).toBe(2);
		expect(output.extraction).toEqual({
			requested: true,
			flushedEvents: 0,
			failedSessions: 0,
			pendingSessions: 1,
			error: expect.stringContaining("observer init unavailable"),
		});
		expect(output.error).toBe("pi_extraction_incomplete");
		expect(process.exitCode).toBe(1);
	});

	it("reports a failed session without losing imported events or polluting JSON", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const observer = fakeObserver(OBSERVATION_XML);
		vi.spyOn(observer, "observe").mockRejectedValue(new Error("observer flush unavailable"));
		mockObserverClient(observer);
		const logs = await runCli(["--db-path", fixture.dbPath, "--extract", "--json"]);
		expect(() => JSON.parse(logs.join("\n"))).not.toThrow();
		const output = JSON.parse(logs.join("\n"));
		expect(output.inserted).toBe(2);
		expect(output.extraction).toEqual({
			requested: true,
			flushedEvents: 0,
			failedSessions: 1,
			pendingSessions: 1,
			error: expect.stringContaining("observer flush unavailable"),
		});
		expect(output.error).toBe("pi_extraction_incomplete");
		expect(process.exitCode).toBe(1);
		const store = new MemoryStore(fixture.dbPath);
		try {
			expect(store.rawEventSessionsPendingFlush()).toEqual([
				{ source: "pi", streamId: SESSION_ID },
			]);
		} finally {
			store.close();
		}
	});
});

describe("Pi extraction JSON outcomes", () => {
	it("reports successful extraction counts while preserving the import summary", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		mockObserverClient(fakeObserver(OBSERVATION_XML));
		const logs = await runCli(["--db-path", fixture.dbPath, "--extract", "--json"]);
		const output = JSON.parse(logs.join("\n"));
		expect(output.inserted).toBe(2);
		expect(output.extraction).toEqual({
			requested: true,
			flushedEvents: 2,
			failedSessions: 0,
			pendingSessions: 0,
			error: null,
		});
		expect(output.error).toBeUndefined();
		expect(process.exitCode ?? 0).toBe(0);
	});

	it("reports pending extraction when another worker has claimed the batch", async () => {
		const fixture = makeFixture();
		useFixtureAgentDir(fixture);
		const failedObserver = fakeObserver(OBSERVATION_XML);
		vi.spyOn(failedObserver, "observe").mockRejectedValue(new Error("retry later"));
		vi.spyOn(p.log, "warn").mockImplementation(() => {});
		await runPiImportSessions(
			{ dbPath: fixture.dbPath, extract: true },
			{ observer: failedObserver },
		);
		const store = new MemoryStore(fixture.dbPath);
		try {
			const batch = store.db.prepare("SELECT id FROM raw_event_flush_batches").get() as {
				id: number;
			};
			expect(store.claimRawEventFlushBatch(batch.id)).toBe(true);
		} finally {
			store.close();
		}
		mockObserverClient(fakeObserver(OBSERVATION_XML));
		const logs = await runCli(["--db-path", fixture.dbPath, "--extract", "--json"]);
		const output = JSON.parse(logs.join("\n"));
		expect(output.extraction).toEqual({
			requested: true,
			flushedEvents: 0,
			failedSessions: 0,
			pendingSessions: 1,
			error: null,
		});
		expect(output.error).toBe("pi_extraction_incomplete");
		expect(process.exitCode).toBe(1);
	});
});

describe("Pi extraction human failures", () => {
	it("shows failed and pending session counts plus the extraction error", () => {
		const human = formatPiImportHuman({
			summary: {
				filesScanned: 1,
				filesImported: 1,
				filesUnchanged: 0,
				filesEmpty: 0,
				filesErrored: 0,
				inserted: 2,
				skipped: 0,
			},
			extraction: {
				requested: true,
				flushedEvents: 0,
				failedSessions: 1,
				pendingSessions: 2,
				error: "observer unavailable",
			},
		});
		expect(human).toContain("observer flushed 0 events");
		expect(human).toContain("1 sessions failed; 2 remain pending");
		expect(human).toContain("Extraction error: observer unavailable");
	});
});
