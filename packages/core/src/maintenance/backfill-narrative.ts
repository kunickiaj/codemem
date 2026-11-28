/* Narrative backfill for session_summary memories.
 */

import type { Database } from "../db.js";
import { writeMemoryRevision } from "../memory-revision-writes.js";
import { SecretScanner } from "../secret-scanner.js";
import { extractNarrativeFromBody } from "./narrative-extract.js";

export interface BackfillNarrativeResult {
	checked: number;
	updated: number;
	skipped: number;
}

export interface BackfillNarrativeOptions {
	limit?: number | null;
	dryRun?: boolean;
	/**
	 * Secret scanner used to redact extracted narrative before persistence.
	 * Source body_text on legacy rows pre-dates the scanner, so the extracted
	 * narrative cannot be assumed redaction-derivative.
	 */
	scanner?: SecretScanner;
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
			`SELECT id, rev, body_text, narrative
			 FROM memory_items
			 WHERE kind = 'session_summary'
			   AND active = 1
			   AND (narrative IS NULL OR LENGTH(narrative) = 0)
			   AND body_text IS NOT NULL
			   AND LENGTH(body_text) > 0
			 ORDER BY created_at ASC
			 ${limitClause}`,
		)
		.all() as Array<{
		id: number;
		rev: number | null;
		body_text: string;
		narrative: string | null;
	}>;

	const scanner = opts.scanner ?? new SecretScanner();
	let checked = 0;
	let updated = 0;
	let skipped = 0;
	const updates: Array<{ row: (typeof rows)[number]; narrative: string }> = [];

	for (const row of rows) {
		checked++;
		const extracted = extractNarrativeFromBody(row.body_text);
		if (!extracted) {
			skipped++;
			continue;
		}
		const narrative = scanner.scan(extracted).redacted;
		updates.push({ row, narrative });
		updated++;
	}

	if (updates.length > 0 && opts.dryRun !== true) {
		const now = new Date().toISOString();
		// Each narrative is a new revision with its op, so peers that hold the memory get it.
		// A row edited or redacted since it was read keeps its current text.
		db.transaction(() => {
			for (const { row, narrative } of updates) {
				const written = writeMemoryRevision(db, {
					memoryId: row.id,
					changes: { narrative },
					expectedRev: row.rev,
					expectedValues: { body_text: row.body_text, narrative: row.narrative },
					now,
				});
				if (written) continue;
				updated--;
				skipped++;
			}
		})();
	}

	return { checked, updated, skipped };
}
