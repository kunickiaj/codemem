/* Low-signal memory deactivation for the maintenance surface.
 */

import type { Database } from "../db.js";
import { isLowSignalObservation } from "../ingest-filters.js";

export interface DeactivateLowSignalResult {
	checked: number;
	deactivated: number;
}

export interface DeactivateLowSignalMemoriesOptions {
	kinds?: string[] | null;
	limit?: number | null;
	dryRun?: boolean;
}

const DEFAULT_LOW_SIGNAL_KINDS = [
	"observation",
	"discovery",
	"change",
	"feature",
	"bugfix",
	"refactor",
	"decision",
	"note",
	"entities",
	"session_summary",
];

const OBSERVATION_EQUIVALENT_KINDS = [
	"observation",
	"bugfix",
	"feature",
	"refactor",
	"change",
	"discovery",
	"decision",
	"exploration",
];

/**
 * Deactivate low-signal observations only.
 */
export function deactivateLowSignalObservations(
	db: Database,
	limit?: number | null,
	dryRun = false,
): DeactivateLowSignalResult {
	return deactivateLowSignalMemories(db, {
		kinds: OBSERVATION_EQUIVALENT_KINDS,
		limit,
		dryRun,
	});
}

/**
 * Deactivate low-signal memories across selected kinds (does not delete rows).
 */
export function deactivateLowSignalMemories(
	db: Database,
	opts: DeactivateLowSignalMemoriesOptions = {},
): DeactivateLowSignalResult {
	const selectedKinds =
		opts.kinds?.map((kind) => kind.trim()).filter((kind) => kind.length > 0) ?? [];
	const kinds = selectedKinds.length > 0 ? selectedKinds : DEFAULT_LOW_SIGNAL_KINDS;
	const placeholders = kinds.map(() => "?").join(",");
	const params: unknown[] = [...kinds];
	let limitClause = "";
	if (opts.limit != null && opts.limit > 0) {
		limitClause = "LIMIT ?";
		params.push(opts.limit);
	}

	const rows = db
		.prepare(
			`SELECT id, title, body_text
			 FROM memory_items
			 WHERE kind IN (${placeholders}) AND active = 1
			 ORDER BY id DESC
			 ${limitClause}`,
		)
		.all(...params) as Array<{ id: number; title: string | null; body_text: string | null }>;

	const checked = rows.length;
	const ids = rows
		.filter((row) => isLowSignalObservation(row.body_text || row.title || ""))
		.map((row) => Number(row.id));

	if (ids.length === 0 || opts.dryRun === true) {
		return { checked, deactivated: ids.length };
	}

	const now = new Date().toISOString();
	const chunkSize = 200;
	for (let start = 0; start < ids.length; start += chunkSize) {
		const chunk = ids.slice(start, start + chunkSize);
		const chunkPlaceholders = chunk.map(() => "?").join(",");
		db.prepare(
			`UPDATE memory_items SET active = 0, updated_at = ? WHERE id IN (${chunkPlaceholders})`,
		).run(now, ...chunk);
	}

	return { checked, deactivated: ids.length };
}
