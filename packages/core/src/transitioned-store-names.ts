/**
 * On-disk names of a transitioned device store, and the SQL rewriting that lets
 * current code keep using the released names.
 *
 * Every object that holds memory content, or that can rebuild it, gets a name no
 * released client knows: memory text and its FTS index, embeddings, captured
 * transcripts and their flush records, prompts, summaries, artifacts, session
 * metadata (which keeps the first prompt), creation snapshots, extracted concept
 * and file references, replication op payloads (including ops held for a memory
 * stored twice) and the sync identity. The
 * inventory test in `transitioned-store-inventory.test.ts` fails when a table with
 * a content-like column is added without either appearing here or being reviewed
 * as metadata there.
 *
 * Never expose a permanent view or trigger under a released name that routes reads
 * or writes to these objects.
 */
export const transitionedNames = {
	sessions: "project_sessions",
	memory_items: "project_memory_items",
	memory_fts: "project_memory_fts",
	memory_items_ai: "project_memory_items_ai",
	memory_items_au: "project_memory_items_au",
	memory_items_ad: "project_memory_items_ad",
	memory_concept_refs: "project_memory_concept_refs",
	memory_file_refs: "project_memory_file_refs",
	memory_local_creation_snapshots: "project_memory_local_creation_snapshots",
	memory_ambiguous_held_ops: "project_memory_ambiguous_held_ops",
	memory_vectors: "project_memory_vectors",
	memory_vectors_rowids: "project_memory_vectors_rowids",
	memory_vectors_v1: "project_memory_vectors_v1",
	memory_vectors_v1_rowids: "project_memory_vectors_v1_rowids",
	artifacts: "project_artifacts",
	user_prompts: "project_user_prompts",
	session_summaries: "project_session_summaries",
	raw_events: "project_raw_events",
	raw_event_flush_batches: "project_raw_event_flush_batches",
	replication_ops: "project_replication_ops",
	sync_device: "project_sync_device",
} as const;

export type TransitionedName = keyof typeof transitionedNames;

/** Ordinary tables renamed in place. Each exists in every current-schema store. */
export const renamedRequiredTables = [
	"sessions",
	"memory_items",
	"artifacts",
	"user_prompts",
	"session_summaries",
	"raw_events",
	"raw_event_flush_batches",
	"replication_ops",
	"sync_device",
] as const satisfies readonly TransitionedName[];

/** Ordinary tables renamed in place when present. Later creation uses the new name. */
export const renamedOptionalTables = [
	"memory_concept_refs",
	"memory_file_refs",
	"memory_local_creation_snapshots",
	"memory_ambiguous_held_ops",
] as const satisfies readonly TransitionedName[];

const physicalByLogical = new Map<string, string>(Object.entries(transitionedNames));
const logicalByPhysical = new Map<string, string>(
	Object.entries(transitionedNames).map(([logical, physical]) => [physical, logical]),
);

/** Released name when `name` is a transitioned on-disk name, otherwise `name`. */
export function logicalName(name: string): string {
	return logicalByPhysical.get(name.toLowerCase()) ?? name;
}

// Only whole identifiers change. Skip SQL strings, comments and named parameters
// before considering identifier tokens.
const tokens =
	/'(?:''|[^'])*(?:'|$)|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:""|[^"])*(?:"|$)|`(?:``|[^`])*(?:`|$)|\[[^\]]*(?:\]|$)|[:@$][\w$\u0080-\uFFFF]+|[\w$\u0080-\uFFFF]+/gu;

// Statements that look objects up by name. Their string literals and bound
// values name tables, so those are translated too, and their results are
// translated back.
const catalog =
	/\b(?:sqlite_master|sqlite_schema|sqlite_temp_master|sqlite_temp_schema|pragma_table_info|pragma_table_xinfo|pragma_index_list|pragma_foreign_key_list|dbstat)\b/i;

// After these keywords an identifier names a table even when the statement also
// uses the same word as an alias.
const tablePosition = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "REFERENCES", "EXISTS"]);

export function isCatalogSql(sql: string): boolean {
	return catalog.test(sql);
}

type TokenKind = "string" | "comment" | "parameter" | "quoted" | "word";

function kindOf(token: string): TokenKind {
	const first = token[0];
	if (first === "'") return "string";
	if (token.startsWith("--") || token.startsWith("/*")) return "comment";
	if (first === ":" || first === "@" || first === "$") return "parameter";
	if (first === '"' || first === "`" || first === "[") return "quoted";
	return "word";
}

function unquote(token: string): string {
	return token.slice(1, -1).toLowerCase();
}

interface Token {
	text: string;
	kind: TokenKind;
	start: number;
	/** The keyword directly before this token, separated by whitespace only. */
	after: string | null;
	/** Lower-case identifier for words and quoted identifiers. */
	name: string | null;
}

function scan(sql: string): Token[] {
	const scanned: Token[] = [];
	let previous: { word: string; end: number } | null = null;
	for (const match of sql.matchAll(tokens)) {
		const text = match[0];
		const start = match.index ?? 0;
		const kind = kindOf(text);
		if (kind === "comment") {
			scanned.push({ text, kind, start, after: null, name: null });
			continue;
		}
		const adjacent = previous !== null && /^\s*$/.test(sql.slice(previous.end, start));
		let name: string | null = null;
		if (kind === "word") name = text.toLowerCase();
		else if (kind === "quoted") name = unquote(text);
		scanned.push({ text, kind, start, after: adjacent ? (previous?.word ?? null) : null, name });
		previous = kind === "word" ? { word: text.toUpperCase(), end: start + text.length } : null;
	}
	return scanned;
}

function physicalToken(token: Token, aliases: Set<string>, literals: boolean): string {
	if (token.kind === "string") {
		const physical = literals ? physicalByLogical.get(unquote(token.text)) : undefined;
		return physical ? `'${physical}'` : token.text;
	}
	const physical = token.name ? physicalByLogical.get(token.name) : undefined;
	if (!physical || !token.name || token.after === "AS") return token.text;
	if (aliases.has(token.name) && !tablePosition.has(token.after ?? "")) return token.text;
	return token.kind === "quoted" ? `"${physical}"` : physical;
}

/**
 * Released names to on-disk names. A word that the statement also defines with
 * `AS` keeps its spelling except where only a table can appear, so
 * `COUNT(*) AS sessions ... JOIN sessions s` reads the moved table and keeps the
 * result column.
 */
export function physicalSql(sql: string): string {
	const scanned = scan(sql);
	const aliases = new Set(
		scanned.flatMap((token) => (token.after === "AS" && token.name ? [token.name] : [])),
	);
	const literals = isCatalogSql(sql);
	let out = "";
	let cursor = 0;
	for (const token of scanned) {
		out += sql.slice(cursor, token.start) + physicalToken(token, aliases, literals);
		cursor = token.start + token.text.length;
	}
	return out + sql.slice(cursor);
}

/**
 * On-disk names back to released names, for schema text read from the catalog.
 * `ALTER TABLE ... RENAME` writes the new name quoted into dependent triggers and
 * indexes. Released names are plain identifiers and are restored unquoted, as
 * the definitions in this codebase spell them.
 */
export function logicalSql(sql: string): string {
	return sql.replace(tokens, (token) => {
		const kind = kindOf(token);
		if (kind === "comment" || kind === "parameter") return token;
		if (kind === "word") return logicalByPhysical.get(token.toLowerCase()) ?? token;
		const logical = logicalByPhysical.get(unquote(token));
		if (!logical) return token;
		return kind === "string" ? `'${logical}'` : logical;
	});
}

/** Bound values of a catalog statement: released table names become on-disk names. */
export function physicalValue(value: unknown): unknown {
	if (typeof value === "string") return physicalByLogical.get(value.toLowerCase()) ?? value;
	if (Array.isArray(value)) return value.map(physicalValue);
	if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, physicalValue(v)]));
	return value;
}

function logicalText(value: string): string {
	return /^\s*CREATE\s/i.test(value) ? logicalSql(value) : logicalName(value);
}

/** A catalog result row (object, raw array or plucked value) with released names. */
export function logicalRow(row: unknown): unknown {
	if (typeof row === "string") return logicalText(row);
	if (Array.isArray(row)) return row.map((value) => logicalRow(value));
	if (row && typeof row === "object" && Object.getPrototypeOf(row) === Object.prototype)
		return Object.fromEntries(
			Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? logicalText(v) : v]),
		);
	return row;
}
