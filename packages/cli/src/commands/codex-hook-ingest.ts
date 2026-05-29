/**
 * codemem codex-hook-ingest — read a single Codex hook payload from stdin and
 * enqueue it for raw-event processing.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	buildRawEventEnvelopeFromCodexHook,
	connect,
	ensureSchemaBootstrapped,
	loadSqliteVec,
	resolveDbPath,
	stripPrivateObj,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addViewerHostOptions, type DbOpts, resolveDbOpt } from "../shared-options.js";
import { logHookEvent } from "./claude-hook-plugin-log.js";
import {
	CodexHookLockBusyError,
	codexHookLockTtlSeconds,
	drainCodexHookSpool,
	hasCodexHookSpooledEntries,
	recoverStaleCodexHookTmpSpool,
	spoolCodexHookPayload,
	withCodexHookIngestLock,
} from "./codex-hook-ingest-spool.js";

type IngestVia = "http" | "direct" | "spool" | "spool_lock_busy";
type IngestResult = { inserted: number; skipped: number; via: IngestVia };
type IngestOpts = { host: string; port: string | number } & DbOpts;

type IngestDeps = {
	httpIngest?: typeof tryHttpIngest;
	directIngest?: typeof directEnqueueCodexHook;
	resolveDb?: typeof resolveDbPath;
};

// Codex hooks run under a tight wrapper budget (see plugins/codex/scripts/
// ingest-hook.mjs, which kills the CLI after ~2s), so the HTTP enqueue attempt
// uses a short 1s default rather than Claude's 5s. Override with
// CODEMEM_CODEX_HOOK_HTTP_TIMEOUT_MS if a slower viewer needs more headroom.
const DEFAULT_HTTP_TIMEOUT_MS = 1000;

function httpTimeoutMs(): number {
	const parsed = Number.parseInt(process.env.CODEMEM_CODEX_HOOK_HTTP_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_TIMEOUT_MS;
}

function emitStructuredError(errorCode: string, message: string): void {
	console.log(JSON.stringify({ error: errorCode, message }));
	process.exitCode = 1;
}

function envTruthyValue(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function hasPayloadTimestamp(payload: Record<string, unknown>): boolean {
	return (
		(typeof payload.timestamp === "string" && payload.timestamp.trim() !== "") ||
		(typeof payload.ts === "string" && payload.ts.trim() !== "")
	);
}

function normalizePayloadForIngest(payload: Record<string, unknown>): Record<string, unknown> {
	if (hasPayloadTimestamp(payload)) return payload;
	return {
		...payload,
		timestamp: new Date().toISOString(),
		codemem_generated_event_nonce: randomUUID(),
	};
}

async function tryHttpIngest(
	payload: Record<string, unknown>,
	host: string,
	port: number,
): Promise<{ ok: boolean; inserted: number; skipped: number }> {
	const url = `http://${host}:${port}/api/codex-hooks`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), httpTimeoutMs());
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!res.ok) return { ok: false, inserted: 0, skipped: 0 };

		const body = (await res.json()) as unknown;
		if (body == null || typeof body !== "object" || Array.isArray(body)) {
			logHookEvent("codemem codex-hook-ingest HTTP accepted with invalid response type");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		const obj = body as Record<string, unknown>;
		if (typeof obj.inserted !== "number" || typeof obj.skipped !== "number") {
			logHookEvent("codemem codex-hook-ingest HTTP accepted with unexpected response body");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		return { ok: true, inserted: obj.inserted, skipped: obj.skipped };
	} catch {
		return { ok: false, inserted: 0, skipped: 0 };
	} finally {
		clearTimeout(timeout);
	}
}

export function directEnqueueCodexHook(
	payload: Record<string, unknown>,
	dbPath: string,
): { inserted: number; skipped: number } {
	const envelope = buildRawEventEnvelopeFromCodexHook(payload);
	if (!envelope) return { inserted: 0, skipped: 1 };

	const db = connect(dbPath);
	try {
		try {
			loadSqliteVec(db);
		} catch {
			// sqlite-vec is not required for raw-event enqueue.
		}
		ensureSchemaBootstrapped(db);
		const strippedPayload = stripPrivateObj(envelope.payload) as Record<string, unknown>;
		const existing = db
			.prepare(
				"SELECT 1 FROM raw_events WHERE source = ? AND stream_id = ? AND event_id = ? LIMIT 1",
			)
			.get(envelope.source, envelope.session_stream_id, envelope.event_id);
		if (existing) return { inserted: 0, skipped: 0 };

		// Seed event_seq from a -1 base so a fresh stream's first event is 0,
		// matching store.recordRawEvent (which increments the session's
		// last_received_event_seq default of -1). This keeps the direct-fallback
		// path and the /api/codex-hooks HTTP path on the same sequence base so
		// maintenance status math does not over/under-count for new streams.
		db.prepare(
			`INSERT INTO raw_events(
				source, stream_id, opencode_session_id, event_id, event_seq,
				event_type, ts_wall_ms, payload_json, created_at
			) VALUES (?, ?, ?, ?, (
				SELECT COALESCE(MAX(event_seq), -1) + 1
				FROM raw_events WHERE source = ? AND stream_id = ?
			), ?, ?, ?, datetime('now'))`,
		).run(
			envelope.source,
			envelope.session_stream_id,
			envelope.opencode_session_id,
			envelope.event_id,
			envelope.source,
			envelope.session_stream_id,
			envelope.event_type,
			envelope.ts_wall_ms,
			JSON.stringify(strippedPayload),
		);

		const maxSeqRow = db
			.prepare(
				"SELECT COALESCE(MAX(event_seq), 0) AS max_seq FROM raw_events WHERE source = ? AND stream_id = ?",
			)
			.get(envelope.source, envelope.session_stream_id) as { max_seq: number };

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
			maxSeqRow.max_seq,
		);

		return { inserted: 1, skipped: 0 };
	} finally {
		db.close();
	}
}

export async function ingestCodexHookPayload(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps = {},
): Promise<IngestResult> {
	const httpIngest = deps.httpIngest ?? tryHttpIngest;
	const directIngest = deps.directIngest ?? directEnqueueCodexHook;
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const port = typeof opts.port === "number" ? opts.port : Number.parseInt(opts.port, 10);
	const ingestPayload = normalizePayloadForIngest(payload);
	let cachedDbPath: string | null = null;
	const getDbPath = (): string => {
		if (cachedDbPath === null) cachedDbPath = resolveDb(resolveDbOpt(opts));
		return cachedDbPath;
	};
	const tryDirectFallback = (queuedPayload: Record<string, unknown>): boolean => {
		try {
			directIngest(queuedPayload, getDbPath());
			return true;
		} catch (err) {
			logHookEvent(
				`codemem codex-hook-ingest direct fallback failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}
	};
	const drainBacklogIfPresent = async (): Promise<void> => {
		if (!hasCodexHookSpooledEntries()) return;
		try {
			await withCodexHookIngestLock(async () => {
				recoverStaleCodexHookTmpSpool(codexHookLockTtlSeconds());
				await drainCodexHookSpool(async (queuedPayload) => {
					const queuedHttp = await httpIngest(queuedPayload, opts.host, port);
					return queuedHttp.ok || tryDirectFallback(queuedPayload);
				});
			});
		} catch (err) {
			if (err instanceof CodexHookLockBusyError) return;
			logHookEvent(
				`codemem codex-hook-ingest backlog drain failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	const httpResult = await httpIngest(ingestPayload, opts.host, port);
	if (httpResult.ok) {
		await drainBacklogIfPresent();
		return { inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" };
	}

	try {
		return await withCodexHookIngestLock(async () => {
			recoverStaleCodexHookTmpSpool(codexHookLockTtlSeconds());

			// Make the current payload durable first so a slow backlog drain
			// can never strand the live event under the hook timeout budget.
			let currentResult: IngestResult;
			try {
				const result = directIngest(ingestPayload, getDbPath());
				currentResult = { ...result, via: "direct" as const };
			} catch (err) {
				logHookEvent(
					`codemem codex-hook-ingest direct fallback failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				if (!spoolCodexHookPayload(ingestPayload)) {
					throw new Error("codex-hook-ingest: fallback and spool both failed");
				}
				currentResult = { inserted: 0, skipped: 0, via: "spool" as const };
			}

			// Now drain any previously spooled payloads under the lock. Use the
			// local direct path only: the live HTTP attempt just failed, so a
			// downed viewer must not consume the hook budget on repeated HTTP
			// timeouts. The HTTP-success path drains via HTTP when the viewer is
			// reachable again.
			await drainCodexHookSpool((queuedPayload) => tryDirectFallback(queuedPayload));

			return currentResult;
		});
	} catch (err) {
		if (!(err instanceof CodexHookLockBusyError)) throw err;
		logHookEvent("codemem codex-hook-ingest lock busy; trying unlocked fallback");
		try {
			const result = directIngest(ingestPayload, getDbPath());
			return { ...result, via: "direct" };
		} catch (directErr) {
			logHookEvent(
				`codemem codex-hook-ingest unlocked direct fallback failed: ${directErr instanceof Error ? directErr.message : String(directErr)}`,
			);
		}
		if (spoolCodexHookPayload(ingestPayload)) {
			return { inserted: 0, skipped: 0, via: "spool_lock_busy" };
		}
		throw err;
	}
}

const codexHookCmd = new Command("codex-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest Codex hook payload: HTTP first, direct DB fallback");

addDbOption(codexHookCmd);
addViewerHostOptions(codexHookCmd);

export const codexHookIngestCommand = codexHookCmd.action(
	async (opts: DbOpts & { host: string; port: string }) => {
		if (envTruthyValue(process.env.CODEMEM_PLUGIN_IGNORE)) return;

		let raw: string;
		try {
			raw = readFileSync(0, "utf8").trim();
		} catch {
			emitStructuredError("read_error", "failed to read stdin");
			return;
		}
		if (!raw) {
			emitStructuredError("read_error", "empty stdin");
			return;
		}

		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				emitStructuredError("parse_error", "payload must be a JSON object");
				return;
			}
			payload = parsed as Record<string, unknown>;
		} catch {
			emitStructuredError("parse_error", "invalid JSON");
			return;
		}

		try {
			const result = await ingestCodexHookPayload(payload, opts);
			console.log(JSON.stringify(result));
		} catch (err) {
			emitStructuredError("ingest_error", err instanceof Error ? err.message : String(err));
		}
	},
);
