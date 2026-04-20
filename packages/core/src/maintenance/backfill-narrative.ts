/* Narrative backfill for session_summary memories.
 */

import type { Database } from "../db.js";
import { extractNarrativeFromBody } from "./narrative-extract.js";

export interface BackfillNarrativeResult {
	checked: number;
	updated: number;
	skipped: number;
}

export interface BackfillNarrativeOptions {
	limit?: number | null;
	dryRun?: boolean;
}

/**
 * Backfill narrative for session_summary memories that have structured
 * body_text with `## Completed` / `## Learned` sections but no narrative.
 *
 * Only touches session_summary kind. Does not overwrite existing narratives.
 */
export function backfillNarrativeFromBody(
	db: Database,
	opts: BackfillNarrativeOptions = {},
): BackfillNarrativeResult {
	const limitClause = opts.limit != null && opts.limit > 0 ? `LIMIT ${Number(opts.limit)}` : "";

	const rows = db
		.prepare(
			`SELECT id, body_text
			 FROM memory_items
			 WHERE kind = 'session_summary'
			   AND active = 1
			   AND (narrative IS NULL OR LENGTH(narrative) = 0)
			   AND body_text IS NOT NULL
			   AND LENGTH(body_text) > 0
			 ORDER BY created_at ASC
			 ${limitClause}`,
		)
		.all() as Array<{ id: number; body_text: string }>;

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	const updates: Array<{ id: number; narrative: string }> = [];

	for (const row of rows) {
		checked++;
		const narrative = extractNarrativeFromBody(row.body_text);
		if (!narrative) {
			skipped++;
			continue;
		}
		updates.push({ id: row.id, narrative });
		updated++;
	}

	if (updates.length > 0 && opts.dryRun !== true) {
		const now = new Date().toISOString();
		const updateStmt = db.prepare(
			"UPDATE memory_items SET narrative = ?, updated_at = ? WHERE id = ?",
		);
		db.transaction(() => {
			for (const update of updates) {
				updateStmt.run(update.narrative, now, update.id);
			}
		})();
	}

	return { checked, updated, skipped };
}
