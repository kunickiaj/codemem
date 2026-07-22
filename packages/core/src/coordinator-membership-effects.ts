import type {
	CoordinatorGrantScopeMembershipInput,
	CoordinatorRevokeScopeMembershipInput,
	CoordinatorScopeMembership,
} from "./coordinator-store-contract.js";

export const SCOPE_MEMBERSHIP_EFFECT_CONFLICT = "scope_membership_effect_conflict";

export type CoordinatorMembershipErrorCode =
	| "device_not_enrolled"
	| "scope_group_mismatch"
	| "scope_inactive"
	| "scope_not_found";

const MEMBERSHIP_ERROR_MESSAGES: Record<CoordinatorMembershipErrorCode, string> = {
	device_not_enrolled: "device must be enrolled and enabled in the scope group.",
	scope_group_mismatch: "membership groupId must match the scope groupId.",
	scope_inactive: "scope is not active.",
	scope_not_found: "scopeId must reference an existing scope.",
};

export class CoordinatorMembershipError extends Error {
	readonly code: CoordinatorMembershipErrorCode;

	constructor(code: CoordinatorMembershipErrorCode) {
		super(MEMBERSHIP_ERROR_MESSAGES[code]);
		this.name = "CoordinatorMembershipError";
		this.code = code;
	}
}

export interface CoordinatorMembershipEffectReceipt {
	effect_id: string;
	action: "grant" | "revoke";
	request_json: string;
	outcome_applied: number;
	scope_id: string;
	device_id: string;
	role: string | null;
	status: string | null;
	membership_epoch: number | null;
	coordinator_id: string | null;
	group_id: string | null;
	manifest_issuer_device_id: string | null;
	manifest_hash: string | null;
	signed_manifest_json: string | null;
	updated_at: string | null;
	created_at: string;
}

function clean(value: string | null | undefined): string | null {
	const normalized = value?.trim();
	return normalized ? normalized : null;
}

export function normalizeMembershipEffectId(value: string): string {
	const effectId = clean(value);
	if (!effectId) throw new Error("effectId is required.");
	if (effectId.length > 512 || /[\p{Cc}\p{Cf}]/u.test(effectId)) {
		throw new Error("effectId is invalid.");
	}
	return effectId;
}

export function grantMembershipEffectRequestJson(
	opts: CoordinatorGrantScopeMembershipInput,
): string {
	return JSON.stringify({
		scopeId: clean(opts.scopeId),
		deviceId: clean(opts.deviceId),
		role: clean(opts.role),
		membershipEpoch: opts.membershipEpoch ?? null,
		coordinatorId: clean(opts.coordinatorId),
		groupId: clean(opts.groupId),
		manifestIssuerDeviceId: clean(opts.manifestIssuerDeviceId),
		manifestHash: clean(opts.manifestHash),
		signedManifestJson: clean(opts.signedManifestJson),
		actorType: clean(opts.actorType),
		actorId: clean(opts.actorId),
	});
}

export function revokeMembershipEffectRequestJson(
	opts: CoordinatorRevokeScopeMembershipInput,
): string {
	return JSON.stringify({
		scopeId: clean(opts.scopeId),
		deviceId: clean(opts.deviceId),
		groupId: clean(opts.groupId),
		membershipEpoch: opts.membershipEpoch ?? null,
		manifestHash: clean(opts.manifestHash),
		signedManifestJson: clean(opts.signedManifestJson),
		actorType: clean(opts.actorType),
		actorId: clean(opts.actorId),
	});
}

export function assertMatchingMembershipEffectReceipt(
	receipt: CoordinatorMembershipEffectReceipt,
	action: CoordinatorMembershipEffectReceipt["action"],
	requestJson: string,
): void {
	if (receipt.action !== action || receipt.request_json !== requestJson) {
		throw new Error(SCOPE_MEMBERSHIP_EFFECT_CONFLICT);
	}
}

export function membershipFromEffectReceipt(
	receipt: CoordinatorMembershipEffectReceipt,
): CoordinatorScopeMembership {
	if (
		receipt.action !== "grant" ||
		receipt.outcome_applied !== 1 ||
		receipt.role == null ||
		receipt.status == null ||
		receipt.membership_epoch == null ||
		receipt.updated_at == null
	) {
		throw new Error("scope_membership_effect_receipt_invalid");
	}
	return {
		scope_id: receipt.scope_id,
		device_id: receipt.device_id,
		role: receipt.role,
		status: receipt.status,
		membership_epoch: receipt.membership_epoch,
		coordinator_id: receipt.coordinator_id,
		group_id: receipt.group_id,
		manifest_issuer_device_id: receipt.manifest_issuer_device_id,
		manifest_hash: receipt.manifest_hash,
		signed_manifest_json: receipt.signed_manifest_json,
		updated_at: receipt.updated_at,
	};
}
