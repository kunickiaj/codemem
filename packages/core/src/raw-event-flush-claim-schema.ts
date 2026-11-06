import type { Database } from "better-sqlite3";

export function verifyRawEventFlushClaimSchema(db: Database): boolean {
	return (
		db
			.prepare(
				"SELECT 1 FROM pragma_table_info('raw_event_flush_batches') WHERE name = 'claim_generation'",
			)
			.get() !== undefined
	);
}

/** Required on every writable open, including databases with a current compatibility marker. */
export function ensureRawEventFlushClaimSchema(db: Database): void {
	if (
		!db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'raw_event_flush_batches'",
			)
			.get()
	)
		return;
	if (verifyRawEventFlushClaimSchema(db)) return;
	if (db.readonly) throw new Error("Raw-event claim schema requires a writable database upgrade");
	try {
		db.exec(
			"ALTER TABLE raw_event_flush_batches ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0",
		);
	} catch (error) {
		// Another connection may have added the column after our first check.
		if (!verifyRawEventFlushClaimSchema(db)) throw error;
	}
	if (!verifyRawEventFlushClaimSchema(db))
		throw new Error("Raw-event claim generation is missing after upgrade");
}
