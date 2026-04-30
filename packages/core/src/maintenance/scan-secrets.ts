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
import { normalizeConcept } from "../ref-populate.js";
import { mergeDetections, type ScanDetection, SecretScanner } from "../secret-scanner.js";

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

export interface ScanSecretsRetroactiveResult {
	checked: number;
	updated: number;
	skippedOversized: number;
	staleWrites: number;
	detections: ScanDetection[];
}

interface MemoryRow {
	id: number;
	rev: number;
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
	const nextJson = JSON.stringify(r.value);
	const changed = nextJson !== json;
	return { json: changed ? nextJson : json, detections: r.detections, changed };
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
			`SELECT id, rev, title, subtitle, body_text, narrative, tags_text,
			        facts, concepts, files_read, files_modified, metadata_json,
			        actor_display_name, origin_source
			 FROM memory_items
			 ORDER BY id ASC
			 ${limitClause}`,
		)
		.all() as MemoryRow[];

	const updateStmt = db.prepare(
		`UPDATE memory_items
		 SET title = ?, subtitle = ?, body_text = ?, narrative = ?, tags_text = ?,
		     facts = ?, concepts = ?, files_read = ?, files_modified = ?,
		     metadata_json = ?, actor_display_name = ?, origin_source = ?,
		     updated_at = ?
		 WHERE id = ? AND rev = ?`,
	);

	const detectionLists: ScanDetection[][] = [];
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

		detectionLists.push(
			titleResult.detections,
			subtitleResult.detections,
			bodyResult.detections,
			narrativeResult.detections,
			actorNameResult.detections,
			originSourceResult.detections,
			tagsResult.detections,
			factsResult.detections,
			conceptsResult.detections,
			filesReadResult.detections,
			filesModifiedResult.detections,
			metaResult.detections,
		);

		if (dryRun) {
			updated++;
			continue;
		}

		// Single-row transaction so a concurrent legitimate writer that bumped
		// `rev` is not silently clobbered. Junction-table refresh is done in
		// the same transaction so the row's stored columns and its derived
		// indexes never disagree.
		const ok = db.transaction(() => {
			const result = updateStmt.run(
				titleResult.value,
				subtitleResult.value,
				bodyResult.value,
				narrativeResult.value,
				tagsResult.text,
				factsResult.json,
				conceptsResult.json,
				filesReadResult.json,
				filesModifiedResult.json,
				metaResult.json,
				actorNameResult.value,
				originSourceResult.value,
				new Date().toISOString(),
				row.id,
				row.rev,
			);
			if (result.changes === 0) return false;
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
		detections: mergeDetections(...detectionLists),
	};
}
