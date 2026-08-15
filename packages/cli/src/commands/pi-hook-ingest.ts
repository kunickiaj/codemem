/**
 * codemem pi-hook-ingest — read a single pi extension event JSON from stdin
 * and enqueue it for raw-event processing.
 *
 * HTTP-first strategy: POST to the running viewer's /api/pi-hooks endpoint,
 * then fall back to direct raw-event enqueue via the local store when the
 * viewer is unreachable. session_before_compact / session_shutdown trigger a
 * best-effort boundary flush with source "pi".
 *
 * Usage (from the pi extension CLI fallback):
 *   echo '{"piEvent":"session_start","sessionId":"...","cwd":"..."}' \
 *     | codemem pi-hook-ingest
 */

import { readFileSync } from "node:fs";
import {
	buildPiFlushSignalFromEvent,
	buildRawEventEnvelopeFromPiEvent,
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
import { logHookEvent } from "./claude-hook-plugin-log.js";
import {
	drainPiHookSpool,
	hasPiHookSpooledEntries,
	PiHookLockBusyError,
	piHookLockTtlSeconds,
	recoverStalePiHookTmpSpool,
	shouldForcePiBoundaryFlush,
	spoolPiHookPayload,
	withPiHookIngestLock,
} from "./pi-hook-ingest-spool.js";

type IngestVia = "http" | "direct" | "spool" | "spool_lock_busy";
type IngestResult = { inserted: number; skipped: number; via: IngestVia };
type IngestOpts = { host: string; port: string | number } & DbOpts;

type IngestDeps = {
	httpIngest?: typeof tryHttpIngest;
	directIngest?: typeof directEnqueuePiHook;
	resolveDb?: typeof resolveDbPath;
	boundaryFlush?: (payload: Record<string, unknown>, dbPath: string) => Promise<void> | void;
};

const DEFAULT_HTTP_TIMEOUT_MS = 5000;

function httpTimeoutMs(): number {
	const parsed = Number.parseInt(process.env.CODEMEM_PI_HOOK_HTTP_TIMEOUT_MS ?? "", 10);
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

/**
 * Try to POST the pi event payload to the running viewer server.
 *
 * Returns `ok: true` whenever the viewer accepts the request and returns a
 * well-shaped JSON body with numeric `inserted` / `skipped` fields — including
 * deterministic skips (unsupported or flush-only events). Retrying those via
 * the direct path would produce the same skip.
 */
async function tryHttpIngest(
	payload: Record<string, unknown>,
	host: string,
	port: number,
): Promise<{ ok: boolean; inserted: number; skipped: number }> {
	const url = `http://${host}:${port}/api/pi-hooks`;
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

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			logHookEvent("codemem pi-hook-ingest HTTP accepted with invalid response body");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		if (body == null || typeof body !== "object" || Array.isArray(body)) {
			logHookEvent("codemem pi-hook-ingest HTTP accepted with invalid response type");
			return { ok: false, inserted: 0, skipped: 0 };
		}
		const obj = body as Record<string, unknown>;
		if (typeof obj.inserted !== "number" || typeof obj.skipped !== "number") {
			logHookEvent("codemem pi-hook-ingest HTTP accepted with unexpected response body");
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
export function directEnqueuePiHook(
	payload: Record<string, unknown>,
	dbPath: string,
): { inserted: number; skipped: number } {
	const envelope = buildRawEventEnvelopeFromPiEvent(payload);
	if (!envelope) return { inserted: 0, skipped: 1 };

	// Attribution contract (D3): source is always the envelope's literal "pi".
	const source = envelope.source;

	const db = connect(dbPath);
	try {
		try {
			loadSqliteVec(db);
		} catch {
			// sqlite-vec is not required for raw-event enqueue.
		}
		// Auto-bootstrap fresh databases before touching raw_events. The viewer
		// server's MemoryStore constructor normally bootstraps first, but hooks
		// can race its startup (pi-hook-ingest is a separate CLI process).
		ensureSchemaBootstrapped(db);
		const strippedPayload = stripPrivateObj(envelope.payload) as Record<string, unknown>;
		const existing = db
			.prepare(
				"SELECT 1 FROM raw_events WHERE source = ? AND stream_id = ? AND event_id = ? LIMIT 1",
			)
			.get(source, envelope.session_stream_id, envelope.event_id);
		if (existing) return { inserted: 0, skipped: 0 };

		// Seed event_seq from a -1 base so a fresh stream's first event is 0,
		// matching store.recordRawEvent (which increments the session's
		// last_received_event_seq default of -1).
		db.prepare(
			`INSERT INTO raw_events(
				source, stream_id, opencode_session_id, event_id, event_seq,
				event_type, ts_wall_ms, payload_json, created_at
			) VALUES (?, ?, ?, ?, (
				SELECT COALESCE(MAX(event_seq), -1) + 1
				FROM raw_events WHERE source = ? AND stream_id = ?
			), ?, ?, ?, datetime('now'))`,
		).run(
			source,
			envelope.session_stream_id,
			envelope.opencode_session_id,
			envelope.event_id,
			source,
			envelope.session_stream_id,
			envelope.event_type,
			envelope.ts_wall_ms,
			JSON.stringify(strippedPayload),
		);

		const maxSeqRow = db
			.prepare(
				"SELECT COALESCE(MAX(event_seq), 0) AS max_seq FROM raw_events WHERE source = ? AND stream_id = ?",
			)
			.get(source, envelope.session_stream_id) as { max_seq: number };

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
			source,
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

/**
 * Best-effort boundary flush for session_before_compact / session_shutdown.
 * Always passes source "pi" — never relies on a helper default.
 * Failures are logged and swallowed so the hook never crashes the agent.
 */
async function flushBoundaryRawEvents(
	payload: Record<string, unknown>,
	dbPath: string,
): Promise<void> {
	const envelope = buildRawEventEnvelopeFromPiEvent(payload);
	const signal = buildPiFlushSignalFromEvent(payload);
	const sessionId = envelope?.session_stream_id ?? signal?.session_id ?? null;
	if (!sessionId) return;

	// Explicit source "pi" per attribution-audit.md — never bare defaults.
	const source = "pi" as const;
	const cwd = envelope?.cwd ?? signal?.cwd ?? null;
	const project = envelope?.project ?? signal?.project ?? null;
	const startedAt = envelope?.started_at ?? null;

	let observer: ObserverClient;
	try {
		observer = new ObserverClient();
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush observer init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	let store: MemoryStore;
	try {
		store = new MemoryStore(dbPath);
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush store init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	try {
		await flushRawEvents(
			store,
			{ observer },
			{
				opencodeSessionId: sessionId,
				source,
				cwd,
				project,
				startedAt,
				maxEvents: null,
			},
		);
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush raw events failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	} finally {
		store.close();
	}
}

/**
 * Ingest one pi extension event using the TS contract:
 * HTTP enqueue first, then locked drain + retry + direct fallback +
 * disk spool durability, with boundary flush on compact/shutdown.
 */
export async function ingestPiHookPayload(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps = {},
): Promise<IngestResult> {
	const httpIngest = deps.httpIngest ?? tryHttpIngest;
	const directIngest = deps.directIngest ?? directEnqueuePiHook;
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const boundaryFlush = deps.boundaryFlush ?? flushBoundaryRawEvents;

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
			logHookEvent(
				`codemem pi-hook-ingest direct fallback failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return { ok: false };
		}
	};

	const flushOnBoundaryIfRequested = async (): Promise<void> => {
		if (!shouldForcePiBoundaryFlush(payload)) return;
		// Best-effort write-through of the boundary payload to the local
		// store, then a synchronous flushRawEvents pass so memory state
		// is durable even when the viewer process is the one being shut
		// down. session_before_compact has no envelope (flush-only), so
		// direct write is a no-op skip — flush still runs via signal.
		try {
			directIngest(payload, getDbPath());
		} catch (err) {
			logHookEvent(
				`codemem pi-hook-ingest boundary flush direct write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		try {
			await boundaryFlush(payload, getDbPath());
		} catch (err) {
			logHookEvent(
				`codemem pi-hook-ingest boundary flush failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	};

	const drainBacklogIfPresent = async (): Promise<void> => {
		if (!hasPiHookSpooledEntries()) return;
		try {
			await withPiHookIngestLock(async () => {
				recoverStalePiHookTmpSpool(piHookLockTtlSeconds());
				await drainPiHookSpool(async (queuedPayload) => {
					const queuedHttp = await httpIngest(queuedPayload, opts.host, port);
					if (queuedHttp.ok) return true;
					return tryDirectFallback(queuedPayload).ok;
				});
			});
		} catch (err) {
			if (err instanceof PiHookLockBusyError) {
				// Another invocation is already draining; nothing to do.
				return;
			}
			logHookEvent(
				`codemem pi-hook-ingest backlog drain failed: ${err instanceof Error ? err.message : String(err)}`,
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
		return await withPiHookIngestLock(async () => {
			recoverStalePiHookTmpSpool(piHookLockTtlSeconds());

			await drainPiHookSpool(async (queuedPayload) => {
				const queuedHttp = await httpIngest(queuedPayload, opts.host, port);
				if (queuedHttp.ok) return true;
				return tryDirectFallback(queuedPayload).ok;
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

			if (spoolPiHookPayload(payload)) {
				// Same boundary flush as lock-busy spool — DB throw + spool
				// success must not drop session_before_compact / session_shutdown.
				// Direct-success path above already flushed; do not flush twice.
				await flushOnBoundaryIfRequested();
				return { inserted: 0, skipped: 0, via: "spool" as const };
			}

			logHookEvent("codemem pi-hook-ingest failed: fallback and spool failed");
			throw new Error("pi-hook-ingest: fallback and spool both failed");
		});
	} catch (err) {
		if (!(err instanceof PiHookLockBusyError)) throw err;

		logHookEvent("codemem pi-hook-ingest lock busy; trying unlocked fallback");
		const direct = tryDirectFallback(payload);
		if (direct.ok) {
			// Same boundary flush as the locked path — lock contention must
			// not drop session_before_compact / session_shutdown flush.
			await flushOnBoundaryIfRequested();
			return { ...direct.result, via: "direct" };
		}
		if (spoolPiHookPayload(payload)) {
			await flushOnBoundaryIfRequested();
			return { inserted: 0, skipped: 0, via: "spool_lock_busy" };
		}
		logHookEvent("codemem pi-hook-ingest failed: unlocked fallback and spool failed");
		throw err;
	}
}

const piHookCmd = new Command("pi-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest pi extension event: HTTP first, direct DB fallback");

addDbOption(piHookCmd);
addViewerHostOptions(piHookCmd);

export const piHookIngestCommand = piHookCmd.action(
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
			const result = await ingestPiHookPayload(payload, opts);
			console.log(JSON.stringify(result));
		} catch (err) {
			emitStructuredError("ingest_error", err instanceof Error ? err.message : String(err));
		}
	},
);
