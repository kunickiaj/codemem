import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { MemoryStore } from "@codemem/core";
import { Hono } from "hono";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_KEY = randomBytes(32);

export const DIAGNOSTIC_SEVERITIES = ["info", "warning", "error"] as const;
export const DIAGNOSTIC_SUBSYSTEMS = [
	"viewer",
	"observer",
	"capture",
	"sync",
	"storage",
	"maintenance",
] as const;

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];
export type DiagnosticSubsystem = (typeof DIAGNOSTIC_SUBSYSTEMS)[number];

export type DiagnosticEvent = {
	id: string;
	occurred_at: string;
	severity: DiagnosticSeverity;
	subsystem: DiagnosticSubsystem;
	code: string;
	message: string;
	recovery?: { label: string; href?: string; command?: string };
	correlation?: { kind: "session" | "device" | "operation"; label: string };
	technical_detail?: { available: boolean; text?: string };
};

type Cursor = { occurredAt: string; orderKey: string };
type StoreFactory = () => MemoryStore;
type EventOptions = {
	cursor: Cursor | null;
	includeTechnical: boolean;
	limit: number;
	severities: Set<DiagnosticSeverity>;
	subsystems: Set<DiagnosticSubsystem>;
};

type OrderedDiagnosticEvent = DiagnosticEvent & { orderKey: string };

function opaqueId(kind: string, sourceId: unknown): string {
	return createHash("sha256")
		.update(`${kind}\0${String(sourceId)}`)
		.digest("base64url")
		.slice(0, 22);
}

function encodeCursor(event: OrderedDiagnosticEvent): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", CURSOR_KEY, iv);
	const plaintext = JSON.stringify({ occurredAt: event.occurred_at, orderKey: event.orderKey });
	const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function parseCursor(raw: string | undefined): Cursor | null | "invalid" {
	if (!raw) return null;
	try {
		const encoded = Buffer.from(raw, "base64url");
		if (encoded.length < 29) return "invalid";
		const decipher = createDecipheriv("aes-256-gcm", CURSOR_KEY, encoded.subarray(0, 12));
		decipher.setAuthTag(encoded.subarray(12, 28));
		const plaintext = Buffer.concat([
			decipher.update(encoded.subarray(28)),
			decipher.final(),
		]).toString("utf8");
		const parsed = JSON.parse(plaintext) as Record<string, unknown>;
		if (
			typeof parsed.occurredAt !== "string" ||
			!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z$/.test(parsed.occurredAt) ||
			!Number.isFinite(Date.parse(parsed.occurredAt))
		) {
			return "invalid";
		}
		if (
			typeof parsed.orderKey !== "string" ||
			parsed.orderKey.length < 3 ||
			parsed.orderKey.length > 2_048
		) {
			return "invalid";
		}
		return { occurredAt: parsed.occurredAt, orderKey: parsed.orderKey };
	} catch {
		return "invalid";
	}
}

function parseLimit(raw: string | undefined): number | "invalid" {
	if (raw == null || raw === "") return DEFAULT_LIMIT;
	if (!/^\d+$/.test(raw)) return "invalid";
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) return "invalid";
	return Math.min(parsed, MAX_LIMIT);
}

function parseFilter<T extends string>(
	raw: string | undefined,
	allowed: readonly T[],
): Set<T> | "invalid" {
	if (raw == null) return new Set(allowed);
	const values = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!values.length || values.some((value) => !allowed.includes(value as T))) return "invalid";
	return new Set(values as T[]);
}

function parseTechnical(raw: string | undefined): boolean | "invalid" {
	if (raw == null || raw === "0") return false;
	if (raw === "1") return true;
	return "invalid";
}

function technicalDetail(available: boolean, text: string, include: boolean) {
	if (!available) return { available: false };
	return include ? { available: true, text: text.slice(0, 2_000) } : { available: true };
}

type DiagnosticSourceRow = {
	source_type: "sync" | "observer" | "capture_failure" | "backlog" | "maintenance";
	source_id: number | string;
	order_key: string;
	occurred_at: string;
	status: string;
	metric_a: number | null;
	metric_b: number | null;
	category: string | null;
};

const SYNC_OCCURRED_AT_SQL = "CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END";

function syncSelect(options: EventOptions): string | null {
	if (!options.subsystems.has("sync")) return null;
	const predicates: string[] = [];
	if (!options.severities.has("info")) predicates.push("ok = 0");
	if (!options.severities.has("error")) predicates.push("ok <> 0");
	if (!options.severities.has("info") && !options.severities.has("error")) return null;
	if (options.cursor) {
		predicates.push(`(${SYNC_OCCURRED_AT_SQL} < @cursorOccurredAt OR
			(${SYNC_OCCURRED_AT_SQL} = @cursorOccurredAt AND
			's:' || printf('%020d', id) < @cursorOrderKey))`);
	}
	const where = predicates.length ? `WHERE ${predicates.join(" AND ")}` : "";
	return `SELECT 'sync' AS source_type, id AS source_id,
		's:' || printf('%020d', id) AS order_key,
		${SYNC_OCCURRED_AT_SQL} AS occurred_at,
		CASE WHEN ok <> 0 THEN 'succeeded' ELSE 'failed' END AS status,
		ops_in AS metric_a, ops_out AS metric_b,
		CASE
			WHEN lower(error) LIKE '%auth%' OR lower(error) LIKE '%unauthorized%' THEN 'authentication'
			WHEN lower(error) LIKE '%timeout%' OR lower(error) LIKE '%timed out%' THEN 'timeout'
			WHEN lower(error) LIKE '%version%' OR lower(error) LIKE '%capability%' THEN 'compatibility'
			WHEN lower(error) LIKE '%connect%' OR lower(error) LIKE '%network%'
				OR lower(error) LIKE '%dns%' THEN 'connectivity'
			ELSE 'unspecified'
		END AS category
		FROM sync_attempts ${where}
		ORDER BY ${SYNC_OCCURRED_AT_SQL} DESC, id DESC
		LIMIT @sourceLimit`;
}

function observerSelect(options: EventOptions): string | null {
	if (!options.severities.has("error")) return null;
	const observer = options.subsystems.has("observer");
	const capture = options.subsystems.has("capture");
	if (!observer && !capture) return null;
	let providerFilter = "";
	if (observer && !capture) providerFilter = "AND observer_provider IS NOT NULL";
	if (capture && !observer) providerFilter = "AND observer_provider IS NULL";
	const cursorFilter = options.cursor
		? `AND (updated_at < @cursorOccurredAt OR
			(updated_at = @cursorOccurredAt AND
			'o:' || printf('%020d', id) < @cursorOrderKey))`
		: "";
	return ["error", "failed", "gave_up"]
		.map(
			(status) => `SELECT * FROM (
				SELECT
					CASE WHEN observer_provider IS NULL THEN 'capture_failure' ELSE 'observer' END AS source_type,
					id AS source_id, 'o:' || printf('%020d', id) AS order_key,
					updated_at AS occurred_at, status, attempt_count AS metric_a,
					NULL AS metric_b,
					CASE
						WHEN lower(COALESCE(observer_error_code, error_type)) LIKE '%auth%' THEN 'authentication'
						WHEN lower(COALESCE(observer_error_code, error_type)) LIKE '%rate%'
							OR lower(COALESCE(observer_error_code, error_type)) LIKE '%limit%' THEN 'rate limit'
						WHEN lower(COALESCE(observer_error_code, error_type)) LIKE '%timeout%' THEN 'timeout'
						WHEN lower(COALESCE(observer_error_code, error_type)) LIKE '%schema%'
							OR lower(COALESCE(observer_error_code, error_type)) LIKE '%parse%' THEN 'response format'
						ELSE 'unspecified'
					END AS category
				FROM raw_event_flush_batches
				WHERE status = '${status}' ${providerFilter} ${cursorFilter}
				ORDER BY updated_at DESC, id DESC
				LIMIT @sourceLimit
			)`,
		)
		.join(" UNION ALL ");
}

function maintenanceSelect(options: EventOptions): string | null {
	if (!options.subsystems.has("maintenance")) return null;
	const statuses: string[] = [];
	if (options.severities.has("info")) statuses.push("'pending'", "'running'");
	if (options.severities.has("warning")) statuses.push("'cancelled'");
	if (options.severities.has("error")) statuses.push("'failed'");
	if (!statuses.length) return null;
	return `SELECT 'maintenance' AS source_type, kind AS source_id,
		'm:' || hex(kind) AS order_key, updated_at AS occurred_at,
		status, progress_current AS metric_a, progress_total AS metric_b,
		NULL AS category
		FROM maintenance_jobs WHERE status IN (${statuses.join(", ")})`;
}

function backlogSelect(options: EventOptions): string | null {
	if (!options.subsystems.has("capture")) return null;
	const warning = options.severities.has("warning");
	const error = options.severities.has("error");
	if (!warning && !error) return null;
	let having = "pending >= 200";
	if (!warning) having = "pending >= 1000";
	if (!error) having = "pending >= 200 AND pending < 1000";
	return `WITH candidate_sessions AS MATERIALIZED (
			SELECT source, stream_id, last_flushed_event_seq, updated_at
			FROM raw_event_sessions
			WHERE last_received_event_seq > last_flushed_event_seq
			ORDER BY updated_at DESC
			LIMIT 1001
		), bounded_sessions AS MATERIALIZED (
			SELECT source, stream_id, last_flushed_event_seq, updated_at
			FROM candidate_sessions
			ORDER BY updated_at DESC
			LIMIT 1000
		), retained_sessions AS MATERIALIZED (
			SELECT updated_at,
				(SELECT COUNT(*) FROM raw_events AS events
					WHERE events.source = sessions.source
						AND events.stream_id = sessions.stream_id
						AND events.event_seq > sessions.last_flushed_event_seq) AS pending
			FROM bounded_sessions AS sessions
		)
		SELECT 'backlog' AS source_type, 0 AS source_id,
		'b:' || printf('%020d', 0) AS order_key, occurred_at,
		CASE WHEN pending >= 1000 THEN 'error' ELSE 'warning' END AS status,
		pending AS metric_a, sessions AS metric_b,
		CASE WHEN candidate_count > 1000 THEN 'capped' ELSE NULL END AS category
		FROM (
			SELECT MAX(updated_at) AS occurred_at,
				SUM(pending) AS pending,
				COUNT(*) FILTER (WHERE pending > 0) AS sessions,
				(SELECT COUNT(*) FROM candidate_sessions) AS candidate_count
			FROM retained_sessions
			WHERE pending > 0
		) WHERE ${having}`;
}

function sourceSelects(options: EventOptions): string[] {
	return [
		syncSelect(options),
		observerSelect(options),
		maintenanceSelect(options),
		backlogSelect(options),
	].filter((select): select is string => select != null);
}

function boundedSourceSelect(select: string, hasCursor: boolean): string {
	const cursorWhere = hasCursor
		? "WHERE occurred_at < @cursorOccurredAt OR (occurred_at = @cursorOccurredAt AND order_key < @cursorOrderKey)"
		: "";
	return `SELECT * FROM (
		SELECT * FROM (${select})
		${cursorWhere}
		ORDER BY occurred_at DESC, order_key DESC
		LIMIT @sourceLimit
	)`;
}

function loadSourceRows(store: MemoryStore, options: EventOptions): DiagnosticSourceRow[] {
	const selects = sourceSelects(options);
	if (!selects.length) return [];
	const boundedSelects = selects.map((select) =>
		boundedSourceSelect(select, options.cursor != null),
	);
	const params: Record<string, unknown> = {
		resultLimit: options.limit + 1,
		sourceLimit: options.limit + 1,
	};
	if (options.cursor) {
		params.cursorOccurredAt = options.cursor.occurredAt;
		params.cursorOrderKey = options.cursor.orderKey;
	}
	return store.db
		.prepare(
			`SELECT * FROM (${boundedSelects.join(" UNION ALL ")})
			 ORDER BY occurred_at DESC, order_key DESC
			 LIMIT @resultLimit`,
		)
		.all(params) as DiagnosticSourceRow[];
}

function syncEvent(row: DiagnosticSourceRow, includeTechnical: boolean): OrderedDiagnosticEvent {
	const succeeded = row.status === "succeeded";
	const opsIn = Number(row.metric_a ?? 0);
	const opsOut = Number(row.metric_b ?? 0);
	const category = row.category ?? "unspecified";
	return {
		id: opaqueId("sync-attempt", row.source_id),
		orderKey: row.order_key,
		occurred_at: row.occurred_at,
		severity: succeeded ? "info" : "error",
		subsystem: "sync",
		code: succeeded ? "sync_attempt_succeeded" : "sync_attempt_failed",
		message: succeeded
			? "A sync attempt completed."
			: "A sync attempt failed before all work completed.",
		recovery: succeeded
			? undefined
			: { label: "Open advanced sync diagnostics", href: "#advanced/sync/diagnostics" },
		technical_detail: technicalDetail(
			true,
			succeeded
				? `${opsIn} inbound and ${opsOut} outbound operations.`
				: `Failure category: ${category}. ${opsIn} inbound and ${opsOut} outbound operations.`,
			includeTechnical,
		),
	};
}

function failureEvent(row: DiagnosticSourceRow, includeTechnical: boolean): OrderedDiagnosticEvent {
	const subsystem = row.source_type === "observer" ? "observer" : "capture";
	const attempts = Math.max(0, Number(row.metric_a ?? 0));
	const gaveUp = row.status === "gave_up";
	return {
		id: opaqueId("processing-failure", row.source_id),
		orderKey: row.order_key,
		occurred_at: row.occurred_at,
		severity: "error",
		subsystem,
		code: `${subsystem}_flush_${gaveUp ? "gave_up" : "failed"}`,
		message: gaveUp
			? "Processing stopped after all retry attempts were exhausted."
			: "Processing failed and queued events are waiting for retry.",
		recovery: { label: "Open observer settings", href: "#settings" },
		technical_detail: technicalDetail(
			true,
			`Failure category: ${row.category ?? "unspecified"}. Attempts: ${attempts}.`,
			includeTechnical,
		),
	};
}

function maintenanceEvent(
	row: DiagnosticSourceRow,
	includeTechnical: boolean,
): OrderedDiagnosticEvent {
	let severity: DiagnosticSeverity = "info";
	let code = "maintenance_job_active";
	let message = "A background maintenance task is active.";
	if (row.status === "failed") {
		severity = "error";
		code = "maintenance_job_failed";
		message = "A background maintenance task failed.";
	} else if (row.status === "cancelled") {
		severity = "warning";
		code = "maintenance_job_cancelled";
		message = "A background maintenance task was cancelled.";
	}
	const total = row.metric_b == null ? "unknown" : String(row.metric_b);
	return {
		id: opaqueId("maintenance", row.source_id),
		orderKey: row.order_key,
		occurred_at: row.occurred_at,
		severity,
		subsystem: "maintenance",
		code,
		message,
		recovery: severity === "error" ? { label: "Open Health", href: "#health" } : undefined,
		technical_detail: technicalDetail(
			true,
			`Progress: ${Number(row.metric_a ?? 0)} of ${total}.`,
			includeTechnical,
		),
	};
}

function backlogEvent(row: DiagnosticSourceRow, includeTechnical: boolean): OrderedDiagnosticEvent {
	const severity = row.status === "error" ? "error" : "warning";
	const pending = Number(row.metric_a ?? 0);
	const sessions = Number(row.metric_b ?? 0);
	const countPrefix = row.category === "capped" ? "At least " : "";
	const sessionLabel = sessions === 1 ? "session" : "sessions";
	return {
		id: opaqueId("capture-backlog", 0),
		orderKey: row.order_key,
		occurred_at: row.occurred_at,
		severity,
		subsystem: "capture",
		code: severity === "error" ? "capture_backlog_high" : "capture_backlog_growing",
		message:
			severity === "error"
				? "The capture queue has a high pending backlog."
				: "The capture queue is growing and may need attention.",
		recovery: { label: "Open Health", href: "#health" },
		technical_detail: technicalDetail(
			true,
			`${countPrefix}${pending} pending events across ${sessions} ${sessionLabel}.`,
			includeTechnical,
		),
	};
}

function collectEvents(store: MemoryStore, options: EventOptions): OrderedDiagnosticEvent[] {
	return loadSourceRows(store, options).map((row) => {
		if (row.source_type === "sync") return syncEvent(row, options.includeTechnical);
		if (row.source_type === "maintenance") {
			return maintenanceEvent(row, options.includeTechnical);
		}
		if (row.source_type === "backlog") return backlogEvent(row, options.includeTechnical);
		return failureEvent(row, options.includeTechnical);
	});
}

export function diagnosticsRoutes(getStore: StoreFactory) {
	const app = new Hono();

	app.get("/api/diagnostics/events", (c) => {
		const limit = parseLimit(c.req.query("limit"));
		const cursor = parseCursor(c.req.query("cursor"));
		const severities = parseFilter(c.req.query("severity"), DIAGNOSTIC_SEVERITIES);
		const subsystems = parseFilter(c.req.query("subsystem"), DIAGNOSTIC_SUBSYSTEMS);
		const includeTechnical = parseTechnical(c.req.query("includeTechnical"));
		if (
			limit === "invalid" ||
			cursor === "invalid" ||
			severities === "invalid" ||
			subsystems === "invalid" ||
			includeTechnical === "invalid"
		) {
			return c.json({ error: "invalid_diagnostics_query" }, 400);
		}

		const generatedAt = new Date().toISOString();
		const events = collectEvents(getStore(), {
			cursor,
			includeTechnical,
			limit,
			severities,
			subsystems,
		});
		const orderedItems = events.slice(0, limit);
		const items = orderedItems.map(({ orderKey: _orderKey, ...event }) => event);
		const lastItem = orderedItems.at(-1);
		const nextCursor = events.length > limit && lastItem ? encodeCursor(lastItem) : null;
		c.header("Cache-Control", "no-store");
		return c.json({
			contract_version: 1,
			items,
			next_cursor: nextCursor,
			redacted: true,
			generated_at: generatedAt,
		});
	});

	return app;
}
