import {
	canonicalRepositoryProjectIdentity,
	type MemoryStore,
	type RecipientPolicyReconcileResult,
	type RecipientPolicyReconcilerEffects,
	reconcileRecipientPolicyProject,
	repositoryIdentitiesByWorkspace,
} from "@codemem/core";

export interface AdvanceProjectShareOperationResult {
	advanced: boolean;
	state: "active" | "waiting_for_acceptance" | "cancelled";
}

export interface AdvancePendingProjectSharesResult {
	processed: number;
	advanced: number;
	waiting: number;
	attention: number;
	failed: number;
	items: Array<{
		operationId: string;
		outcome:
			| "advanced"
			| "waiting_for_acceptance"
			| "waiting_for_device"
			| "retry_scheduled"
			| "needs_attention"
			| "superseded"
			| "failed";
		error?: string;
	}>;
}

export type AdvanceProjectShareOperation = (
	store: MemoryStore,
	operationId: string,
) => Promise<AdvanceProjectShareOperationResult>;

const AUTOMATIC_SHARE_OPERATION_STATES = [
	"waiting_for_acceptance",
	"accepted",
	"provisioning",
	"initial_sync",
	"waiting_for_device",
] as const;

const AUTOMATIC_WAITING_ACCEPTANCE_RETRY_COOLDOWN_MS = 30 * 1000;
const AUTOMATIC_WAITING_DEVICE_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const TERMINAL_SHARE_MAINTENANCE_ERRORS = new Set([
	"coordinator_not_configured",
	"conflicting_repository_mappings",
	"project_mapping_conflict",
	"team_sharing_not_configured",
	"team_selection_ambiguous",
	"initiating_device_not_reviewed",
	"inviter_project_access_ambiguous",
	"managed_boundary_plan_missing",
	"operation_device_binding_missing",
	"operation_intent_invalid",
	"provisioning_membership_plan_invalid",
	"device_binding_conflict",
	"intent_conflict",
	"inviter_identity_conflict",
]);

export const PROJECT_INVITE_OWNER_CONFLICT_ERRORS = new Set([
	"operation_scope_mismatch",
	"operation_state_invalid",
	"operation_acceptance_invalid",
	"operation_trust_state_invalid",
	"operation_intent_invalid",
	"operation_intent_mismatch",
	"recipient_fingerprint_mismatch",
	"recipient_device_identity_conflict",
	"recipient_actor_conflict",
	"pending_person_identity_conflict",
	"device_binding_conflict",
	"intent_conflict",
	"inviter_identity_conflict",
]);

const TERMINAL_RECONCILIATION_ERRORS = new Set([
	"coordinator_not_configured",
	"team_sharing_not_configured",
	"team_selection_ambiguous",
	"operation_not_found",
	...PROJECT_INVITE_OWNER_CONFLICT_ERRORS,
]);

function errorStatus(error: unknown): number | null {
	const value = error && typeof error === "object" ? (error as { status?: unknown }).status : null;
	return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
		? value
		: null;
}

function recordInviteReconciliationFailure(
	store: MemoryStore,
	operationId: string,
	error: unknown,
	now: string,
): "retry_scheduled" | "needs_attention" {
	const message = error instanceof Error ? error.message : String(error);
	const safeErrorCode = TERMINAL_RECONCILIATION_ERRORS.has(message)
		? message
		: "operation_read_failed";
	const status = errorStatus(error);
	const retryable =
		!TERMINAL_RECONCILIATION_ERRORS.has(message) &&
		(status == null || status === 408 || status === 429 || status >= 500);
	store.db
		.prepare(`UPDATE share_operation_steps SET
			status = CASE WHEN ? = 1 THEN 'pending' ELSE 'failed' END,
			attempt_count = attempt_count + 1, last_attempt_at = ?, safe_error_code = ?, updated_at = ?
			WHERE operation_id = ? AND step_key = 'invite_consumption'`)
		.run(retryable ? 1 : 0, now, safeErrorCode, now, operationId);
	const outcome = retryable ? "retry_scheduled" : "needs_attention";
	store.db
		.prepare("UPDATE share_operations SET state = ?, updated_at = ? WHERE operation_id = ?")
		.run(
			outcome === "needs_attention" ? "needs_attention" : "waiting_for_acceptance",
			now,
			operationId,
		);
	return outcome;
}

function pendingShareOperationRows(
	store: MemoryStore,
	input: { limit: number; maintenanceNow: Date },
): Array<{ operation_id: string }> {
	const placeholders = AUTOMATIC_SHARE_OPERATION_STATES.map(() => "?").join(", ");
	const waitingAcceptanceRetryBefore = new Date(
		input.maintenanceNow.getTime() - AUTOMATIC_WAITING_ACCEPTANCE_RETRY_COOLDOWN_MS,
	).toISOString();
	const waitingRetryBefore = new Date(
		input.maintenanceNow.getTime() - AUTOMATIC_WAITING_DEVICE_RETRY_COOLDOWN_MS,
	).toISOString();
	return store.db
		.prepare(`SELECT operation.operation_id FROM share_operations AS operation
		 WHERE operation.inviter_actor_id = ?
		 AND operation.state IN (${placeholders})
		 AND (operation.state <> 'waiting_for_acceptance' OR operation.updated_at <= ?)
		 AND (
			operation.state <> 'waiting_for_device'
			OR operation.updated_at <= ?
			OR (
				NOT EXISTS (
					SELECT 1 FROM share_operation_steps AS step
					WHERE step.operation_id = operation.operation_id
					AND step.step_key = 'capability_preflight'
					AND step.status <> 'completed'
					AND (
						step.status = 'running'
						OR step.safe_error_code IN (
							'waiting_for_device', 'device_offline', 'recipient_offline'
						)
					)
				)
				AND EXISTS (
					SELECT 1 FROM sync_attempts AS attempt
					WHERE attempt.id = (
						SELECT latest.id FROM sync_attempts AS latest
						WHERE latest.peer_device_id = operation.recipient_device_id
						ORDER BY latest.started_at DESC, latest.id DESC
						LIMIT 1
					)
					AND attempt.ok = 1
					AND julianday(COALESCE(attempt.finished_at, attempt.started_at)) >
						julianday(operation.updated_at)
				)
			)
		 )
		 ORDER BY CASE WHEN operation.state IN ('accepted', 'provisioning', 'initial_sync') THEN 0 ELSE 1 END,
			CASE WHEN operation.state IN ('waiting_for_acceptance', 'waiting_for_device')
				THEN operation.updated_at ELSE operation.created_at END ASC,
			operation.created_at ASC, operation.operation_id ASC
		 LIMIT ?`)
		.all(
			store.actorId,
			...AUTOMATIC_SHARE_OPERATION_STATES,
			waitingAcceptanceRetryBefore,
			waitingRetryBefore,
			input.limit,
		) as Array<{ operation_id: string }>;
}

function recordPendingShareFailure(
	store: MemoryStore,
	result: AdvancePendingProjectSharesResult,
	operationId: string,
	error: unknown,
	now: string,
): void {
	const message = error instanceof Error ? error.message : String(error);
	const state = store.db
		.prepare("SELECT state FROM share_operations WHERE operation_id = ?")
		.pluck()
		.get(operationId);
	if (state === "cancelled") {
		result.items.push({ operationId, outcome: "superseded" });
		return;
	}
	if (message === "waiting_for_device" || state === "waiting_for_device") {
		result.waiting += 1;
		result.items.push({ operationId, outcome: "waiting_for_device" });
		return;
	}
	if (state === "needs_attention") {
		result.attention += 1;
		result.items.push({ operationId, outcome: "needs_attention", error: message });
		return;
	}
	if (state === "waiting_for_acceptance") {
		const outcome = recordInviteReconciliationFailure(store, operationId, error, now);
		if (outcome === "needs_attention") result.attention += 1;
		else result.waiting += 1;
		result.items.push({ operationId, outcome, error: message });
		return;
	}
	if (TERMINAL_SHARE_MAINTENANCE_ERRORS.has(message)) {
		store.db
			.prepare(
				"UPDATE share_operations SET state = 'needs_attention', updated_at = ? WHERE operation_id = ?",
			)
			.run(now, operationId);
		result.attention += 1;
		result.items.push({ operationId, outcome: "needs_attention", error: message });
		return;
	}
	result.failed += 1;
	result.items.push({ operationId, outcome: "failed", error: message });
}

async function processPendingShareOperation(
	store: MemoryStore,
	result: AdvancePendingProjectSharesResult,
	operationId: string,
	advanceOperation: AdvanceProjectShareOperation,
	now: string,
): Promise<void> {
	result.processed += 1;
	try {
		const advanced = await advanceOperation(store, operationId);
		if (advanced.advanced) {
			result.advanced += 1;
			result.items.push({ operationId, outcome: "advanced" });
			return;
		}
		if (advanced.state === "cancelled") {
			result.items.push({ operationId, outcome: "superseded" });
			return;
		}
		store.db
			.prepare("UPDATE share_operations SET updated_at = ? WHERE operation_id = ?")
			.run(now, operationId);
		result.waiting += 1;
		result.items.push({ operationId, outcome: "waiting_for_acceptance" });
	} catch (error) {
		recordPendingShareFailure(store, result, operationId, error, now);
	}
}

export async function advancePendingProjectSharesOperation(
	store: MemoryStore,
	options: { limit?: number; now?: Date; advanceOperation: AdvanceProjectShareOperation },
): Promise<AdvancePendingProjectSharesResult> {
	const limit = Math.max(1, Math.min(Math.trunc(options.limit ?? 3), 10));
	const maintenanceNow = options.now ?? new Date();
	const rows = pendingShareOperationRows(store, { limit, maintenanceNow });
	const result: AdvancePendingProjectSharesResult = {
		processed: 0,
		advanced: 0,
		waiting: 0,
		attention: 0,
		failed: 0,
		items: [],
	};
	const now = maintenanceNow.toISOString();
	for (const row of rows) {
		await processPendingShareOperation(
			store,
			result,
			row.operation_id,
			options.advanceOperation,
			now,
		);
	}
	return result;
}

export interface ReconcileRecipientPolicyProjectsResult {
	processed: number;
	active: number;
	waiting: number;
	attention: number;
	failed: number;
	items: Array<{
		canonicalProjectIdentity: string;
		status: RecipientPolicyReconcileResult["status"] | "failed";
		safeErrorCode: string | null;
	}>;
}

const RECIPIENT_POLICY_MAINTENANCE_MAX_LIMIT = 10;
const RECIPIENT_POLICY_MAINTENANCE_DEFAULT_LIMIT = 3;
const RECIPIENT_POLICY_MAINTENANCE_BACKOFF_MS = 60_000;

interface MaintenanceAuthorityRow {
	canonical_project_identity: string;
	last_attempt_at: string | null;
	safe_error_code: string | null;
}

function recipientPolicyMaintenanceCandidates(
	store: MemoryStore,
	retryBefore: string,
	limit: number,
): string[] {
	const repositoryIdentities = repositoryIdentitiesByWorkspace(store.db);
	const canonicalize = (projectId: string) =>
		canonicalRepositoryProjectIdentity(repositoryIdentities, projectId);
	const projectIds = store.db
		.prepare(
			`SELECT canonical_project_identity FROM project_recipients
			 UNION SELECT canonical_project_identity FROM recipient_policy_authority_states`,
		)
		.all() as Array<{ canonical_project_identity: string }>;
	const authorityRows = store.db
		.prepare(
			`SELECT canonical_project_identity, last_attempt_at, safe_error_code
			 FROM recipient_policy_authority_states`,
		)
		.all() as MaintenanceAuthorityRow[];
	const authorityByProject = new Map<string, MaintenanceAuthorityRow>();
	for (const row of authorityRows) {
		const projectId = canonicalize(row.canonical_project_identity);
		const current = authorityByProject.get(projectId);
		if (!current) {
			authorityByProject.set(projectId, row);
			continue;
		}
		if (current.canonical_project_identity === projectId) continue;
		if (row.canonical_project_identity === projectId) {
			authorityByProject.set(projectId, row);
			continue;
		}
		if (String(row.last_attempt_at ?? "") > String(current.last_attempt_at ?? "")) {
			authorityByProject.set(projectId, row);
		}
	}
	return [...new Set(projectIds.map((row) => canonicalize(row.canonical_project_identity)))]
		.filter((projectId) => {
			const authority = authorityByProject.get(projectId);
			return (
				authority?.safe_error_code == null ||
				authority.last_attempt_at == null ||
				authority.last_attempt_at <= retryBefore
			);
		})
		.toSorted((left, right) => {
			const leftAttempt = authorityByProject.get(left)?.last_attempt_at;
			const rightAttempt = authorityByProject.get(right)?.last_attempt_at;
			if (leftAttempt == null && rightAttempt != null) return -1;
			if (leftAttempt != null && rightAttempt == null) return 1;
			return (
				String(leftAttempt ?? "").localeCompare(String(rightAttempt ?? "")) ||
				left.localeCompare(right)
			);
		})
		.slice(0, limit);
}

function recordRecipientPolicyMaintenanceFailure(
	store: MemoryStore,
	projectId: string,
	attemptedAt: string,
): void {
	store.db
		.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, state_changed_at, created_at, updated_at,
			 attempt_count, last_attempt_at, safe_error_code, last_error_at
			 ) VALUES (?, ?, ?, ?, 1, ?, 'recipient_policy_reconciliation_failed', ?)
			 ON CONFLICT(canonical_project_identity) DO UPDATE SET
			 attempt_count = attempt_count + 1, last_attempt_at = excluded.last_attempt_at,
			 safe_error_code = excluded.safe_error_code, last_error_at = excluded.last_error_at,
			 updated_at = excluded.updated_at`,
		)
		.run(projectId, attemptedAt, attemptedAt, attemptedAt, attemptedAt, attemptedAt);
}

function isSqliteBusy(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	const code = error.code;
	return (
		typeof code === "string" && (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
	);
}

function recordMaintenanceFailureIfAvailable(
	store: MemoryStore,
	projectId: string,
	attemptedAt: string,
	error: unknown,
): void {
	if (isSqliteBusy(error)) return;
	try {
		recordRecipientPolicyMaintenanceFailure(store, projectId, attemptedAt);
	} catch (bookkeepingError) {
		if (!isSqliteBusy(bookkeepingError)) throw bookkeepingError;
	}
}

export async function reconcileRecipientPolicyProjectsOperation(
	store: MemoryStore,
	options: {
		limit?: number;
		now?: Date;
		backoffMs?: number;
		leaseOwner?: string;
		effects: RecipientPolicyReconcilerEffects;
		reconcileProject?: typeof reconcileRecipientPolicyProject;
	},
): Promise<ReconcileRecipientPolicyProjectsResult> {
	const limit = Math.max(
		1,
		Math.min(
			Math.trunc(options.limit ?? RECIPIENT_POLICY_MAINTENANCE_DEFAULT_LIMIT),
			RECIPIENT_POLICY_MAINTENANCE_MAX_LIMIT,
		),
	);
	const maintenanceNow = options.now ?? new Date();
	const backoffMs = Math.max(
		0,
		Math.trunc(options.backoffMs ?? RECIPIENT_POLICY_MAINTENANCE_BACKOFF_MS),
	);
	const retryBefore = new Date(maintenanceNow.getTime() - backoffMs).toISOString();
	const attemptedAt = maintenanceNow.toISOString();
	const projectIds = recipientPolicyMaintenanceCandidates(store, retryBefore, limit);
	const reconcileProject = options.reconcileProject ?? reconcileRecipientPolicyProject;
	const result: ReconcileRecipientPolicyProjectsResult = {
		processed: 0,
		active: 0,
		waiting: 0,
		attention: 0,
		failed: 0,
		items: [],
	};
	for (const projectId of projectIds) {
		result.processed += 1;
		try {
			const outcome = await reconcileProject(
				store.db,
				{
					canonicalProjectIdentity: projectId,
					leaseOwner:
						options.leaseOwner ?? `recipient-policy-maintenance:${store.deviceId || process.pid}`,
				},
				options.effects,
			);
			if (outcome.status === "active") result.active += 1;
			else if (outcome.status === "needs_attention") result.attention += 1;
			else result.waiting += 1;
			result.items.push({
				canonicalProjectIdentity: projectId,
				status: outcome.status,
				safeErrorCode: outcome.safeErrorCode,
			});
		} catch (error) {
			recordMaintenanceFailureIfAvailable(store, projectId, attemptedAt, error);
			result.failed += 1;
			result.items.push({
				canonicalProjectIdentity: projectId,
				status: "failed",
				safeErrorCode: "recipient_policy_reconciliation_failed",
			});
		}
	}
	return result;
}
