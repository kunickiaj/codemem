/**
 * Tests for pi-sessions-import.ts orchestration (task 1.3): size/mtime skip,
 * idempotent re-import, per-file progress output, and error tolerance.
 */

import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { importPiSessions } from "./pi-sessions-import.js";
import { initTestSchema } from "./test-utils.js";

const SESSION_HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: "01a0c40b-c3bd-763b-8d1f-96d2031f6593",
	timestamp: "2026-09-21T12:58:20.477Z",
	cwd: "/tmp/repo",
});

function messageEntry(id: string, text: string, timestamp: string): string {
	return JSON.stringify({
		type: "message",
		id,
		timestamp,
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.parse(timestamp),
		},
	});
}

const cleanupPaths: string[] = [];

function makeFixtureSession(): { agentDir: string; dbPath: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "codemem-pi-import-orch-"));
	cleanupPaths.push(dir);
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	mkdirSync(join(dir, "sessions", "--tmp-repo--"), { recursive: true });
	const file = join(dir, "sessions", "--tmp-repo--", "2026-09-21T12-58-20-477Z_s.jsonl");
	writeFileSync(
		file,
		`${SESSION_HEADER}\n${messageEntry("aaa1", "first message", "2026-09-21T12:58:21.000Z")}`,
	);
	return { agentDir: dir, dbPath, file };
}

function piRowCount(dbPath: string): number {
	const db = connect(dbPath);
	try {
		const row = db.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE source = 'pi'").get() as {
			n: number;
		};
		return Number(row.n);
	} finally {
		db.close();
	}
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("importPiSessions orchestration", () => {
	it("is idempotent: second run over unchanged files inserts nothing", () => {
		const { agentDir, dbPath } = makeFixtureSession();

		const first = importPiSessions({ dbPath, agentDir });
		expect(first.inserted).toBe(1);
		expect(first.filesImported).toBe(1);
		expect(piRowCount(dbPath)).toBe(1);

		const second = importPiSessions({ dbPath, agentDir });
		expect(second.inserted).toBe(0);
		expect(second.filesUnchanged).toBe(1);
		expect(second.filesScanned).toBe(1);
		expect(piRowCount(dbPath)).toBe(1);
	});

	it("still dedupes by event id when the skip-state rows are cleared", () => {
		const { agentDir, dbPath } = makeFixtureSession();
		importPiSessions({ dbPath, agentDir });
		const db = connect(dbPath);
		db.exec("DELETE FROM pi_import_state");
		db.close();

		const rerun = importPiSessions({ dbPath, agentDir });
		expect(rerun.filesUnchanged).toBe(0);
		expect(rerun.inserted).toBe(0);
		expect(rerun.skipped).toBe(1);
		expect(piRowCount(dbPath)).toBe(1);
	});

	it("imports only appended messages when a file changes", () => {
		const { agentDir, dbPath, file } = makeFixtureSession();
		importPiSessions({ dbPath, agentDir });

		appendFileSync(file, `\n${messageEntry("bbb2", "second message", "2026-09-21T12:59:00.000Z")}`);
		const rerun = importPiSessions({ dbPath, agentDir });
		expect(rerun.filesUnchanged).toBe(0);
		expect(rerun.inserted).toBe(1);
		expect(rerun.skipped).toBe(1);
		expect(piRowCount(dbPath)).toBe(2);
	});

	it("reports per-file progress and tolerates empty and malformed files", () => {
		const { agentDir, dbPath, file } = makeFixtureSession();
		writeFileSync(join(file, "..", "empty.jsonl"), "");
		writeFileSync(join(file, "..", "broken.jsonl"), "no session header here\n");

		const progress: string[] = [];
		const summary = importPiSessions({
			dbPath,
			agentDir,
			onProgress: (p) => progress.push(`${p.status}:${p.inserted}/${p.skipped}`),
		});

		expect(summary.filesScanned).toBe(3);
		expect(summary.filesImported).toBe(1);
		expect(summary.filesEmpty).toBe(2);
		expect(summary.filesErrored).toBe(0);
		expect(summary.inserted).toBe(1);
		expect(progress).toContain(`imported:1/0`);
		expect(progress.filter((entry) => entry.startsWith("empty:"))).toHaveLength(2);
		expect(readdirSync(join(agentDir, "sessions", "--tmp-repo--"))).toContain("empty.jsonl");
		const db = connect(dbPath);
		const stateRows = db.prepare("SELECT COUNT(*) AS n FROM pi_import_state").get() as {
			n: number;
		};
		db.close();
		expect(Number(stateRows.n)).toBe(3);
	});
});
