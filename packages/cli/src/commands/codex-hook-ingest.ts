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
	ingestRawEvents,
	loadSqliteVec,
	resolveDbPath,
	TRUSTED_HOOK_MAPPER_OPTIONS,
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
import { isViewerTargetConflict, rawEventTarget } from "./raw-event-target.js";

type IngestVia = "http" | "spool";
type IngestResult = { inserted: number; skipped: number; via: IngestVia };
type IngestOpts = { host: string; port: string | number } & DbOpts;

type IngestDeps = {
	httpIngest?: typeof tryHttpIngest;
	resolveDb?: typeof resolveDbPath;
};
type HttpIngestResult = {
	ok: boolean;
	inserted: number;
	skipped: number;
	queued?: number;
	targetMismatch?: boolean;
	cause?: "timeout" | "connection" | "http_status" | "malformed_response" | "invalid_target";
	status?: number;
	elapsedMs?: number;
};

function elapsedSince(startedAt: number): number {
	return Math.max(0, Date.now() - startedAt);
}

function transportCause(error: unknown): "timeout" | "connection" {
	const diagnostic = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	return /AbortError|TimeoutError|timeout|timed out|ETIMEDOUT/i.test(diagnostic)
		? "timeout"
		: "connection";
}

function logHttpFailure(result: HttpIngestResult): void {
	const fields = [
		"codemem codex-hook-ingest HTTP failed",
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
		logHookEvent("codemem codex-hook-ingest HTTP accepted with invalid response type");
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
	logHookEvent("codemem codex-hook-ingest HTTP accepted with unexpected response body");
	return malformedHttpResult(startedAt);
}

// Codex hooks run under a tight wrapper budget (see plugins/codex/scripts/
// ingest-hook.mjs, which kills the CLI after ~2s), so the HTTP enqueue attempt
// uses a short 1s default rather than Claude's 5s. Override with
// CODEMEM_CODEX_HOOK_HTTP_TIMEOUT_MS if a slower viewer needs more headroom.
const DEFAULT_HTTP_TIMEOUT_MS = 1000;

function httpTimeoutMs(): number {
	const parsed = Number.parseInt(process.env.CODEMEM_CODEX_HOOK_HTTP_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_TIMEOUT_MS;
}

// Codex parses a command hook's STDOUT as its hook-output JSON. Always emit the
// canonical continue response there so capture never trips Codex's hook-output
// validation, and route diagnostics/errors to STDERR (which Codex ignores).
// Ingest is best-effort: it must never block the session, so we exit 0.
function emitHookContinue(): void {
	console.log(JSON.stringify({ continue: true }));
}

function logHookDiagnostic(message: string): void {
	console.error(`[codemem] codex-hook-ingest: ${message}`);
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

export function codexViewerBaseUrl(host: string, port: number): string | null {
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) return null;
	const normalizedHost = host
		.trim()
		.toLowerCase()
		.replace(/^\[(.*)\]$/, "$1");
	const ipv4Parts = normalizedHost.split(".");
	const isIpv4Loopback =
		ipv4Parts.length === 4 &&
		ipv4Parts[0] === "127" &&
		ipv4Parts.every(
			(part) => /^\d+$/.test(part) && String(Number(part)) === part && Number(part) <= 255,
		);
	const urlHost =
		normalizedHost === "localhost" || isIpv4Loopback
			? normalizedHost
			: normalizedHost === "::1" || normalizedHost === "0:0:0:0:0:0:0:1"
				? "[::1]"
				: null;
	return urlHost ? `http://${urlHost}:${port}` : null;
}

export async function tryHttpIngest(
	payload: Record<string, unknown>,
	host: string,
	port: number,
): Promise<HttpIngestResult> {
	const baseUrl = codexViewerBaseUrl(host, port);
	if (!baseUrl) {
		return { ok: false, inserted: 0, skipped: 0, cause: "invalid_target", elapsedMs: 0 };
	}
	const url = `${baseUrl}/api/codex-hooks`;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), httpTimeoutMs());
	const startedAt = Date.now();
	try {
		const res = await fetch(url, {
			method: "POST",
			redirect: "manual",
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
				cause: "http_status",
				status: res.status,
				elapsedMs: elapsedSince(startedAt),
			};
		}

		let body: unknown;
		try {
			body = await res.json();
		} catch {
			logHookEvent("codemem codex-hook-ingest HTTP accepted with invalid response body");
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

export function directEnqueueCodexHook(
	payload: Record<string, unknown>,
	dbPath: string,
): { inserted: number; skipped: number } {
	const envelope = buildRawEventEnvelopeFromCodexHook(payload, TRUSTED_HOOK_MAPPER_OPTIONS);
	if (!envelope) return { inserted: 0, skipped: 1 };

	const db = connect(dbPath);
	try {
		try {
			loadSqliteVec(db);
		} catch {
			// sqlite-vec is not required for raw-event enqueue.
		}
		ensureSchemaBootstrapped(db);
		const result = ingestRawEvents({ db }, envelope);
		return { inserted: result.inserted, skipped: result.skipped };
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
	const resolveDb = deps.resolveDb ?? resolveDbPath;
	const port = typeof opts.port === "number" ? opts.port : Number.parseInt(opts.port, 10);
	const ingestPayload = normalizePayloadForIngest(payload);
	let cachedDbPath: string | null = null;
	const getDbPath = (): string => {
		if (cachedDbPath === null) cachedDbPath = resolveDb(resolveDbOpt(opts));
		return cachedDbPath;
	};
	const httpPayload = (queuedPayload: Record<string, unknown>): Record<string, unknown> => ({
		...queuedPayload,
		...rawEventTarget(getDbPath()),
	});
	const drainBacklogIfPresent = async (): Promise<boolean> => {
		if (!hasCodexHookSpooledEntries()) return true;
		const startedAt = Date.now();
		try {
			await withCodexHookIngestLock(async () => {
				recoverStaleCodexHookTmpSpool(codexHookLockTtlSeconds());
				await drainCodexHookSpool(async (queuedPayload) => {
					const queuedHttp = await httpIngest(httpPayload(queuedPayload), opts.host, port);
					if (!queuedHttp.ok) logHttpFailure(queuedHttp);
					return queuedHttp.ok;
				});
			});
			logHookEvent(`codemem codex-hook-ingest spool drain elapsed_ms=${elapsedSince(startedAt)}`);
			return !hasCodexHookSpooledEntries();
		} catch (err) {
			if (err instanceof CodexHookLockBusyError) {
				logHookEvent(
					`codemem codex-hook-ingest spool drain deferred cause=lock_busy elapsed_ms=${elapsedSince(startedAt)}`,
				);
				return false;
			}
			logHookEvent(
				`codemem codex-hook-ingest backlog drain failed cause=${err instanceof Error ? err.name : "unknown"} elapsed_ms=${elapsedSince(startedAt)}`,
			);
			return false;
		}
	};

	if (!(await drainBacklogIfPresent())) {
		if (spoolCodexHookPayload(ingestPayload)) {
			return { inserted: 0, skipped: 0, via: "spool" };
		}
		throw new Error("codex-hook-ingest: backlog recovery and spool both failed");
	}

	const httpResult = await httpIngest(httpPayload(ingestPayload), opts.host, port);
	if (httpResult.ok) {
		return { inserted: httpResult.inserted, skipped: httpResult.skipped, via: "http" };
	}
	logHttpFailure(httpResult);
	if (spoolCodexHookPayload(ingestPayload)) {
		return { inserted: 0, skipped: 0, via: "spool" };
	}
	throw new Error("codex-hook-ingest: HTTP and spool failed");
}

const codexHookCmd = new Command("codex-hook-ingest")
	.configureHelp(helpStyle)
	.description("Ingest Codex hook payload: durable HTTP queue with local spool fallback");

addDbOption(codexHookCmd);
addViewerHostOptions(codexHookCmd);

export const codexHookIngestCommand = codexHookCmd.action(
	async (opts: DbOpts & { host: string; port: string }) => {
		if (envTruthyValue(process.env.CODEMEM_PLUGIN_IGNORE)) {
			emitHookContinue();
			return;
		}

		let raw: string;
		try {
			raw = readFileSync(0, "utf8").trim();
		} catch {
			logHookDiagnostic("failed to read stdin");
			emitHookContinue();
			return;
		}
		if (!raw) {
			emitHookContinue();
			return;
		}

		let payload: Record<string, unknown>;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				logHookDiagnostic("payload must be a JSON object");
				emitHookContinue();
				return;
			}
			payload = parsed as Record<string, unknown>;
		} catch {
			logHookDiagnostic("invalid JSON payload");
			emitHookContinue();
			return;
		}

		try {
			const result = await ingestCodexHookPayload(payload, opts);
			logHookDiagnostic(JSON.stringify(result));
		} catch (err) {
			logHookDiagnostic(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		emitHookContinue();
	},
);
