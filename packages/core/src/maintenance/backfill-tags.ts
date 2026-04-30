/* Tag-text backfill for memory_items.tags_text.
 */

import type { Database } from "../db.js";
import { projectClause } from "../project.js";
import { SecretScanner } from "../secret-scanner.js";
import { deriveTags, parseJsonStringList } from "./tag-helpers.js";

export interface BackfillTagsTextOptions {
	limit?: number | null;
	since?: string | null;
	project?: string | null;
	activeOnly?: boolean;
	dryRun?: boolean;
	memoryIds?: number[] | null;
	/**
	 * Secret scanner used to redact derived tag values before persistence.
	 * Tags derive from kind/title/concepts/files which are persisted columns —
	 * but legacy rows pre-date the scanner so we cannot trust those columns to
	 * be redacted-derivative. Caveat: `deriveTags` lowercases tags before this
	 * scan runs, so case-sensitive rules (AWS AKIA*, Google AIza*, JWT eyJ*)
	 * won't fire on legacy-derived tags. Catching the long tail there is the
	 * job of the retroactive sweep (codemem-vb2s).
	 */
	scanner?: SecretScanner;
}

export interface BackfillTagsTextResult {
	checked: number;
	updated: number;
	skipped: number;
}

/**
 * Populate memory_items.tags_text for rows where it is empty.
 */
export function backfillTagsText(
	db: Database,
	opts: BackfillTagsTextOptions = {},
): BackfillTagsTextResult {
	const { limit, since, project, activeOnly = true, dryRun = false, memoryIds } = opts;

	const params: unknown[] = [];
	const whereClauses = ["(memory_items.tags_text IS NULL OR TRIM(memory_items.tags_text) = '')"];

	if (activeOnly) whereClauses.push("memory_items.active = 1");
	if (since) {
		whereClauses.push("memory_items.created_at >= ?");
		params.push(since);
	}

	let joinSessions = false;
	if (project) {
		const pc = projectClause(project);
		if (pc.clause) {
			whereClauses.push(pc.clause);
			params.push(...pc.params);
			joinSessions = true;
		}
	}

	if (memoryIds && memoryIds.length > 0) {
		const placeholders = memoryIds.map(() => "?").join(",");
		whereClauses.push(`memory_items.id IN (${placeholders})`);
		params.push(...memoryIds.map((id) => Number(id)));
	}

	const where = whereClauses.join(" AND ");
	const joinClause = joinSessions ? "JOIN sessions ON sessions.id = memory_items.session_id" : "";
	const limitClause = limit != null && limit > 0 ? "LIMIT ?" : "";
	if (limit != null && limit > 0) params.push(limit);

	const rows = db
		.prepare(
			`SELECT memory_items.id, memory_items.kind, memory_items.title,
			        memory_items.concepts, memory_items.files_read, memory_items.files_modified
			 FROM memory_items
			 ${joinClause}
			 WHERE ${where}
			 ORDER BY memory_items.created_at ASC
			 ${limitClause}`,
		)
		.all(...params) as Array<{
		id: number;
		kind: string | null;
		title: string | null;
		concepts: string | null;
		files_read: string | null;
		files_modified: string | null;
	}>;

	const scanner = opts.scanner ?? new SecretScanner();
	let checked = 0;
	let updated = 0;
	let skipped = 0;
	const now = new Date().toISOString();
	const updateStmt = db.prepare(
		"UPDATE memory_items SET tags_text = ?, updated_at = ? WHERE id = ?",
	);
	const updates: Array<{ id: number; tagsText: string }> = [];

	for (const row of rows) {
		checked += 1;
		const tags = deriveTags({
			kind: String(row.kind ?? ""),
			title: String(row.title ?? ""),
			concepts: parseJsonStringList(row.concepts),
			filesRead: parseJsonStringList(row.files_read),
			filesModified: parseJsonStringList(row.files_modified),
		});
		const safeTags = tags.map((t) => scanner.scan(t).redacted);
		const tagsText = safeTags.join(" ");
		if (!tagsText) {
			skipped += 1;
			continue;
		}
		updates.push({ id: row.id, tagsText });
		updated += 1;
	}

	if (!dryRun && updates.length > 0) {
		db.transaction(() => {
			for (const update of updates) {
				updateStmt.run(update.tagsText, now, update.id);
			}
		})();
	}

	return { checked, updated, skipped };
}
