import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	legacyDecisionCountsAsOwner,
	legacyTeamCandidateId,
	normalizeCoordinatorLegacyTeamCompletionManifest,
	type ResolvedAccountOwnerReceiptReference,
} from "@codemem/core";
import type {
	RecoveryHistoryRow,
	RecoverySelection,
	ReviewedWeakLabel,
} from "./owner-recovery-types.js";

export const RECOVERY_SCOPE = "historical_included_owner_labels_only";
// The coordinator reports blocked reviews as a code, optionally followed by
// operator guidance ("ownership_unavailable: inspect ..."). Accept only
// bounded printable ASCII so control characters and dumps stay rejected.
const RECOVERY_REASON = /^[a-z][a-z0-9_]{0,119}(?:: [\x20-\x7e]{1,240})?$/;
export class AccountOwnerRecoveryError extends Error {
	constructor(readonly code: "invalid" | "busy" | "context_changed" | "unavailable" = "invalid") {
		super("account_owner_recovery_invalid");
	}
}
/**
 * The fix for an unsafe local state directory, or null for any other error. Matches the
 * core error by code because the bundle can carry a second copy of the core class.
 */
export function unsafeStorageMessage(error: unknown): string | null {
	if (!(error instanceof Error) || !("code" in error)) return null;
	return error.code === "account_owner_association_directory_unsafe" ? error.message : null;
}
export function requireRecovery(
	condition: unknown,
	code: AccountOwnerRecoveryError["code"] = "invalid",
): asserts condition {
	if (!condition) throw new AccountOwnerRecoveryError(code);
}
export function recoveryId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}
export function recoveryHash(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
export function recoveryRecord(value: unknown): Record<string, unknown> {
	requireRecovery(value && typeof value === "object" && !Array.isArray(value));
	return value as Record<string, unknown>;
}
export function exactRecoveryFields(row: Record<string, unknown>, fields: readonly string[]): void {
	requireRecovery(
		Object.keys(row).length === fields.length && fields.every((key) => Object.hasOwn(row, key)),
	);
}
function timestamp(value: unknown): boolean {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function readWeakLabel(value: unknown): ReviewedWeakLabel {
	const row = recoveryRecord(value);
	exactRecoveryFields(row, ["label", "kind", "group_id", "device_id", "evidence_ref", "effect"]);
	requireRecovery(
		recoveryId(row.label) &&
			recoveryId(row.group_id) &&
			recoveryId(row.device_id) &&
			recoveryId(row.evidence_ref),
	);
	requireRecovery(
		row.kind === "legacy_included_owner_label" || row.kind === "consumed_project_actor_label",
	);
	requireRecovery(row.effect === "account_owner_display_only");
	return {
		label: row.label,
		kind: row.kind,
		group_id: row.group_id,
		device_id: row.device_id,
		evidence_ref: row.evidence_ref,
		effect: row.effect,
	};
}
function historyRows(
	value: unknown,
	selection: RecoverySelection,
	labels: ReviewedWeakLabel[],
): RecoveryHistoryRow[] {
	const row = recoveryRecord(value);
	requireRecovery(
		recoveryId(row.group_id) && recoveryId(row.candidate_ref) && timestamp(row.created_at),
	);
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest(row.manifest);
	requireRecovery(
		manifest.coordinator_id === selection.profile.coordinatorId &&
			manifest.candidate_ref === row.candidate_ref &&
			manifest.version === row.manifest_version &&
			manifest.completed_at === row.completed_at &&
			legacyTeamCandidateId(manifest.coordinator_id, row.group_id) === manifest.candidate_ref &&
			canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest) === row.manifest_json,
	);
	const groupId = row.group_id;
	return manifest.device_decisions.map((decision) => {
		let relation: RecoveryHistoryRow["relation"] = "other";
		if (decision.device_id === selection.profile.deviceId) relation = "exact_subject";
		else if (
			labels.some(
				(label) =>
					label.kind === "legacy_included_owner_label" &&
					label.group_id === groupId &&
					label.device_id === decision.device_id &&
					label.label === decision.identity_id &&
					label.evidence_ref === manifest.source_digest,
			)
		)
			relation = "alias";
		return {
			id: `${manifest.candidate_ref}:${decision.device_id}`,
			groupId,
			deviceId: decision.device_id,
			fingerprint: decision.key_fingerprint,
			identityId: decision.identity_id ?? "",
			assignment: decision.decision,
			relation,
			reason: legacyDecisionCountsAsOwner(decision)
				? "Recorded in Team history."
				: "Guessed by another device in Team history.",
		};
	});
}
function receiptPart(value: unknown, idField: string): { id: string; digest: string } {
	const row = recoveryRecord(value);
	exactRecoveryFields(row, ["disposition", idField, "evidence_digest", "created_at"]);
	const id = row[idField];
	requireRecovery(
		recoveryId(id) &&
			recoveryHash(row.evidence_digest) &&
			timestamp(row.created_at) &&
			(row.disposition === "created" || row.disposition === "reused"),
	);
	return { id, digest: row.evidence_digest };
}
export function reviewReceipt(row: Record<string, unknown>): ResolvedAccountOwnerReceiptReference {
	requireRecovery(recoveryId(row.attestation_id));
	const source = receiptPart(row.recovery_receipt, "review_receipt_id");
	const resolution = receiptPart(row.owner_resolution, "resolution_id");
	return {
		attestationId: row.attestation_id,
		reviewReceiptId: source.id,
		reviewEvidenceDigest: source.digest,
		resolutionId: resolution.id,
		resolutionEvidenceDigest: resolution.digest,
	};
}
export interface ValidatedRecoveryReview {
	state: "ready" | "restored" | "needs_review";
	digest?: string;
	receipt?: ResolvedAccountOwnerReceiptReference;
	rows: RecoveryHistoryRow[];
	labels: ReviewedWeakLabel[];
	reasons: string[];
}
export function validateRecoveryReview(
	value: unknown,
	selection: RecoverySelection,
	groupId: string,
): ValidatedRecoveryReview {
	const row = recoveryRecord(value);
	const profile = selection.profile;
	requireRecovery(
		row.purpose === "existing_account_owner" &&
			row.resolution_scope === RECOVERY_SCOPE &&
			row.coordinator_id === profile.coordinatorId &&
			row.group_id === groupId &&
			row.device_id === profile.deviceId &&
			row.fingerprint === profile.fingerprint &&
			row.identity_id === selection.existingOwnerId,
	);
	requireRecovery(
		Array.isArray(row.legacy_history) &&
			row.legacy_history.length <= 500 &&
			Array.isArray(row.reviewed_weak_labels) &&
			row.reviewed_weak_labels.length <= 256 &&
			Array.isArray(row.reasons) &&
			row.reasons.every((reason) => typeof reason === "string"),
	);
	const labels = row.reviewed_weak_labels.map(readWeakLabel);
	requireRecovery(new Set(labels.map((label) => JSON.stringify(label))).size === labels.length);
	const rows = row.legacy_history.flatMap((history) => historyRows(history, selection, labels));
	requireRecovery(
		row.reasons.length <= 8 &&
			row.reasons.every((reason) => typeof reason === "string" && RECOVERY_REASON.test(reason)),
	);
	const reasons = row.reasons as string[];
	if (row.state === "needs_review") {
		requireRecovery(row.reasons.length > 0 && !Object.hasOwn(row, "owner_resolution_digest"));
		return { state: row.state, rows, labels, reasons };
	}
	requireRecovery(
		(row.state === "ready" || row.state === "restored") &&
			recoveryHash(row.owner_resolution_digest) &&
			row.reasons.length === 0,
	);
	const target = recoveryRecord(row.account_owner_target);
	requireRecovery(
		target.identity_id === selection.existingOwnerId &&
			recoveryId(target.link_id) &&
			recoveryId(target.auth_config_revision) &&
			typeof target.created_at_ms === "number" &&
			Number.isSafeInteger(target.created_at_ms),
	);
	let receipt: ResolvedAccountOwnerReceiptReference | undefined;
	if (row.state === "restored" || Object.hasOwn(row, "owner_resolution"))
		receipt = reviewReceipt(row);
	return { state: row.state, digest: row.owner_resolution_digest, receipt, rows, labels, reasons };
}

function replyGroups(row: Record<string, unknown>, selection: RecoverySelection): unknown[] {
	exactRecoveryFields(row, [
		"version",
		"purpose",
		"scope",
		"coordinatorOrigin",
		"coordinatorId",
		"deviceId",
		"fingerprint",
		"ownerIdentityId",
		"groups",
	]);
	const p = selection.profile;
	requireRecovery(
		row.version === 1 &&
			row.purpose === "existing_account_owner" &&
			row.scope === RECOVERY_SCOPE &&
			row.coordinatorOrigin === p.coordinatorOrigin &&
			row.coordinatorId === p.coordinatorId &&
			row.deviceId === p.deviceId &&
			row.fingerprint === p.fingerprint &&
			row.ownerIdentityId === selection.existingOwnerId &&
			Array.isArray(row.groups) &&
			row.groups.length === selection.groups.length,
	);
	return row.groups;
}

export function parseRecoveryReply(
	text: string,
	selection: RecoverySelection,
): Map<string, ResolvedAccountOwnerReceiptReference> {
	requireRecovery(typeof text === "string" && Buffer.byteLength(text) <= 32 * 1024);
	const groups = replyGroups(recoveryRecord(JSON.parse(text)), selection);
	const receipts = new Map<string, ResolvedAccountOwnerReceiptReference>();
	for (const input of groups) {
		const group = recoveryRecord(input);
		exactRecoveryFields(group, [
			"groupId",
			"attestationId",
			"reviewReceiptId",
			"reviewEvidenceDigest",
			"resolutionId",
			"resolutionEvidenceDigest",
		]);
		requireRecovery(
			typeof group.groupId === "string" &&
				selection.groups.includes(group.groupId) &&
				!receipts.has(group.groupId),
		);
		requireRecovery(
			recoveryId(group.attestationId) &&
				recoveryId(group.reviewReceiptId) &&
				recoveryId(group.resolutionId) &&
				recoveryHash(group.reviewEvidenceDigest) &&
				recoveryHash(group.resolutionEvidenceDigest),
		);
		receipts.set(group.groupId, {
			attestationId: group.attestationId,
			reviewReceiptId: group.reviewReceiptId,
			reviewEvidenceDigest: group.reviewEvidenceDigest,
			resolutionId: group.resolutionId,
			resolutionEvidenceDigest: group.resolutionEvidenceDigest,
		});
	}
	return receipts;
}
