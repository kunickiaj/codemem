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

export interface PiImportRunResult {
	summary: PiImportSummary;
	/** Events flushed through the observer when --extract was set; null otherwise. */
	extractedEvents: number | null;
}

/**
 * Import sessions, then — when --extract is set — drain the imported pi
 * sessions through the standard flush path. Returns the import summary plus
 * the observer-flushed event count (null when extraction was not requested).
 */
export async function runPiImportSessions(
	opts: PiImportOpts,
	deps: PiImportDeps = {},
): Promise<PiImportRunResult> {
	const dbPath = resolveDbPath(resolveDbOpt(opts));
	const summary = importPiSessions({ dbPath, onProgress: deps.onProgress });
	const extractedEvents = opts.extract
		? await flushImportedPiSessions(dbPath, deps.observer)
		: null;
	return { summary, extractedEvents };
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
): Promise<number> {
	const store: MemoryStore = new MemoryStore(dbPath);
	try {
		let resolved: ObserverClient;
		try {
			resolved = observer ?? new ObserverClient();
		} catch (err) {
			p.log.warn(
				`extraction unavailable (observer init failed): ${err instanceof Error ? err.message : String(err)}`,
			);
			return 0;
		}
		let flushed = 0;
		const attempted = new Set<string>();
		let pending = piPendingSessions(store, attempted);
		while (pending.length > 0) {
			for (const streamId of pending) {
				attempted.add(streamId);
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
					flushed += result.flushed;
				} catch (err) {
					p.log.warn(
						`extraction failed for session ${streamId}: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			pending = piPendingSessions(store, attempted);
		}
		return flushed;
	} finally {
		store.close();
	}
}

/** Pending-flush sessions attributed to source "pi" that were not attempted yet. */
function piPendingSessions(store: MemoryStore, attempted: Set<string>): string[] {
	return store
		.rawEventSessionsPendingFlush()
		.filter((session) => session.source === "pi" && session.streamId)
		.map((session) => session.streamId)
		.filter((streamId) => !attempted.has(streamId));
}

/** Human-readable summary line; per-file progress is streamed by the caller. */
export function formatPiImportHuman(result: PiImportRunResult): string {
	const summary = result.summary;
	const lines = [
		`Scanned ${summary.filesScanned} files: ${summary.filesImported} imported, ${summary.filesUnchanged} unchanged, ${summary.filesEmpty} empty, ${summary.filesErrored} errored — ${summary.inserted} events inserted, ${summary.skipped} skipped.`,
	];
	if (result.extractedEvents !== null) {
		lines.push(`Extraction: observer flushed ${result.extractedEvents} events into memories.`);
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
		if (opts.json) {
			console.log(JSON.stringify(result.summary, null, 2));
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
