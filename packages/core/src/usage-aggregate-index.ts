import type { Database } from "better-sqlite3";

const INDEX_NAME = "idx_usage_events_public_aggregate_cover";

/** Keep dashboard aggregates on the small index instead of decoding metadata on every read. */
export function ensureUsageEventsAggregateIndex(db: Database): void {
	if (db.readonly) return;
	try {
		if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(INDEX_NAME))
			return;
		// Match classifiedUsageSql's JSON expression and public-row predicate exactly.
		// Built-in JSON functions keep the derived index writable by older clients.
		db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_events_public_aggregate_cover
			ON usage_events (
				event,
				CASE WHEN json_valid(metadata_json)
					THEN json_extract(metadata_json, '$.token_usage.source') ELSE NULL END,
				tokens_read, tokens_written, tokens_saved, session_id
			)
			WHERE event != 'observer_recovery_scope_denial'
				AND event NOT GLOB 'observer_recovery_call_clock:*'`);
	} catch {
		// Optional access path: locked, query-only and partial legacy schemas keep
		// their existing aggregate queries and retry on the next writable open.
	}
}
