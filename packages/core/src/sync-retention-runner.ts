import type { Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readCoordinatorSyncConfig } from "./coordinator-runtime.js";
import { connect, resolveDbPath } from "./db.js";
import { readCodememConfigFile } from "./observer-config.js";
import * as schema from "./schema.js";
import { pruneReplicationOps } from "./sync-replication.js";

export interface SyncRetentionRunnerOptions {
	dbPath?: string;
	signal?: AbortSignal;
}

export class SyncRetentionRunner {
	private readonly dbPath: string;
	private readonly signal?: AbortSignal;
	private active = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private currentRun: Promise<void> | null = null;

	constructor(options?: SyncRetentionRunnerOptions) {
		this.dbPath = resolveDbPath(options?.dbPath);
		this.signal = options?.signal;
	}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.schedule(10_000);
	}

	async stop(): Promise<void> {
		this.active = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.currentRun) await this.currentRun;
	}

	private schedule(delayMs: number): void {
		if (!this.active || this.signal?.aborted) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.currentRun = this.runOnce()
				.catch(() => {
					// Errors are persisted into sync_retention_state where possible; never crash the viewer.
				})
				.finally(() => {
					this.currentRun = null;
					const config = readCoordinatorSyncConfig(readCodememConfigFile());
					this.schedule(config.syncRetentionIntervalS * 1000);
				});
		}, delayMs);
		if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
	}

	private async runOnce(): Promise<void> {
		if (!this.active || this.signal?.aborted) return;
		const config = readCoordinatorSyncConfig(readCodememConfigFile());
		if (!config.syncRetentionEnabled) return;
		const db = connect(this.dbPath) as Database;
		db.exec(`
			CREATE TABLE IF NOT EXISTS sync_retention_state (
				id INTEGER PRIMARY KEY,
				last_run_at TEXT,
				last_duration_ms INTEGER,
				last_deleted_ops INTEGER NOT NULL DEFAULT 0,
				last_estimated_bytes_before INTEGER,
				last_estimated_bytes_after INTEGER,
				retained_floor_cursor TEXT,
				last_error TEXT,
				last_error_at TEXT
			)
		`);
		const d = drizzle(db, { schema });
		const startedAt = new Date().toISOString();
		try {
			const result = pruneReplicationOps(db, {
				maxAgeDays: config.syncRetentionMaxAgeDays,
				maxSizeBytes: config.syncRetentionMaxSizeMb * 1024 * 1024,
				maxDeleteOps: config.syncRetentionMaxOpsPerPass,
				maxRuntimeMs: config.syncRetentionMaxRuntimeMs,
			});
			d.insert(schema.syncRetentionState)
				.values({
					id: 1,
					last_run_at: startedAt,
					last_duration_ms: Date.now() - Date.parse(startedAt),
					last_deleted_ops: result.deleted,
					last_estimated_bytes_before: result.estimated_bytes_before ?? null,
					last_estimated_bytes_after: result.estimated_bytes_after ?? null,
					retained_floor_cursor: result.retained_floor_cursor,
					last_error: null,
					last_error_at: null,
				})
				.onConflictDoUpdate({
					target: schema.syncRetentionState.id,
					set: {
						last_run_at: startedAt,
						last_duration_ms: Date.now() - Date.parse(startedAt),
						last_deleted_ops: result.deleted,
						last_estimated_bytes_before: result.estimated_bytes_before ?? null,
						last_estimated_bytes_after: result.estimated_bytes_after ?? null,
						retained_floor_cursor: result.retained_floor_cursor,
						last_error: null,
						last_error_at: null,
					},
				})
				.run();
		} catch (err) {
			d.insert(schema.syncRetentionState)
				.values({
					id: 1,
					last_run_at: startedAt,
					last_duration_ms: Date.now() - Date.parse(startedAt),
					last_deleted_ops: 0,
					last_estimated_bytes_before: null,
					last_estimated_bytes_after: null,
					retained_floor_cursor: null,
					last_error: err instanceof Error ? err.message : String(err),
					last_error_at: new Date().toISOString(),
				})
				.onConflictDoUpdate({
					target: schema.syncRetentionState.id,
					set: {
						last_run_at: startedAt,
						last_duration_ms: Date.now() - Date.parse(startedAt),
						last_deleted_ops: 0,
						last_estimated_bytes_before: null,
						last_estimated_bytes_after: null,
						retained_floor_cursor: null,
						last_error: err instanceof Error ? err.message : String(err),
						last_error_at: new Date().toISOString(),
					},
				})
				.run();
		} finally {
			db.close();
		}
	}
}
