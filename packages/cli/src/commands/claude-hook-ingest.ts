/**
 * codemem claude-hook-ingest — read a single Claude Code hook payload
 * from stdin and enqueue it for processing.
 *
 * Queue-first strategy: POST to the running viewer's durable inbox. Ordinary
 * failures spool locally; boundary events retain direct ingest as a final
 * safeguard.
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
	ingestRawEvents,
	loadSqliteVec,
	MemoryStore,
	ObserverClient,
	resolveDbPath,
	TRUSTED_HOOK_MAPPER_OPTIONS,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addViewerHostOptions, type DbOpts, resolveDbOpt } from "../shared-options.js";
import {
	currentPayloadIsOnlySpooledEntry,
	drainSpool,
	hasSpooledEntries,
	LockBusyError,
	lockTtlSeconds,
	recoverStaleTmpSpool,
	removeSpooledPayload,
	shouldForceBoundaryFlush,
	spoolPayload,
	spoolPayloadWithReceipt,
	withClaudeHookIngestLock,
} from "./claude-hook-ingest-spool.js";
import { logHookEvent } from "./claude-hook-plugin-log.js";
import { trackHookSessionState } from "./claude-hook-session-state.js";
import { isViewerTargetConflict, rawEventTarget } from "./raw-event-target.js";

type IngestVia = "http" | "direct" | "spool";

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

type HttpIngestResult = {
	ok: boolean;
	inserted: number;
	skipped: number;
	queued?: number;
	targetMismatch?: boolean;
	cause?: "timeout" | "connection" | "http_status" | "malformed_response";
	status?: number;
	elapsedMs?: number;
};

type HttpIngestOptions = { flushBoundary?: boolean };

function elapsedSince(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : "unknown";
}

function transportCause(error: unknown): "timeout" | "connection" {
	const diagnostic = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /AbortError|TimeoutError|timeout|timed out|ETIMEDOUT/i.test(diagnostic)
		? "timeout"
		: "connection";
}

function logHttpFailure(result: HttpIngestResult): void {
	const fields = [
		"codemem claude-hook-ingest HTTP failed",
		`cause=${result.targetMismatch ? "target_mismatch" : (result.cause ?? "unknown")}`,
		`elapsed_ms=${result.elapsedMs ?? 0}`,
	];
	if (result.status != null) fields.push(`status=${result.status}`);
	logHookEvent(fields.join(" "));
}

function malformedHttpResult(startedAt: number): HttpIngestResult {
	return {
		ok: false,
		inserted: 0,
		skipped: 0,
		cause: "malformed_response",
		elapsedMs: elapsedSince(startedAt),
	};
}

function acceptedHttpResult(body: unknown, startedAt: number): HttpIngestResult {
	if (body == null || typeof body !== "object" || Array.isArray(body)) {
		logHookEvent("codemem claude-hook-ingest HTTP accepted with invalid response type");
		return malformedHttpResult(startedAt);
	}
	const result = body as Record<string, unknown>;
	if (typeof result.accepted === "number" && typeof result.queued === "number") {
		return {
			ok: true,
			inserted: 0,
			skipped: 0,
			queued: result.queued,
			elapsedMs: elapsedSince(startedAt),
		};
	}
	if (typeof result.inserted === "number" && typeof result.skipped === "number") {
		return {
			ok: true,
			inserted: result.inserted,
			skipped: result.skipped,
			elapsedMs: elapsedSince(startedAt),
		};
	}
	logHookEvent("codemem claude-hook-ingest HTTP accepted with unexpected response body");
	return malformedHttpResult(startedAt);
}

function emitStructuredError(errorCode: string, message: string): void {
	console.log(JSON.stringify({ error: errorCode, message }));
	process.exitCode = 1;
}

/** Try to POST the hook payload to the running viewer server.
 *
 * Returns `ok: true` whenever the viewer accepts the request and returns
 * either the durable queue response or the legacy synchronous response.
 * The latter includes the `{inserted: 0, skipped: 1}` response the
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
export async function tryHttpIngest(
	payload: Record<string, unknown>,
	host: string,
	port: number,
	options: HttpIngestOptions = {},
): Promise<HttpIngestResult> {
	const url = `http://${host}:${port}/api/claude-hooks`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	const startedAt = Date.now();
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(options.flushBoundary ? { "X-Codemem-Boundary-Flush": "1" } : {}),
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			return {
				ok: false,
				inserted: 0,
				skipped: 0,
				targetMismatch: isViewerTargetConflict(res.status, body),
				cause: "http_status",
				status: res.status,
				elapsedMs: elapsedSince(startedAt),
			};
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			logHookEvent("codemem claude-hook-ingest HTTP accepted with invalid response body");
			return malformedHttpResult(startedAt);
		}
		return acceptedHttpResult(body, startedAt);
	} catch (error) {
		return {
			ok: false,
			inserted: 0,
			skipped: 0,
			cause: transportCause(error),
			elapsedMs: elapsedSince(startedAt),
		};
	} finally {
		clearTimeout(timeout);
	}
}

/** Fall back to direct raw-event enqueue via the local SQLite store. */
export function directEnqueue(
	payload: Record<string, unknown>,
	dbPath: string,
): { inserted: number; skipped: number } {
	const envelope = buildRawEventEnvelopeFromHook(payload, TRUSTED_HOOK_MAPPER_OPTIONS);
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
		const result = ingestRawEvents({ db }, envelope);
		return { inserted: result.inserted, skipped: result.skipped };
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
	const envelope = buildRawEventEnvelopeFromHook(payload, TRUSTED_HOOK_MAPPER_OPTIONS);
	if (!envelope) return;

	let observer: ObserverClient;
	try {
		observer = new ObserverClient();
	} catch (err) {
		logHookEvent(
			`codemem claude-hook-ingest boundary flush observer init failed cause=${err instanceof Error ? err.name : "unknown"}`,
		);
		return;
	}

	let store: MemoryStore;
	try {
		store = new MemoryStore(dbPath);
	} catch (err) {
		logHookEvent(
			`codemem claude-hook-ingest boundary flush store init failed cause=${err instanceof Error ? err.name : "unknown"}`,
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
		logHookEvent(
			`codemem claude-hook-ingest boundary flush raw events failed cause=${err instanceof Error ? err.name : "unknown"}`,
		);
	} finally {
		store.close();
	}
}

type ClaudeIngestRuntime = {
	payload: Record<string, unknown>;
	opts: IngestOpts;
	port: number;
	httpIngest: typeof tryHttpIngest;
	directIngest: typeof directEnqueue;
	boundaryFlush: (payload: Record<string, unknown>, dbPath: string) => Promise<void> | void;
	getDbPath: () => string;
	httpPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
};

function createClaudeIngestRuntime(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps,
): ClaudeIngestRuntime {
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	let cachedDbPath: string | null = null;
	const getDbPath = (): string => {
		if (cachedDbPath === null) cachedDbPath = resolveDb(resolveDbOpt(opts));
		return cachedDbPath;
	};
	return {
		payload,
		opts,
		port: typeof opts.port === "number" ? opts.port : Number.parseInt(opts.port, 10),
		httpIngest: deps.httpIngest ?? tryHttpIngest,
		directIngest: deps.directIngest ?? directEnqueue,
		boundaryFlush: deps.boundaryFlush ?? flushBoundaryRawEvents,
		getDbPath,
		httpPayload: (queued) => ({ ...queued, ...rawEventTarget(getDbPath()) }),
	};
}

function spoolClaudePayloadOrThrow(
	payload: Record<string, unknown>,
	message: string,
): IngestResult {
	if (spoolPayload(payload)) return { inserted: 0, skipped: 0, via: "spool" };
	throw new Error(message);
}

function tryClaudeDirectFallback(
	runtime: ClaudeIngestRuntime,
	queued: Record<string, unknown>,
): { ok: true; result: { inserted: number; skipped: number } } | { ok: false } {
	const startedAt = Date.now();
	try {
		const result = runtime.directIngest(queued, runtime.getDbPath());
		logHookEvent(
			`codemem claude-hook-ingest direct fallback ok elapsed_ms=${elapsedSince(startedAt)}`,
		);
		return { ok: true, result };
	} catch (error) {
		logHookEvent(
			`codemem claude-hook-ingest direct fallback failed elapsed_ms=${elapsedSince(startedAt)} cause=${error instanceof Error ? error.name : "unknown"}`,
		);
		return { ok: false };
	}
}

async function flushClaudeBoundary(runtime: ClaudeIngestRuntime): Promise<void> {
	const startedAt = Date.now();
	try {
		await runtime.boundaryFlush(runtime.payload, runtime.getDbPath());
		logHookEvent(
			`codemem claude-hook-ingest boundary flush ok elapsed_ms=${elapsedSince(startedAt)}`,
		);
	} catch (error) {
		logHookEvent(
			`codemem claude-hook-ingest boundary flush failed elapsed_ms=${elapsedSince(startedAt)} cause=${error instanceof Error ? error.name : "unknown"}`,
		);
	}
}

type ClaudeBacklogDrain = { drained: boolean; lastResult: HttpIngestResult | null };

async function drainClaudeBacklog(runtime: ClaudeIngestRuntime): Promise<ClaudeBacklogDrain> {
	const startedAt = Date.now();
	let lastResult: HttpIngestResult | null = null;
	try {
		await withClaudeHookIngestLock(async () => {
			recoverStaleTmpSpool(lockTtlSeconds());
			await drainSpool(async (queuedPayload) => {
				lastResult = await runtime.httpIngest(
					runtime.httpPayload(queuedPayload),
					runtime.opts.host,
					runtime.port,
					{ flushBoundary: shouldForceBoundaryFlush(queuedPayload) },
				);
				if (!lastResult.ok) logHttpFailure(lastResult);
				return lastResult.ok;
			});
		});
		logHookEvent(`codemem claude-hook-ingest spool drain elapsed_ms=${elapsedSince(startedAt)}`);
		return { drained: !hasSpooledEntries(), lastResult };
	} catch (error) {
		const cause = error instanceof LockBusyError ? "lock_busy" : errorName(error);
		logHookEvent(
			`codemem claude-hook-ingest spool drain deferred cause=${cause} elapsed_ms=${elapsedSince(startedAt)}`,
		);
		return { drained: false, lastResult };
	}
}

async function ingestClaudeBoundaryFallback(
	runtime: ClaudeIngestRuntime,
	currentReceipt: string | null,
): Promise<IngestResult> {
	const startedAt = Date.now();
	const ingestDirect = async (): Promise<IngestResult> => {
		const direct = tryClaudeDirectFallback(runtime, runtime.payload);
		if (!direct.ok) {
			if (currentReceipt !== null) return { inserted: 0, skipped: 0, via: "spool" };
			return spoolClaudePayloadOrThrow(
				runtime.payload,
				"claude-hook-ingest: fallback and spool both failed",
			);
		}
		if (currentReceipt !== null) removeSpooledPayload(currentReceipt);
		await flushClaudeBoundary(runtime);
		return { ...direct.result, via: "direct" };
	};
	try {
		return await withClaudeHookIngestLock(async () => {
			recoverStaleTmpSpool(lockTtlSeconds());
			return await ingestDirect();
		});
	} catch (error) {
		if (!(error instanceof LockBusyError)) throw error;
		logHookEvent(
			`codemem claude-hook-ingest lock busy; trying unlocked fallback elapsed_ms=${elapsedSince(startedAt)}`,
		);
		return await ingestDirect();
	}
}

/**
 * Ingest one Claude hook payload through the Viewer queue or local spool.
 * Boundary events retain locked direct ingestion as the terminal fallback.
 */
export async function ingestClaudeHookPayload(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps = {},
): Promise<IngestResult> {
	// Update per-session state alongside ingestion so claude-hook-inject's
	// retrieval query can draw on prompts/files seen on the ingest path.
	// Failures must never crash the hook command.
	try {
		trackHookSessionState(payload);
	} catch {
		// best-effort
	}
	const runtime = createClaudeIngestRuntime(payload, opts, deps);
	const boundaryRequested = shouldForceBoundaryFlush(payload);
	let currentReceipt: string | null = null;
	if (hasSpooledEntries()) {
		currentReceipt = spoolPayloadWithReceipt(payload);
		if (currentReceipt === null) {
			throw new Error(
				"claude-hook-ingest: failed to spool current payload before backlog recovery",
			);
		}
		const recovery = await drainClaudeBacklog(runtime);
		if (recovery.drained && recovery.lastResult?.ok) {
			return {
				inserted: recovery.lastResult.inserted,
				skipped: recovery.lastResult.skipped,
				via: "http",
			};
		}
		if (boundaryRequested && currentPayloadIsOnlySpooledEntry(currentReceipt)) {
			return await ingestClaudeBoundaryFallback(runtime, currentReceipt);
		}
		return { inserted: 0, skipped: 0, via: "spool" };
	}

	// Unlocked HTTP attempt — fast path when the viewer is up.
	const httpResult = await runtime.httpIngest(
		runtime.httpPayload(payload),
		opts.host,
		runtime.port,
		{
			flushBoundary: boundaryRequested,
		},
	);
	if (httpResult.ok) {
		return { inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" };
	}
	logHttpFailure(httpResult);

	if (!boundaryRequested) {
		return spoolClaudePayloadOrThrow(payload, "claude-hook-ingest: HTTP and spool failed");
	}
	return await ingestClaudeBoundaryFallback(runtime, null);
}

const claudeHookCmd = new Command("claude-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest Claude hook payload: durable HTTP queue with local spool fallback");

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
