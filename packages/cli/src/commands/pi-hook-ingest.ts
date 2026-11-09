/**
 * codemem pi-hook-ingest — read a single pi extension event JSON from stdin
 * and enqueue it for raw-event processing.
 *
 * Queue-first strategy: POST to the running viewer's /api/pi-hooks endpoint,
 * then durably spool ordinary transport failures for ordered HTTP recovery.
 * session_before_compact / session_shutdown retain serialized direct ingest
 * and synchronous flush as their terminal safeguard.
 *
 * Usage (from the pi extension CLI fallback):
 *   echo '{"piEvent":"session_start","sessionId":"...","cwd":"..."}' \
 *     | codemem pi-hook-ingest
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildPiFlushSignalFromEvent,
	buildRawEventEnvelopeFromPiEvent,
	connect,
	DEFAULT_RAW_EVENT_FLUSH_MAX_EVENTS,
	ensureSchemaBootstrapped,
	flushRawEvents,
	ingestRawEvents,
	loadSqliteVec,
	MemoryStore,
	ObserverClient,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, addViewerHostOptions, type DbOpts, resolveDbOpt } from "../shared-options.js";
import { logHookEvent } from "./claude-hook-plugin-log.js";
import { classifyNativeHookHttpFailure } from "./hook-delivery-outcome.js";
import {
	retainNativeHookRejection,
	retainNativeHookRejectionWithLock,
} from "./native-hook-terminal-retention.js";
import {
	drainPiHookSpool,
	hasPiHookSpooledEntries,
	hasSpooledPiHookPayload,
	PiHookLockBusyError,
	piHookLockTtlSeconds,
	piHookSpoolDir,
	recoverStalePiHookTmpSpool,
	removeSpooledPiHookPayload,
	shouldForcePiBoundaryFlush,
	spoolPiHookPayload,
	spoolPiHookPayloadWithReceipt,
	withPiHookIngestLock,
} from "./pi-hook-ingest-spool.js";
import { isViewerTargetConflict, rawEventTarget } from "./raw-event-target.js";

type IngestVia = "http" | "direct" | "spool" | "spool_lock_busy";
type IngestResult = { inserted: number; skipped: number; via: IngestVia };
type HttpIngestResult = {
	ok: boolean;
	inserted: number;
	skipped: number;
	queued?: number;
	targetMismatch?: boolean;
	failureOutcome?: ReturnType<typeof classifyNativeHookHttpFailure>;
};
type IngestLock = <T>(fn: () => Promise<T> | T) => Promise<T>;
type IngestOpts = { host: string; port: string | number } & DbOpts;
type BoundaryFlush = (
	payload: Record<string, unknown>,
	dbPath: string,
	receipt?: string,
) => Promise<boolean | undefined> | boolean | undefined;
type IngestDeps = {
	httpIngest?: typeof tryHttpIngest;
	directIngest?: typeof directEnqueuePiHook;
	resolveDb?: typeof resolveDbPath;
	boundaryFlush?: BoundaryFlush;
	withLock?: IngestLock;
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
): Promise<HttpIngestResult> {
	const url = `http://${host}:${port}/api/pi-hooks`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), httpTimeoutMs());
	try {
		const requestBody = JSON.stringify(payload);
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: requestBody,
			signal: controller.signal,
		});
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			const failureOutcome = classifyNativeHookHttpFailure({
				status: res.status,
				responseBody: body,
				outgoingBytes: Buffer.byteLength(requestBody, "utf8"),
				redirected: res.redirected,
			});
			return {
				ok: false,
				inserted: 0,
				skipped: 0,
				targetMismatch: isViewerTargetConflict(res.status, body),
				...(failureOutcome ? { failureOutcome } : {}),
			};
		}

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
		if (typeof obj.accepted === "number" && typeof obj.queued === "number") {
			return { ok: true, inserted: 0, skipped: 0, queued: obj.queued };
		}
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

	// Attribution contract (D3): source is always the envelope's literal
	// "pi" — ingestRawEvents derives it from the envelope, never a default.
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
		const result = ingestRawEvents({ db }, envelope);
		return { inserted: result.inserted, skipped: result.skipped };
	} finally {
		db.close();
	}
}

/**
 * Best-effort boundary flush for session_before_compact / session_shutdown.
 * Always passes source "pi" — never relies on a helper default.
 * Returns false until the captured boundary is complete, retaining the receipt
 * for the next invocation. Each attempt extracts at most one batch.
 */
async function flushBoundaryRawEvents(
	payload: Record<string, unknown>,
	dbPath: string,
	receipt?: string,
): Promise<boolean> {
	const envelope = buildRawEventEnvelopeFromPiEvent(payload);
	const signal = buildPiFlushSignalFromEvent(payload);
	const sessionId = envelope?.session_stream_id ?? signal?.session_id ?? null;
	if (!sessionId) return true;

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
		return false;
	}

	let store: MemoryStore;
	try {
		store = new MemoryStore(dbPath);
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush store init failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}

	try {
		const throughEventSeq = capturePiBoundaryCeiling(store, sessionId, payload, receipt);
		await flushRawEvents(
			store,
			{ observer },
			{
				opencodeSessionId: sessionId,
				source,
				cwd,
				project,
				startedAt,
				maxEvents: DEFAULT_RAW_EVENT_FLUSH_MAX_EVENTS,
				throughEventSeq,
			},
		);
		return isPiBoundaryComplete(store, sessionId, throughEventSeq);
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush raw events failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	} finally {
		store.close();
	}
}

const BOUNDARY_CEILING_FIELD = "_codememBoundaryThroughEventSeq";

function isPiBoundaryComplete(
	store: MemoryStore,
	sessionId: string,
	throughEventSeq: number,
): boolean {
	const cursor = store.rawEventFlushState(sessionId, "pi");
	return (
		cursor >= throughEventSeq ||
		store.rawEventsSinceBySeq(sessionId, "pi", cursor, 1, throughEventSeq).length === 0
	);
}

function capturePiBoundaryCeiling(
	store: MemoryStore,
	sessionId: string,
	payload: Record<string, unknown>,
	receipt?: string,
): number {
	const saved = payload[BOUNDARY_CEILING_FIELD];
	if (typeof saved === "number" && Number.isSafeInteger(saved) && saved >= -1) return saved;
	const ceiling = Number(store.rawEventSessionMeta(sessionId, "pi").last_received_event_seq ?? -1);
	if (!Number.isSafeInteger(ceiling) || ceiling < -1) {
		throw new Error("invalid Pi boundary event sequence");
	}
	if (receipt) {
		// Keep the original target across retries so new arrivals cannot prolong
		// this receipt forever. Persist it before any observer work starts.
		const dir = piHookSpoolDir();
		const temporary = join(dir, `.hook-tmp-boundary-${receipt}.tmp`);
		try {
			writeFileSync(temporary, JSON.stringify({ ...payload, [BOUNDARY_CEILING_FIELD]: ceiling }));
			renameSync(temporary, join(dir, receipt));
		} finally {
			try {
				unlinkSync(temporary);
			} catch {
				// The successful rename already removed the temporary file.
			}
		}
	}
	return ceiling;
}

type DirectFallback = { ok: true; result: { inserted: number; skipped: number } } | { ok: false };
type PiBoundaryResult =
	| { ok: true; boundaryState: "complete"; result: { inserted: number; skipped: number } }
	| { ok: false; boundaryState: "pending" };

type PiIngestRuntime = {
	payload: Record<string, unknown>;
	opts: IngestOpts;
	port: number;
	httpIngest: typeof tryHttpIngest;
	directIngest: typeof directEnqueuePiHook;
	boundaryFlush: BoundaryFlush;
	boundaryFlushAttempted: boolean;
	withLock: IngestLock;
	getDbPath: () => string;
	httpPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
};

function dbPathGetter(resolveDb: typeof resolveDbPath, opts: IngestOpts): () => string {
	let cached: string | null = null;
	return () => {
		if (cached === null) cached = resolveDb(resolveDbOpt(opts));
		return cached;
	};
}

function tryDirectFallback(
	runtime: PiIngestRuntime,
	queued: Record<string, unknown>,
): DirectFallback {
	try {
		return { ok: true, result: runtime.directIngest(queued, runtime.getDbPath()) };
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest direct fallback failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { ok: false };
	}
}

async function writeAndFlushBoundary(
	runtime: PiIngestRuntime,
	payload: Record<string, unknown>,
	receipt: string,
): Promise<PiBoundaryResult> {
	if (runtime.boundaryFlushAttempted) return { ok: false, boundaryState: "pending" };
	const direct = tryDirectFallback(runtime, payload);
	if (!direct.ok) return { ok: false, boundaryState: "pending" };
	// Every receipt in this invocation shares one local extraction allowance.
	// Queued HTTP acknowledgments can still transfer later receipts to the Viewer.
	runtime.boundaryFlushAttempted = true;
	try {
		const flushed = await runtime.boundaryFlush(payload, runtime.getDbPath(), receipt);
		if (flushed === false) {
			logHookEvent("codemem pi-hook-ingest boundary flush failed; keeping spooled payload");
			return { ok: false, boundaryState: "pending" };
		}
		return { ...direct, boundaryState: "complete" };
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush failed; keeping spooled payload: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { ok: false, boundaryState: "pending" };
	}
}

/** Wrap one payload with the db/identity target fields /api/pi-hooks expects. */
function targetedPiPayload(
	payload: Record<string, unknown>,
	getDbPath: () => string,
): Record<string, unknown> {
	return { ...payload, ...rawEventTarget(getDbPath()) };
}

function createPiIngestRuntime(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps,
): PiIngestRuntime {
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const getDbPath = dbPathGetter(resolveDb, opts);
	return {
		payload,
		opts,
		port: typeof opts.port === "number" ? opts.port : Number.parseInt(opts.port, 10),
		httpIngest: deps.httpIngest ?? tryHttpIngest,
		directIngest: deps.directIngest ?? directEnqueuePiHook,
		boundaryFlush: deps.boundaryFlush ?? flushBoundaryRawEvents,
		boundaryFlushAttempted: false,
		withLock: deps.withLock ?? withPiHookIngestLock,
		getDbPath,
		httpPayload: (queued) => targetedPiPayload(queued, getDbPath),
	};
}

function stabilizePiBoundaryPayload(payload: Record<string, unknown>): Record<string, unknown> {
	if (!shouldForcePiBoundaryFlush(payload)) return payload;
	const envelope = buildRawEventEnvelopeFromPiEvent(payload);
	const signal = envelope === null ? buildPiFlushSignalFromEvent(payload) : null;
	const timestamp = envelope?.payload.timestamp ?? signal?.ts;
	if (typeof timestamp !== "string") return payload;
	return { ...payload, ts: timestamp };
}

function spoolPiPayloadOrThrow(payload: Record<string, unknown>): IngestResult {
	if (spoolPiHookPayload(payload)) return { inserted: 0, skipped: 0, via: "spool" };
	throw new Error("pi-hook-ingest: HTTP and spool failed");
}

async function deliverQueuedPiHook(
	runtime: PiIngestRuntime,
	queuedPayload: Record<string, unknown>,
	receipt: string,
): Promise<{
	accepted: boolean;
	boundaryState: "not_required" | "complete" | "pending";
	httpResult: HttpIngestResult;
	directResult: { inserted: number; skipped: number } | null;
}> {
	const result = await runtime.httpIngest(
		runtime.httpPayload(queuedPayload),
		runtime.opts.host,
		runtime.port,
	);
	const boundaryRequested = shouldForcePiBoundaryFlush(queuedPayload);
	if (result.ok && (result.queued !== undefined || !boundaryRequested)) {
		return {
			accepted: true,
			boundaryState: "not_required",
			httpResult: result,
			directResult: null,
		};
	}
	if (!boundaryRequested)
		return {
			accepted: false,
			boundaryState: "not_required",
			httpResult: result,
			directResult: null,
		};
	const boundary = await writeAndFlushBoundary(runtime, queuedPayload, receipt);
	if (!boundary.ok)
		return {
			accepted: false,
			boundaryState: boundary.boundaryState,
			httpResult: result,
			directResult: null,
		};
	return {
		accepted: true,
		boundaryState: boundary.boundaryState,
		httpResult: result,
		directResult: result.ok ? null : boundary.result,
	};
}

async function ingestPiBoundaryDirect(
	runtime: PiIngestRuntime,
	receipt: string,
): Promise<IngestResult> {
	const boundary = await writeAndFlushBoundary(runtime, runtime.payload, receipt);
	if (!boundary.ok) return { inserted: 0, skipped: 0, via: "spool" };
	removeSpooledPiHookPayload(receipt);
	return { ...boundary.result, via: "direct" };
}

type PiBacklogDrain = {
	currentHandled: boolean;
	currentAccepted: boolean;
	currentRetentionAttempted: boolean;
	currentResult: HttpIngestResult | null;
	boundaryResult: IngestResult | null;
};

async function drainPiBacklog(
	runtime: PiIngestRuntime,
	currentReceipt: string,
): Promise<PiBacklogDrain> {
	let currentResult: HttpIngestResult | null = null;
	let currentAccepted = false;
	let currentHandled = false;
	let currentRetentionAttempted = false;
	let boundaryResult: IngestResult | null = null;
	try {
		await runtime.withLock(async () => {
			recoverStalePiHookTmpSpool(piHookLockTtlSeconds());
			await drainPiHookSpool(
				async (queuedPayload, receipt) => {
					const delivery = await deliverQueuedPiHook(runtime, queuedPayload, receipt);
					if (receipt === currentReceipt) {
						currentResult = delivery.httpResult;
						currentAccepted = delivery.accepted;
						if (delivery.directResult) {
							boundaryResult = { ...delivery.directResult, via: "direct" };
						}
					}
					if (delivery.accepted) return true;
					// A saved ceiling or pending local boundary obligation must stay on the ordinary retry path.
					if (
						delivery.boundaryState === "pending" ||
						Object.hasOwn(queuedPayload, BOUNDARY_CEILING_FIELD)
					)
						return false;
					return delivery.httpResult.failureOutcome || false;
				},
				{
					retainTerminal: ({ receipt, rejection }) => {
						if (receipt === currentReceipt) currentRetentionAttempted = true;
						return retainNativeHookRejection({
							provider: "pi",
							dir: piHookSpoolDir(),
							receipt,
							rejection,
						});
					},
				},
			);
			currentHandled =
				currentRetentionAttempted || currentAccepted || !hasSpooledPiHookPayload(currentReceipt);
		});
	} catch (error) {
		if (!(error instanceof PiHookLockBusyError)) {
			logHookEvent(
				`codemem pi-hook-ingest backlog drain failed: ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}
	return {
		currentHandled,
		currentAccepted,
		currentRetentionAttempted,
		currentResult,
		boundaryResult,
	};
}

async function processStandaloneBoundaryReceipt(
	runtime: PiIngestRuntime,
	receipt: string,
): Promise<IngestResult> {
	try {
		return await runtime.withLock(async () => {
			recoverStalePiHookTmpSpool(piHookLockTtlSeconds());
			if (!hasSpooledPiHookPayload(receipt)) {
				return { inserted: 0, skipped: 0, via: "spool" };
			}
			return await ingestPiBoundaryDirect(runtime, receipt);
		});
	} catch (error) {
		if (!(error instanceof PiHookLockBusyError)) throw error;
		return { inserted: 0, skipped: 0, via: "spool_lock_busy" };
	}
}

async function retainAndProcessBoundary(runtime: PiIngestRuntime): Promise<IngestResult> {
	const receipt = spoolPiHookPayloadWithReceipt(runtime.payload);
	if (receipt === null) throw new Error("pi-hook-ingest: failed to spool boundary payload");
	return await processStandaloneBoundaryReceipt(runtime, receipt);
}

async function ingestPiWithoutBacklog(
	runtime: PiIngestRuntime,
	boundaryRequested: boolean,
): Promise<IngestResult> {
	const httpResult = await runtime.httpIngest(
		runtime.httpPayload(runtime.payload),
		runtime.opts.host,
		runtime.port,
	);
	if (httpResult.ok) {
		if (boundaryRequested && httpResult.queued === undefined) {
			const boundary = await retainAndProcessBoundary(runtime);
			if (boundary.via !== "direct") return boundary;
		}
		return { inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" };
	}
	if (boundaryRequested) return await retainAndProcessBoundary(runtime);
	const rejection = httpResult.failureOutcome;
	if (!rejection) return spoolPiPayloadOrThrow(runtime.payload);
	const receipt = spoolPiHookPayloadWithReceipt(runtime.payload);
	if (receipt === null) throw new Error("pi-hook-ingest: HTTP and spool failed");
	await retainNativeHookRejectionWithLock({
		provider: "pi",
		dir: piHookSpoolDir(),
		receipt,
		rejection,
		withLock: runtime.withLock,
	});
	return { inserted: 0, skipped: 0, via: "spool" };
}

/** Ingest one Pi event through the Viewer queue or local spool. */
export async function ingestPiHookPayload(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps = {},
): Promise<IngestResult> {
	// Only recovered receipts may carry a previously captured ceiling. A live
	// caller cannot choose a ceiling that skips its pending extraction work.
	const { [BOUNDARY_CEILING_FIELD]: _ignoredCeiling, ...livePayload } = payload;
	const stablePayload = stabilizePiBoundaryPayload(livePayload);
	const runtime = createPiIngestRuntime(stablePayload, opts, deps);
	const boundaryRequested = shouldForcePiBoundaryFlush(stablePayload);
	if (hasPiHookSpooledEntries()) {
		const receipt = spoolPiHookPayloadWithReceipt(stablePayload);
		if (receipt === null) {
			throw new Error("pi-hook-ingest: failed to spool current payload before backlog recovery");
		}
		const recovery = await drainPiBacklog(runtime, receipt);
		if (recovery.currentRetentionAttempted) return { inserted: 0, skipped: 0, via: "spool" };
		if (recovery.boundaryResult !== null) return recovery.boundaryResult;
		if (recovery.currentAccepted && recovery.currentResult?.ok) {
			return {
				inserted: recovery.currentResult.inserted,
				skipped: recovery.currentResult.skipped,
				via: "http",
			};
		}
		if (recovery.currentHandled) return { inserted: 0, skipped: 0, via: "spool" };
		return { inserted: 0, skipped: 0, via: "spool" };
	}

	return await ingestPiWithoutBacklog(runtime, boundaryRequested);
}

const piHookCmd = new Command("pi-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest pi extension event: durable HTTP queue with local spool fallback");

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
