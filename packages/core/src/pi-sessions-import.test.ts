/**
 * Tests for pi-sessions-import.ts — parsing, deterministic id derivation,
 * and live-capture dedup (design D2).
 *
 * Fixtures are synthetic JSONL mirroring pi's session format: a
 * type:"session" header (id + cwd), type:"message" entries whose message
 * carries role + content blocks (text/thinking/toolCall/toolResult) and a
 * numeric message.timestamp.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connect } from "./db.js";
import { buildRawEventEnvelopeFromPiEvent } from "./pi-hooks.js";
import {
	importPiSessions,
	parsePiSessionJsonl,
	stablePiMessageEntryId,
} from "./pi-sessions-import.js";
import { ingestRawEvents } from "./raw-event-ingest.js";
import { initTestSchema } from "./test-utils.js";

function requireEnvelope(envelope: ReturnType<typeof buildRawEventEnvelopeFromPiEvent>) {
	if (envelope === null) throw new Error("expected pi envelope");
	return envelope;
}

const SESSION_ID = "01a09a64-85ff-7444-9201-c22f263f3819";
const USER_TEXT = "verify the review claims on the PR";
const USER_TS = 1789296676453;
const ASSISTANT_TEXT = "Checked both claims; here is the verdict.";
const ASSISTANT_TS = 1789296685457;

const USER_ENTRY = JSON.stringify({
	type: "message",
	id: "b413a3f3",
	parentId: null,
	timestamp: "2026-09-13T10:51:16.455Z",
	message: {
		role: "user",
		content: [{ type: "text", text: USER_TEXT }],
		timestamp: USER_TS,
	},
});
const ASSISTANT_ENTRY = JSON.stringify({
	type: "message",
	id: "4a97ad4d",
	parentId: "b413a3f3",
	timestamp: "2026-09-13T10:51:25.596Z",
	message: {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "let me check" },
			{ type: "text", text: ASSISTANT_TEXT },
			{ type: "toolCall", id: "tc-1", name: "read", arguments: { path: "x.ts" } },
		],
		timestamp: ASSISTANT_TS,
	},
});
const TOOL_RESULT_ENTRY = JSON.stringify({
	type: "message",
	id: "92852e34",
	parentId: "4a97ad4d",
	timestamp: "2026-09-13T10:51:25.619Z",
	message: {
		role: "toolResult",
		toolCallId: "tc-1",
		content: [{ type: "text", text: "tool output" }],
		timestamp: 1789296685619,
	},
});
const SESSION_HEADER = JSON.stringify({
	type: "session",
	version: 3,
	id: SESSION_ID,
	timestamp: "2026-09-13T10:51:14.303Z",
	cwd: "/tmp/repo",
});

function fixtureJsonl(): string {
	return [
		SESSION_HEADER,
		'{"type":"model_change","id":"9755972d","timestamp":"2026-09-13T10:51:14.303Z","provider":"xai","modelId":"grok-4.6"}',
		USER_ENTRY,
		ASSISTANT_ENTRY,
		TOOL_RESULT_ENTRY,
		"not json at all",
		'{"type":"message","id":"deadbeef","timestamp":"2026-09-13T10:52:00.000Z","message":{"role":"user","content":[{"type":"image","data":"x"}],"timestamp":1789296720000}}',
	].join("\n");
}

// Independent re-derivation of the extension's LIVE formulas
// (packages/pi-extension/src/payloads.ts stableMessageEntryId + core
// buildPiEventId) — pinning the contract the import must collide with.
function liveExtensionEntryId(role: string, text: string, timestamp: number): string {
	return stablePiMessageEntryId(SESSION_ID, role, text, timestamp);
}

function liveExtensionEventId(role: string, text: string, timestamp: number): string {
	const entryId = liveExtensionEntryId(role, text, timestamp);
	const digest = createHash("sha256")
		.update([SESSION_ID, "message_end", entryId].join("|"), "utf-8")
		.digest("hex")
		.slice(0, 24);
	return `pi_evt_${digest}`;
}

const cleanupPaths: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanupPaths.push(dir);
	return dir;
}

function makeDbPath(): string {
	const dir = makeTempDir("codemem-pi-import-");
	const dbPath = join(dir, "test.sqlite");
	const db = connect(dbPath);
	initTestSchema(db);
	db.close();
	return dbPath;
}

function writeSession(agentDir: string, relativeName: string, content: string): string {
	const dir = join(agentDir, "sessions", "--tmp-repo--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, relativeName);
	writeFileSync(file, content);
	return file;
}

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("parsePiSessionJsonl", () => {
	it("extracts user/assistant text, skipping other blocks and entries", () => {
		const parsed = parsePiSessionJsonl(fixtureJsonl());
		expect(parsed).not.toBeNull();
		expect(parsed?.sessionId).toBe(SESSION_ID);
		expect(parsed?.cwd).toBe("/tmp/repo");
		expect(parsed?.messages).toHaveLength(2);
		expect(parsed?.messages[0]?.role).toBe("user");
		expect(parsed?.messages[0]?.text).toBe(USER_TEXT);
		expect(parsed?.messages[0]?.discriminator).toBe(USER_TS);
		expect(parsed?.messages[1]?.role).toBe("assistant");
		expect(parsed?.messages[1]?.text).toBe(ASSISTANT_TEXT);
		expect(parsed?.messages[1]?.ts).toBe("2026-09-13T10:51:25.596Z");
	});

	it("skips malformed lines and returns null without a session header", () => {
		expect(parsePiSessionJsonl('garbage\n\n{"type":"message"}')).toBeNull();
	});

	it("accepts string message content like the live extractor", () => {
		const entry = `${SESSION_HEADER}\n${JSON.stringify({
			type: "message",
			id: "ab12cd34",
			timestamp: "2026-09-13T10:53:00.000Z",
			message: { role: "user", content: "plain string content", timestamp: 1 },
		})}`;
		const parsed = parsePiSessionJsonl(entry);
		expect(parsed?.messages).toHaveLength(1);
		expect(parsed?.messages[0]?.text).toBe("plain string content");
	});
});

describe("pi session import event ids", () => {
	it("derives live-identical pi_evt_ ids and dedupes a live-captured session to zero rows", () => {
		const dbPath = makeDbPath();
		const agentDir = makeTempDir("codemem-pi-agent-");
		writeSession(agentDir, "2026-09-13T10-51-14-303Z_test.jsonl", fixtureJsonl());

		// Seed the store as if the session was captured live: ids computed by
		// the extension formula, ingested through the standard pipeline.
		const db = connect(dbPath);
		for (const [role, text, ts] of [
			["user", USER_TEXT, USER_TS],
			["assistant", ASSISTANT_TEXT, ASSISTANT_TS],
		] as const) {
			const envelope = buildRawEventEnvelopeFromPiEvent({
				piEvent: "message_end",
				sessionId: SESSION_ID,
				entryId: liveExtensionEntryId(role, text, ts),
				role,
				text,
				ts: "2026-09-13T10:51:30.000Z",
				cwd: "/tmp/repo",
			});
			expect(envelope?.event_id).toBe(liveExtensionEventId(role, text, ts));
			const seeded = ingestRawEvents({ db }, requireEnvelope(envelope));
			expect(seeded.inserted).toBe(1);
		}
		db.close();

		const summary = importPiSessions({ dbPath, agentDir });
		expect(summary.inserted).toBe(0);
		expect(summary.filesImported).toBe(1);
		expect(summary.filesScanned).toBe(1);

		const check = connect(dbPath);
		try {
			const rows = check
				.prepare("SELECT event_id, source, stream_id, event_type FROM raw_events ORDER BY id")
				.all() as Array<{
				event_id: string;
				source: string;
				stream_id: string;
				event_type: string;
			}>;
			expect(rows).toHaveLength(2);
			expect(rows[0]?.event_id).toBe(liveExtensionEventId("user", USER_TEXT, USER_TS));
			expect(rows[0]?.source).toBe("pi");
			expect(rows[0]?.stream_id).toBe(SESSION_ID);
			expect(rows[0]?.event_type).toBe("pi.hook");
		} finally {
			check.close();
		}
	});

	it("imports an unseen session with deterministic pi_evt_ ids and _adapter payloads", () => {
		const dbPath = makeDbPath();
		const agentDir = makeTempDir("codemem-pi-agent-");
		writeSession(agentDir, "2026-09-14T09-00-00-000Z_test.jsonl", fixtureJsonl());

		const summary = importPiSessions({ dbPath, agentDir });
		expect(summary.inserted).toBe(2);

		const check = connect(dbPath);
		try {
			const rows = check
				.prepare("SELECT event_id, payload_json FROM raw_events ORDER BY id")
				.all() as Array<{ event_id: string; payload_json: string }>;
			expect(rows).toHaveLength(2);
			for (const row of rows) expect(row.event_id).toMatch(/^pi_evt_[0-9a-f]{24}$/);
			const adapter = (
				JSON.parse(rows[0]?.payload_json ?? "{}") as { _adapter?: Record<string, unknown> }
			)._adapter;
			expect(adapter?.source).toBe("pi");
			expect(adapter?.event_type).toBe("prompt");
		} finally {
			check.close();
		}
	});
});

describe("PI_CODING_AGENT_DIR resolution", () => {
	it("imports from the overridden agent dir", () => {
		const dbPath = makeDbPath();
		const overridden = makeTempDir("codemem-pi-override-");
		writeSession(overridden, "2026-09-14T09-00-00-000Z_env.jsonl", fixtureJsonl());

		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = overridden;
		try {
			const summary = importPiSessions({ dbPath });
			expect(summary.filesScanned).toBe(1);
			expect(summary.inserted).toBe(2);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
	});
});

describe("pi import skip state is per database", () => {
	it("imports into a fresh database beside an imported one, and after recreation", () => {
		const dir = mkdtempSync(join(tmpdir(), "codemem-pi-import-state-"));
		cleanupPaths.push(dir);
		const dbA = join(dir, "a.sqlite");
		const dbB = join(dir, "b.sqlite");
		for (const dbPath of [dbA, dbB]) {
			const db = connect(dbPath);
			initTestSchema(db);
			db.close();
		}
		const agentDir = makeTempDir("codemem-pi-agent-");
		writeSession(agentDir, "2026-09-15T09-00-00-000Z_state.jsonl", fixtureJsonl());

		const first = importPiSessions({ dbPath: dbA, agentDir });
		expect(first.inserted).toBe(2);

		const intoA = importPiSessions({ dbPath: dbA, agentDir });
		expect(intoA.filesUnchanged).toBe(1);
		expect(intoA.inserted).toBe(0);

		// A different database sharing the directory has no skip state.
		const intoB = importPiSessions({ dbPath: dbB, agentDir });
		expect(intoB.filesUnchanged).toBe(0);
		expect(intoB.inserted).toBe(2);

		// Recreating a database forgets its skip state: full re-import.
		rmSync(dbB);
		const recreated = connect(dbB);
		initTestSchema(recreated);
		recreated.close();
		const intoFreshB = importPiSessions({ dbPath: dbB, agentDir });
		expect(intoFreshB.filesUnchanged).toBe(0);
		expect(intoFreshB.inserted).toBe(2);
	});
});

describe("timestamp-less message discriminators", () => {
	const TS_LESS_TEXT = "send the identical request again";

	/** A user turn with NO message.timestamp, like live timestamp-less captures. */
	function tsLessEntry(id: string): string {
		return JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-09-15T10:00:00.000Z",
			message: {
				role: "user",
				content: [{ type: "text", text: TS_LESS_TEXT }],
			},
		});
	}

	it("assigns the live n:<seq> fallback so duplicate turns keep distinct ids", () => {
		const parsed = parsePiSessionJsonl(
			[SESSION_HEADER, tsLessEntry("no-ts-1"), tsLessEntry("no-ts-2")].join("\n"),
		);
		expect(parsed?.messages).toHaveLength(2);
		expect(parsed?.messages[0]?.discriminator).toBe("n:1");
		expect(parsed?.messages[1]?.discriminator).toBe("n:2");
		expect(stablePiMessageEntryId(SESSION_ID, "user", TS_LESS_TEXT, "n:1")).not.toBe(
			stablePiMessageEntryId(SESSION_ID, "user", TS_LESS_TEXT, "n:2"),
		);
	});

	it("imports both duplicate turns and dedupes the live-captured n:1 counterpart", () => {
		const dbPath = makeDbPath();
		const agentDir = makeTempDir("codemem-pi-agent-");
		writeSession(
			agentDir,
			"2026-09-15T10-00-00-000Z_noseq.jsonl",
			[SESSION_HEADER, tsLessEntry("no-ts-1"), tsLessEntry("no-ts-2")].join("\n"),
		);

		// Seed the store as if the first timestamp-less turn was captured live:
		// the extension's messageDiscriminator assigned it n:1.
		const db = connect(dbPath);
		const envelope = buildRawEventEnvelopeFromPiEvent({
			piEvent: "message_end",
			sessionId: SESSION_ID,
			entryId: stablePiMessageEntryId(SESSION_ID, "user", TS_LESS_TEXT, "n:1"),
			role: "user",
			text: TS_LESS_TEXT,
			ts: "2026-09-15T10:00:01.000Z",
			cwd: "/tmp/repo",
		});
		const seeded = ingestRawEvents({ db }, requireEnvelope(envelope));
		expect(seeded.inserted).toBe(1);
		db.close();

		const summary = importPiSessions({ dbPath, agentDir });
		expect(summary.inserted).toBe(1);
		expect(summary.skipped).toBe(1);
	});
});
