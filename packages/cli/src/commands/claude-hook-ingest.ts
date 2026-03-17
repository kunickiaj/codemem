/**
 * codemem claude-hook-ingest — read a single Claude Code hook payload
 * from stdin and enqueue it for processing.
 *
 * Ports codemem/commands/claude_hook_runtime_cmds.py with an HTTP-first
 * strategy: try POST /api/claude-hooks (viewer must be running), then
 * fall back to direct raw-event enqueue via the local store.
 *
 * Usage (from Claude hooks config):
 *   echo '{"hook_event_name":"Stop","session_id":"...","last_assistant_message":"..."}' \
 *     | codemem claude-hook-ingest
 */

import { readFileSync } from "node:fs";
import {
	buildRawEventEnvelopeFromHook,
	connect,
	loadSqliteVec,
	resolveDbPath,
	stripPrivateObj,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

/** Try to POST the hook payload to the running viewer server. */
async function tryHttpIngest(
	payload: Record<string, unknown>,
	host: string,
	port: number,
): Promise<{ ok: boolean; inserted: number; skipped: number }> {
	const url = `http://${host}:${port}/api/claude-hooks`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!res.ok) return { ok: false, inserted: 0, skipped: 0 };
		const body = (await res.json()) as Record<string, unknown>;
		return {
			ok: true,
			inserted: Number(body.inserted ?? 0),
			skipped: Number(body.skipped ?? 0),
		};
	} catch {
		return { ok: false, inserted: 0, skipped: 0 };
	} finally {
		clearTimeout(timeout);
	}
}

/** Fall back to direct raw-event enqueue via the local SQLite store. */
function directEnqueue(
	payload: Record<string, unknown>,
	dbPath: string,
): { inserted: number; skipped: number } {
	const envelope = buildRawEventEnvelopeFromHook(payload);
	if (!envelope) return { inserted: 0, skipped: 1 };

	const db = connect(dbPath);
	try {
		try {
			loadSqliteVec(db);
		} catch {
			// sqlite-vec not available — non-fatal for raw event enqueue
		}
		const strippedPayload = stripPrivateObj(envelope.payload) as Record<string, unknown>;
		const existing = db
			.prepare(
				"SELECT 1 FROM raw_events WHERE source = ? AND stream_id = ? AND event_id = ? LIMIT 1",
			)
			.get(envelope.source, envelope.session_stream_id, envelope.event_id);
		if (existing) return { inserted: 0, skipped: 0 };

		db.prepare(
			`INSERT INTO raw_events(
				source, stream_id, opencode_session_id, event_id, event_seq,
				event_type, ts_wall_ms, payload_json, created_at
			) VALUES (?, ?, ?, ?, (
				SELECT COALESCE(MAX(event_seq), 0) + 1
				FROM raw_events WHERE source = ? AND stream_id = ?
			), ?, ?, ?, datetime('now'))`,
		).run(
			envelope.source,
			envelope.session_stream_id,
			envelope.opencode_session_id,
			envelope.event_id,
			envelope.source,
			envelope.session_stream_id,
			"claude.hook",
			envelope.ts_wall_ms,
			JSON.stringify(strippedPayload),
		);

		// Query actual max event_seq for this stream to keep session metadata in sync
		const maxSeqRow = db
			.prepare(
				"SELECT COALESCE(MAX(event_seq), 0) AS max_seq FROM raw_events WHERE source = ? AND stream_id = ?",
			)
			.get(envelope.source, envelope.session_stream_id) as { max_seq: number };
		const currentMaxSeq = maxSeqRow.max_seq;

		// Upsert session metadata with accurate sequence tracking
		db.prepare(
			`INSERT INTO raw_event_sessions(
				source, stream_id, opencode_session_id, cwd, project, started_at,
				last_seen_ts_wall_ms, last_received_event_seq, last_flushed_event_seq, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, -1, datetime('now'))
			ON CONFLICT(source, stream_id) DO UPDATE SET
				cwd = COALESCE(excluded.cwd, cwd),
				project = COALESCE(excluded.project, project),
				started_at = COALESCE(excluded.started_at, started_at),
				last_seen_ts_wall_ms = MAX(COALESCE(excluded.last_seen_ts_wall_ms, 0), COALESCE(last_seen_ts_wall_ms, 0)),
				last_received_event_seq = MAX(excluded.last_received_event_seq, last_received_event_seq),
				updated_at = datetime('now')`,
		).run(
			envelope.source,
			envelope.session_stream_id,
			envelope.opencode_session_id,
			envelope.cwd,
			envelope.project,
			envelope.started_at,
			envelope.ts_wall_ms,
			currentMaxSeq,
		);

		return { inserted: 1, skipped: 0 };
	} finally {
		db.close();
	}
}

export const claudeHookIngestCommand = new Command("claude-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest a Claude Code hook payload from stdin")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--host <host>", "viewer server host", "127.0.0.1")
	.option("--port <port>", "viewer server port", "38888")
	.action(async (opts: { db?: string; host: string; port: string }) => {
		// Read payload from stdin
		let raw: string;
		try {
			raw = readFileSync(0, "utf8").trim();
		} catch {
			process.exitCode = 1;
			return;
		}
		if (!raw) {
			process.exitCode = 1;
			return;
		}

		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				process.exitCode = 1;
				return;
			}
			payload = parsed as Record<string, unknown>;
		} catch {
			process.exitCode = 1;
			return;
		}

		const port = Number.parseInt(opts.port, 10);
		const host = opts.host;

		// Strategy 1: try HTTP POST to running viewer
		const httpResult = await tryHttpIngest(payload, host, port);
		if (httpResult.ok) {
			console.log(
				JSON.stringify({ inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" }),
			);
			return;
		}

		// Strategy 2: direct local enqueue
		try {
			const dbPath = resolveDbPath(opts.db);
			const directResult = directEnqueue(payload, dbPath);
			console.log(JSON.stringify({ ...directResult, via: "direct" }));
		} catch {
			process.exitCode = 1;
		}
	});
