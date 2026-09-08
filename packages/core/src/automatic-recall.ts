import type { Database } from "./db.js";
import { buildFilterClausesWithContext, type OwnershipFilterContext } from "./filters.js";
import type { RetrievalLedgerFailureReason } from "./retrieval-ledger.js";

export interface AutomaticRecallMeasurement {
	v: 1;
	candidateItems: number;
	duplicatesOmitted: number;
	beforeTokens: number;
	afterTokens: number;
	missingRetainedMetadata: boolean;
	invalidRetainedMetadata: boolean;
	packMetadata: "valid" | "missing" | "invalid";
}

const KEYS = new Set([
	"v",
	"candidateItems",
	"duplicatesOmitted",
	"beforeTokens",
	"afterTokens",
	"missingRetainedMetadata",
	"invalidRetainedMetadata",
	"packMetadata",
]);
const DUPLICATE_EVALUATION_MARKER_VERSION = 1;

export function isAutomaticRecallMeasurement(value: unknown): value is AutomaticRecallMeasurement {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const m = value as AutomaticRecallMeasurement;
	if (Object.keys(m).length !== KEYS.size || Object.keys(m).some((key) => !KEYS.has(key)))
		return false;
	return (
		m.v === 1 &&
		[m.candidateItems, m.duplicatesOmitted, m.beforeTokens, m.afterTokens].every(
			(n) => Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000,
		) &&
		m.candidateItems <= 50 &&
		m.duplicatesOmitted <= m.candidateItems &&
		m.afterTokens <= m.beforeTokens &&
		(m.duplicatesOmitted > 0 || m.afterTokens === m.beforeTokens) &&
		(m.packMetadata === "valid" || m.duplicatesOmitted === 0) &&
		typeof m.missingRetainedMetadata === "boolean" &&
		typeof m.invalidRetainedMetadata === "boolean" &&
		["valid", "missing", "invalid"].includes(m.packMetadata)
	);
}

export type AutomaticRecallWriteOutcome =
	| { ok: true; value: { changed: boolean } }
	| { ok: false; reason: RetrievalLedgerFailureReason; errorCode: "automatic_recall_write_failed" };

type AutomaticRecallAttempt = {
	selected_count: number;
	output_tokens: number | null;
	automatic_recall_json: string | null;
	automatic_recall_key: string | null;
};

type AutomaticRecallRow = Pick<
	AutomaticRecallAttempt,
	"automatic_recall_json" | "automatic_recall_key"
>;

type AutomaticRecallHealthResult = ReturnType<typeof createAutomaticRecallHealthResult>;

function automaticRecallFailure(reason: RetrievalLedgerFailureReason): AutomaticRecallWriteOutcome {
	return { ok: false, reason, errorCode: "automatic_recall_write_failed" };
}

function matchesAttemptCounts(
	value: AutomaticRecallMeasurement,
	attempt: { selected_count: number; output_tokens: number | null },
) {
	if (value.candidateItems !== attempt.selected_count || attempt.output_tokens == null)
		return false;
	if (attempt.selected_count === 0) return value.beforeTokens === 0;
	return (
		value.beforeTokens >= attempt.output_tokens && value.beforeTokens <= attempt.output_tokens + 8
	);
}

function decodeMeasurement(json: string | null): AutomaticRecallMeasurement | null {
	if (!json || json.length > 1024) return null;
	try {
		const value: unknown = JSON.parse(json);
		return isAutomaticRecallMeasurement(value) ? value : null;
	} catch {
		return null;
	}
}

function duplicateEvaluationMarker(evaluationKey: string): string {
	return JSON.stringify({
		v: DUPLICATE_EVALUATION_MARKER_VERSION,
		duplicateEvaluationKey: evaluationKey,
	});
}

function decodeDuplicateEvaluationKey(json: string | null): string | null {
	if (!json || json.length > 128) return null;
	try {
		const value: unknown = JSON.parse(json);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const marker = value as Record<string, unknown>;
		if (
			Object.keys(marker).length !== 2 ||
			marker.v !== DUPLICATE_EVALUATION_MARKER_VERSION ||
			typeof marker.duplicateEvaluationKey !== "string" ||
			!/^[a-f0-9]{64}$/.test(marker.duplicateEvaluationKey)
		)
			return null;
		return marker.duplicateEvaluationKey;
	} catch {
		return null;
	}
}

function encodeMeasurement(value: AutomaticRecallMeasurement): string {
	return JSON.stringify(
		Object.fromEntries(
			[...KEYS].map((name) => [name, value[name as keyof AutomaticRecallMeasurement]]),
		),
	);
}

function readAutomaticRecallAttempt(
	db: Database,
	attemptId: string,
): AutomaticRecallAttempt | undefined {
	return db
		.prepare(`SELECT selected_count, output_tokens, automatic_recall_json, automatic_recall_key
			FROM retrieval_attempts WHERE attempt_id = ? AND contract_version = 1
			AND surface = 'prompt_pack' AND trigger = 'automatic' AND source = 'opencode'
			AND retrieval_status IN ('succeeded', 'no_results')
			AND COALESCE(request_id, '') NOT LIKE 'cache_reuse:%'`)
		.get(attemptId) as AutomaticRecallAttempt | undefined;
}

function existingMeasurementOutcome(
	attempt: AutomaticRecallAttempt,
	evaluationKey: string,
	json: string,
): AutomaticRecallWriteOutcome | null {
	if (attempt.automatic_recall_json === null) return null;
	const duplicateKey = decodeDuplicateEvaluationKey(attempt.automatic_recall_json);
	if (duplicateKey !== null) {
		return duplicateKey === evaluationKey
			? { ok: true, value: { changed: false } }
			: automaticRecallFailure("idempotency_conflict");
	}
	const same =
		attempt.automatic_recall_json === json && attempt.automatic_recall_key === evaluationKey;
	return same
		? { ok: true, value: { changed: false } }
		: automaticRecallFailure("idempotency_conflict");
}

function persistAutomaticRecall(
	db: Database,
	attemptId: string,
	evaluationKey: string,
	value: AutomaticRecallMeasurement,
): AutomaticRecallWriteOutcome {
	const attempt = readAutomaticRecallAttempt(db, attemptId);
	if (!attempt) return automaticRecallFailure("attempt_not_found");
	if (!matchesAttemptCounts(value, attempt)) return automaticRecallFailure("invalid_input");
	const json = encodeMeasurement(value);
	const existing = existingMeasurementOutcome(attempt, evaluationKey, json);
	if (existing) return existing;
	const keyExists = db
		.prepare("SELECT 1 FROM retrieval_attempts WHERE automatic_recall_key = ?")
		.get(evaluationKey);
	if (keyExists) {
		db.prepare("UPDATE retrieval_attempts SET automatic_recall_json = ? WHERE attempt_id = ?").run(
			duplicateEvaluationMarker(evaluationKey),
			attemptId,
		);
		return { ok: true, value: { changed: false } };
	}
	db.prepare(
		"UPDATE retrieval_attempts SET automatic_recall_json = ?, automatic_recall_key = ? WHERE attempt_id = ?",
	).run(json, evaluationKey, attemptId);
	return { ok: true, value: { changed: true } };
}

/** Enrich only an existing automatic attempt; diagnostics never create retrievals. */
export function recordAutomaticRecall(
	db: Database,
	attemptId: string,
	evaluationKey: unknown,
	value: unknown,
): AutomaticRecallWriteOutcome {
	if (
		!isAutomaticRecallMeasurement(value) ||
		typeof evaluationKey !== "string" ||
		!/^[a-f0-9]{64}$/.test(evaluationKey)
	)
		return automaticRecallFailure("invalid_input");
	try {
		return db
			.transaction(() => persistAutomaticRecall(db, attemptId, evaluationKey, value))
			.immediate();
	} catch {
		return automaticRecallFailure("storage_unavailable");
	}
}

function createAutomaticRecallHealthResult(now: Date) {
	return {
		availability: "no_data" as "available" | "no_data" | "unavailable",
		periodStart: new Date(now.getTime() - 30 * 86_400_000).toISOString(),
		periodEnd: now.toISOString(),
		windowLimit: 1000,
		freshEvaluations: 0,
		evaluationsWithDuplicates: 0,
		candidateItems: 0,
		duplicatesOmitted: 0,
		beforeTokens: 0,
		afterTokens: 0,
		estimatedTokensAvoided: 0,
		missingRetainedMetadata: 0,
		invalidRetainedMetadata: 0,
		packMetadataGaps: 0,
		unmeasuredAttempts: 0,
		captureVersion: "opencode-retained-v1",
	};
}

function readVisibleAutomaticRecallRows(
	db: Database,
	context: OwnershipFilterContext,
	periodStart: string,
	periodEnd: string,
): AutomaticRecallRow[] {
	const visibility = buildFilterClausesWithContext(null, {
		...context,
		enforceScopeVisibility: true,
	});
	// Exclude whole attempts if any selected exposure is unavailable, including revoked scopes.
	// The window bounds both rows read and JSON decoded; the ledger owns retention/deletion.
	return db
		.prepare(`WITH recent AS (
		SELECT attempt_id, selected_count, automatic_recall_json, automatic_recall_key FROM retrieval_attempts
		WHERE source = 'opencode' AND surface = 'prompt_pack' AND trigger = 'automatic'
		AND contract_version = 1 AND retrieval_status IN ('succeeded', 'no_results')
		AND COALESCE(request_id, '') NOT LIKE 'cache_reuse:%'
		AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC, attempt_id DESC LIMIT 1000
	) SELECT automatic_recall_json, automatic_recall_key FROM recent WHERE selected_count = (
		SELECT COUNT(*) FROM retrieval_exposures e JOIN memory_items ON memory_items.id = e.memory_id
		WHERE e.attempt_id = recent.attempt_id AND e.disposition = 'selected'
		AND memory_items.active = 1 AND memory_items.deleted_at IS NULL
		${visibility.clauses.map((clause) => `AND ${clause}`).join(" ")}
	)`)
		.all(periodStart, periodEnd, ...visibility.params) as AutomaticRecallRow[];
}

function measuredEvaluationKeys(rows: AutomaticRecallRow[]): Set<string> {
	return new Set(
		rows.flatMap((row) => {
			if (!decodeMeasurement(row.automatic_recall_json)) return [];
			return row.automatic_recall_key && /^[a-f0-9]{64}$/.test(row.automatic_recall_key)
				? [row.automatic_recall_key]
				: [];
		}),
	);
}

function addMeasurement(
	result: AutomaticRecallHealthResult,
	measurement: AutomaticRecallMeasurement,
) {
	result.freshEvaluations++;
	result.evaluationsWithDuplicates += Number(measurement.duplicatesOmitted > 0);
	result.candidateItems += measurement.candidateItems;
	result.duplicatesOmitted += measurement.duplicatesOmitted;
	result.beforeTokens += measurement.beforeTokens;
	result.afterTokens += measurement.afterTokens;
	result.estimatedTokensAvoided += measurement.beforeTokens - measurement.afterTokens;
	result.missingRetainedMetadata += Number(measurement.missingRetainedMetadata);
	result.invalidRetainedMetadata += Number(measurement.invalidRetainedMetadata);
	result.packMetadataGaps += Number(measurement.packMetadata !== "valid");
}

function aggregateAutomaticRecallRows(
	rows: AutomaticRecallRow[],
	result: AutomaticRecallHealthResult,
) {
	const measuredKeys = measuredEvaluationKeys(rows);
	for (const row of rows) {
		const measurement = decodeMeasurement(row.automatic_recall_json);
		if (measurement) {
			addMeasurement(result, measurement);
			continue;
		}
		const duplicateKey = decodeDuplicateEvaluationKey(row.automatic_recall_json);
		if (!duplicateKey || !measuredKeys.has(duplicateKey)) result.unmeasuredAttempts++;
	}
}

export function automaticRecallHealth(
	db: Database,
	context: OwnershipFilterContext,
	now = new Date(),
) {
	const result = createAutomaticRecallHealthResult(now);
	try {
		const rows = readVisibleAutomaticRecallRows(db, context, result.periodStart, result.periodEnd);
		aggregateAutomaticRecallRows(rows, result);
		if (result.freshEvaluations > 0) result.availability = "available";
	} catch {
		result.availability = "unavailable";
	}
	return result;
}
