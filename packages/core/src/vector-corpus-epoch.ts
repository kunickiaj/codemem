import type { Database } from "better-sqlite3";

const TRIGGERS = [
	["insert", "AFTER INSERT", ""],
	["delete", "AFTER DELETE", ""],
	[
		"update",
		// UPDATE OF id misses writes through rowid/_rowid_/oid aliases.
		"AFTER UPDATE",
		"WHEN OLD.id IS NOT NEW.id OR OLD.title IS NOT NEW.title OR OLD.body_text IS NOT NEW.body_text OR OLD.active IS NOT NEW.active",
	],
].map(([suffix, event, condition]) => ({
	name: `vector_corpus_epoch_${suffix}`,
	sql: `CREATE TRIGGER vector_corpus_epoch_${suffix} ${event} ON memory_items ${condition}
	BEGIN UPDATE vector_corpus_epoch SET epoch = epoch + 1 WHERE id = 1; END`,
}));

function hasCurrentTriggers(db: Database): boolean {
	const select = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = ?");
	return TRIGGERS.every(
		({ name, sql }) => (select.get(name) as { sql: string } | undefined)?.sql === sql,
	);
}

/** Ordinary-table triggers also observe writes from older application versions. */
export function ensureVectorCorpusEpoch(db: Database): void {
	if (db.readonly) return;
	try {
		installVectorCorpusEpoch(db);
	} catch {
		// Optional derived state: minimal/query-only/locked handles retain the
		// conservative mutation fence. The installation transaction rolls back.
	}
}

function installVectorCorpusEpoch(db: Database): void {
	const columns = db.prepare("PRAGMA table_info(memory_items)").all() as { name: string }[];
	if (!["id", "title", "body_text", "active"].every((name) => columns.some((c) => c.name === name)))
		return;
	if (readVectorCorpusFence(db).epoch !== null) return;
	db.transaction(() => {
		db.exec(
			"CREATE TABLE IF NOT EXISTS vector_corpus_epoch (id INTEGER PRIMARY KEY CHECK (id = 1), epoch INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch >= 0))",
		);
		const initialized = db
			.prepare("INSERT OR IGNORE INTO vector_corpus_epoch VALUES (1, 0)")
			.run().changes;
		if (!initialized && hasCurrentTriggers(db)) return;
		for (const { name, sql } of TRIGGERS) {
			db.exec(`DROP TRIGGER IF EXISTS ${name}`);
			db.exec(sql);
		}
		db.exec("UPDATE vector_corpus_epoch SET epoch = epoch + 1 WHERE id = 1");
	}).immediate();
}

/** Compare both fields: repairing a deleted counter row can repeat an epoch. */
export type VectorCorpusFence = { schemaVersion: number; epoch: string | null };

export function readVectorCorpusFence(db: Database): VectorCorpusFence {
	const schemaVersion = Number(db.pragma("schema_version", { simple: true }));
	try {
		if (!hasCurrentTriggers(db)) return { schemaVersion, epoch: null };
		const row = db
			.prepare(
				"SELECT CAST(epoch AS TEXT) AS epoch FROM vector_corpus_epoch WHERE id = 1 AND typeof(epoch) = 'integer' AND epoch >= 0",
			)
			.get() as { epoch: string } | undefined;
		return { schemaVersion, epoch: row?.epoch ?? null };
	} catch {
		// Minimal/legacy schemas retain the conservative global mutation fence.
		return { schemaVersion, epoch: null };
	}
}
