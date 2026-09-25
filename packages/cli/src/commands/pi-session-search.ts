/**
 * codemem pi-session-search — search stored pi session conversations.
 *
 * Queries the raw-event store (source "pi") via core searchPiSessions — the
 * same contract as GET /api/pi/sessions/search and the pi-extension
 * memory_session_search tool (design D5). --json prints the exact response
 * object those surfaces return, which is what the extension's CLI fallback
 * parses.
 *
 * Empty results usually mean the index only covers sessions captured since
 * codemem was installed; `codemem pi-import-sessions` backfills history.
 */

import * as p from "@clack/prompts";
import {
	MemoryStore,
	type PiSessionSearchResponse,
	resolveDbPath,
	searchPiSessions,
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

const EMPTY_INDEX_HINT =
	"The index may only cover sessions captured since codemem was installed; " +
	"backfill history with: codemem pi-import-sessions";

interface PiSessionSearchOpts extends DbOpts, JsonOpts {
	project?: string;
	sessionId?: string;
	limit?: string;
	snippetChars?: string;
}

function intOption(value: string | undefined): number | undefined {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Run the session search and return the shared response object.
 * Throws on invalid input or store failure; printing stays with the caller.
 */
export function runPiSessionSearch(
	query: string,
	opts: PiSessionSearchOpts,
): PiSessionSearchResponse {
	if (!query.trim()) throw new Error("query required");
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		return searchPiSessions(store.db, query, {
			project: opts.project,
			session_id: opts.sessionId,
			limit: intOption(opts.limit),
			snippet_chars: intOption(opts.snippetChars),
		});
	} finally {
		store.close();
	}
}

/** Human-readable output: "Found N results" header + attributed snippet lines. */
export function formatPiSessionSearchHuman(response: PiSessionSearchResponse): string {
	if (response.results.length === 0) {
		return `No results found for "${response.query}". ${EMPTY_INDEX_HINT}`;
	}
	const lines = [`Found ${response.returned} results for "${response.query}"`];
	for (const [index, match] of response.results.entries()) {
		const attribution = [
			match.role,
			match.project ?? "no project",
			`session ${match.session_id}`,
			match.timestamp ?? "unknown time",
		].join(" · ");
		const snippet = match.snippet_truncated ? `${match.snippet}…` : match.snippet;
		lines.push(`${index + 1}. ${attribution}`, snippet);
	}
	if (response.truncated) {
		lines.push(`Showing ${response.returned} of ${response.total_matches} matches.`);
	}
	return lines.join("\n");
}

const cmd = new Command("pi-session-search")
	.configureHelp(helpStyle)
	.description("Search stored pi session conversations by text query")
	.argument("<query>", "search query")
	.option("--project <project>", "filter by project label")
	.option("--session-id <id>", "filter by pi session id")
	.option("--limit <n>", "max results (1-20)", "10")
	.option("--snippet-chars <n>", "per-result snippet cap in chars (100-4000)", "1200");

addDbOption(cmd);
addJsonOption(cmd);

export const piSessionSearchCommand = cmd.action((query: string, opts: PiSessionSearchOpts) => {
	try {
		const response = runPiSessionSearch(query, opts);
		if (opts.json) {
			console.log(JSON.stringify(response, null, 2));
			return;
		}
		const text = formatPiSessionSearchHuman(response);
		if (response.results.length === 0) p.log.warn(text);
		else p.log.message(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : "pi-session-search failed";
		if (opts.json) {
			emitJsonError("pi_session_search_failed", message);
		} else {
			p.log.error(message);
			process.exitCode = 1;
		}
	}
});
