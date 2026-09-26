/* Dedup-key planning and backfill for memory_items.
 */

import type { Database } from "../db.js";
import { buildMemoryDedupKey } from "../memory-dedup.js";

export interface BackfillDedupKeysResult {
	checked: number;
	updated: number;
	skipped: number;
}

export interface BackfillDedupKeysPlan extends BackfillDedupKeysResult {
	backfillable: number;
	updates: Array<{ id: number; dedupKey: string }>;
	lastScannedId: number;
	lastScannedCreatedAt: string | null;
	exhausted: boolean;
}

export interface BackfillDedupKeysOptions {
	limit?: number | null;
	dryRun?: boolean;
}

interface BackfillDedupKeysPlanOptions {
	rowLimit?: number | null;
	updateLimit?: number | null;
	afterId?: number | null;
	/** Pair with afterId; rows are scanned in (created_at, id) order. */
	afterCreatedAt?: string | null;
}

type DedupKeyCandidateRow = {
	id: number;
	created_at: string;
	title: string;
	session_id: number;
	kind: string;
	visibility: string | null;
	workspace_id: string | null;
	active: number;
};

function selectDedupKeyCandidateRows(
	db: Database,
	options: BackfillDedupKeysPlanOptions,
): DedupKeyCandidateRow[] {
	const limitClause =
		options.rowLimit != null && options.rowLimit > 0 ? `LIMIT ${Number(options.rowLimit)}` : "";
	const afterId = options.afterId != null && options.afterId > 0 ? options.afterId : 0;
	// The cursor must follow the scan order. An id-only cursor over rows sorted
	// by created_at skips older-created rows with smaller ids (common after sync),
	// leaving them unkeyed while the job reports completion.
	const afterCreatedAt = afterId > 0 ? (options.afterCreatedAt ?? "") : "";
	return db
		.prepare(
			`SELECT id, created_at, title, session_id, kind, visibility, workspace_id, active
			 FROM memory_items
			 WHERE dedup_key IS NULL
			   AND (created_at > ? OR (created_at = ? AND id > ?))
			 ORDER BY created_at ASC, id ASC
			 ${limitClause}`,
		)
		.all(afterCreatedAt, afterCreatedAt, afterId) as DedupKeyCandidateRow[];
}

function scanCursor(
	rows: DedupKeyCandidateRow[],
	options: BackfillDedupKeysPlanOptions,
): Pick<BackfillDedupKeysPlan, "lastScannedId" | "lastScannedCreatedAt"> {
	const last = rows.at(-1);
	if (last) return { lastScannedId: last.id, lastScannedCreatedAt: last.created_at };
	return {
		lastScannedId: options.afterId ?? 0,
		lastScannedCreatedAt: options.afterCreatedAt ?? null,
	};
}

function buildDedupActiveScopeKey(row: DedupKeyCandidateRow, dedupKey: string): string {
	return [row.session_id, row.kind, row.visibility ?? "", row.workspace_id ?? "", dedupKey].join(
		"\u001f",
	);
}

export function planMemoryDedupKeys(
	db: Database,
	options: BackfillDedupKeysPlanOptions = {},
): BackfillDedupKeysPlan {
	const rowLimit = options.rowLimit ?? null;
	const rows = selectDedupKeyCandidateRows(db, { ...options, rowLimit });
	const updateLimit =
		options.updateLimit != null && options.updateLimit > 0 ? options.updateLimit : null;

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	let backfillable = 0;
	const updates: Array<{ id: number; dedupKey: string }> = [];
	const seenActiveScopes = new Set<string>();
	const hasActiveConflict = db.prepare(
		`SELECT 1 AS ok
		 FROM memory_items
		 WHERE id != ?
		   AND active = 1
		   AND session_id = ?
		   AND kind = ?
		   AND visibility IS ?
		   AND workspace_id IS ?
		   AND dedup_key = ?
		 LIMIT 1`,
	);

	for (const row of rows) {
		checked++;
		const dedupKey = buildMemoryDedupKey(row.title);
		if (!dedupKey) {
			skipped++;
			continue;
		}

		const activeScopeKey = buildDedupActiveScopeKey(row, dedupKey);
		if (
			row.active === 1 &&
			(seenActiveScopes.has(activeScopeKey) ||
				hasActiveConflict.get(
					row.id,
					row.session_id,
					row.kind,
					row.visibility,
					row.workspace_id,
					dedupKey,
				))
		) {
			skipped++;
			continue;
		}

		backfillable++;
		if (updateLimit == null || updates.length < updateLimit) {
			updates.push({ id: row.id, dedupKey });
		}
		if (row.active === 1) seenActiveScopes.add(activeScopeKey);
		updated++;
	}

	return {
		checked,
		updated,
		skipped,
		backfillable,
		updates,
		...scanCursor(rows, options),
		exhausted: rowLimit == null || rows.length < rowLimit,
	};
}

export function applyMemoryDedupKeyUpdates(
	db: Database,
	updates: Array<{ id: number; dedupKey: string }>,
): void {
	if (updates.length <= 0) return;
	const now = new Date().toISOString();
	const updateStmt = db.prepare(
		"UPDATE memory_items SET dedup_key = ?, updated_at = ? WHERE id = ?",
	);
	db.transaction(() => {
		for (const update of updates) {
			updateStmt.run(update.dedupKey, now, update.id);
		}
	})();
}

export function backfillMemoryDedupKeys(
	db: Database,
	opts: BackfillDedupKeysOptions = {},
): BackfillDedupKeysResult {
	const plan = planMemoryDedupKeys(db, { rowLimit: opts.limit ?? null });
	if (opts.dryRun !== true) {
		applyMemoryDedupKeyUpdates(db, plan.updates);
	}
	return { checked: plan.checked, updated: plan.updated, skipped: plan.skipped };
}
