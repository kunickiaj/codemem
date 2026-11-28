/**
 * Retroactive secret-scan sweep over already-stored memories.
 *
 * Day-one users of the scanner have an unscanned backlog: memories written
 * before the scanner shipped retain whatever secret-shaped content was in
 * their bodies, titles, narratives, etc. This sweep walks `memory_items`,
 * scans every content-bearing column, writes redacted versions back, and
 * refreshes junction tables (`memory_concept_refs`, `memory_file_refs`)
 * derived from the redacted columns so they cannot retain stale unredacted
 * concept strings.
 *
 * Idempotent — scanning an already-redacted string yields the same string
 * (the `[REDACTED:<kind>]` markers do not match any default rule), so a
 * second run is a no-op except for the work of reading rows.
 *
 * Concurrency — each row is updated in its own transaction with a
 * `WHERE rev = ?` guard so a concurrent legitimate write that bumped `rev`
 * is not silently clobbered. The local-only sweep does not bump `rev` or
 * record a replication op; peers redact their own copies via the
 * sync-receive scanner.
 */

import type { Database } from "../db.js";
import { memoryWrittenHere } from "../memory-copy-provenance.js";
import { writeMemoryRevision } from "../memory-revision-writes.js";
import { normalizeConcept } from "../ref-populate.js";
import { mergeDetections, type ScanDetection, SecretScanner } from "../secret-scanner.js";
import { DEFAULT_SYNC_SCOPE_ID, localReplicationDeviceId } from "../sync-replication.js";
import { queueVectorBackfill } from "../vector-backfill-queue.js";

export interface ScanSecretsRetroactiveOptions {
	/** Max rows to scan in this run. Omit (or pass null/0) for "everything". */
	limit?: number | null;
	/** Preview redactions without writing. */
	dryRun?: boolean;
	/** Custom scanner. Defaults to a fresh `SecretScanner` with built-in rules. */
	scanner?: SecretScanner;
	/**
	 * Per-row content length above which we skip and count rather than spend
	 * scanner CPU on a single huge body. Default 1 MiB. Note: this is a CPU
	 * cap, not a memory cap — the row's columns are already loaded into Node
	 * before this check.
	 */
	maxRowBytes?: number;
}

/**
 * Per-row summary of what got redacted. The redacted title is safe to display
 * (markers, not the original value) and lets a caller manually look the
 * memory up in the DB to confirm a hit was a real secret vs. a false positive
 * before committing to a non-dry-run sweep.
 */
export interface ScanSecretsRetroactiveSample {
	id: number;
	redactedTitle: string | null;
	detections: ScanDetection[];
}

/**
 * A memory redacted on this device only, though sync may already have delivered
 * its content: no revision can carry the redaction, because this device cannot
 * show it created this copy. Its peers keep the unredacted copy until it is redacted
 * where it was written, or removed from them.
 */
export interface UnpropagatedRedaction {
	id: number;
	scope_id: string | null;
}

export interface ScanSecretsRetroactiveResult {
	checked: number;
	updated: number;
	skippedOversized: number;
	staleWrites: number;
	detections: ScanDetection[];
	samples: ScanSecretsRetroactiveSample[];
	unpropagatedRedactions: UnpropagatedRedaction[];
}

/**
 * The report entry for a redaction that stays on this device although sync may
 * already have delivered the memory: it sits in a scope that sync serves, by
 * ops or by snapshot pages. Whether an op for it survives here does not matter,
 * since snapshots carry memories without ops and retention prunes old ops.
 */
function unpropagatedRedaction(
	db: Database,
	row: Pick<MemoryRow, "id" | "import_key" | "scope_id">,
	deviceId: string,
): UnpropagatedRedaction | null {
	if (!row.import_key || !row.scope_id || row.scope_id === DEFAULT_SYNC_SCOPE_ID) return null;
	if (memoryWrittenHere(db, row.id, deviceId)) return null;
	const served = db
		.prepare("SELECT 1 FROM replication_scopes WHERE scope_id = ? AND authority_type != 'local'")
		.get(row.scope_id);
	return served ? { id: row.id, scope_id: row.scope_id } : null;
}

interface MemoryRow {
	id: number;
	rev: number;
	import_key: string | null;
	scope_id: string | null;
	title: string | null;
	subtitle: string | null;
	body_text: string | null;
	narrative: string | null;
	tags_text: string | null;
	facts: string | null;
	concepts: string | null;
	files_read: string | null;
	files_modified: string | null;
	metadata_json: string | null;
	actor_display_name: string | null;
	origin_source: string | null;
}

const DEFAULT_MAX_ROW_BYTES = 1024 * 1024;

function rowBytes(row: MemoryRow): number {
	let total = 0;
	for (const v of [
		row.title,
		row.subtitle,
		row.body_text,
		row.narrative,
		row.tags_text,
		row.facts,
		row.concepts,
		row.files_read,
		row.files_modified,
		row.metadata_json,
		row.actor_display_name,
		row.origin_source,
	]) {
		if (typeof v === "string") total += v.length;
	}
	return total;
}

function scanArrayJson(
	json: string | null,
	scanner: SecretScanner,
): {
	json: string | null;
	detections: ScanDetection[];
	changed: boolean;
} {
	if (json == null || json.length === 0) return { json, detections: [], changed: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { json, detections: [], changed: false };
	}
	if (!Array.isArray(parsed)) return { json, detections: [], changed: false };
	const lists: ScanDetection[][] = [];
	const next: unknown[] = [];
	let changed = false;
	for (const item of parsed) {
		if (typeof item === "string") {
			const r = scanner.scan(item);
			if (r.redacted !== item) changed = true;
			lists.push(r.detections);
			next.push(r.redacted);
		} else {
			next.push(item);
		}
	}
	return {
		json: changed ? JSON.stringify(next) : json,
		detections: mergeDetections(...lists),
		changed,
	};
}

function scanMetadataJson(
	json: string | null,
	scanner: SecretScanner,
): {
	json: string | null;
	detections: ScanDetection[];
	changed: boolean;
} {
	if (json == null || json.length === 0) return { json, detections: [], changed: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return { json, detections: [], changed: false };
	}
	if (parsed === null || typeof parsed !== "object") {
		return { json, detections: [], changed: false };
	}
	const r = scanner.redactValue(parsed);
	if (r.detections.length === 0) {
		// Nothing matched. Preserve the original JSON bytes — re-stringifying a
		// parse round-trip would canonicalize whitespace and key order, which
		// makes every row with metadata report `changed=true` and triggers a
		// spurious UPDATE for content that was never actually touched.
		return { json, detections: [], changed: false };
	}
	return { json: JSON.stringify(r.value), detections: r.detections, changed: true };
}

function scanTagsText(
	text: string | null,
	scanner: SecretScanner,
): {
	text: string | null;
	detections: ScanDetection[];
	changed: boolean;
} {
	if (text == null || text.length === 0) return { text, detections: [], changed: false };
	const parts = text.split(/\s+/).filter(Boolean);
	const lists: ScanDetection[][] = [];
	const next: string[] = [];
	let changed = false;
	for (const part of parts) {
		const r = scanner.scan(part);
		if (r.redacted !== part) changed = true;
		lists.push(r.detections);
		next.push(r.redacted);
	}
	return {
		text: changed ? next.join(" ") : text,
		detections: mergeDetections(...lists),
		changed,
	};
}

function scanString(
	value: string | null,
	scanner: SecretScanner,
): { value: string | null; detections: ScanDetection[]; changed: boolean } {
	if (value == null || value.length === 0) {
		return { value, detections: [], changed: false };
	}
	const r = scanner.scan(value);
	return { value: r.redacted, detections: r.detections, changed: r.redacted !== value };
}

function asStringArray(json: string | null): string[] | null {
	if (json == null || json.length === 0) return null;
	try {
		const parsed = JSON.parse(json);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((v): v is string => typeof v === "string");
	} catch {
		return null;
	}
}

/** Accept the row update only after its embedding-source repair intent is persisted. */
function finishRedactionUpdate(
	db: Database,
	memoryId: number,
	update: { changes: number },
	embeddingSources: readonly { changed: boolean }[],
): boolean {
	if (update.changes === 0) return false;
	if (update.changes === 1 && embeddingSources.some((source) => source.changed)) {
		queueVectorBackfill(db, { upsertMemoryIds: [memoryId], deleteMemoryIds: [] });
	}
	return true;
}

export function scanSecretsRetroactive(
	db: Database,
	opts: ScanSecretsRetroactiveOptions = {},
): ScanSecretsRetroactiveResult {
	const scanner = opts.scanner ?? new SecretScanner();
	const dryRun = opts.dryRun === true;
	const maxRowBytes = opts.maxRowBytes ?? DEFAULT_MAX_ROW_BYTES;
	const hasLimit = typeof opts.limit === "number" && Number.isInteger(opts.limit) && opts.limit > 0;
	const limitClause = hasLimit ? `LIMIT ${Number(opts.limit)}` : "";

	const rows = db
		.prepare(
			`SELECT id, rev, import_key, scope_id, title, subtitle, body_text, narrative, tags_text,
			        facts, concepts, files_read, files_modified, metadata_json,
			        actor_display_name, origin_source
			 FROM memory_items
			 ORDER BY id ASC
			 ${limitClause}`,
		)
		.all() as MemoryRow[];

	// Accumulate detections inline into a single map. We previously kept an
	// array-of-arrays and called `mergeDetections(...detectionLists)` at the
	// end; spreading >65k entries into a function call trips V8's argument-
	// stack limit on large stores ("Maximum call stack size exceeded").
	const detectionCounts = new Map<string, number>();
	const recordDetections = (list: ScanDetection[]): void => {
		for (const d of list) detectionCounts.set(d.kind, (detectionCounts.get(d.kind) ?? 0) + d.count);
	};
	const samples: ScanSecretsRetroactiveSample[] = [];
	const unpropagatedRedactions: UnpropagatedRedaction[] = [];
	const deviceId = localReplicationDeviceId(db);
	let checked = 0;
	let updated = 0;
	let skippedOversized = 0;
	let staleWrites = 0;

	for (const row of rows) {
		checked++;
		if (rowBytes(row) > maxRowBytes) {
			skippedOversized++;
			continue;
		}

		const titleResult = scanString(row.title, scanner);
		const subtitleResult = scanString(row.subtitle, scanner);
		const bodyResult = scanString(row.body_text, scanner);
		const narrativeResult = scanString(row.narrative, scanner);
		const actorNameResult = scanString(row.actor_display_name, scanner);
		const originSourceResult = scanString(row.origin_source, scanner);
		const tagsResult = scanTagsText(row.tags_text, scanner);
		const factsResult = scanArrayJson(row.facts, scanner);
		const conceptsResult = scanArrayJson(row.concepts, scanner);
		const filesReadResult = scanArrayJson(row.files_read, scanner);
		const filesModifiedResult = scanArrayJson(row.files_modified, scanner);
		const metaResult = scanMetadataJson(row.metadata_json, scanner);

		const changed =
			titleResult.changed ||
			subtitleResult.changed ||
			bodyResult.changed ||
			narrativeResult.changed ||
			actorNameResult.changed ||
			originSourceResult.changed ||
			tagsResult.changed ||
			factsResult.changed ||
			conceptsResult.changed ||
			filesReadResult.changed ||
			filesModifiedResult.changed ||
			metaResult.changed;

		if (!changed) continue;

		// Aggregate detections + sample only when the operation will actually
		// land. For dry-run that is "always" — the read-only path always
		// reports what it would have done. For real runs we defer recording
		// until after the transaction-with-rev-guard succeeds, so a stale
		// write (concurrent rev bump) does not appear in `detections` /
		// `samples` as if it had been redacted.
		const fieldResults = [
			titleResult,
			subtitleResult,
			bodyResult,
			narrativeResult,
			actorNameResult,
			originSourceResult,
			tagsResult,
			factsResult,
			conceptsResult,
			filesReadResult,
			filesModifiedResult,
			metaResult,
		];
		const recordResult = (): void => {
			for (const result of fieldResults) recordDetections(result.detections);
			const perRow = mergeDetections(...fieldResults.map((result) => result.detections));
			samples.push({
				id: row.id,
				redactedTitle: titleResult.value,
				detections: perRow,
			});
			const unpropagated = unpropagatedRedaction(db, row, deviceId);
			if (unpropagated) unpropagatedRedactions.push(unpropagated);
		};

		if (dryRun) {
			recordResult();
			updated++;
			continue;
		}

		// Single-row transaction so a concurrent legitimate writer that bumped
		// `rev` is not silently clobbered. Junction-table refresh is done in
		// the same transaction so the row's stored columns and its derived
		// indexes never disagree.
		const ok = db.transaction(() => {
			// A redaction of a copy this device created is a new revision with its op, so
			// peers that hold it get it. Any other redaction stays here and is reported.
			const written = writeMemoryRevision(db, {
				memoryId: row.id,
				changes: {
					title: titleResult.value,
					subtitle: subtitleResult.value,
					body_text: bodyResult.value,
					narrative: narrativeResult.value,
					tags_text: tagsResult.text,
					facts: factsResult.json,
					concepts: conceptsResult.json,
					files_read: filesReadResult.json,
					files_modified: filesModifiedResult.json,
					metadata_json: metaResult.json,
					actor_display_name: actorNameResult.value,
					origin_source: originSourceResult.value,
				},
				expectedRev: row.rev,
			});
			const result = { changes: Number(written) };
			if (!finishRedactionUpdate(db, row.id, result, [titleResult, bodyResult])) return false;
			// Junction tables derive from concepts and files_read/files_modified
			// and index the raw strings. If we redacted any of those columns,
			// the junction tables still hold the unredacted form and act as a
			// side-channel for queries / exports that read them.
			if (conceptsResult.changed) {
				db.prepare("DELETE FROM memory_concept_refs WHERE memory_id = ?").run(row.id);
				const concepts = asStringArray(conceptsResult.json);
				if (concepts) {
					const insertStmt = db.prepare(
						"INSERT OR IGNORE INTO memory_concept_refs (memory_id, concept) VALUES (?, ?)",
					);
					for (const concept of concepts) {
						const normalized = normalizeConcept(concept);
						if (normalized) insertStmt.run(row.id, normalized);
					}
				}
			}
			if (filesReadResult.changed || filesModifiedResult.changed) {
				db.prepare("DELETE FROM memory_file_refs WHERE memory_id = ?").run(row.id);
				const insertStmt = db.prepare(
					"INSERT OR IGNORE INTO memory_file_refs (memory_id, file_path, relation) VALUES (?, ?, ?)",
				);
				for (const path of asStringArray(filesReadResult.json) ?? []) {
					if (path) insertStmt.run(row.id, path, "read");
				}
				for (const path of asStringArray(filesModifiedResult.json) ?? []) {
					if (path) insertStmt.run(row.id, path, "modified");
				}
			}
			return true;
		})();

		if (ok) {
			recordResult();
			updated++;
		} else {
			staleWrites++;
		}
	}

	return {
		checked,
		updated,
		skippedOversized,
		staleWrites,
		detections: Array.from(detectionCounts.entries()).map(([kind, count]) => ({ kind, count })),
		samples,
		unpropagatedRedactions,
	};
}
