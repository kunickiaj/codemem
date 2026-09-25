/**
 * Lexical search over stored pi session events (design D1/D5/D6).
 *
 * Queries the existing raw_events store (source "pi") directly — no new
 * tables, indexes, or migrations. Message text lives in the normalized
 * adapter event inside the stored payload envelope
 * (`{ type: "pi.hook", timestamp, _adapter: { event_type, payload } }`,
 * see buildRawEventEnvelopeFromPiEvent); extractPiSessionText is the typed
 * accessor for it.
 *
 * The response shape is the shared contract for the viewer REST route, the
 * pi-extension native tool, and the CLI: results carry source, session id,
 * project, role, and timestamp plus a bounded content snippet, with explicit
 * truncation markers and counts.
 */

import type { Database } from "./db.js";
import { projectColumnClause, projectMatchesFilter } from "./project.js";
import { expandQuery } from "./search.js";

export interface PiSessionTextEvent {
	role: "user" | "assistant";
	text: string;
}

/**
 * Extract user/assistant text from a STORED raw-event payload envelope.
 *
 * mapPiEventPayload stores user message text with adapter event_type
 * "prompt" and assistant text with "assistant", each as `{ text }` inside
 * the adapter payload. Returns null for everything else — session
 * boundaries, tool_call/tool_result events, and malformed rows.
 */
export function extractPiSessionText(payload: unknown): PiSessionTextEvent | null {
	if (payload == null || typeof payload !== "object" || Array.isArray(payload)) return null;
	const envelope = payload as Record<string, unknown>;
	if (envelope.type !== "pi.hook") return null;
	const adapter = envelope._adapter;
	if (adapter == null || typeof adapter !== "object" || Array.isArray(adapter)) return null;
	const adapterRecord = adapter as Record<string, unknown>;
	if (adapterRecord.source !== "pi") return null;
	const eventType = adapterRecord.event_type;
	if (eventType !== "prompt" && eventType !== "assistant") return null;
	const inner = adapterRecord.payload;
	if (inner == null || typeof inner !== "object" || Array.isArray(inner)) return null;
	const text = (inner as Record<string, unknown>).text;
	if (typeof text !== "string" || !text.trim()) return null;
	return { role: eventType === "prompt" ? "user" : "assistant", text: text.trim() };
}

const DEFAULT_SEARCH_LIMIT = 10;
const MIN_SEARCH_LIMIT = 1;
const MAX_SEARCH_LIMIT = 20;
const DEFAULT_SNIPPET_CHARS = 1200;
const MIN_SNIPPET_CHARS = 100;
const MAX_SNIPPET_CHARS = 4000;
/** ~50KB serialized-response ceiling for one search call (D6). */
const TOTAL_OUTPUT_CAP_CHARS = 50_000;
/** Recency-window ceiling for one LIKE pass over raw_events. */
const MAX_SCAN_ROWS = 1000;
/** Lead-in context kept before the first matched token in a snippet. */
const SNIPPET_LEAD_CHARS = 200;

export interface PiSessionSearchOptions {
	/** Filter by project label (raw_event_sessions.project). */
	project?: string | null;
	/** Filter by pi session id (raw_events.stream_id). */
	session_id?: string | null;
	/** Result cap; clamped to 1–20 (default 10). */
	limit?: number;
	/** Per-result snippet cap in chars; clamped to 100–4000 (default 1200). */
	snippet_chars?: number;
}

export interface PiSessionSearchMatch {
	source: "pi";
	session_id: string;
	project: string | null;
	role: "user" | "assistant";
	timestamp: string | null;
	snippet: string;
	snippet_truncated: boolean;
	/** Full stored text length in chars; snippet is a window of it. */
	full_length: number;
}

export interface PiSessionSearchResponse {
	query: string;
	results: PiSessionSearchMatch[];
	returned: number;
	/** Matching text events found inside the recency scan window. */
	total_matches: number;
	/** True when matches were dropped by limit, output cap, or scan window. */
	truncated: boolean;
}

interface ParsedSearchOptions {
	limit: number;
	snippetChars: number;
	sessionId: string;
	projectFilter: string;
}

function parseSearchOptions(options: PiSessionSearchOptions): ParsedSearchOptions {
	const clamp = (value: number | undefined, fallback: number, min: number, max: number): number => {
		if (value == null || typeof value !== "number" || !Number.isFinite(value)) return fallback;
		return Math.min(max, Math.max(min, Math.trunc(value)));
	};
	return {
		limit: clamp(options.limit, DEFAULT_SEARCH_LIMIT, MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT),
		snippetChars: clamp(
			options.snippet_chars,
			DEFAULT_SNIPPET_CHARS,
			MIN_SNIPPET_CHARS,
			MAX_SNIPPET_CHARS,
		),
		sessionId: typeof options.session_id === "string" ? options.session_id.trim() : "",
		projectFilter: typeof options.project === "string" ? options.project.trim() : "",
	};
}

/** Escape SQL LIKE wildcards so tokens match literally (ESCAPE '\'). */
function likePattern(token: string): string {
	const escaped = token.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
	return `%${escaped}%`;
}

interface PiSessionEventRow {
	stream_id: string;
	ts_wall_ms: number | null;
	payload_json: string;
	project: string | null;
}

/**
 * Load candidate rows for the lexical scan: pi-source transcript events whose
 * stored payload JSON contains any query token, most-recent-first. The
 * optional project filter is applied INSIDE this query (before the LIMIT)
 * so the recency window is bounded within the requested scope.
 *
 * ponytail: LIKE scan over raw_events.payload_json — no FTS index or side
 * table by design (D1): per-user pi event volume is modest and this pass is
 * bounded by the recency window below. Upgrade to an FTS5 virtual table +
 * ingest triggers when measured slowness on real histories says so.
 */
function loadCandidateRows(
	db: Database,
	tokens: string[],
	sessionId: string,
	projectFilter: string,
): PiSessionEventRow[] {
	const likeClauses = tokens.map(() => "payload_json LIKE ? ESCAPE '\\'");
	const params: unknown[] = tokens.map(likePattern);
	let sql = `
		SELECT r.stream_id, r.ts_wall_ms, r.payload_json, s.project
		FROM raw_events r
		LEFT JOIN raw_event_sessions s ON s.source = r.source AND s.stream_id = r.stream_id
		WHERE r.source = 'pi' AND r.event_type = 'pi.hook' AND (${likeClauses.join(" OR ")})
	`;

	// SQL-equivalent of projectMatchesFilter (same contract as memory
	// search): keeps the scan window bounded within the requested project —
	// without it, newer rows from other projects would fill the LIMIT and hide
	// valid rows. Superset of the JS check, which still runs per row.
	const projectPrefilter = projectColumnClause("s.project", projectFilter);
	if (projectPrefilter.clause) {
		sql += ` AND ${projectPrefilter.clause}`;
		params.push(...projectPrefilter.params);
	}
	if (sessionId) {
		sql += " AND r.stream_id = ?";
		params.push(sessionId);
	}
	sql += " ORDER BY r.ts_wall_ms DESC, r.id DESC LIMIT ?";
	params.push(MAX_SCAN_ROWS);
	return db.prepare(sql).all(...params) as PiSessionEventRow[];
}

function buildSnippet(
	text: string,
	loweredTokens: string[],
	cap: number,
): { snippet: string; truncated: boolean } {
	if (text.length <= cap) return { snippet: text, truncated: false };
	const lowered = text.toLowerCase();
	let start = 0;
	for (const token of loweredTokens) {
		const idx = lowered.indexOf(token);
		if (idx >= 0) {
			start = Math.max(0, idx - SNIPPET_LEAD_CHARS);
			break;
		}
	}
	return { snippet: text.slice(start, start + cap), truncated: true };
}

function collectMatches(
	rows: PiSessionEventRow[],
	loweredTokens: string[],
	snippetChars: number,
	projectFilter: string,
): PiSessionSearchMatch[] {
	const matches: PiSessionSearchMatch[] = [];
	for (const row of rows) {
		let payload: unknown;
		try {
			payload = JSON.parse(row.payload_json);
		} catch {
			continue;
		}
		const textEvent = extractPiSessionText(payload);
		if (!textEvent) continue;
		// The payload_json prefilter also sees cwd/project/session metadata
		// outside the message; require at least one effective token in the
		// extracted conversation text before returning/counting the row.
		const loweredText = textEvent.text.toLowerCase();
		if (!loweredTokens.some((token) => loweredText.includes(token))) continue;
		if (projectFilter && !projectMatchesFilter(projectFilter, row.project)) continue;
		const snippet = buildSnippet(textEvent.text, loweredTokens, snippetChars);
		matches.push({
			source: "pi",
			session_id: row.stream_id,
			project: row.project,
			role: textEvent.role,
			timestamp:
				row.ts_wall_ms != null && Number.isFinite(row.ts_wall_ms)
					? new Date(row.ts_wall_ms).toISOString()
					: null,
			snippet: snippet.snippet,
			snippet_truncated: snippet.truncated,
			full_length: textEvent.text.length,
		});
	}
	return matches;
}

/**
 * Search stored pi session text by a free-text lexical query.
 *
 * Matches are ordered most-recent-first; no matches yield an explicit empty
 * response (never an error). Tokens reuse the memory-search lexical
 * primitives (expandQuery: alphanumeric tokens minus FTS operators and stop
 * words, OR semantics for broad matching).
 */
export function searchPiSessions(
	db: Database,
	query: string,
	options: PiSessionSearchOptions = {},
): PiSessionSearchResponse {
	const parsed = parseSearchOptions(options);

	// Same tokenization as memory search: expandQuery returns the effective
	// tokens OR-joined, so splitting on " OR " recovers them without
	// duplicating the stop-word/operator lists.
	const expanded = expandQuery(query);
	const tokens = expanded ? expanded.split(" OR ") : [];

	const empty: PiSessionSearchResponse = {
		query,
		results: [],
		returned: 0,
		total_matches: 0,
		truncated: false,
	};
	if (tokens.length === 0) return empty;

	const rows = loadCandidateRows(db, tokens, parsed.sessionId, parsed.projectFilter);
	const windowSaturated = rows.length >= MAX_SCAN_ROWS;
	const loweredTokens = tokens.map((token) => token.toLowerCase());
	const matches = collectMatches(rows, loweredTokens, parsed.snippetChars, parsed.projectFilter);

	const buildResponse = (results: PiSessionSearchMatch[]): PiSessionSearchResponse => ({
		query,
		results,
		returned: results.length,
		total_matches: matches.length,
		truncated: windowSaturated || matches.length > results.length,
	});

	let capped = matches.slice(0, parsed.limit);
	while (
		capped.length > 0 &&
		JSON.stringify(buildResponse(capped)).length > TOTAL_OUTPUT_CAP_CHARS
	) {
		capped = capped.slice(0, -1);
	}
	return buildResponse(capped);
}
