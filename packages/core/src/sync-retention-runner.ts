import type { Database } from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { readCoordinatorSyncConfig } from "./coordinator-runtime.js";
import { connect, resolveDbPath } from "./db.js";
import { readCodememConfigFile } from "./observer-config.js";
import * as schema from "./schema.js";
import {
	DEFAULT_SYNC_SCOPE_ID,
	estimateReplicationOpsScopeBytes,
	pruneReplicationOpsUntilCaughtUp,
} from "./sync-replication.js";

export interface SyncRetentionRunnerOptions {
	dbPath?: string;
	signal?: AbortSignal;
}

export interface SyncRetentionPassConfig {
	syncRetentionEnabled: boolean;
	syncRetentionMaxAgeDays: number;
	syncRetentionMaxSizeMb: number;
	syncRetentionMaxOpsPerPass: number;
	syncRetentionMaxRuntimeMs: number;
	scopeId?: string | null;
	maxCatchUpPasses?: number;
	signal?: AbortSignal;
}

function normalizeRetentionScopeId(scopeId: string | null | undefined): string {
	const trimmed = String(scopeId ?? "").trim();
	return trimmed.length > 0 ? trimmed : DEFAULT_SYNC_SCOPE_ID;
}

function ensureSyncRetentionStateTables(db: Database): void {
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
		);
		CREATE TABLE IF NOT EXISTS sync_retention_state_v2 (
			scope_id TEXT PRIMARY KEY NOT NULL,
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
}

function listRetentionScopeIds(db: Database): string[] {
	const rows = db
		.prepare(
			`SELECT scope_id FROM (
				SELECT COALESCE(NULLIF(TRIM(scope_id), ''), ?) AS scope_id FROM replication_ops
				UNION
				SELECT COALESCE(NULLIF(TRIM(scope_id), ''), ?) AS scope_id FROM sync_reset_state_v2
				UNION
				SELECT COALESCE(NULLIF(TRIM(scope_id), ''), ?) AS scope_id FROM sync_retention_state_v2
			)
			ORDER BY CASE WHEN scope_id = ? THEN 0 ELSE 1 END, scope_id`,
		)
		.all(
			DEFAULT_SYNC_SCOPE_ID,
			DEFAULT_SYNC_SCOPE_ID,
			DEFAULT_SYNC_SCOPE_ID,
			DEFAULT_SYNC_SCOPE_ID,
		) as Array<{ scope_id: string | null }>;
	const scopeIds = new Set<string>([DEFAULT_SYNC_SCOPE_ID]);
	for (const row of rows) {
		const scopeId = normalizeRetentionScopeId(row.scope_id);
		scopeIds.add(scopeId);
	}
	return Array.from(scopeIds);
}

interface RetentionStateValues {
	last_run_at: string;
	last_duration_ms: number;
	last_deleted_ops: number;
	last_estimated_bytes_before: number | null;
	last_estimated_bytes_after: number | null;
	retained_floor_cursor: string | null;
	last_error: string | null;
	last_error_at: string | null;
}

function persistRetentionState(
	d: ReturnType<typeof drizzle>,
	scopeId: string,
	values: RetentionStateValues,
	mirrorLegacy: boolean,
): void {
	d.insert(schema.syncRetentionStateV2)
		.values({
			scope_id: scopeId,
			...values,
		})
		.onConflictDoUpdate({
			target: schema.syncRetentionStateV2.scope_id,
			set: values,
		})
		.run();
	if (mirrorLegacy) {
		d.insert(schema.syncRetentionState)
			.values({
				id: 1,
				...values,
			})
			.onConflictDoUpdate({
				target: schema.syncRetentionState.id,
				set: values,
			})
			.run();
	}
}

function runSyncRetentionScopePass(
	db: Database,
	d: ReturnType<typeof drizzle>,
	config: SyncRetentionPassConfig,
	startedAt: string,
	scopeId: string,
): void {
	const shouldMirrorLegacy = scopeId === DEFAULT_SYNC_SCOPE_ID;
	try {
		const estimatedBytesBefore = estimateReplicationOpsScopeBytes(db, scopeId);
		const result = pruneReplicationOpsUntilCaughtUp(db, {
			maxAgeDays: config.syncRetentionMaxAgeDays,
			maxSizeBytes: config.syncRetentionMaxSizeMb * 1024 * 1024,
			maxDeleteOps: config.syncRetentionMaxOpsPerPass,
			maxRuntimeMs: config.syncRetentionMaxRuntimeMs,
			scopeId,
			maxPasses: config.maxCatchUpPasses,
			signal: config.signal,
		});
		persistRetentionState(
			d,
			scopeId,
			{
				last_run_at: startedAt,
				last_duration_ms: Date.now() - Date.parse(startedAt),
				last_deleted_ops: result.totalDeleted,
				last_estimated_bytes_before: estimatedBytesBefore,
				last_estimated_bytes_after: result.afterBytes,
				retained_floor_cursor: result.lastFloor,
				last_error: null,
				last_error_at: null,
			},
			shouldMirrorLegacy,
		);
	} catch (err) {
		persistRetentionState(
			d,
			scopeId,
			{
				last_run_at: startedAt,
				last_duration_ms: Date.now() - Date.parse(startedAt),
				last_deleted_ops: 0,
				last_estimated_bytes_before: null,
				last_estimated_bytes_after: null,
				retained_floor_cursor: null,
				last_error: err instanceof Error ? err.message : String(err),
				last_error_at: new Date().toISOString(),
			},
			shouldMirrorLegacy,
		);
	}
}

export async function runSyncRetentionPass(
	db: Database,
	config: SyncRetentionPassConfig,
): Promise<void> {
	if (!config.syncRetentionEnabled) return;
	ensureSyncRetentionStateTables(db);
	const d = drizzle(db, { schema });
	const startedAt = new Date().toISOString();
	const scopeIds =
		config.scopeId === undefined
			? listRetentionScopeIds(db)
			: [normalizeRetentionScopeId(config.scopeId)];
	for (const scopeId of scopeIds) {
		runSyncRetentionScopePass(db, d, config, startedAt, scopeId);
	}
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
		const db = connect(this.dbPath) as Database;
		try {
			await runSyncRetentionPass(db, { ...config, signal: this.signal });
		} finally {
			db.close();
		}
	}
}
