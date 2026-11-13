import type { Database } from "./db.js";
import { projectColumnClause } from "./project.js";
import { summaryLikeSqlPredicate } from "./summary-memory.js";
import type { AutomaticContext } from "./types.js";

/** Select continuity within the current project when a host session has moved. */
export function automaticSummarySession(
	db: Database,
	context: AutomaticContext | null | undefined,
	project?: string | null,
): number | null | undefined {
	if (context === undefined) return undefined;
	if (context === null) return null;
	const source = context.source.trim().toLowerCase();
	const hostId = context.hostSessionId.trim();
	if (!source || !hostId || hostId.toLowerCase() === "unknown") return null;
	const filter = projectColumnClause("s.project", project ?? "");
	const rows = db
		.prepare(`
		SELECT os.session_id FROM opencode_sessions os JOIN sessions s ON s.id = os.session_id
		WHERE os.source = ? AND os.opencode_session_id = ?
		${filter.clause ? `AND ${filter.clause}` : ""}
		ORDER BY (SELECT MAX(memory_items.created_at) FROM memory_items
			WHERE memory_items.session_id = os.session_id AND memory_items.active = 1
			AND ${summaryLikeSqlPredicate()}) DESC, s.started_at DESC, s.id DESC LIMIT 2
	`)
		.all(source, hostId, ...filter.params) as Array<{ session_id: number }>;
	if (!filter.clause && rows.length > 1) return null;
	return rows[0]?.session_id ?? null;
}
