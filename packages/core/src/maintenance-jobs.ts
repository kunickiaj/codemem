import type { Database } from "./db.js";

export type MaintenanceJobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface MaintenanceJobRecord {
	kind: string;
	title: string;
	status: MaintenanceJobStatus;
	message: string | null;
	progress_current: number;
	progress_total: number | null;
	progress_unit: string;
	metadata_json: string | null;
	started_at: string | null;
	updated_at: string;
	finished_at: string | null;
	error: string | null;
}

export interface MaintenanceJobSnapshot {
	kind: string;
	title: string;
	status: MaintenanceJobStatus;
	message: string | null;
	progress: {
		current: number;
		total: number | null;
		unit: string;
	};
	metadata: Record<string, unknown> | null;
	started_at: string | null;
	updated_at: string;
	finished_at: string | null;
	error: string | null;
}

export interface StartMaintenanceJobInput {
	kind: string;
	title: string;
	message?: string | null;
	progressTotal?: number | null;
	progressUnit?: string;
	metadata?: Record<string, unknown> | null;
	status?: "pending" | "running";
}

export interface UpdateMaintenanceJobInput {
	message?: string | null;
	progressCurrent?: number;
	progressTotal?: number | null;
	progressUnit?: string;
	metadata?: Record<string, unknown> | null;
	status?: MaintenanceJobStatus;
}

function ensureTable(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS maintenance_jobs (
			kind TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			status TEXT NOT NULL,
			message TEXT,
			progress_current INTEGER NOT NULL DEFAULT 0,
			progress_total INTEGER,
			progress_unit TEXT NOT NULL DEFAULT 'items',
			metadata_json TEXT,
			started_at TEXT,
			updated_at TEXT NOT NULL,
			finished_at TEXT,
			error TEXT
		);
		CREATE INDEX IF NOT EXISTS idx_maintenance_jobs_status_updated
			ON maintenance_jobs(status, updated_at);
	`);
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		return null;
	}
	return null;
}

function isTerminalStatus(status: MaintenanceJobStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

function resolveMessage(
	input: UpdateMaintenanceJobInput,
	existing: MaintenanceJobSnapshot,
): string | null {
	if (Object.hasOwn(input, "message")) {
		return input.message ?? null;
	}
	return existing.message;
}

function resolveMetadataJson(
	input: UpdateMaintenanceJobInput,
	existing: MaintenanceJobSnapshot,
): string | null {
	if (Object.hasOwn(input, "metadata")) {
		return input.metadata ? JSON.stringify(input.metadata) : null;
	}
	return existing.metadata ? JSON.stringify(existing.metadata) : null;
}

function toSnapshot(row: MaintenanceJobRecord | undefined): MaintenanceJobSnapshot | null {
	if (!row) return null;
	return {
		kind: row.kind,
		title: row.title,
		status: row.status,
		message: row.message,
		progress: {
			current: row.progress_current,
			total: row.progress_total,
			unit: row.progress_unit,
		},
		metadata: parseMetadata(row.metadata_json),
		started_at: row.started_at,
		updated_at: row.updated_at,
		finished_at: row.finished_at,
		error: row.error,
	};
}

export function getMaintenanceJob(db: Database, kind: string): MaintenanceJobSnapshot | null {
	ensureTable(db);
	const row = db.prepare("SELECT * FROM maintenance_jobs WHERE kind = ?").get(kind) as
		| MaintenanceJobRecord
		| undefined;
	return toSnapshot(row);
}

export function listMaintenanceJobs(db: Database): MaintenanceJobSnapshot[] {
	ensureTable(db);
	const rows = db
		.prepare("SELECT * FROM maintenance_jobs ORDER BY updated_at DESC, kind ASC")
		.all() as MaintenanceJobRecord[];
	return rows
		.map((row) => toSnapshot(row))
		.filter((row): row is MaintenanceJobSnapshot => row != null);
}

export function startMaintenanceJob(
	db: Database,
	input: StartMaintenanceJobInput,
): MaintenanceJobSnapshot {
	ensureTable(db);
	const now = new Date().toISOString();
	const status = input.status ?? "running";
	const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
	db.prepare(
		`INSERT INTO maintenance_jobs(
			kind, title, status, message, progress_current, progress_total,
			progress_unit, metadata_json, started_at, updated_at, finished_at, error
		) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, NULL)
		ON CONFLICT(kind) DO UPDATE SET
			title = excluded.title,
			status = excluded.status,
			message = excluded.message,
			progress_current = 0,
			progress_total = excluded.progress_total,
			progress_unit = excluded.progress_unit,
			metadata_json = excluded.metadata_json,
			started_at = excluded.started_at,
			updated_at = excluded.updated_at,
			finished_at = NULL,
			error = NULL`,
	).run(
		input.kind,
		input.title,
		status,
		input.message ?? null,
		input.progressTotal ?? null,
		input.progressUnit ?? "items",
		metadataJson,
		now,
		now,
	);
	const job = getMaintenanceJob(db, input.kind);
	if (!job) {
		throw new Error(`Failed to start maintenance job: ${input.kind}`);
	}
	return job;
}

export function updateMaintenanceJob(
	db: Database,
	kind: string,
	input: UpdateMaintenanceJobInput,
): MaintenanceJobSnapshot | null {
	ensureTable(db);
	const existing = getMaintenanceJob(db, kind);
	if (!existing) return null;
	const now = new Date().toISOString();
	const nextStatus = input.status ?? existing.status;
	const transitioningToTerminal =
		!isTerminalStatus(existing.status) && isTerminalStatus(nextStatus);
	const transitioningToRunning = isTerminalStatus(existing.status) && !isTerminalStatus(nextStatus);
	const finishedAt = transitioningToTerminal
		? now
		: transitioningToRunning
			? null
			: existing.finished_at;
	const error =
		nextStatus === "failed"
			? existing.error
			: nextStatus === "completed" || nextStatus === "cancelled" || transitioningToRunning
				? null
				: existing.error;
	db.prepare(
		`UPDATE maintenance_jobs
		 SET status = ?,
		     message = ?,
		     progress_current = ?,
		     progress_total = ?,
		     progress_unit = ?,
		     metadata_json = ?,
		     updated_at = ?,
		     finished_at = ?,
		     error = ?
		 WHERE kind = ?`,
	).run(
		nextStatus,
		resolveMessage(input, existing),
		input.progressCurrent ?? existing.progress.current,
		input.progressTotal === undefined ? existing.progress.total : input.progressTotal,
		input.progressUnit ?? existing.progress.unit,
		resolveMetadataJson(input, existing),
		now,
		finishedAt,
		error,
		kind,
	);
	return getMaintenanceJob(db, kind);
}

export function completeMaintenanceJob(
	db: Database,
	kind: string,
	input: Omit<UpdateMaintenanceJobInput, "status"> = {},
): MaintenanceJobSnapshot | null {
	return updateMaintenanceJob(db, kind, { ...input, status: "completed" });
}

export function failMaintenanceJob(
	db: Database,
	kind: string,
	error: string,
	input: Omit<UpdateMaintenanceJobInput, "status"> = {},
): MaintenanceJobSnapshot | null {
	ensureTable(db);
	const existing = getMaintenanceJob(db, kind);
	if (!existing) return null;
	const now = new Date().toISOString();
	db.prepare(
		`UPDATE maintenance_jobs
		 SET status = 'failed',
		     message = ?,
		     progress_current = ?,
			 progress_total = ?,
			 progress_unit = ?,
			 metadata_json = ?,
			 updated_at = ?,
			 finished_at = ?,
			 error = ?
		 WHERE kind = ?`,
	).run(
		resolveMessage(input, existing),
		input.progressCurrent ?? existing.progress.current,
		input.progressTotal === undefined ? existing.progress.total : input.progressTotal,
		input.progressUnit ?? existing.progress.unit,
		resolveMetadataJson(input, existing),
		now,
		now,
		error,
		kind,
	);
	return getMaintenanceJob(db, kind);
}

export function ensureMaintenanceJobsSchema(db: Database): void {
	ensureTable(db);
}
