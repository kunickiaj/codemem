import { setImmediate, setTimeout } from "node:timers/promises";
import type { Database } from "./db.js";
import { tryResolveEmbeddingVectorIdentityLabel } from "./embeddings.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	getMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "./maintenance-jobs.js";
import { auditBatch } from "./semantic/validated-vector-index-audit.js";
import { readState, type State } from "./semantic/validated-vector-index-state.js";
import { prepareVectorWrites } from "./vector-writes.js";

const VALIDATION_JOB = "vector_index_validation";

function isBusy(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = String(error.code);
	return code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED");
}

function withoutBusyWait<T>(db: Database, operation: () => T): T {
	const timeout = Number(db.pragma("busy_timeout", { simple: true }));
	db.pragma("busy_timeout = 0");
	try {
		return operation();
	} finally {
		db.pragma(`busy_timeout = ${timeout}`);
	}
}

/** Acquire the writer lock before any reads or job updates, without blocking the event loop. */
function immediate<T>(db: Database, operation: () => T): T {
	return withoutBusyWait(db, () => db.transaction(operation).immediate());
}

interface BatchProgress {
	generation: string;
	checked: number;
	pruned: number;
}

function hasRepairRows(db: Database): boolean {
	return Boolean(
		db
			.prepare(`SELECT 1 FROM validated_vector_rows
		WHERE audit_state='invalid' AND reason IS NOT 'model' LIMIT 1`)
			.get(),
	);
}

/** Deletes derived vectors only; the production writer updates catalog counts and versions. */
function pruneInvalidPage(db: Database): number {
	const rows = db
		.prepare(`SELECT rowid FROM validated_vector_rows
		WHERE audit_state='invalid' AND reason IS NOT 'model' ORDER BY rowid LIMIT 250`)
		.all() as { rowid: number }[];
	if (!rows.length) return 0;
	return prepareVectorWrites(db)({ deleteRowIds: rows.map((row) => row.rowid) }).deleted;
}

/** Uses only persisted/runtime-resolved metadata, never an unresolved revision or inference. */
export function configuredVectorIndexModel(db: Database): string | undefined {
	for (const kind of ["vector_model_identity", "vector_model_migration"]) {
		const metadata = getMaintenanceJob(db, kind)?.metadata;
		const model = tryResolveEmbeddingVectorIdentityLabel({
			targetModel: metadata?.target_model,
			requestedModel: metadata?.requested_model,
			requestedRevision: metadata?.requested_revision,
		});
		if (model) return model;
	}
	return undefined;
}

/** One store-owned audit loop. Model declarations/censuses remain writer responsibilities. */
export class VectorIndexMaintenance {
	private pending: Promise<void> | undefined;
	private failure: { error: unknown } | undefined;
	private closing = false;
	private progress: BatchProgress | undefined;
	private noRepairRowsAt: { generationId: string; invalidCount: number } | undefined;

	constructor(
		private readonly db: Database,
		private readonly shouldStop: () => boolean,
	) {}

	get requiresAsyncClose(): boolean {
		return this.pending !== undefined || this.failure !== undefined;
	}

	schedule(): void {
		if (this.pending || this.failure || this.stopped()) return;
		try {
			const state = withoutBusyWait(this.db, () => readState(this.db));
			if (state.status === "ready" || !state.audit_started) return;
			if (state.status === "needsrepair" && this.hasOnlyModelRejections(state)) return;
		} catch (error) {
			if (!isBusy(error)) throw error;
		}
		this.pending = this.run()
			.catch((error: unknown) => this.recordFailure(error))
			.finally(() => {
				this.pending = undefined;
			});
	}

	async close(): Promise<void> {
		this.closing = true;
		await this.pending;
		if (this.failure) throw this.failure.error;
	}

	private hasOnlyModelRejections(state: State): boolean {
		const previous = this.noRepairRowsAt;
		if (
			previous?.generationId === state.generation_id &&
			previous.invalidCount === state.invalid_count
		)
			return true;
		if (hasRepairRows(this.db)) return false;
		// Valid writes cannot add rejected rows; audits rotate the generation before reclassifying them.
		this.noRepairRowsAt = { generationId: state.generation_id, invalidCount: state.invalid_count };
		return true;
	}

	private stopped(): boolean {
		return this.closing || this.shouldStop();
	}

	private async run(): Promise<void> {
		while (!this.stopped()) {
			await setImmediate();
			if (this.stopped()) break;
			try {
				const result = immediate(this.db, () => this.tick());
				this.progress = result.progress;
				if (!result.more) return;
			} catch (error) {
				if (!isBusy(error)) throw error;
				await setTimeout(25);
			}
		}
		try {
			immediate(this.db, () =>
				this.pause("Validation paused; an async request resumes pending rows."),
			);
		} catch (error) {
			// Another writer may prevent persisting the pause; it must not prevent local shutdown.
			if (!isBusy(error)) throw error;
		}
	}

	private tick(): { more: boolean; progress: BatchProgress | undefined } {
		const state = readState(this.db);
		if (!state.audit_started) {
			this.pause("Vector index changed; validation requires a new census.");
			return { more: false, progress: this.progress };
		}
		if (state.status === "ready") {
			if (this.progress) this.finish(state);
			return { more: false, progress: this.progress };
		}
		const progress = this.startGeneration(state);
		if (state.status === "building")
			progress.checked += auditBatch(this.db, { limit: 250 }).checked;
		else progress.pruned += pruneInvalidPage(this.db);
		const after = readState(this.db);
		this.reportProgress(after, progress);
		const more =
			after.status === "building" || (after.status === "needsrepair" && hasRepairRows(this.db));
		if (!more) this.finish(after);
		return { more, progress };
	}

	private reportProgress(state: State, progress: BatchProgress): void {
		const current = progress.checked + progress.pruned;
		updateMaintenanceJob(this.db, VALIDATION_JOB, {
			status: "running",
			progressCurrent: current,
			progressTotal: current + state.pending_count + state.invalid_count,
			metadata: {
				generation_id: state.generation_id,
				invalid_rows: state.invalid_count,
				pruned_rows: progress.pruned,
			},
		});
	}

	private pause(message: string): void {
		if (!this.progress) return;
		updateMaintenanceJob(this.db, VALIDATION_JOB, { status: "cancelled", message });
	}

	private startGeneration(state: State): BatchProgress {
		if (this.progress?.generation === state.generation_id) return { ...this.progress };
		startMaintenanceJob(this.db, {
			kind: VALIDATION_JOB,
			title: "Validate vector index",
			progressTotal: state.pending_count + state.invalid_count,
			progressUnit: "rows",
			metadata: { generation_id: state.generation_id },
		});
		return { generation: state.generation_id, checked: 0, pruned: 0 };
	}

	private finish(state: State): void {
		if (state.status === "needsrepair") {
			failMaintenanceJob(
				this.db,
				VALIDATION_JOB,
				`${state.invalid_count} vector rows use undeclared models. Configure or migrate the embedding model to validate them; their vectors were retained.`,
			);
			return;
		}
		completeMaintenanceJob(this.db, VALIDATION_JOB, {
			message: "Vector index validation finished.",
		});
	}

	private async recordFailure(error: unknown): Promise<void> {
		this.failure = { error };
		while (!this.stopped()) {
			try {
				immediate(this.db, () => this.reportFailure(error));
				return;
			} catch (reportingError) {
				if (isBusy(reportingError)) {
					await setTimeout(25);
					continue;
				}
				this.failure = {
					error: new AggregateError([error, reportingError], "Vector index validation failed."),
				};
				return;
			}
		}
	}

	private reportFailure(error: unknown): void {
		if (!getMaintenanceJob(this.db, VALIDATION_JOB)) {
			startMaintenanceJob(this.db, { kind: VALIDATION_JOB, title: "Validate vector index" });
		}
		failMaintenanceJob(
			this.db,
			VALIDATION_JOB,
			error instanceof Error ? error.message : String(error),
		);
	}
}
