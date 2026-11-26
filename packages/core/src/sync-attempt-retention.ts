/**
 * Retention for sync attempt history.
 *
 * Every sync pass records one `sync_attempts` row per peer, so the table grows without
 * limit. This keeps every attempt from the last SYNC_ATTEMPT_RETENTION_DAYS and, older than
 * that, only the rows a reader still uses:
 *
 * - each peer's SYNC_ATTEMPT_RECENT_PER_PEER newest attempts, which the sync pass reads to
 *   back off from a peer that keeps failing to connect, and which hold its latest attempt;
 * - each peer's latest successful attempt and its latest failed attempt of every failure
 *   category, which peer health and the share-operation follow-up read;
 * - the SYNC_ATTEMPT_RECENT_OVERALL newest attempts across all peers, the most the Viewer's
 *   attempt list and sync status show.
 *
 * A removed peer's rows follow the same rule, so its latest attempts stay as history.
 * Attempts without a finish time come from old versions and are never removed, because the
 * sync status lists them after finished ones.
 */
import type { Database, Statement } from "better-sqlite3";
import {
	drainInBatches,
	PeriodicRetentionRunner,
	type PeriodicRetentionRunnerOptions,
	type RetentionPassOutcome,
	startRetentionBudget,
} from "./periodic-retention.js";

/** Attempts newer than this many days are always kept. */
export const SYNC_ATTEMPT_RETENTION_DAYS = 7;
/** Newest attempts kept per peer, whatever their age. */
export const SYNC_ATTEMPT_RECENT_PER_PEER = 10;
/** Newest attempts kept across all peers: the Viewer's attempt list shows at most 500. */
export const SYNC_ATTEMPT_RECENT_OVERALL = 500;
/** Attempt rows are small, so a batch deletes more of them than the ledger purge does. */
export const DEFAULT_SYNC_ATTEMPT_RETENTION_BATCH_SIZE = 1_000;

const KEEP_TABLE = "temp.sync_attempt_retention_keep";

export interface SyncAttemptRetentionPassOptions {
	now?: string;
	batchSize?: number;
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	/** Milliseconds clock for the runtime budget; tests replace it. */
	clock?: () => number;
}

export interface SyncAttemptRetentionPassResult {
	syncAttemptsPurged: number;
	batches: number;
	/** Whether every removable row was removed; false when the pass stopped at its budget. */
	complete: boolean;
	durationMs: number;
}

function tableExists(db: Database, name: string): boolean {
	return (
		db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
		undefined
	);
}

/** Attempts older than this are removed unless a reader still uses them. */
export function syncAttemptRetentionCutoff(now: string): string {
	return new Date(Date.parse(now) - SYNC_ATTEMPT_RETENTION_DAYS * 86_400_000).toISOString();
}

type AttemptKind = { ok: number; failure_category: string | null };

/** Every peer with attempts, one index seek each, so the cost follows peers, not rows. */
function peersWithAttempts(db: Database): string[] {
	const next = db
		.prepare("SELECT min(peer_device_id) FROM sync_attempts WHERE peer_device_id > ?")
		.pluck();
	const peers: string[] = [];
	for (
		let peer = next.get("") as string | null;
		peer != null;
		peer = next.get(peer) as string | null
	)
		peers.push(peer);
	const empty = db.prepare("SELECT 1 FROM sync_attempts WHERE peer_device_id = '' LIMIT 1").get();
	return empty ? ["", ...peers] : peers;
}

/** The kinds of attempt one peer has: success, and failure per category. */
function kindsForPeer(statements: KindStatements, peer: string): AttemptKind[] {
	const kinds: AttemptKind[] = [];
	let kind = statements.first.get(peer) as AttemptKind | undefined;
	while (kind) {
		kinds.push(kind);
		const sameOk =
			kind.failure_category == null
				? statements.nextCategoryAfterNull.get(peer, kind.ok)
				: statements.nextCategory.get(peer, kind.ok, kind.failure_category);
		kind = (sameOk ?? statements.nextOk.get(peer, kind.ok)) as AttemptKind | undefined;
	}
	return kinds;
}

interface KindStatements {
	first: Statement<unknown[]>;
	nextCategoryAfterNull: Statement<unknown[]>;
	nextCategory: Statement<unknown[]>;
	nextOk: Statement<unknown[]>;
}

/**
 * Records, in a temporary table on this connection, the ids of the rows a reader uses. Every
 * lookup is an index seek or a short index range, so the cost follows the number of peers and
 * kinds of attempt, not the size of the table. The set is taken once per pass. Rows recorded
 * later are newer than the cutoff, so they are never removed, and every row a reader needs
 * later is either one of them or in this set.
 */
function recordRowsReadersUse(db: Database): void {
	db.exec(`DROP TABLE IF EXISTS ${KEEP_TABLE}`);
	db.exec(`CREATE TABLE ${KEEP_TABLE} (id INTEGER PRIMARY KEY)`);
	const keep = db.prepare(`INSERT OR IGNORE INTO ${KEEP_TABLE}(id) VALUES (?)`);
	const keepAll = (ids: unknown[]) => {
		for (const id of ids) keep.run(id);
	};
	const recentForPeer = db
		.prepare(
			`SELECT id FROM sync_attempts WHERE peer_device_id = ?
			 ORDER BY started_at DESC, id DESC LIMIT ?`,
		)
		.pluck();
	const kindColumns = "SELECT ok, failure_category FROM sync_attempts";
	const kinds: KindStatements = {
		first: db.prepare(
			`${kindColumns} WHERE peer_device_id = ? ORDER BY ok, failure_category LIMIT 1`,
		),
		nextCategoryAfterNull: db.prepare(
			`${kindColumns} WHERE peer_device_id = ? AND ok = ? AND failure_category IS NOT NULL
			 ORDER BY failure_category LIMIT 1`,
		),
		nextCategory: db.prepare(
			`${kindColumns} WHERE peer_device_id = ? AND ok = ? AND failure_category > ?
			 ORDER BY failure_category LIMIT 1`,
		),
		nextOk: db.prepare(
			`${kindColumns} WHERE peer_device_id = ? AND ok > ? ORDER BY ok, failure_category LIMIT 1`,
		),
	};
	// The latest row of each kind, ordered as readers order it: start time, then id.
	const latestOfKind = db
		.prepare(
			`SELECT id FROM sync_attempts
			 WHERE peer_device_id = ? AND ok = ? AND failure_category IS ?
			 ORDER BY started_at DESC, id DESC LIMIT 1`,
		)
		.pluck();
	for (const peer of peersWithAttempts(db)) {
		keepAll(recentForPeer.all(peer, SYNC_ATTEMPT_RECENT_PER_PEER));
		for (const kind of kindsForPeer(kinds, peer))
			keepAll(latestOfKind.all(peer, kind.ok, kind.failure_category));
	}
	keepAll(
		db
			.prepare(
				`SELECT id FROM sync_attempts WHERE finished_at IS NOT NULL
				 ORDER BY CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END DESC, id DESC
				 LIMIT ?`,
			)
			.pluck()
			.all(SYNC_ATTEMPT_RECENT_OVERALL),
	);
}

/**
 * Deletes the oldest removable rows below the cutoff. It walks the effective-time index from
 * the oldest row, so a batch reads its own rows plus the few kept or unfinished ones before
 * them, however large the table is.
 */
function purgeBatch(db: Database, cutoff: string, limit: number): number {
	return db
		.prepare(
			`DELETE FROM sync_attempts WHERE id IN (
				SELECT id FROM sync_attempts
				WHERE CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END < ?
				  AND finished_at IS NOT NULL
				  AND id NOT IN (SELECT id FROM ${KEEP_TABLE})
				ORDER BY CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END, id
				LIMIT ?
			)`,
		)
		.run(cutoff, limit).changes;
}

/**
 * Removes old sync attempts that no reader uses, in batches. The first batch always runs, and
 * the runtime budget covers the batches after it, so a pass that finds removable rows always
 * removes some, however long finding the rows to keep took.
 */
export async function runSyncAttemptRetentionPass(
	db: Database,
	options: SyncAttemptRetentionPassOptions = {},
): Promise<SyncAttemptRetentionPassResult> {
	const pass = startRetentionBudget(options);
	const batchSize = options.batchSize ?? DEFAULT_SYNC_ATTEMPT_RETENTION_BATCH_SIZE;
	if (!Number.isInteger(batchSize) || batchSize <= 0) {
		throw new Error("sync attempt retention batch size must be a positive integer");
	}
	if (options.signal?.aborted) {
		return { syncAttemptsPurged: 0, batches: 0, complete: false, durationMs: pass.elapsedMs() };
	}
	if (!tableExists(db, "sync_attempts")) {
		return { syncAttemptsPurged: 0, batches: 0, complete: true, durationMs: pass.elapsedMs() };
	}
	const cutoff = syncAttemptRetentionCutoff(options.now ?? new Date().toISOString());
	let batches = 0;
	recordRowsReadersUse(db);
	try {
		// The first batch runs whatever the budget, so every pass makes progress.
		const first = purgeBatch(db, cutoff, batchSize);
		batches += 1;
		if (first < batchSize) {
			return { syncAttemptsPurged: first, batches, complete: true, durationMs: pass.elapsedMs() };
		}
		const deletes = startRetentionBudget(options);
		const rest = await drainInBatches(
			(limit) => purgeBatch(db, cutoff, limit),
			batchSize,
			deletes.outOfBudget,
			() => {
				batches += 1;
			},
		);
		return {
			syncAttemptsPurged: first + rest.purged,
			batches,
			complete: rest.done,
			durationMs: pass.elapsedMs(),
		};
	} finally {
		db.exec(`DROP TABLE IF EXISTS ${KEEP_TABLE}`);
	}
}

export function describeSyncAttemptRetentionPass(result: SyncAttemptRetentionPassResult): string {
	const remaining = result.complete ? "" : "; more old attempts remain";
	return `Sync attempt retention purged ${result.syncAttemptsPurged} attempts in ${result.durationMs} ms${remaining}`;
}

export interface SyncAttemptRetentionRunnerOptions extends PeriodicRetentionRunnerOptions {
	pass?: Omit<SyncAttemptRetentionPassOptions, "signal" | "now" | "clock">;
}

/** Runs sync attempt retention passes on a timer in a long-lived process. */
export class SyncAttemptRetentionRunner extends PeriodicRetentionRunner {
	protected readonly label = "Sync attempt retention";
	private readonly passOptions: SyncAttemptRetentionRunnerOptions["pass"];

	constructor(options: SyncAttemptRetentionRunnerOptions = {}) {
		super(options);
		this.passOptions = options.pass;
	}

	protected async runPass(db: Database): Promise<RetentionPassOutcome> {
		const result = await runSyncAttemptRetentionPass(db, {
			...this.passOptions,
			signal: this.signal,
		});
		return {
			purged: result.syncAttemptsPurged,
			complete: result.complete,
			summary: describeSyncAttemptRetentionPass(result),
		};
	}
}
