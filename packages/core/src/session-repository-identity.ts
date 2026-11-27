/**
 * Each session's recorded repository identity, stored beside the session so the reads
 * that map checkout folders to repositories need not parse every session's metadata.
 *
 * `recorded_repository_identity` holds what `repositoryIdentityFromMetadata` returns for
 * the row's metadata, the same JavaScript function those reads used before, so nothing
 * about which identity a session records changes. `recorded_repository_identity_checked`
 * is 1 once that value was computed from the row's current metadata.
 *
 * Writers do not maintain the column. Two triggers clear the checked flag whenever a row's
 * metadata changes or a row arrives already flagged, whichever process or release writes
 * it, and the maintenance worker fills the column in small batches. Readers take the stored
 * value only from flagged rows and parse the metadata of the rest, so a read is exact at
 * every point of the backfill. Without the triggers, readers use none of this.
 *
 * The columns, triggers and indexes are created by the maintenance worker, never when a
 * database is opened, so opening and the sync preflight never wait on an index build.
 */
import type { Database } from "better-sqlite3";
import {
	drainInBatches,
	PeriodicRetentionRunner,
	type PeriodicRetentionRunnerOptions,
	type RetentionPassOutcome,
	startRetentionBudget,
} from "./periodic-retention.js";
import { repositoryIdentityFromMetadata } from "./project.js";
import { columnExists, schemaObjectExists } from "./schema-lookups.js";

export const SESSION_IDENTITY_COLUMN = "recorded_repository_identity";
export const SESSION_IDENTITY_CHECKED_COLUMN = "recorded_repository_identity_checked";

const RESET_ON_UPDATE_TRIGGER = "trg_sessions_repository_identity_reset_update";
const RESET_ON_INSERT_TRIGGER = "trg_sessions_repository_identity_reset_insert";
/** Covers the folder reads for checked rows. */
const CHECKED_INDEX = "idx_sessions_repository_identity_checked";
/** Finds the rows still to check. */
const UNCHECKED_INDEX = "idx_sessions_repository_identity_unchecked";
/** Covers the distinct-folder read. */
const CWD_INDEX = "idx_sessions_cwd";

const DEFAULT_BATCH_SIZE = 500;

const TRIGGERS_SQL = `
	CREATE TRIGGER IF NOT EXISTS ${RESET_ON_UPDATE_TRIGGER}
	AFTER UPDATE OF metadata_json ON sessions
	WHEN NEW.metadata_json IS NOT OLD.metadata_json
	BEGIN
		UPDATE sessions SET ${SESSION_IDENTITY_COLUMN} = NULL, ${SESSION_IDENTITY_CHECKED_COLUMN} = NULL
		WHERE id = NEW.id;
	END;
	CREATE TRIGGER IF NOT EXISTS ${RESET_ON_INSERT_TRIGGER}
	AFTER INSERT ON sessions
	WHEN NEW.${SESSION_IDENTITY_CHECKED_COLUMN} IS NOT NULL
	BEGIN
		UPDATE sessions SET ${SESSION_IDENTITY_COLUMN} = NULL, ${SESSION_IDENTITY_CHECKED_COLUMN} = NULL
		WHERE id = NEW.id;
	END;`;

const INDEXES_SQL = `
	CREATE INDEX IF NOT EXISTS ${CHECKED_INDEX}
		ON sessions(cwd, git_remote, ${SESSION_IDENTITY_COLUMN})
		WHERE ${SESSION_IDENTITY_CHECKED_COLUMN} = 1;
	CREATE INDEX IF NOT EXISTS ${UNCHECKED_INDEX}
		ON sessions(id) WHERE ${SESSION_IDENTITY_CHECKED_COLUMN} IS NULL;
	CREATE INDEX IF NOT EXISTS ${CWD_INDEX} ON sessions(cwd);`;

/**
 * Whether readers may trust the checked flag: the columns exist and both triggers that
 * clear it are in place. Remembered per connection until the schema changes.
 */
export function sessionRepositoryIdentityReady(db: Database): boolean {
	return (
		columnExists(db, "sessions", SESSION_IDENTITY_COLUMN) &&
		columnExists(db, "sessions", SESSION_IDENTITY_CHECKED_COLUMN) &&
		schemaObjectExists(db, "trigger", RESET_ON_UPDATE_TRIGGER) &&
		schemaObjectExists(db, "trigger", RESET_ON_INSERT_TRIGGER)
	);
}

function sessionsTableUsable(db: Database): boolean {
	return (
		columnExists(db, "sessions", "id") &&
		columnExists(db, "sessions", "cwd") &&
		columnExists(db, "sessions", "git_remote") &&
		columnExists(db, "sessions", "metadata_json")
	);
}

/**
 * Creates the columns, the triggers and the indexes. When the triggers are new, every
 * flag is cleared in the same transaction: rows flagged while no trigger was watching
 * may hold a value their metadata no longer gives.
 */
export function installSessionRepositoryIdentity(db: Database): boolean {
	if (!sessionsTableUsable(db)) return false;
	db.transaction(() => {
		if (!columnExists(db, "sessions", SESSION_IDENTITY_COLUMN)) {
			db.exec(`ALTER TABLE sessions ADD COLUMN ${SESSION_IDENTITY_COLUMN} TEXT`);
		}
		if (!columnExists(db, "sessions", SESSION_IDENTITY_CHECKED_COLUMN)) {
			db.exec(`ALTER TABLE sessions ADD COLUMN ${SESSION_IDENTITY_CHECKED_COLUMN} INTEGER`);
		}
		const triggersPresent =
			schemaObjectExists(db, "trigger", RESET_ON_UPDATE_TRIGGER) &&
			schemaObjectExists(db, "trigger", RESET_ON_INSERT_TRIGGER);
		if (!triggersPresent) {
			db.exec(TRIGGERS_SQL);
			db.exec(
				`UPDATE sessions SET ${SESSION_IDENTITY_COLUMN} = NULL, ${SESSION_IDENTITY_CHECKED_COLUMN} = NULL
				 WHERE ${SESSION_IDENTITY_CHECKED_COLUMN} IS NOT NULL`,
			);
		}
	}).immediate();
	db.exec(INDEXES_SQL);
	return true;
}

/**
 * Computes the identity of up to `limit` unchecked rows and flags them, in one write
 * transaction, so no other writer can change a row's metadata between the read and the
 * flag. Returns how many rows it checked.
 */
export function checkSessionRepositoryIdentities(db: Database, limit: number): number {
	return db
		.transaction(() => {
			const rows = db
				.prepare(
					`SELECT id, metadata_json FROM sessions
					 WHERE ${SESSION_IDENTITY_CHECKED_COLUMN} IS NULL LIMIT ?`,
				)
				.all(limit) as Array<{ id: number; metadata_json: string | null }>;
			const update = db.prepare(
				`UPDATE sessions SET ${SESSION_IDENTITY_COLUMN} = ?, ${SESSION_IDENTITY_CHECKED_COLUMN} = 1
				 WHERE id = ?`,
			);
			for (const row of rows) update.run(repositoryIdentityFromMetadata(row.metadata_json), row.id);
			return rows.length;
		})
		.immediate();
}

export interface SessionRepositoryIdentityPassOptions {
	batchSize?: number;
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	clock?: () => number;
}

export async function runSessionRepositoryIdentityPass(
	db: Database,
	options: SessionRepositoryIdentityPassOptions = {},
): Promise<{ checked: number; complete: boolean }> {
	if (!installSessionRepositoryIdentity(db)) return { checked: 0, complete: true };
	const budget = startRetentionBudget(options);
	const { purged, done } = await drainInBatches(
		(limit) => checkSessionRepositoryIdentities(db, limit),
		options.batchSize ?? DEFAULT_BATCH_SIZE,
		budget.outOfBudget,
		() => undefined,
	);
	return { checked: purged, complete: done };
}

/** Fills session repository identities on a timer in the maintenance worker. */
export class SessionRepositoryIdentityRunner extends PeriodicRetentionRunner {
	protected readonly label = "Session repository identity backfill";
	private readonly passOptions: Omit<SessionRepositoryIdentityPassOptions, "signal">;

	constructor(
		options: PeriodicRetentionRunnerOptions & {
			pass?: Omit<SessionRepositoryIdentityPassOptions, "signal">;
		} = {},
	) {
		// Until the first pass installs the column, folder reads parse metadata, so it runs
		// soon after start. New sessions arrive with every flush, so idle passes come every
		// minute.
		super({ initialDelayMs: 10_000, idleIntervalMs: 60_000, backlogIntervalMs: 5_000, ...options });
		this.passOptions = options.pass ?? {};
	}

	protected async runPass(db: Database): Promise<RetentionPassOutcome> {
		const result = await runSessionRepositoryIdentityPass(db, {
			...this.passOptions,
			signal: this.signal,
		});
		return {
			// New sessions are checked every minute; only log the backfill of a backlog.
			purged: result.checked > DEFAULT_BATCH_SIZE ? result.checked : 0,
			complete: result.complete,
			summary: `Session repository identity backfill checked ${result.checked} sessions`,
		};
	}
}
