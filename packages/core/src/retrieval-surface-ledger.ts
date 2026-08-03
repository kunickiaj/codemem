import { posix, win32 } from "node:path";
import type { Database } from "./db.js";
import { estimateTokens } from "./pack.js";
import { sanitizeSearchQuery } from "./query-sanitizer.js";
import {
	hashRetrievalQuery,
	isValidRetrievalFilterSummaryEntry,
	MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES,
	MAX_RETRIEVAL_JSON_BYTES,
	MAX_RETRIEVAL_SELECTED_EXPOSURES,
	type RecordRetrievalAttemptInput,
	type RetrievalExposureInput,
	type RetrievalFilterSummary,
	type RetrievalLedgerWriteOutcome,
	tryReconcileFailedRetrievalAttempt,
	tryRecordRetrievalAttempt,
} from "./retrieval-ledger.js";
import type { MemoryFilters } from "./types.js";

type Snapshot = {
	id: number;
	import_key: string | null;
	origin_device_id: string | null;
	rev: number;
	updated_at: string;
	scope_id: string | null;
	kind: string;
	active: number;
	deleted_at: string | null;
};

const FILTER_KEYS = new Set<keyof RetrievalFilterSummary>([
	"kind",
	"session_id",
	"since",
	"project",
	"scope_id",
	"include_scope_ids",
	"exclude_scope_ids",
	"visibility",
	"include_visibility",
	"exclude_visibility",
	"include_workspace_ids",
	"exclude_workspace_ids",
	"include_workspace_kinds",
	"exclude_workspace_kinds",
	"include_actor_ids",
	"exclude_actor_ids",
	"include_trust_states",
	"exclude_trust_states",
	"ownership_scope",
	"personal_first",
	"trust_bias",
	"widen_shared_when_weak",
	"widen_shared_min_personal_results",
	"widen_shared_min_personal_score",
	"widen_project_when_weak",
	"widen_project_min_results",
	"widen_project_min_score",
	"widen_project_max_results",
]);

export interface RetrievalSurfaceRecordInput
	extends Omit<
		RecordRetrievalAttemptInput,
		| "candidateCount"
		| "selectedCount"
		| "exposures"
		| "filterSummary"
		| "queryHashSha256"
		| "queryCharCount"
		| "queryTokenEstimate"
		| "workingSetFiles"
		| "workingSetFileCount"
	> {
	candidateIds?: number[];
	selectedIds?: number[];
	candidateCount?: number;
	filters?: MemoryFilters;
	query?: string | null;
	repositoryPaths?: string[];
}

function safeIdentity(value: string | null): string | null {
	if (!value || value.length > 512 || posix.isAbsolute(value) || win32.isAbsolute(value))
		return null;
	return value;
}

export function sanitizeRepositoryPaths(paths: string[] | undefined): string[] | null {
	const output: string[] = [];
	for (const path of paths ?? []) {
		if (
			output.length >= 50 ||
			path.length > 1024 ||
			posix.isAbsolute(path) ||
			win32.isAbsolute(path)
		) {
			continue;
		}
		const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
		if (!normalized || normalized === ".." || normalized.startsWith("../")) continue;
		if (!output.includes(normalized)) output.push(normalized);
	}
	return output.length > 0 ? output : null;
}

export function sanitizeRetrievalFilters(
	filters: MemoryFilters | undefined,
): RetrievalFilterSummary | null {
	if (!filters) return null;
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(filters)) {
		if (!FILTER_KEYS.has(key as keyof RetrievalFilterSummary) || value === undefined) continue;
		if (
			typeof value === "string" &&
			(!value || value.length > 512 || posix.isAbsolute(value) || win32.isAbsolute(value))
		) {
			continue;
		}
		if (Array.isArray(value)) {
			const items = value
				.slice(0, 50)
				.filter(
					(item) =>
						typeof item === "string" &&
						item.length > 0 &&
						item.length <= 512 &&
						!posix.isAbsolute(item) &&
						!win32.isAbsolute(item),
				);
			const boundedItems: string[] = [];
			for (const item of items) {
				const candidate = [...boundedItems, item];
				if (
					Buffer.byteLength(JSON.stringify({ ...output, [key]: candidate }), "utf8") >
					MAX_RETRIEVAL_JSON_BYTES
				) {
					break;
				}
				boundedItems.push(item);
			}
			if (boundedItems.length > 0 && isValidRetrievalFilterSummaryEntry(key, boundedItems)) {
				output[key] = boundedItems;
			}
			continue;
		}
		if (
			isValidRetrievalFilterSummaryEntry(key, value) &&
			Buffer.byteLength(JSON.stringify({ ...output, [key]: value }), "utf8") <=
				MAX_RETRIEVAL_JSON_BYTES
		) {
			output[key] = value;
		}
	}
	return Object.keys(output).length > 0 ? (output as RetrievalFilterSummary) : null;
}

function snapshots(db: Database, ids: number[]): Map<number, Snapshot> {
	if (ids.length === 0) return new Map();
	const unique = [...new Set(ids)];
	const rows = db
		.prepare(
			`SELECT id, import_key, origin_device_id, rev, updated_at, scope_id, kind, active, deleted_at
			 FROM memory_items WHERE id IN (${unique.map(() => "?").join(", ")})`,
		)
		.all(...unique) as Snapshot[];
	return new Map(rows.map((row) => [row.id, row]));
}

function exposureRows(
	db: Database,
	candidateIds: number[],
	selectedIds: number[],
	deliveryStatus: RecordRetrievalAttemptInput["deliveryStatus"],
): RetrievalExposureInput[] {
	const allSelected = new Set(selectedIds);
	const boundedSelected = selectedIds.slice(0, MAX_RETRIEVAL_SELECTED_EXPOSURES);
	const selected = new Set(boundedSelected);
	const ordered = [...new Set([...candidateIds, ...selectedIds])];
	const retained = [
		...boundedSelected,
		...ordered.filter((id) => !allSelected.has(id)).slice(0, MAX_RETRIEVAL_DIAGNOSTIC_EXPOSURES),
	];
	const ranks = new Map(ordered.map((id, index) => [id, index + 1]));
	const byId = snapshots(db, retained);
	return retained.map((id) => {
		const snapshot = byId.get(id);
		const isSelected = selected.has(id);
		return {
			memoryId: snapshot?.id ?? null,
			memoryImportKey: safeIdentity(snapshot?.import_key ?? null),
			originDeviceId: safeIdentity(snapshot?.origin_device_id ?? null),
			rank: ranks.get(id) as number,
			disposition: isSelected ? "selected" : "dropped",
			handoffStatus: isSelected ? deliveryStatus : "not_attempted",
			memoryRev: snapshot?.rev ?? null,
			memoryUpdatedAt: snapshot?.updated_at ?? null,
			memoryScopeId: safeIdentity(snapshot?.scope_id ?? null),
			memoryKind: snapshot?.kind ?? null,
			memoryActive: snapshot == null ? null : snapshot.active === 1,
			memoryDeletedAt: snapshot?.deleted_at ?? null,
			reasonCodes: isSelected
				? [
						"surface.returned",
						...(selectedIds.length > MAX_RETRIEVAL_SELECTED_EXPOSURES
							? ["surface.returned_truncated"]
							: []),
					]
				: ["surface.candidate"],
		};
	});
}

export function resolveRetrievalSession(
	db: Database,
	source: string,
	sourceSessionId: string | null | undefined,
): number | null {
	if (!sourceSessionId) return null;
	try {
		const row = db
			.prepare(
				`SELECT session_id FROM opencode_sessions
				 WHERE source = ? AND (stream_id = ? OR opencode_session_id = ?)
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(source, sourceSessionId, sourceSessionId) as { session_id: number | null } | undefined;
		return row?.session_id ?? null;
	} catch {
		return null;
	}
}

function retrievalSurfaceAttempt(
	db: Database,
	input: RetrievalSurfaceRecordInput,
): RecordRetrievalAttemptInput {
	const {
		candidateIds: inputCandidateIds,
		selectedIds: inputSelectedIds,
		candidateCount,
		filters,
		query,
		repositoryPaths,
		...attempt
	} = input;
	const candidateIds = inputCandidateIds ?? inputSelectedIds ?? [];
	const selectedIds = [...new Set(inputSelectedIds ?? [])];
	const paths = sanitizeRepositoryPaths(repositoryPaths);
	const sanitizedQuery = query ? sanitizeSearchQuery(query).clean_query : "";
	const queryIdentity = sanitizedQuery ? hashRetrievalQuery(sanitizedQuery) : null;
	return {
		...attempt,
		candidateCount: candidateCount ?? candidateIds.length,
		selectedCount: selectedIds.length,
		project: safeIdentity(filters?.project ?? null),
		scopeId: Array.isArray(filters?.scope_id)
			? filters.scope_id.length === 1
				? safeIdentity(filters.scope_id[0] ?? null)
				: null
			: safeIdentity(filters?.scope_id ?? null),
		workingSetFileCount: paths?.length ?? 0,
		workingSetFiles: paths,
		queryHashSha256: queryIdentity?.queryHashSha256 ?? null,
		queryCharCount: queryIdentity?.queryCharCount ?? null,
		queryTokenEstimate: sanitizedQuery ? estimateTokens(sanitizedQuery) : null,
		filterSummary: sanitizeRetrievalFilters(filters),
		exposures: exposureRows(db, candidateIds, selectedIds, input.deliveryStatus),
	};
}

export function recordRetrievalSurface(
	db: Database,
	input: RetrievalSurfaceRecordInput,
): RetrievalLedgerWriteOutcome {
	try {
		return tryRecordRetrievalAttempt(db, retrievalSurfaceAttempt(db, input));
	} catch {
		return {
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "storage_unavailable",
		};
	}
}

export function reconcileFailedRetrievalSurface(
	db: Database,
	input: RetrievalSurfaceRecordInput,
): RetrievalLedgerWriteOutcome {
	try {
		return tryReconcileFailedRetrievalAttempt(db, retrievalSurfaceAttempt(db, input));
	} catch {
		return {
			ok: false,
			errorCode: "retrieval_ledger_write_failed",
			reason: "storage_unavailable",
		};
	}
}
