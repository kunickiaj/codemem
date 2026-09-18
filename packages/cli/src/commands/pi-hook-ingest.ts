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
import { readFileSync } from "node:fs";
import {
	buildPiFlushSignalFromEvent,
	buildRawEventEnvelopeFromPiEvent,
	connect,
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
import {
	drainPiHookSpool,
	hasPiHookSpooledEntries,
	hasSpooledPiHookPayload,
	PiHookLockBusyError,
	piHookLockTtlSeconds,
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
};
type IngestLock = <T>(fn: () => Promise<T> | T) => Promise<T>;
type IngestOpts = { host: string; port: string | number } & DbOpts;
type BoundaryFlush = (
	payload: Record<string, unknown>,
	dbPath: string,
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
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
 * Returns false when observer/store/extraction fail so a recovered-boundary
 * retry can keep the spool; live hook callers stay fail-open and ignore it.
 */
async function flushBoundaryRawEvents(
	payload: Record<string, unknown>,
	dbPath: string,
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
		return true;
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush raw events failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	} finally {
		store.close();
	}
}

type DirectFallback = { ok: true; result: { inserted: number; skipped: number } } | { ok: false };

type PiIngestRuntime = {
	payload: Record<string, unknown>;
	opts: IngestOpts;
	port: number;
	httpIngest: typeof tryHttpIngest;
	directIngest: typeof directEnqueuePiHook;
	boundaryFlush: BoundaryFlush;
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
): Promise<DirectFallback> {
	const direct = tryDirectFallback(runtime, payload);
	if (!direct.ok) return direct;
	try {
		const flushed = await runtime.boundaryFlush(payload, runtime.getDbPath());
		if (flushed === false) {
			logHookEvent("codemem pi-hook-ingest boundary flush failed; keeping spooled payload");
			return { ok: false };
		}
		return direct;
	} catch (err) {
		logHookEvent(
			`codemem pi-hook-ingest boundary flush failed; keeping spooled payload: ${err instanceof Error ? err.message : String(err)}`,
		);
		return { ok: false };
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
		withLock: deps.withLock ?? withPiHookIngestLock,
		getDbPath,
		httpPayload: (queued) => targetedPiPayload(queued, getDbPath),
	};
}

function spoolPiPayloadOrThrow(payload: Record<string, unknown>): IngestResult {
	if (spoolPiHookPayload(payload)) return { inserted: 0, skipped: 0, via: "spool" };
	throw new Error("pi-hook-ingest: HTTP and spool failed");
}

async function deliverQueuedPiHook(
	runtime: PiIngestRuntime,
	queuedPayload: Record<string, unknown>,
): Promise<{
	accepted: boolean;
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
		return { accepted: true, httpResult: result, directResult: null };
	}
	if (!boundaryRequested) return { accepted: false, httpResult: result, directResult: null };
	const boundary = await writeAndFlushBoundary(runtime, queuedPayload);
	if (!boundary.ok) return { accepted: false, httpResult: result, directResult: null };
	return {
		accepted: true,
		httpResult: result,
		directResult: result.ok ? null : boundary.result,
	};
}

async function ingestPiBoundaryDirect(
	runtime: PiIngestRuntime,
	receipt: string,
): Promise<IngestResult> {
	const boundary = await writeAndFlushBoundary(runtime, runtime.payload);
	if (!boundary.ok) return { inserted: 0, skipped: 0, via: "spool" };
	removeSpooledPiHookPayload(receipt);
	return { ...boundary.result, via: "direct" };
}

type PiBacklogDrain = {
	currentHandled: boolean;
	currentResult: HttpIngestResult | null;
	boundaryResult: IngestResult | null;
};

async function drainPiBacklog(
	runtime: PiIngestRuntime,
	currentReceipt: string,
	boundaryRequested: boolean,
): Promise<PiBacklogDrain> {
	let currentResult: HttpIngestResult | null = null;
	let currentAccepted = false;
	let currentHandled = false;
	let boundaryResult: IngestResult | null = null;
	try {
		await runtime.withLock(async () => {
			recoverStalePiHookTmpSpool(piHookLockTtlSeconds());
			await drainPiHookSpool(async (queuedPayload, receipt) => {
				const delivery = await deliverQueuedPiHook(runtime, queuedPayload);
				if (receipt === currentReceipt) {
					currentResult = delivery.httpResult;
					currentAccepted = delivery.accepted;
					if (delivery.directResult) {
						boundaryResult = { ...delivery.directResult, via: "direct" };
					}
				}
				return delivery.accepted;
			});
			currentHandled = currentAccepted || !hasSpooledPiHookPayload(currentReceipt);
			if (!currentHandled && boundaryRequested) {
				boundaryResult = await ingestPiBoundaryDirect(runtime, currentReceipt);
			}
		});
	} catch (error) {
		if (!(error instanceof PiHookLockBusyError)) {
			logHookEvent(
				`codemem pi-hook-ingest backlog drain failed: ${error instanceof Error ? error.name : "unknown"}`,
			);
		}
	}
	return { currentHandled, currentResult, boundaryResult };
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

/** Ingest one Pi event through the Viewer queue or local spool. */
export async function ingestPiHookPayload(
	payload: Record<string, unknown>,
	opts: IngestOpts,
	deps: IngestDeps = {},
): Promise<IngestResult> {
	const runtime = createPiIngestRuntime(payload, opts, deps);
	const boundaryRequested = shouldForcePiBoundaryFlush(payload);
	if (hasPiHookSpooledEntries()) {
		const receipt = spoolPiHookPayloadWithReceipt(payload);
		if (receipt === null) {
			throw new Error("pi-hook-ingest: failed to spool current payload before backlog recovery");
		}
		const recovery = await drainPiBacklog(runtime, receipt, boundaryRequested);
		if (recovery.boundaryResult !== null) return recovery.boundaryResult;
		if (recovery.currentResult?.ok) {
			return {
				inserted: recovery.currentResult.inserted,
				skipped: recovery.currentResult.skipped,
				via: "http",
			};
		}
		if (recovery.currentHandled) return { inserted: 0, skipped: 0, via: "spool" };
		return { inserted: 0, skipped: 0, via: "spool" };
	}

	const httpResult = await runtime.httpIngest(
		runtime.httpPayload(payload),
		opts.host,
		runtime.port,
	);
	if (httpResult.ok) {
		if (boundaryRequested && httpResult.queued === undefined) {
			await retainAndProcessBoundary(runtime);
		}
		return { inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" };
	}
	if (!boundaryRequested) return spoolPiPayloadOrThrow(payload);
	return await retainAndProcessBoundary(runtime);
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
