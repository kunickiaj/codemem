import type { Database } from "./db.js";
import {
	type DeviceIdentityInventoryInput,
	type DeviceIdentityInventoryItemV1,
	listDeviceIdentityInventory,
} from "./device-identity-inventory.js";
import {
	isActiveUnmergedActor,
	isActiveUnmergedLocalActor,
} from "./recipient-policy-actor-eligibility.js";
import {
	canonicalRecipientPolicyJson,
	legacyRecipientPolicyDigest,
} from "./recipient-policy-identifiers.js";

export const DEVICE_IDENTITY_BINDING_VERSION = 1 as const;
const BINDING_LIMIT = 100;

export interface DeviceIdentityBindingSelectionV1 {
	deviceId: string;
	targetIdentityId: string;
	confirmed: boolean;
	allowRebind?: boolean;
}

export interface DeviceIdentityBindingPreviewRequestV1 {
	bindings: DeviceIdentityBindingSelectionV1[];
}

export interface DeviceIdentityBindingCommitRequestV1
	extends DeviceIdentityBindingPreviewRequestV1 {
	reviewedInventoryDigest: string;
}

export type DeviceIdentityBindingActionV1 = "bind" | "rebind" | "unchanged";
export type DeviceIdentityBindingStatusV1 =
	| "ready"
	| "applied"
	| "invalid"
	| "not_found"
	| "stale"
	| "conflict";

export interface DeviceIdentityBindingOutcomeV1 {
	deviceId: string;
	displayName: string;
	targetIdentityId: string;
	previousIdentityId: string | null;
	action: DeviceIdentityBindingActionV1;
	isLocal: boolean;
}

export interface DeviceIdentityBindingPreviewV1 {
	version: typeof DEVICE_IDENTITY_BINDING_VERSION;
	status: Exclude<DeviceIdentityBindingStatusV1, "applied" | "stale">;
	reviewedInventoryDigest: string;
	errorCode: string | null;
	outcomes: DeviceIdentityBindingOutcomeV1[];
	writeCount: number;
}

export interface DeviceIdentityBindingCommitV1 {
	version: typeof DEVICE_IDENTITY_BINDING_VERSION;
	status: Exclude<DeviceIdentityBindingStatusV1, "ready">;
	reviewedInventoryDigest: string;
	errorCode: string | null;
	outcomes: DeviceIdentityBindingOutcomeV1[];
	writeCount: number;
	idempotent: boolean;
}

export interface DeviceIdentityBindingContext {
	localActorId: string;
	localDeviceId: string;
	now?: () => string;
}

interface StoredBindingCommit {
	request_json: string;
	outcomes_json: string;
	write_count: number;
}

interface StoredBinding {
	identity_id: string;
	status: string;
	assignment_version: number;
}

class BindingWriteBoundaryError extends Error {
	constructor(
		readonly status: "stale" | "conflict",
		readonly errorCode: string,
	) {
		super(errorCode);
	}
}

const canonicalJson = canonicalRecipientPolicyJson;
const digest = legacyRecipientPolicyDigest;

function normalizedRequest(request: DeviceIdentityBindingPreviewRequestV1): string {
	return canonicalJson({
		bindings: request.bindings.map((binding) => ({
			deviceId: binding.deviceId,
			targetIdentityId: binding.targetIdentityId,
			confirmed: binding.confirmed,
			allowRebind: binding.allowRebind === true,
		})),
	});
}

function failure(
	status: "invalid" | "not_found" | "conflict",
	errorCode: string,
): DeviceIdentityBindingPreviewV1 {
	return {
		version: DEVICE_IDENTITY_BINDING_VERSION,
		status,
		reviewedInventoryDigest: "",
		errorCode,
		outcomes: [],
		writeCount: 0,
	};
}

function validSelection(value: DeviceIdentityBindingSelectionV1): boolean {
	return (
		typeof value?.deviceId === "string" &&
		value.deviceId.trim() === value.deviceId &&
		value.deviceId.length > 0 &&
		typeof value.targetIdentityId === "string" &&
		value.targetIdentityId.trim() === value.targetIdentityId &&
		value.targetIdentityId.length > 0 &&
		value.confirmed === true &&
		(value.allowRebind === undefined || typeof value.allowRebind === "boolean")
	);
}

function outcome(
	item: DeviceIdentityInventoryItemV1,
	selection: DeviceIdentityBindingSelectionV1,
	deviceId: string,
): DeviceIdentityBindingOutcomeV1 | DeviceIdentityBindingPreviewV1 {
	if (item.state === "pairing_required") return failure("conflict", "device_pairing_required");
	if (item.state === "conflicted") return failure("conflict", "device_evidence_conflict");
	if (item.state === "configured" && item.identityId !== selection.targetIdentityId) {
		if (selection.allowRebind !== true) {
			return failure("conflict", "device_rebind_confirmation_required");
		}
		return {
			deviceId,
			displayName: item.displayName,
			targetIdentityId: selection.targetIdentityId,
			previousIdentityId: item.identityId,
			action: "rebind",
			isLocal: item.isLocal,
		};
	}
	return {
		deviceId,
		displayName: item.displayName,
		targetIdentityId: selection.targetIdentityId,
		previousIdentityId: item.identityId,
		action: item.state === "configured" ? "unchanged" : "bind",
		isLocal: item.isLocal,
	};
}

function reviewedItemEvidence(item: DeviceIdentityInventoryItemV1): Record<string, unknown> {
	return {
		deviceId: item.deviceId,
		evidenceDeviceIds: item.evidenceDeviceIds,
		state: item.state,
		identityId: item.identityId,
		validatedFingerprint: item.validatedFingerprint,
		isLocal: item.isLocal,
		sources: item.sources,
		conflictCodes: item.conflictCodes,
	};
}

export function previewDeviceIdentityBindings(
	db: Database,
	inventoryInput: DeviceIdentityInventoryInput,
	request: DeviceIdentityBindingPreviewRequestV1,
): DeviceIdentityBindingPreviewV1 {
	if (
		!request ||
		!Array.isArray(request.bindings) ||
		request.bindings.length === 0 ||
		request.bindings.length > BINDING_LIMIT ||
		request.bindings.some((binding) => !validSelection(binding))
	) {
		return failure("invalid", "binding_request_invalid");
	}
	const deviceIds = request.bindings.map((binding) => binding.deviceId);
	if (new Set(deviceIds).size !== deviceIds.length) {
		return failure("invalid", "duplicate_device_id");
	}
	const inventory = listDeviceIdentityInventory(db, inventoryInput);
	if (inventory.truncated) return failure("conflict", "device_inventory_truncated");
	const inventoryByDeviceId = new Map(inventory.items.map((item) => [item.deviceId, item]));
	const selectedItems: DeviceIdentityInventoryItemV1[] = [];
	for (const selection of request.bindings) {
		const item = inventoryByDeviceId.get(selection.deviceId);
		if (!item) return failure("not_found", "device_not_found");
		selectedItems.push(item);
	}
	if (inventory.coordinatorEvidence.availability !== "available") {
		const localOnlyWithoutCoordinator =
			inventory.coordinatorEvidence.safeErrorCode === "coordinator_not_configured" &&
			selectedItems.every((item) => item.isLocal);
		if (!localOnlyWithoutCoordinator) {
			return failure("conflict", "device_inventory_incomplete");
		}
	}
	const outcomes: DeviceIdentityBindingOutcomeV1[] = [];
	for (const [index, selection] of request.bindings.entries()) {
		if (!isActiveUnmergedActor(db, selection.targetIdentityId)) {
			return failure("not_found", "target_identity_unavailable");
		}
		const item = selectedItems[index];
		if (!item) return failure("not_found", "device_not_found");
		let authoritativeDeviceId = item.deviceId;
		if (item.state === "configured") {
			const activeBindingDeviceIds = item.evidenceDeviceIds.filter(
				(deviceId) => currentBinding(db, deviceId)?.status === "active",
			);
			if (activeBindingDeviceIds.length !== 1) {
				return failure("conflict", "device_evidence_conflict");
			}
			authoritativeDeviceId = activeBindingDeviceIds[0] ?? item.deviceId;
		}
		const planned = outcome(item, selection, authoritativeDeviceId);
		if ("status" in planned) return planned;
		outcomes.push(planned);
	}
	const reviewedInventoryDigest = digest("device-identity-binding-preview-v1", {
		selectedItems: selectedItems.map(reviewedItemEvidence),
		coordinatorAvailability: inventory.coordinatorEvidence.availability,
		inventoryTruncated: inventory.truncated,
		request: JSON.parse(normalizedRequest(request)),
	});
	return {
		version: DEVICE_IDENTITY_BINDING_VERSION,
		status: "ready",
		reviewedInventoryDigest,
		errorCode: null,
		outcomes,
		writeCount: outcomes.filter((item) => item.action !== "unchanged").length,
	};
}

function currentBinding(db: Database, deviceId: string): StoredBinding | undefined {
	return db
		.prepare(
			`SELECT identity_id, status, assignment_version FROM identity_devices
			 WHERE device_id = ?`,
		)
		.get(deviceId) as StoredBinding | undefined;
}

function exactRetry(
	db: Database,
	inventoryInput: DeviceIdentityInventoryInput,
	commitDigest: string,
	requestJson: string,
	request: DeviceIdentityBindingCommitRequestV1,
): DeviceIdentityBindingCommitV1 | null {
	const stored = db
		.prepare(
			`SELECT request_json, outcomes_json, write_count
			 FROM device_identity_binding_commits WHERE commit_digest = ?`,
		)
		.get(commitDigest) as StoredBindingCommit | undefined;
	if (!stored) return null;
	if (stored.request_json !== requestJson) {
		return {
			...failure("conflict", "binding_commit_conflict"),
			status: "conflict",
			reviewedInventoryDigest: request.reviewedInventoryDigest,
			idempotent: false,
		};
	}
	const outcomes = JSON.parse(stored.outcomes_json) as DeviceIdentityBindingOutcomeV1[];
	const stillApplied = outcomes.every((item) => {
		const binding = currentBinding(db, item.deviceId);
		return (
			binding?.status === "active" &&
			binding.identity_id === item.targetIdentityId &&
			isActiveUnmergedActor(db, item.targetIdentityId)
		);
	});
	if (!stillApplied) {
		return {
			version: DEVICE_IDENTITY_BINDING_VERSION,
			status: "stale",
			reviewedInventoryDigest: request.reviewedInventoryDigest,
			errorCode: "binding_retry_stale",
			outcomes: [],
			writeCount: 0,
			idempotent: false,
		};
	}
	const revalidated = previewDeviceIdentityBindings(db, inventoryInput, request);
	if (
		revalidated.status === "invalid" ||
		revalidated.status === "not_found" ||
		revalidated.status === "conflict"
	) {
		return {
			...revalidated,
			status: revalidated.status,
			reviewedInventoryDigest: request.reviewedInventoryDigest,
			idempotent: false,
		};
	}
	if (revalidated.outcomes.some((item) => item.action !== "unchanged")) {
		return {
			version: DEVICE_IDENTITY_BINDING_VERSION,
			status: "stale",
			reviewedInventoryDigest: request.reviewedInventoryDigest,
			errorCode: "binding_retry_stale",
			outcomes: [],
			writeCount: 0,
			idempotent: false,
		};
	}
	return {
		version: DEVICE_IDENTITY_BINDING_VERSION,
		status: "applied",
		reviewedInventoryDigest: request.reviewedInventoryDigest,
		errorCode: null,
		outcomes,
		writeCount: 0,
		idempotent: true,
	};
}

function writeBinding(
	db: Database,
	context: DeviceIdentityBindingContext,
	commitDigest: string,
	outcome: DeviceIdentityBindingOutcomeV1,
	now: string,
): void {
	const before = currentBinding(db, outcome.deviceId);
	if (outcome.action === "bind" && before) {
		throw new BindingWriteBoundaryError("conflict", "binding_write_conflict");
	}
	if (
		outcome.action === "rebind" &&
		(before?.status !== "active" || before.identity_id !== outcome.previousIdentityId)
	) {
		throw new BindingWriteBoundaryError("stale", "binding_rebind_stale");
	}
	if (
		outcome.action === "unchanged" &&
		(before?.status !== "active" || before.identity_id !== outcome.targetIdentityId)
	) {
		throw new BindingWriteBoundaryError("stale", "binding_unchanged_stale");
	}
	const revision = digest("device-identity-binding-revision-v1", [commitDigest, outcome.deviceId]);
	const idempotencyKey = digest("device-identity-binding-row-v1", [commitDigest, outcome.deviceId]);
	if (outcome.action === "rebind") {
		const updated = db
			.prepare(
				`UPDATE identity_devices SET identity_id = ?, status = 'active',
			 provenance = 'user_confirmed_identity_setup', revision = ?, migration_state = 'user_managed',
			 source_fingerprint = ?, idempotency_key = ?, updated_at = ?
			 WHERE device_id = ? AND identity_id = ? AND status = 'active'`,
			)
			.run(
				outcome.targetIdentityId,
				revision,
				commitDigest,
				idempotencyKey,
				now,
				outcome.deviceId,
				outcome.previousIdentityId,
			);
		if (updated.changes !== 1) {
			throw new BindingWriteBoundaryError("stale", "binding_rebind_stale");
		}
	} else if (outcome.action === "bind") {
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, ?, 'active', 'user_confirmed_identity_setup', ?, 'user_managed', ?, ?, ?, ?)`,
		).run(
			outcome.deviceId,
			outcome.targetIdentityId,
			outcome.displayName,
			revision,
			commitDigest,
			idempotencyKey,
			now,
			now,
		);
	}
	const after = currentBinding(db, outcome.deviceId);
	if (after?.status !== "active" || after.identity_id !== outcome.targetIdentityId) {
		throw new BindingWriteBoundaryError("stale", "binding_write_stale");
	}
	db.prepare(
		`INSERT INTO device_identity_binding_audit(
		 event_id, commit_digest, device_id, previous_identity_id, target_identity_id,
		 action, previous_assignment_version, resulting_assignment_version,
		 decided_by_identity_id, decided_by_device_id, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		digest("device-identity-binding-event-v1", [commitDigest, outcome.deviceId]),
		commitDigest,
		outcome.deviceId,
		before?.identity_id ?? null,
		outcome.targetIdentityId,
		outcome.action,
		before?.assignment_version ?? null,
		after.assignment_version,
		context.localActorId,
		context.localDeviceId,
		now,
	);
}

function commitInTransaction(
	db: Database,
	context: DeviceIdentityBindingContext,
	inventoryInput: DeviceIdentityInventoryInput,
	request: DeviceIdentityBindingCommitRequestV1,
): DeviceIdentityBindingCommitV1 {
	if (typeof request.reviewedInventoryDigest !== "string" || !request.reviewedInventoryDigest) {
		return {
			...failure("invalid", "reviewed_inventory_digest_required"),
			status: "invalid",
			idempotent: false,
		};
	}
	const requestJson = normalizedRequest(request);
	const commitDigest = digest("device-identity-binding-commit-v1", {
		request: JSON.parse(requestJson),
		reviewedInventoryDigest: request.reviewedInventoryDigest,
	});
	const retry = exactRetry(db, inventoryInput, commitDigest, requestJson, request);
	if (retry) return retry;
	const preview = previewDeviceIdentityBindings(db, inventoryInput, request);
	if (preview.status !== "ready") {
		return { ...preview, status: preview.status, idempotent: false };
	}
	if (preview.reviewedInventoryDigest !== request.reviewedInventoryDigest) {
		return {
			...preview,
			status: "stale",
			errorCode: "binding_evidence_stale",
			writeCount: 0,
			idempotent: false,
		};
	}
	if (!isActiveUnmergedLocalActor(db, context.localActorId)) {
		return {
			...preview,
			status: "invalid",
			errorCode: "deciding_identity_unavailable",
			writeCount: 0,
			idempotent: false,
		};
	}
	const now = (context.now ?? (() => new Date().toISOString()))();
	db.prepare(
		`INSERT INTO device_identity_binding_commits(
		 commit_digest, reviewed_inventory_digest, request_json, outcomes_json, write_count,
		 decided_by_identity_id, decided_by_device_id, created_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		commitDigest,
		request.reviewedInventoryDigest,
		requestJson,
		canonicalJson(preview.outcomes),
		preview.writeCount,
		context.localActorId,
		context.localDeviceId,
		now,
	);
	for (const item of preview.outcomes) writeBinding(db, context, commitDigest, item, now);
	return {
		...preview,
		status: "applied",
		idempotent: false,
	};
}

export function commitDeviceIdentityBindings(
	db: Database,
	context: DeviceIdentityBindingContext,
	inventoryInput: DeviceIdentityInventoryInput,
	request: DeviceIdentityBindingCommitRequestV1,
): DeviceIdentityBindingCommitV1 {
	try {
		return db
			.transaction(() => commitInTransaction(db, context, inventoryInput, request))
			.immediate();
	} catch (error) {
		if (error instanceof BindingWriteBoundaryError) {
			return {
				version: DEVICE_IDENTITY_BINDING_VERSION,
				status: error.status,
				reviewedInventoryDigest: request.reviewedInventoryDigest ?? "",
				errorCode: error.errorCode,
				outcomes: [],
				writeCount: 0,
				idempotent: false,
			};
		}
		const code =
			error && typeof error === "object" && "code" in error
				? String((error as { code?: unknown }).code ?? "")
				: "";
		if (code.startsWith("SQLITE_CONSTRAINT")) {
			return {
				...failure("conflict", "binding_commit_conflict"),
				status: "conflict",
				reviewedInventoryDigest: request.reviewedInventoryDigest ?? "",
				idempotent: false,
			};
		}
		throw error;
	}
}
