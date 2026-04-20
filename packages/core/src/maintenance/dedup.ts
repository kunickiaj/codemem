/* Near-duplicate memory deactivation.
 */

import type { Database } from "../db.js";

export interface DedupNearDuplicatesResult {
	checked: number;
	deactivated: number;
	pairs: Array<{ kept_id: number; deactivated_id: number; title: string }>;
}

export interface DedupNearDuplicatesOptions {
	/** Max time gap in milliseconds between duplicate candidates (default: 1 hour). */
	windowMs?: number;
	limit?: number | null;
	dryRun?: boolean;
}

/**
 * Find and deactivate near-duplicate memories: cross-session pairs with
 * identical normalized titles created within a configurable time window.
 *
 * Keeps the higher-confidence member (ties: most recent). Does not delete
 * rows — only sets `active = 0`.
 */
export function dedupNearDuplicateMemories(
	db: Database,
	opts: DedupNearDuplicatesOptions = {},
): DedupNearDuplicatesResult {
	const windowMs = opts.windowMs ?? 3_600_000; // 1 hour
	const windowSeconds = windowMs / 1000;
	const limitClause = opts.limit != null && opts.limit > 0 ? `LIMIT ${Number(opts.limit)}` : "";

	// Find cross-session pairs with identical normalized titles within the time window.
	// Self-join ordered so a.id < b.id to avoid duplicate pair reporting.
	const pairRows = db
		.prepare(
			`SELECT
				a.id AS id_a, a.session_id AS session_a, a.confidence AS conf_a, a.created_at AS created_a,
				b.id AS id_b, b.session_id AS session_b, b.confidence AS conf_b, b.created_at AS created_b,
				a.title AS title
			 FROM memory_items a
			 JOIN memory_items b
			   ON LOWER(TRIM(a.title)) = LOWER(TRIM(b.title))
			   AND a.id < b.id
			   AND a.session_id != b.session_id
			   AND a.active = 1
			   AND b.active = 1
			   AND ABS(JULIANDAY(a.created_at) - JULIANDAY(b.created_at)) * 86400 <= ?
			 ORDER BY a.created_at DESC
			 ${limitClause}`,
		)
		.all(windowSeconds) as Array<{
		id_a: number;
		session_a: number;
		conf_a: number;
		created_a: string;
		id_b: number;
		session_b: number;
		conf_b: number;
		created_b: string;
		title: string;
	}>;

	const checked = pairRows.length;
	const toDeactivate: number[] = [];
	const pairs: DedupNearDuplicatesResult["pairs"] = [];

	for (const row of pairRows) {
		// Keep higher confidence; on tie, keep the more recent one.
		let keepId: number;
		let dropId: number;
		if (row.conf_a > row.conf_b) {
			keepId = row.id_a;
			dropId = row.id_b;
		} else if (row.conf_b > row.conf_a) {
			keepId = row.id_b;
			dropId = row.id_a;
		} else {
			// Equal confidence — keep the more recent one
			keepId = row.created_a > row.created_b ? row.id_a : row.id_b;
			dropId = keepId === row.id_a ? row.id_b : row.id_a;
		}
		if (!toDeactivate.includes(dropId)) {
			toDeactivate.push(dropId);
			pairs.push({ kept_id: keepId, deactivated_id: dropId, title: row.title });
		}
	}

	if (toDeactivate.length === 0 || opts.dryRun === true) {
		return { checked, deactivated: toDeactivate.length, pairs };
	}

	const now = new Date().toISOString();
	const chunkSize = 200;
	for (let start = 0; start < toDeactivate.length; start += chunkSize) {
		const chunk = toDeactivate.slice(start, start + chunkSize);
		const placeholders = chunk.map(() => "?").join(",");
		db.prepare(
			`UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN (${placeholders})`,
		).run(now, ...chunk);
	}

	return { checked, deactivated: toDeactivate.length, pairs };
}
