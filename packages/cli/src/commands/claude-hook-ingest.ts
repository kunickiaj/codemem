/**
 * codemem claude-hook-ingest — read a single Claude Code hook payload
 * from stdin and enqueue it for processing.
 *
 * HTTP-first strategy: POST to the running viewer's /api/claude-hooks
 * endpoint, then fall back to direct raw-event enqueue via the local
 * store when the viewer is unreachable.
 *
 * Usage (from Claude hooks config):
 *   echo '{"hook_event_name":"Stop","session_id":"...","last_assistant_message":"..."}' \
 *     | codemem claude-hook-ingest
 */

import { readFileSync } from "node:fs";
import {
	buildRawEventEnvelopeFromHook,
	connect,
	ensureSchemaBootstrapped,
	flushRawEvents,
	loadSqliteVec,
	MemoryStore,
	ObserverClient,
	resolveDbPath,
	stripPrivateObj,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addViewerHostOptions, type DbOpts, resolveDbOpt } from "../shared-options.js";
import {
	drainSpool,
	hasSpooledEntries,
	LockBusyError,
	lockTtlSeconds,
	recoverStaleTmpSpool,
	shouldForceBoundaryFlush,
	spoolPayload,
	withClaudeHookIngestLock,
} from "./claude-hook-ingest-spool.js";
import { logHookFailure } from "./claude-hook-plugin-log.js";
import { trackHookSessionState } from "./claude-hook-session-state.js";

type IngestVia = "http" | "direct" | "spool" | "spool_lock_busy";

type IngestResult = { inserted: number; skipped: number; via: IngestVia };

type IngestOpts = {
	host: string;
	port: string | number;
} & DbOpts;

type IngestDeps = {
	httpIngest?: typeof tryHttpIngest;
	directIngest?: typeof directEnqueue;
	resolveDb?: typeof resolveDbPath;
	boundaryFlush?: (payload: Record<string, unknown>, dbPath: string) => Promise<void> | void;
};

function emitStructuredError(errorCode: string, message: string): void {
	console.log(JSON.stringify({ error: errorCode, message }));
	process.exitCode = 1;
}

/** Try to POST the hook payload to the running viewer server.
 *
 * Returns `ok: true` whenever the viewer accepts the request and
 * returns a well-shaped JSON body with numeric `inserted` / `skipped`
 * fields. That includes the `{inserted: 0, skipped: 1}` response the
 * viewer emits when the payload maps to a null envelope (Stop with no
 * assistant text, UserPromptSubmit with empty prompt, etc.) — that
 * determination is deterministic, so retrying via the direct fallback
 * would produce the exact same null envelope and the same skip. We
 * accept those as benign no-ops instead of triggering the durability
 * dance pointlessly.
 *
 * If a future server change adds a new `skipped` reason that IS
 * transient, we'll need a reason field in the response and updated
 * client handling — not an unconditional fail-over.
 */
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

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			logHookFailure("codemem claude-hook-ingest HTTP accepted with invalid response body");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		if (body == null || typeof body !== "object" || Array.isArray(body)) {
			logHookFailure("codemem claude-hook-ingest HTTP accepted with invalid response type");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		const obj = body as Record<string, unknown>;
		if (typeof obj.inserted !== "number" || typeof obj.skipped !== "number") {
			logHookFailure("codemem claude-hook-ingest HTTP accepted with unexpected response body");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		return { ok: true, inserted: obj.inserted, skipped: obj.skipped };
	} catch {
		return { ok: false, inserted: 0, skipped: 0 };
	} finally {
		clearTimeout(timeout);
	}
}

/** Fall back to direct raw-event enqueue via the local SQLite store. */
export function directEnqueue(
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
		// Auto-bootstrap fresh databases before touching raw_events. The MCP
		// server's MemoryStore constructor normally bootstraps first, but
		// hooks can race its startup (claude-hook-ingest is a separate CLI
		// process) so we can't rely on that ordering.
		ensureSchemaBootstrapped(db);
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

/**
 * Best-effort boundary flush: write the payload through to the local
 * store (so the just-fired SessionEnd / Stop event is durable in
 * raw_events) and then run a synchronous flushRawEvents pass so that
 * the latest memories are extracted before the hook process exits and
 * the user closes their terminal.
 *
 * Any failure here \u2014 observer construction, store I/O, flush errors,
 * or simply running without observer credentials \u2014 is logged to
 * `~/.codemem/plugin.log` and swallowed. The hook command must never
 * crash on a boundary flush failure.
 */
async function flushBoundaryRawEvents(
	payload: Record<string, unknown>,
	dbPath: string,
): Promise<void> {
	const envelope = buildRawEventEnvelopeFromHook(payload);
	if (!envelope) return;

	let observer: ObserverClient;
	try {
		observer = new ObserverClient();
	} catch (err) {
		logHookFailure(
			`codemem claude-hook-ingest boundary flush observer init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	let store: MemoryStore;
	try {
		store = new MemoryStore(dbPath);
	} catch (err) {
		logHookFailure(
			`codemem claude-hook-ingest boundary flush store init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	try {
		await flushRawEvents(
			store,
			{ observer },
			{
				opencodeSessionId: envelope.session_stream_id,
				source: envelope.source,
				cwd: envelope.cwd ?? null,
				project: envelope.project ?? null,
				startedAt: envelope.started_at ?? null,
				maxEvents: null,
			},
		);
	} catch (err) {
		logHookFailure(
			`codemem claude-hook-ingest boundary flush raw events failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		store.close();
	}
}

/**
 * Ingest one Claude hook payload using the TS contract:
 * HTTP enqueue first, then locked drain + retry + direct fallback +
 * disk spool durability.
 */
export async function ingestClaudeHookPayload(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps = {},
): Promise<IngestResult> {
	const httpIngest = deps.httpIngest ?? tryHttpIngest;
	const directIngest = deps.directIngest ?? directEnqueue;
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const boundaryFlush = deps.boundaryFlush ?? flushBoundaryRawEvents;

	// Update per-session state alongside ingestion so claude-hook-inject's
	// retrieval query can draw on prompts/files seen on the ingest path.
	// Failures must never crash the hook command.
	try {
		trackHookSessionState(payload);
	} catch {
		// best-effort
	}

	const port = typeof opts.port === "number" ? opts.port : Number.parseInt(opts.port, 10);

	// Resolve DB path lazily so the unlocked HTTP-success path doesn't
	// touch the filesystem when the viewer is up.
	let cachedDbPath: string | null = null;
	const getDbPath = (): string => {
		if (cachedDbPath === null) cachedDbPath = resolveDb(resolveDbOpt(opts));
		return cachedDbPath;
	};

	const tryDirectFallback = (
		queued: Record<string, unknown>,
	): { ok: true; result: { inserted: number; skipped: number } } | { ok: false } => {
		try {
			return { ok: true, result: directIngest(queued, getDbPath()) };
		} catch (err) {
			logHookFailure(
				`codemem claude-hook-ingest direct fallback failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return { ok: false };
		}
	};

	const flushOnBoundaryIfRequested = async (): Promise<void> => {
		if (!shouldForceBoundaryFlush(payload)) return;
		// Best-effort write-through of the boundary payload to the local
		// store, then a synchronous flushRawEvents pass so memory state
		// is durable even when the viewer process is the one being shut
		// down. Both halves are logged with a boundary-specific message
		// so operators can distinguish them from regular fallback errors.
		try {
			directIngest(payload, getDbPath());
		} catch (err) {
			logHookFailure(
				`codemem claude-hook-ingest boundary flush direct write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		try {
			await boundaryFlush(payload, getDbPath());
		} catch (err) {
			logHookFailure(
				`codemem claude-hook-ingest boundary flush failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	// Drain any backlog spooled by previous failed invocations. Runs on
	// every successful HTTP path so the queue is recovered as soon as
	// the viewer comes back up; if a previous run had to spool because
	// both HTTP and direct ingest failed, those payloads must not sit
	// stranded just because the next call happens to hit a healthy
	// viewer. Cheap pre-check avoids the lock acquisition cost on the
	// fast path when the spool is empty (the common case).
	const drainBacklogIfPresent = async (): Promise<void> => {
		if (!hasSpooledEntries()) return;
		try {
			await withClaudeHookIngestLock(async () => {
				recoverStaleTmpSpool(lockTtlSeconds());
				await drainSpool(async (queuedPayload) => {
					const queuedHttp = await httpIngest(queuedPayload, opts.host, port);
					if (queuedHttp.ok) return true;
					return tryDirectFallback(queuedPayload).ok;
				});
			});
		} catch (err) {
			if (err instanceof LockBusyError) {
				// Another invocation is already draining; nothing to do.
				return;
			}
			logHookFailure(
				`codemem claude-hook-ingest backlog drain failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	// 1. Unlocked HTTP attempt — fast path when the viewer is up.
	const httpResult = await httpIngest(payload, opts.host, port);
	if (httpResult.ok) {
		await flushOnBoundaryIfRequested();
		await drainBacklogIfPresent();
		return { inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" };
	}

	// 2. Locked failure path: drain spool, retry HTTP, fall back to
	//    direct, spool the payload as last resort.
	try {
		return await withClaudeHookIngestLock(async () => {
			recoverStaleTmpSpool(lockTtlSeconds());

			await drainSpool(async (queuedPayload) => {
				const queuedHttp = await httpIngest(queuedPayload, opts.host, port);
				if (queuedHttp.ok) return true;
				const direct = tryDirectFallback(queuedPayload);
				return direct.ok;
			});

			const secondHttp = await httpIngest(payload, opts.host, port);
			if (secondHttp.ok) {
				await flushOnBoundaryIfRequested();
				return {
					inserted: secondHttp.inserted,
					skipped: secondHttp.skipped,
					via: "http" as const,
				};
			}

			const direct = tryDirectFallback(payload);
			if (direct.ok) {
				await flushOnBoundaryIfRequested();
				return { ...direct.result, via: "direct" as const };
			}

			if (spoolPayload(payload)) {
				return { inserted: 0, skipped: 0, via: "spool" as const };
			}

			logHookFailure("codemem claude-hook-ingest failed: fallback and spool failed");
			throw new Error("claude-hook-ingest: fallback and spool both failed");
		});
	} catch (err) {
		if (!(err instanceof LockBusyError)) throw err;

		logHookFailure("codemem claude-hook-ingest lock busy; trying unlocked fallback");
		const direct = tryDirectFallback(payload);
		if (direct.ok) {
			return { ...direct.result, via: "direct" };
		}
		if (spoolPayload(payload)) {
			return { inserted: 0, skipped: 0, via: "spool_lock_busy" };
		}
		logHookFailure("codemem claude-hook-ingest failed: unlocked fallback and spool failed");
		throw err;
	}
}

const claudeHookCmd = new Command("claude-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest Claude hook payload: HTTP first, direct DB fallback");

addDbOption(claudeHookCmd);
addViewerHostOptions(claudeHookCmd);

function envTruthyValue(value: string | undefined): boolean {
	const normalized = String(value ?? "")
		.trim()
		.toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export const claudeHookIngestCommand = claudeHookCmd.action(
	async (opts: DbOpts & { host: string; port: string }) => {
		// Honor the global plugin-ignore kill switch first so users can
		// disable every codemem hook side effect by exporting
		// CODEMEM_PLUGIN_IGNORE=1 without having to know which subcommand
		// is wired to which hook. Mirrors the inject command.
		if (envTruthyValue(process.env.CODEMEM_PLUGIN_IGNORE)) {
			return;
		}

		// Read payload from stdin
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
			const result = await ingestClaudeHookPayload(payload, opts);
			console.log(JSON.stringify(result));
		} catch (err) {
			emitStructuredError("ingest_error", err instanceof Error ? err.message : String(err));
		}
	},
);
