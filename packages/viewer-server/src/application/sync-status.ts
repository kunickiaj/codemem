import {
	coordinatorStatusSnapshot,
	getCoordinatorEnrollmentReconciliationIssueSummary,
	getSemanticIndexDiagnostics,
	getSyncResetState,
	type InboundScopeRejectionPeerSummary,
	listCoordinatorJoinRequests,
	listMaintenanceJobs,
	type MemoryStore,
	readCoordinatorSyncConfig,
	schema,
} from "@codemem/core";
import { count, desc, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { safeJsonList } from "../helpers.js";

export type SyncRuntimeStatus = {
	phase:
		| "starting"
		| "running"
		| "stopping"
		| "error"
		| "disabled"
		| "rebootstrapping"
		| "needs_attention"
		| null;
	detail?: string | null;
};

const SAFE_RUNTIME_DETAILS: Partial<Record<NonNullable<SyncRuntimeStatus["phase"]>, string>> = {
	starting: "Running initial sync in background",
	stopping: "Stopping sync daemon",
	error: "Background sync failed. Open diagnostics for details.",
	rebootstrapping: "Restoring sync baseline",
	needs_attention: "Sync needs attention",
	disabled: "Sync is off",
};

type PeerOperations = Map<string, { in: number; out: number }>;
type ScopeRejections = Map<string, InboundScopeRejectionPeerSummary>;
type SyncConfig = ReturnType<typeof readCoordinatorSyncConfig>;
type RetentionState = {
	last_run_at?: string | null;
	last_duration_ms?: number | null;
	last_deleted_ops?: number | null;
	last_estimated_bytes_before?: number | null;
	last_estimated_bytes_after?: number | null;
	retained_floor_cursor?: string | null;
	last_error?: string | null;
	last_error_at?: string | null;
};

export interface SyncStatusOperations {
	cleanupDiagnostics: (
		store: MemoryStore,
		localDeviceId: string | null,
		showDiagnostics: boolean,
	) => Record<string, unknown>;
	isRecentIso: (value: unknown) => boolean;
	legacySharedReviewSummary: (store: MemoryStore) => Record<string, unknown>;
	listRecipientPolicyReconciliationStatus: (store: MemoryStore) => unknown;
	mapPeerRow: (
		store: MemoryStore,
		row: Record<string, unknown>,
		showDiagnostics: boolean,
		recentOperations: PeerOperations,
		scopeRejections: ScopeRejections,
		localDeviceId: string | null,
	) => Record<string, unknown>;
	mapSyncAttemptRow: (
		row: Record<string, unknown>,
		showDiagnostics: boolean,
		addresses?: string[],
	) => Record<string, unknown>;
	peerStatus: (peer: Record<string, unknown>) => Record<string, unknown>;
	readViewerBinding: (dbPath: string) => { host: string; port: number } | null;
	recentPeerOps: (store: MemoryStore) => PeerOperations;
	recentScopeRejectionsByPeer: (store: MemoryStore) => ScopeRejections;
	redactCoordinatorStatus: (
		status: Awaited<ReturnType<typeof coordinatorStatusSnapshot>>,
		showDiagnostics: boolean,
	) => Record<string, unknown>;
	redactSemanticIndexDiagnostics: (
		diagnostics: ReturnType<typeof getSemanticIndexDiagnostics>,
		showDiagnostics: boolean,
	) => unknown;
	summarizeMaintenanceJobs: (
		jobs: ReturnType<typeof listMaintenanceJobs>,
		showDiagnostics: boolean,
	) => unknown;
}

export interface SyncStatusInput {
	store: MemoryStore;
	showDiagnostics: boolean;
	includeJoinRequests: boolean;
	project: string | null;
	getSyncRuntimeStatus?: () => SyncRuntimeStatus | null;
	operations: SyncStatusOperations;
}

interface StatusRows {
	device: { device_id: string | null; fingerprint: string | null } | undefined;
	daemon:
		| { last_error: string | null; last_error_at: string | null; last_ok_at: string | null }
		| undefined;
	peerCount: number;
	retention: RetentionState | undefined;
	lastSyncAt: string | null;
}

interface BaseStatus {
	config: SyncConfig;
	localDeviceId: string | null;
	statusPayload: Record<string, unknown>;
	daemonState: string;
	daemonRunning: boolean;
	daemonDetail: string | null;
}

interface PeerStatusReadModel {
	items: Record<string, unknown>[];
	byId: Record<string, unknown>;
}

interface AttemptStatusReadModel {
	items: Record<string, unknown>[];
	latestError: string;
}

function traceSync<T>(label: string, operation: () => T): T {
	if (process.env.CODEMEM_TRACE_SYNC_STATUS !== "1") return operation();
	const startedAt = Date.now();
	console.warn(`[codemem sync-status] ${label} start`);
	try {
		return operation();
	} finally {
		console.warn(`[codemem sync-status] ${label} ${Date.now() - startedAt}ms`);
	}
}

function readRetentionState(store: MemoryStore): RetentionState | undefined {
	try {
		return traceSync("retentionState", () =>
			drizzle(store.db, { schema })
				.select()
				.from(schema.syncRetentionState)
				.where(eq(schema.syncRetentionState.id, 1))
				.get(),
		);
	} catch {
		return undefined;
	}
}

function readStatusRows(store: MemoryStore): StatusRows {
	const d = drizzle(store.db, { schema });
	const device = traceSync("deviceRow", () =>
		d
			.select({
				device_id: schema.syncDevice.device_id,
				fingerprint: schema.syncDevice.fingerprint,
			})
			.from(schema.syncDevice)
			.limit(1)
			.get(),
	);
	const daemon = traceSync("daemonState", () =>
		d.select().from(schema.syncDaemonState).where(eq(schema.syncDaemonState.id, 1)).get(),
	);
	const peerCount = traceSync("peerCountRow", () =>
		d.select({ total: count() }).from(schema.syncPeers).get(),
	);
	const retention = readRetentionState(store);
	const lastSync = traceSync("lastSyncRow", () =>
		d
			.select({ last_sync_at: max(schema.syncPeers.last_sync_at) })
			.from(schema.syncPeers)
			.get(),
	);
	return {
		device,
		daemon,
		peerCount: Number(peerCount?.total ?? 0),
		retention,
		lastSyncAt: lastSync?.last_sync_at ?? null,
	};
}

function enrollmentIssueStatus(store: MemoryStore, showDiagnostics: boolean): unknown {
	const summary = traceSync("coordinatorEnrollmentIssues", () =>
		getCoordinatorEnrollmentReconciliationIssueSummary(store.db),
	);
	if (!showDiagnostics) return { counts: summary.counts };
	return {
		counts: summary.counts,
		issues: summary.issues.map((issue) => ({
			coordinator_id: issue.coordinatorId,
			group_id: issue.groupId,
			kind: issue.kind,
			reference_id: issue.referenceId,
			code: issue.code,
			status: issue.status,
			first_seen_at: issue.firstSeenAt,
			last_seen_at: issue.lastSeenAt,
			resolved_at: issue.resolvedAt,
			occurrence_count: issue.occurrenceCount,
			updated_at: issue.updatedAt,
		})),
	};
}

function initialDaemonState(config: SyncConfig, rows: StatusRows, daemonRunning: boolean): string {
	if (!config.syncEnabled) return "disabled";
	const lastError = rows.daemon?.last_error;
	const lastErrorAt = rows.daemon?.last_error_at;
	const lastOkAt = rows.daemon?.last_ok_at;
	if (lastError && (!lastOkAt || String(lastOkAt) < String(lastErrorAt ?? ""))) return "error";
	if (!daemonRunning) return "stopped";
	return "ok";
}

export function safeDaemonIssueCode(
	state: string,
	lastError: string | null | undefined,
): "coordinator_timeout" | "coordinator_error" | null {
	if (state !== "error" || !lastError?.includes("coordinator enrollment maintenance failed"))
		return null;
	return lastError.includes(":request_timeout") ? "coordinator_timeout" : "coordinator_error";
}

function retentionPayload(config: SyncConfig, rows: StatusRows, retainedFloor: string | null) {
	const state = rows.retention;
	return {
		enabled: config.syncRetentionEnabled,
		max_age_days: config.syncRetentionMaxAgeDays,
		max_size_mb: config.syncRetentionMaxSizeMb,
		retained_floor_cursor: retainedFloor ?? state?.retained_floor_cursor ?? null,
		last_run_at: state?.last_run_at ?? null,
		last_duration_ms: typeof state?.last_duration_ms === "number" ? state.last_duration_ms : null,
		last_deleted_ops: typeof state?.last_deleted_ops === "number" ? state.last_deleted_ops : null,
		last_estimated_bytes_before:
			typeof state?.last_estimated_bytes_before === "number"
				? state.last_estimated_bytes_before
				: null,
		last_estimated_bytes_after:
			typeof state?.last_estimated_bytes_after === "number"
				? state.last_estimated_bytes_after
				: null,
		last_error: state?.last_error ?? null,
		last_error_at: state?.last_error_at ?? null,
	};
}

function addDiagnosticStatusFields(
	payload: Record<string, unknown>,
	config: SyncConfig,
	rows: StatusRows,
): void {
	payload.device_id = rows.device?.device_id ?? null;
	payload.fingerprint = rows.device?.fingerprint ?? null;
	payload.bind = `${config.syncHost}:${config.syncPort}`;
	payload.daemon_last_error = rows.daemon?.last_error ?? null;
	payload.daemon_last_error_at = rows.daemon?.last_error_at ?? null;
	payload.daemon_last_ok_at = rows.daemon?.last_ok_at ?? null;
}

function buildBasePayload(
	input: SyncStatusInput,
	config: SyncConfig,
	rows: StatusRows,
	daemon: { state: string; running: boolean; detail: string | null },
	retainedFloor: string | null,
	semanticIndex: unknown,
	enrollmentIssues: unknown,
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		enabled: config.syncEnabled,
		interval_s: config.syncIntervalS,
		retention: retentionPayload(config, rows, retainedFloor),
		semantic_index: semanticIndex,
		coordinator_enrollment_reconciliation_issues: enrollmentIssues,
		peer_count: rows.peerCount,
		last_sync_at: rows.lastSyncAt,
		daemon_state: daemon.state,
		daemon_running: daemon.running,
		daemon_detail: daemon.detail,
		project_filter_active:
			config.syncProjectsInclude.length > 0 || config.syncProjectsExclude.length > 0,
		project_filter: {
			include: config.syncProjectsInclude,
			exclude: config.syncProjectsExclude,
		},
		cleanup_diagnostics: input.operations.cleanupDiagnostics(
			input.store,
			rows.device?.device_id ?? null,
			input.showDiagnostics,
		),
		redacted: !input.showDiagnostics,
	};
	if (input.showDiagnostics) addDiagnosticStatusFields(payload, config, rows);
	return payload;
}

function readBaseStatus(input: SyncStatusInput): BaseStatus {
	const config = traceSync("readCoordinatorSyncConfig", () => readCoordinatorSyncConfig());
	const reset = traceSync("getSyncResetState", () => getSyncResetState(input.store.db));
	const rows = readStatusRows(input.store);
	const semanticIndex = traceSync("semanticIndex", () =>
		input.operations.redactSemanticIndexDiagnostics(
			getSemanticIndexDiagnostics(input.store.db),
			input.showDiagnostics,
		),
	);
	const enrollmentIssues = enrollmentIssueStatus(input.store, input.showDiagnostics);
	const binding = traceSync("readViewerBinding", () =>
		input.operations.readViewerBinding(input.store.dbPath),
	);
	const running = Boolean(binding);
	const detail = binding ? `viewer pidfile at ${binding.host}:${binding.port}` : null;
	let state = initialDaemonState(config, rows, running);
	const statusPayload = buildBasePayload(
		input,
		config,
		rows,
		{ state, running, detail },
		reset.retained_floor_cursor ?? null,
		semanticIndex,
		enrollmentIssues,
	);
	const runtime = input.getSyncRuntimeStatus?.() ?? null;
	if (runtime?.phase && runtime.phase !== "running") {
		state = runtime.phase;
		statusPayload.daemon_state = state;
		statusPayload.daemon_running = runtime.phase === "starting" || running;
		statusPayload.daemon_detail = input.showDiagnostics
			? (runtime.detail ?? detail)
			: (SAFE_RUNTIME_DETAILS[runtime.phase] ?? null);
	}
	statusPayload.daemon_issue_code = safeDaemonIssueCode(
		state,
		runtime?.phase === "error" ? null : rows.daemon?.last_error,
	);
	return {
		config,
		localDeviceId: rows.device?.device_id ?? null,
		statusPayload,
		daemonState: state,
		daemonRunning: running,
		daemonDetail: detail,
	};
}

function readPeerStatus(input: SyncStatusInput, localDeviceId: string | null): PeerStatusReadModel {
	const rows = traceSync(
		"peerRows",
		() => input.store.db.prepare(PEERS_QUERY).all() as Record<string, unknown>[],
	);
	const recentOperations = traceSync("recentPeerOps", () =>
		input.operations.recentPeerOps(input.store),
	);
	const scopeRejections = traceSync("recentScopeRejectionsByPeer", () =>
		input.operations.recentScopeRejectionsByPeer(input.store),
	);
	const items = rows.map((row) => {
		const peer = input.operations.mapPeerRow(
			input.store,
			row,
			input.showDiagnostics,
			recentOperations,
			scopeRejections,
			localDeviceId,
		);
		peer.status = input.operations.peerStatus(peer);
		return peer;
	});
	const byId: Record<string, unknown> = {};
	for (const peer of items) byId[String(peer.peer_device_id)] = peer.status;
	return { items, byId };
}

function readAttemptRows(store: MemoryStore): Record<string, unknown>[] {
	return traceSync("attemptRows", () =>
		drizzle(store.db, { schema })
			.select({
				peer_device_id: schema.syncAttempts.peer_device_id,
				ok: schema.syncAttempts.ok,
				error: schema.syncAttempts.error,
				started_at: schema.syncAttempts.started_at,
				finished_at: schema.syncAttempts.finished_at,
				ops_in: schema.syncAttempts.ops_in,
				ops_out: schema.syncAttempts.ops_out,
				local_sync_capability: schema.syncAttempts.local_sync_capability,
				peer_sync_capability: schema.syncAttempts.peer_sync_capability,
				negotiated_sync_capability: schema.syncAttempts.negotiated_sync_capability,
			})
			.from(schema.syncAttempts)
			.orderBy(desc(schema.syncAttempts.finished_at))
			.limit(25)
			.all(),
	);
}

function readPeerAddressMap(store: MemoryStore): Map<string, string[]> {
	const rows = traceSync(
		"peerAddressRows",
		() =>
			store.db.prepare("SELECT peer_device_id, addresses_json FROM sync_peers").all() as Array<{
				peer_device_id: string | null;
				addresses_json: string | null;
			}>,
	);
	const addressesByPeer = new Map<string, string[]>();
	for (const row of rows) {
		const addresses = safeJsonList(row.addresses_json);
		if (addresses.length) addressesByPeer.set(String(row.peer_device_id ?? ""), addresses);
	}
	return addressesByPeer;
}

function readAttemptStatus(input: SyncStatusInput): AttemptStatusReadModel {
	const rows = readAttemptRows(input.store);
	const addressesByPeer = readPeerAddressMap(input.store);
	const items = rows.map((row) =>
		input.operations.mapSyncAttemptRow(
			row,
			input.showDiagnostics,
			input.showDiagnostics ? addressesByPeer.get(String(row.peer_device_id ?? "")) : undefined,
		),
	);
	return { items, latestError: String(rows[0]?.error || "").trim() };
}

export function latestFailedPeerIds(
	store: MemoryStore,
	activePeerIds: Set<string>,
	isRecentIso: (value: unknown) => boolean,
): Set<string> {
	const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
	const now = new Date().toISOString();
	return traceSync("recentPeerFailures", () => {
		const rows = store.db
			.prepare(
				`SELECT peer_device_id, ok, error, finished_at
				 FROM sync_attempts
				 WHERE (CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END) BETWEEN ? AND ?
				 ORDER BY (CASE WHEN finished_at IS NULL THEN started_at ELSE finished_at END) DESC, id DESC`,
			)
			.iterate(cutoff, now) as Iterable<{
			peer_device_id: string;
			ok: number;
			error: string | null;
			finished_at: string | null;
		}>;
		const seen = new Set<string>();
		const failed = new Set<string>();
		for (const row of rows) {
			if (!activePeerIds.has(row.peer_device_id) || seen.has(row.peer_device_id)) continue;
			if (!isRecentIso(row.finished_at)) continue;
			seen.add(row.peer_device_id);
			if (!row.ok && row.error) failed.add(row.peer_device_id);
		}
		return failed;
	});
}

function peerStates(peers: PeerStatusReadModel): Set<string> {
	return new Set(
		peers.items.map((peer) =>
			String((peer.status as Record<string, unknown> | undefined)?.peer_state ?? ""),
		),
	);
}

function allPeersOffline(peers: PeerStatusReadModel): boolean {
	return (
		peers.items.length > 0 &&
		peers.items.every(
			(peer) => String((peer.status as Record<string, unknown>)?.peer_state ?? "") === "offline",
		)
	);
}

export function degradedDaemonState(
	peers: PeerStatusReadModel,
	failedPeerIds: Set<string>,
): string {
	const states = peerStates(peers);
	const allOffline = allPeersOffline(peers);
	if (failedPeerIds.size > 0) {
		if (states.has("online") || states.has("degraded")) return "degraded";
		if (allOffline) return "offline-peers";
		if (peers.items.length > 0) return "stale";
	}
	if (states.has("degraded")) return "degraded";
	if (allOffline) return "offline-peers";
	if (peers.items.length > 0 && !states.has("online")) return "stale";
	return "ok";
}

function applyDerivedDaemonState(
	base: BaseStatus,
	peers: PeerStatusReadModel,
	attempts: AttemptStatusReadModel,
	failedPeerIds: Set<string>,
	statusBlock: Record<string, unknown>,
): void {
	let state = base.daemonState;
	if (state === "ok" && attempts.latestError.startsWith("needs_attention:")) {
		state = "needs_attention";
		const detail = attempts.latestError.replace(/^needs_attention:/, "");
		base.statusPayload.daemon_detail = detail;
		statusBlock.daemon_detail = detail;
	} else if (state === "ok") {
		state = degradedDaemonState(peers, failedPeerIds);
	}
	base.statusPayload.daemon_state = state;
	statusBlock.daemon_state = state;
}

async function readJoinRequests(
	input: SyncStatusInput,
	config: SyncConfig,
): Promise<Record<string, unknown>[]> {
	if (!input.includeJoinRequests || !input.showDiagnostics || !config.syncCoordinatorAdminSecret) {
		return [];
	}
	try {
		return await listCoordinatorJoinRequests(config);
	} catch {
		return [];
	}
}

export async function buildSyncStatusResponse(
	input: SyncStatusInput,
): Promise<Record<string, unknown>> {
	const base = readBaseStatus(input);
	const coordinatorSnapshot = await coordinatorStatusSnapshot(input.store, base.config);
	const coordinator = traceSync("coordinator", () =>
		input.operations.redactCoordinatorStatus(coordinatorSnapshot, input.showDiagnostics),
	);
	const peers = readPeerStatus(input, base.localDeviceId);
	const attempts = readAttemptStatus(input);
	const activePeerIds = new Set(peers.items.map((peer) => String(peer.peer_device_id ?? "")));
	const failedPeerIds = latestFailedPeerIds(
		input.store,
		activePeerIds,
		input.operations.isRecentIso,
	);
	for (const peer of peers.items) {
		const status = peer.status as Record<string, unknown>;
		status.recent_failed_attempt = failedPeerIds.has(String(peer.peer_device_id ?? ""));
	}
	const statusBlock: Record<string, unknown> = {
		...base.statusPayload,
		background_maintenance: input.operations.summarizeMaintenanceJobs(
			listMaintenanceJobs(input.store.db),
			input.showDiagnostics,
		),
		peers: peers.byId,
		pending: 0,
		sync: {},
		ping: {},
	};
	const legacyDevices = traceSync("legacyDevices", () => input.store.claimableLegacyDeviceIds());
	const legacyReview = traceSync("legacySharedReview", () =>
		input.operations.legacySharedReviewSummary(input.store),
	);
	const sharingReview = traceSync("sharingReview", () =>
		input.store.sharingReviewSummary(input.project),
	);
	const recipientPolicyReconciliation = traceSync("recipientPolicyReconciliation", () =>
		input.operations.listRecipientPolicyReconciliationStatus(input.store),
	);
	const joinRequests = await readJoinRequests(input, base.config);
	applyDerivedDaemonState(base, peers, attempts, failedPeerIds, statusBlock);
	const response: Record<string, unknown> = {
		...base.statusPayload,
		status: statusBlock,
		peers: peers.items,
		attempts: attempts.items.slice(0, 5),
		legacy_devices: legacyDevices,
		legacy_shared_review: legacyReview,
		sharing_review: sharingReview,
		recipient_policy_reconciliation: recipientPolicyReconciliation,
		coordinator,
	};
	if (input.includeJoinRequests && input.showDiagnostics) response.join_requests = joinRequests;
	return response;
}

const PEERS_QUERY = `
	SELECT p.peer_device_id, p.name, p.pinned_fingerprint, p.addresses_json,
	       p.last_seen_at, p.last_sync_at, p.last_error,
	       p.runtime_version, p.runtime_version_observed_at,
	       p.projects_include_json, p.projects_exclude_json, p.claimed_local_actor,
	       p.actor_id, p.discovered_via_coordinator_id, p.discovered_via_group_id,
	       a.display_name AS actor_display_name
	FROM sync_peers AS p
	LEFT JOIN actors AS a ON a.actor_id = p.actor_id
	ORDER BY name, peer_device_id
`;
