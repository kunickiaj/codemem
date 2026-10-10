/**
 * codemem pi-import-sessions — backfill pi agent session history (design D3/D4).
 *
 * Thin wrapper over core importPiSessions: walks every session JSONL file under
 * <pi-agent-dir>/sessions (project subdirs included, PI_CODING_AGENT_DIR honored).
 *
 * Extraction is opt-in (--extract, off by default): it runs the observer model over
 * the imported history, which costs tokens proportional to backlog size. With
 * --extract the STANDARD flush path (flushRawEvents — the same function the
 * raw-event sweeper calls each tick) runs over the imported pi sessions; there is
 * no bespoke extraction pipeline. Without it, imported events are stored searchable
 * and the running viewer's sweeper picks them up like any other backlog.
 */

import * as p from "@clack/prompts";
import {
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
	"also extract memories (runs the observer model over imported history — LLM cost scales with backlog; default: off, imported events stay searchable)";

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
		// Snapshot the Pi backlog so failed attempts cannot hide later sessions.
		for (const streamId of piPendingSessions(store)) {
			try {
				const result = await flushRawEvents(
					store,
					{ observer: resolved },
					{
						opencodeSessionId: streamId,
						source: "pi",
						cwd: null,
						project: null,
						startedAt: null,
						// One-shot full drain, mirroring the boundary flush pattern.
						maxEvents: null,
					},
				);
				extraction.flushedEvents += result.flushed;
			} catch (err) {
				extraction.failedSessions++;
				extraction.error ??= `session ${streamId}: ${err instanceof Error ? err.message : String(err)}`;
			}
		}
		extraction.pendingSessions = piPendingSessions(store).length;
		return extraction;
	} finally {
		store.close();
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

const cmd = new Command("pi-import-sessions")
	.configureHelp(helpStyle)
	.description("Import pi agent session history into the searchable store")
	.option("--extract", EXTRACT_COST_NOTE);

addDbOption(cmd);
addJsonOption(cmd);

export const piImportSessionsCommand = cmd.action(async (opts: PiImportOpts) => {
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
});
