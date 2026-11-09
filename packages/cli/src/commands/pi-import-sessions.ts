/**
 * codemem session import — backfill Pi agent session history.
 *
 * Thin wrapper over core importPiSessions: walks every session JSONL file under
 * <pi-agent-dir>/sessions (project subdirs included, PI_CODING_AGENT_DIR honored).
 *
 * Immediate extraction is opt-in (--extract, off by default): it runs the observer model over
 * the imported history, which costs tokens proportional to backlog size. With
 * --extract the STANDARD flush path (flushRawEvents — the same function the
 * raw-event sweeper calls each tick) runs over the imported pi sessions; there is
 * no bespoke extraction pipeline. Without it, imported events are stored searchable
 * and a running service may process them later like any other backlog.
 */

import * as p from "@clack/prompts";
import {
	DEFAULT_RAW_EVENT_FLUSH_MAX_EVENTS,
	flushRawEvents,
	importPiSessions,
	MemoryStore,
	ObserverClient,
	type PiImportProgress,
	type PiImportSummary,
	resolveDbPath,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

const EXTRACT_COST_NOTE =
	"extract immediately (runs the observer model; cost scales with imported history)";

interface PiImportOpts extends DbOpts, JsonOpts {
	extract?: boolean;
}

export interface PiImportDeps {
	/** Per-file progress sink (human mode only). */
	onProgress?: (progress: PiImportProgress) => void;
	/** Observer override for tests; defaults to a real ObserverClient. */
	observer?: ObserverClient;
}

export interface PiImportExtractionResult {
	requested: boolean;
	flushedEvents: number;
	failedSessions: number;
	/** Null when extraction was not requested and the backlog was not checked. */
	pendingSessions: number | null;
	error: string | null;
}

export interface PiImportRunResult {
	summary: PiImportSummary;
	extraction: PiImportExtractionResult;
}

/**
 * Import sessions, then — when --extract is set — drain the imported pi
 * sessions through the standard flush path. Returns the import summary plus
 * extraction counts and failures.
 */
export async function runPiImportSessions(
	opts: PiImportOpts,
	deps: PiImportDeps = {},
): Promise<PiImportRunResult> {
	const dbPath = resolveDbPath(resolveDbOpt(opts));
	const summary = importPiSessions({ dbPath, onProgress: deps.onProgress });
	const extraction = opts.extract
		? await flushImportedPiSessions(dbPath, deps.observer)
		: { requested: false, flushedEvents: 0, failedSessions: 0, pendingSessions: null, error: null };
	return { summary, extraction };
}

/**
 * Run the existing raw-event flush (the sweeper's own flushRawEvents) over
 * every pending source-"pi" session — never a bespoke extraction path. Fails
 * open per session: a failed flush batch stays retryable by the sweeper's
 * pending-queue phase, exactly like live-session flush failures.
 */
export async function flushImportedPiSessions(
	dbPath: string,
	observer?: ObserverClient,
): Promise<PiImportExtractionResult> {
	const store: MemoryStore = new MemoryStore(dbPath);
	const extraction: PiImportExtractionResult = {
		requested: true,
		flushedEvents: 0,
		failedSessions: 0,
		pendingSessions: 0,
		error: null,
	};
	try {
		let resolved: ObserverClient;
		try {
			resolved = observer ?? new ObserverClient();
		} catch (err) {
			extraction.error = `observer init failed: ${err instanceof Error ? err.message : String(err)}`;
			extraction.pendingSessions = piPendingSessions(store).length;
			return extraction;
		}
		// Capture every ceiling before extraction, including streams processed later.
		const backlog = piPendingSessions(store).map((streamId) => ({
			streamId,
			throughEventSeq: Number(store.rawEventSessionMeta(streamId, "pi").last_received_event_seq),
			initialCursor: store.rawEventFlushState(streamId, "pi"),
		}));
		for (const stream of backlog) {
			try {
				await drainImportedPiStream(store, resolved, stream, extraction);
			} catch (err) {
				extraction.failedSessions++;
				extraction.error ??= `session ${stream.streamId}: ${err instanceof Error ? err.message : String(err)}`;
			}
		}
		extraction.pendingSessions = piPendingSessions(store).length;
		return extraction;
	} finally {
		store.close();
	}
}

async function drainImportedPiStream(
	store: MemoryStore,
	observer: ObserverClient,
	stream: { streamId: string; throughEventSeq: number; initialCursor: number },
	extraction: PiImportExtractionResult,
): Promise<void> {
	const { streamId, throughEventSeq, initialCursor } = stream;
	const maxAttempts = Math.max(0, throughEventSeq - initialCursor);
	if (
		!Number.isSafeInteger(throughEventSeq) ||
		!Number.isSafeInteger(initialCursor) ||
		!Number.isSafeInteger(maxAttempts) ||
		throughEventSeq < -1 ||
		initialCursor < -1
	) {
		throw new Error("invalid Pi import event sequence");
	}
	// Host-generation splits can produce batches smaller than 100. Each
	// progressing iteration advances at least one integer sequence, so the
	// captured sequence span bounds attempts even when every batch has one event.
	let cursor = initialCursor;
	for (let attempt = 0; attempt < maxAttempts && cursor < throughEventSeq; attempt++) {
		const result = await flushRawEvents(
			store,
			{ observer },
			{
				opencodeSessionId: streamId,
				source: "pi",
				cwd: null,
				project: null,
				startedAt: null,
				maxEvents: DEFAULT_RAW_EVENT_FLUSH_MAX_EVENTS,
				throughEventSeq,
			},
		);
		extraction.flushedEvents += result.flushed;
		const nextCursor = store.rawEventFlushState(streamId, "pi");
		if (!Number.isSafeInteger(nextCursor)) throw new Error("invalid Pi import flush cursor");
		if (nextCursor <= cursor) break;
		cursor = nextCursor;
	}
}

/** Pending-flush sessions attributed to source "pi", without a page cap. */
function piPendingSessions(store: MemoryStore): string[] {
	return store.rawEventSessionsPendingFlush(null, "pi").map((session) => session.streamId);
}

/** Human-readable summary line; per-file progress is streamed by the caller. */
export function formatPiImportHuman(result: PiImportRunResult): string {
	const { summary, extraction } = result;
	const lines = [
		`Scanned ${summary.filesScanned} files: ${summary.filesImported} imported, ${summary.filesUnchanged} unchanged, ${summary.filesEmpty} empty, ${summary.filesErrored} errored — ${summary.inserted} events inserted, ${summary.skipped} skipped.`,
	];
	if (extraction.requested) {
		lines.push(`Extraction: observer flushed ${extraction.flushedEvents} events into memories.`);
		if (extraction.failedSessions > 0 || (extraction.pendingSessions ?? 0) > 0) {
			lines.push(
				`${extraction.failedSessions} sessions failed; ${extraction.pendingSessions} remain pending.`,
			);
		}
		if (extraction.error) lines.push(`Extraction error: ${extraction.error}`);
	}
	return lines.join("\n");
}

function logProgress(progress: PiImportProgress): void {
	const name = progress.file;
	if (progress.status === "imported") {
		p.log.info(`imported ${name} (+${progress.inserted} events)`);
	} else if (progress.status === "unchanged") {
		p.log.info(`unchanged ${name}`);
	} else if (progress.status === "empty") {
		p.log.info(`empty ${name}`);
	} else {
		p.log.warn(`error ${name}: ${progress.error ?? "unknown error"}`);
	}
}

export function createPiImportSessionsCommand(): Command {
	const cmd = new Command("pi-import-sessions")
		.configureHelp(helpStyle)
		.description("Import Pi session history")
		.option("--extract", EXTRACT_COST_NOTE)
		.addHelpText(
			"after",
			"\nImports stay searchable without --extract. A running service may later process them with the observer model, which can incur model costs.",
		);

	addDbOption(cmd);
	addJsonOption(cmd);
	return cmd.action(piImportSessionsAction);
}

const piImportSessionsAction = async (opts: PiImportOpts) => {
	try {
		const deps: PiImportDeps = opts.json ? {} : { onProgress: logProgress };
		const result = await runPiImportSessions(opts, deps);
		const { extraction } = result;
		let extractionFailure: string | undefined;
		if (
			extraction.error ||
			extraction.failedSessions > 0 ||
			(extraction.pendingSessions ?? 0) > 0
		) {
			extractionFailure =
				extraction.error ??
				`${extraction.failedSessions} sessions failed; ${extraction.pendingSessions} remain pending.`;
			process.exitCode = 1;
		}
		if (opts.json) {
			console.log(
				JSON.stringify(
					{
						...result.summary,
						extraction,
						error: extractionFailure ? "pi_extraction_incomplete" : undefined,
						message: extractionFailure,
					},
					null,
					2,
				),
			);
			return;
		}
		p.log.message(formatPiImportHuman(result));
	} catch (error) {
		const message = error instanceof Error ? error.message : "pi-import-sessions failed";
		if (opts.json) {
			emitJsonError("pi_import_sessions_failed", message);
		} else {
			p.log.error(message);
			process.exitCode = 1;
		}
	}
};

export const piImportSessionsCommand = createPiImportSessionsCommand();
