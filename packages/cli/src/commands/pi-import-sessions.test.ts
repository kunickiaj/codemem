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

	it("--json prints the import summary object only", async () => {
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
		expect(result.extractedEvents).toBeNull();
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
		expect(result.extractedEvents).toBe(2);

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
			extractedEvents: 2,
		});
		expect(human).toContain("Scanned 3 files: 1 imported, 1 unchanged, 1 empty, 0 errored");
		expect(human).toContain("2 events inserted, 0 skipped");
		expect(human).toContain("Extraction: observer flushed 2 events into memories.");
	});
});
