import {
	DEDUP_KEY_BACKFILL_JOB,
	DedupKeyBackfillRunner,
	getMaintenanceJob,
	hasPendingDedupKeyBackfill,
	hasPendingRefBackfill,
	hasPendingScopeBackfill,
	hasPendingSessionContextBackfill,
	hasPendingSummaryDedupBackfill,
	isEmbeddingDisabled,
	type MemoryStore,
	MemoryStore as MemoryStoreCtor,
	REF_BACKFILL_JOB,
	RefBackfillRunner,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	resolveDbPath,
	SCOPE_BACKFILL_JOB,
	ScopeBackfillRunner,
	SESSION_CONTEXT_BACKFILL_JOB,
	SessionContextBackfillRunner,
	SUMMARY_DEDUP_BACKFILL_JOB,
	SummaryDedupBackfillRunner,
	SyncRetentionRunner,
	VectorModelMigrationRunner,
} from "@codemem/core";

export interface MaintenanceWorkerLogger {
	step(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface MaintenanceWorkerRuntimeOptions {
	dbPath?: string | null;
	configPath?: string | null;
	signal?: AbortSignal;
	logger?: MaintenanceWorkerLogger;
}

export type ManagedMaintenanceRunner = {
	start(): void;
	stop(): Promise<void>;
};

export type BackfillJobPlan = {
	name: string;
	kind: string;
	isPending: (db: MemoryStore["db"]) => boolean;
	createRunner: () => ManagedMaintenanceRunner;
};

const defaultLogger: MaintenanceWorkerLogger = {
	step: (message) => console.error(message),
	warn: (message) => console.error(`Warning: ${message}`),
	error: (message) => console.error(`Error: ${message}`),
};

function readWorkerSyncConfig(configPath?: string | null) {
	const config = configPath ? readCodememConfigFileAtPath(configPath) : readCodememConfigFile();
	return readCoordinatorSyncConfig(config);
}

export function createSequentialBackfillCoordinator(
	store: MemoryStore,
	jobPlans: BackfillJobPlan[],
	options: { signal?: AbortSignal; logger: MaintenanceWorkerLogger },
): ManagedMaintenanceRunner {
	const pollIntervalMs = 1000;
	let activeRunner: ManagedMaintenanceRunner | null = null;
	let activePlan: BackfillJobPlan | null = null;
	let activePollTimer: ReturnType<typeof setTimeout> | null = null;
	let nextJobIndex = 0;
	let stopped = false;

	const clearPollTimer = () => {
		if (!activePollTimer) return;
		clearTimeout(activePollTimer);
		activePollTimer = null;
	};

	const schedulePoll = (fn: () => void) => {
		clearPollTimer();
		activePollTimer = setTimeout(fn, pollIntervalMs);
		if (typeof activePollTimer === "object" && "unref" in activePollTimer) {
			activePollTimer.unref();
		}
	};

	const startNextJob = () => {
		clearPollTimer();
		if (stopped || options.signal?.aborted) return;
		while (nextJobIndex < jobPlans.length) {
			const plan = jobPlans[nextJobIndex++];
			if (!plan) continue;
			if (!plan.isPending(store.db)) continue;
			activePlan = plan;
			activeRunner = plan.createRunner();
			options.logger.step(`${plan.name} backfill started`);
			activeRunner.start();
			schedulePoll(waitForCurrentJob);
			return;
		}
		options.logger.step("All backfill jobs complete");
	};

	const waitForCurrentJob = () => {
		if (stopped || options.signal?.aborted || !activePlan || !activeRunner) return;
		const job = getMaintenanceJob(store.db, activePlan.kind);
		if (job?.status === "failed") {
			const failedPlan = activePlan;
			const failedRunner = activeRunner;
			activePlan = null;
			activeRunner = null;
			void failedRunner.stop().finally(() => {
				if (!stopped && !options.signal?.aborted) {
					options.logger.warn(
						`${failedPlan.name} backfill failed and will be retried on a later startup`,
					);
					startNextJob();
				}
			});
			return;
		}
		if (!activePlan.isPending(store.db)) {
			const finishedPlan = activePlan;
			const finishedRunner = activeRunner;
			activePlan = null;
			activeRunner = null;
			void finishedRunner.stop().finally(() => {
				if (!stopped && !options.signal?.aborted) {
					options.logger.step(`${finishedPlan.name} backfill complete`);
					startNextJob();
				}
			});
			return;
		}
		schedulePoll(waitForCurrentJob);
	};

	return {
		start: () => {
			if (stopped || options.signal?.aborted) return;
			const pendingCount = jobPlans.filter((plan) => plan.isPending(store.db)).length;
			if (pendingCount === 0) return;
			options.logger.step(`${pendingCount} backfill job(s) pending — starting sequential runners`);
			startNextJob();
		},
		stop: async () => {
			stopped = true;
			clearPollTimer();
			const runner = activeRunner;
			activeRunner = null;
			activePlan = null;
			if (runner) await runner.stop();
		},
	};
}

export function startMaintenanceWorkerRuntime(
	options: MaintenanceWorkerRuntimeOptions = {},
): ManagedMaintenanceRunner {
	const logger = options.logger ?? defaultLogger;
	const dbPath = resolveDbPath(options.dbPath ?? undefined);
	const store = new MemoryStoreCtor(dbPath);
	const syncConfig = readWorkerSyncConfig(options.configPath);
	const runners: ManagedMaintenanceRunner[] = [];
	const walCheckpointTimer = setInterval(
		() => {
			try {
				store.db.pragma("wal_checkpoint(TRUNCATE)");
			} catch (error) {
				logger.warn(
					`WAL checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		5 * 60 * 1000,
	);
	walCheckpointTimer.unref();

	if (!isEmbeddingDisabled()) {
		runners.push(
			new VectorModelMigrationRunner({
				dbPath,
				signal: options.signal,
				idleIntervalMs: 5000,
			}),
		);
	}

	runners.push(
		createSequentialBackfillCoordinator(
			store,
			[
				{
					name: "Sharing-domain",
					kind: SCOPE_BACKFILL_JOB,
					isPending: hasPendingScopeBackfill,
					createRunner: () => new ScopeBackfillRunner({ dbPath, signal: options.signal }),
				},
				{
					name: "Dedup-key",
					kind: DEDUP_KEY_BACKFILL_JOB,
					isPending: hasPendingDedupKeyBackfill,
					createRunner: () => new DedupKeyBackfillRunner({ dbPath, signal: options.signal }),
				},
				{
					name: "Session-context",
					kind: SESSION_CONTEXT_BACKFILL_JOB,
					isPending: hasPendingSessionContextBackfill,
					createRunner: () => new SessionContextBackfillRunner({ dbPath, signal: options.signal }),
				},
				{
					name: "Ref",
					kind: REF_BACKFILL_JOB,
					isPending: hasPendingRefBackfill,
					createRunner: () => new RefBackfillRunner({ dbPath, signal: options.signal }),
				},
				{
					name: "Session-summary dedup",
					kind: SUMMARY_DEDUP_BACKFILL_JOB,
					isPending: hasPendingSummaryDedupBackfill,
					createRunner: () =>
						new SummaryDedupBackfillRunner({
							dbPath,
							deviceId: store.deviceId,
							signal: options.signal,
						}),
				},
			],
			{ signal: options.signal, logger },
		),
	);

	if (syncConfig.syncRetentionEnabled) {
		runners.push(new SyncRetentionRunner({ dbPath, signal: options.signal }));
	}

	for (const runner of runners) runner.start();
	logger.step("Maintenance worker started");

	return {
		start: () => {
			for (const runner of runners) runner.start();
		},
		stop: async () => {
			clearInterval(walCheckpointTimer);
			for (const runner of [...runners].reverse()) {
				await runner.stop();
			}
			store.close();
		},
	};
}
