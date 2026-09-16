import { CoordinatorMembershipError } from "./coordinator-membership-effects.js";
import type {
	CoordinatorCreateBootstrapGrantInput,
	CoordinatorCreateInviteInput,
	CoordinatorCreateScopeInput,
	CoordinatorGrantScopeMembershipInput,
	CoordinatorInvite,
	CoordinatorInviteKind,
	CoordinatorRecipientInviteInspection,
	CoordinatorReviewJoinRequestBootstrapGrantInput,
	CoordinatorScope,
	CoordinatorScopeMembership,
	CoordinatorUpdateScopeInput,
} from "./coordinator-store-contract.js";
import { isCoordinatorAssignedIdentityId } from "./coordinator-store-contract.js";
import {
	canonicalRecipientReviewedIntentJson,
	parseStoredRecipientReviewedIntent,
	type RecipientReviewedIntentTargetV1,
	verifyRecipientReviewedIntent,
} from "./recipient-reviewed-intent.js";

function normalizeAddress(address: string): string {
	const value = address.trim();
	if (!value) return "";
	const withScheme = value.includes("://") ? value : `http://${value}`;
	try {
		const url = new URL(withScheme);
		if (!url.hostname) return "";
		if (url.port && (Number(url.port) <= 0 || Number(url.port) > 65535)) return "";
		return url.origin + url.pathname.replace(/\/+$/, "");
	} catch {
		return "";
	}
}

function addressDedupeKey(address: string): string {
	if (!address) return "";
	try {
		const parsed = new URL(address);
		const host = parsed.hostname.toLowerCase();
		if (
			(parsed.protocol === "http:" || parsed.protocol === "") &&
			host &&
			parsed.port &&
			parsed.pathname === "/"
		) {
			return `${host}:${parsed.port}`;
		}
	} catch {}
	return address;
}

export function mergeCoordinatorAddresses(existing: string[], candidates: string[]): string[] {
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const address of [...existing, ...candidates]) {
		const cleaned = normalizeAddress(address);
		const key = addressDedupeKey(cleaned);
		if (!cleaned || seen.has(key)) continue;
		seen.add(key);
		normalized.push(cleaned);
	}
	return normalized;
}

export function normalizeCoordinatorBootstrapGrantRequest(
	input: CoordinatorReviewJoinRequestBootstrapGrantInput | null | undefined,
): CoordinatorCreateBootstrapGrantInput | null {
	if (!input) return null;
	const seedDeviceId = String(input.seedDeviceId ?? "").trim();
	const expiresAt = String(input.expiresAt ?? "").trim();
	const createdBy = String(input.createdBy ?? "").trim() || null;
	if (!seedDeviceId || !expiresAt) {
		throw new Error("bootstrapGrant.seedDeviceId and expiresAt are required.");
	}
	return {
		groupId: "",
		seedDeviceId,
		workerDeviceId: "",
		expiresAt,
		createdBy,
	};
}

export function normalizeCoordinatorBootstrapGrantInput(
	opts: CoordinatorCreateBootstrapGrantInput,
): CoordinatorCreateBootstrapGrantInput {
	const groupId = String(opts.groupId ?? "").trim();
	const seedDeviceId = String(opts.seedDeviceId ?? "").trim();
	const workerDeviceId = String(opts.workerDeviceId ?? "").trim();
	const expiresAt = String(opts.expiresAt ?? "").trim();
	const createdBy = String(opts.createdBy ?? "").trim() || null;
	if (!groupId || !seedDeviceId || !workerDeviceId || !expiresAt) {
		throw new Error("groupId, seedDeviceId, workerDeviceId, and expiresAt are required.");
	}
	return { groupId, seedDeviceId, workerDeviceId, expiresAt, createdBy };
}

export function clean(value: string | null | undefined): string | null {
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

interface NormalizedInviteMetadata {
	inviteKind: CoordinatorInviteKind;
	policyTeamId: string | null;
	targetIdentityId: string | null;
	reviewedPreviewDigest: string | null;
}

const RECIPIENT_INVITE_KINDS = new Set<CoordinatorInviteKind>([
	"legacy_enrollment",
	"project_share",
	"team_member",
	"add_device",
]);

function validateInviteMetadataIdentifiers(metadata: NormalizedInviteMetadata): void {
	if (!RECIPIENT_INVITE_KINDS.has(metadata.inviteKind)) {
		throw new Error("inviteKind is invalid.");
	}
	if (
		[metadata.policyTeamId, metadata.targetIdentityId]
			.filter((value): value is string => Boolean(value))
			.some((value) => value.length > 256 || /[\p{Cc}\p{Cf}]/u.test(value))
	) {
		throw new Error("recipient invite identifier is invalid.");
	}
	if (metadata.reviewedPreviewDigest && !/^[a-f0-9]{64}$/u.test(metadata.reviewedPreviewDigest)) {
		throw new Error("reviewedPreviewDigest must be a SHA-256 digest.");
	}
}

type InviteMetadataValidator = (
	operationId: string | null,
	metadata: NormalizedInviteMetadata,
) => void;

const INVITE_METADATA_VALIDATORS: Record<CoordinatorInviteKind, InviteMetadataValidator> = {
	project_share(operationId, metadata) {
		if (!operationId) throw new Error("project_share invite requires operationId.");
		if (metadata.policyTeamId || metadata.targetIdentityId || metadata.reviewedPreviewDigest) {
			throw new Error("recipient invite metadata requires a recipient invite kind.");
		}
	},
	legacy_enrollment(operationId, metadata) {
		if (operationId) throw new Error("legacy_enrollment invite cannot reference an operation.");
		if (metadata.policyTeamId || metadata.targetIdentityId || metadata.reviewedPreviewDigest) {
			throw new Error("recipient invite metadata requires a recipient invite kind.");
		}
	},
	team_member(operationId, metadata) {
		if (
			!metadata.policyTeamId ||
			!metadata.reviewedPreviewDigest ||
			metadata.targetIdentityId ||
			operationId
		) {
			throw new Error("team_member invite metadata is invalid.");
		}
	},
	add_device(operationId, metadata) {
		if (
			!metadata.targetIdentityId ||
			!metadata.reviewedPreviewDigest ||
			metadata.policyTeamId ||
			operationId
		) {
			throw new Error("add_device invite metadata is invalid.");
		}
	},
};

function validateInviteMetadataShape(
	opts: CoordinatorCreateInviteInput,
	metadata: NormalizedInviteMetadata,
): void {
	INVITE_METADATA_VALIDATORS[metadata.inviteKind](clean(opts.operationId), metadata);
}

function reviewedIntentTarget(metadata: NormalizedInviteMetadata): {
	target: RecipientReviewedIntentTargetV1;
	digest: string;
} {
	if (
		metadata.inviteKind === "team_member" &&
		metadata.policyTeamId &&
		metadata.reviewedPreviewDigest
	) {
		return {
			target: { kind: "team_member", policyTeamId: metadata.policyTeamId },
			digest: metadata.reviewedPreviewDigest,
		};
	}
	if (
		metadata.inviteKind === "add_device" &&
		metadata.targetIdentityId &&
		metadata.reviewedPreviewDigest
	) {
		return {
			target: { kind: "add_device", targetIdentityId: metadata.targetIdentityId },
			digest: metadata.reviewedPreviewDigest,
		};
	}
	throw new Error("recipient invite metadata requires a recipient invite kind.");
}

export async function normalizeCoordinatorInviteMetadata(
	opts: CoordinatorCreateInviteInput,
): Promise<{
	inviteKind: CoordinatorInviteKind;
	policyTeamId: string | null;
	targetIdentityId: string | null;
	reviewedPreviewDigest: string | null;
	reviewedIntentJson: string | null;
}> {
	const metadata = {
		inviteKind:
			opts.inviteKind ?? (clean(opts.operationId) ? "project_share" : "legacy_enrollment"),
		policyTeamId: clean(opts.policyTeamId),
		targetIdentityId: clean(opts.targetIdentityId),
		reviewedPreviewDigest: clean(opts.reviewedPreviewDigest),
	} satisfies NormalizedInviteMetadata;
	validateInviteMetadataIdentifiers(metadata);
	validateInviteMetadataShape(opts, metadata);
	const reviewedIntentProvided = opts.reviewedIntent !== undefined && opts.reviewedIntent !== null;
	if (!reviewedIntentProvided) {
		if (metadata.inviteKind === "team_member" || metadata.inviteKind === "add_device") {
			throw new Error("recipient_invite_review_unavailable");
		}
		return {
			...metadata,
			reviewedIntentJson: null,
		};
	}
	const reviewedIntent = reviewedIntentTarget(metadata);
	await verifyRecipientReviewedIntent(opts.reviewedIntent, {
		target: reviewedIntent.target,
		digest: reviewedIntent.digest,
	});
	return {
		...metadata,
		reviewedIntentJson: canonicalRecipientReviewedIntentJson(
			opts.reviewedIntent,
			reviewedIntent.target,
		),
	};
}

export async function inspectCoordinatorRecipientInvite(
	invite: CoordinatorInvite,
): Promise<CoordinatorRecipientInviteInspection | null> {
	if (invite.invite_kind === "team_member") {
		if (
			!invite.policy_team_id ||
			!isCoordinatorAssignedIdentityId(invite.assigned_identity_id) ||
			!invite.reviewed_preview_digest
		)
			throw new Error("invite_invalid");
		const reviewedIntent = await parseStoredRecipientReviewedIntent(invite.reviewed_intent_json, {
			target: { kind: "team_member", policyTeamId: invite.policy_team_id },
			digest: invite.reviewed_preview_digest,
		});
		return {
			kind: "team_member",
			invite,
			policy_team_id: invite.policy_team_id,
			assigned_identity_id: invite.assigned_identity_id,
			reviewed_preview_digest: invite.reviewed_preview_digest,
			reviewed_intent: reviewedIntent,
			bound: Boolean(invite.consumed_at),
		};
	}
	if (invite.invite_kind === "add_device") {
		if (!invite.target_identity_id || !invite.reviewed_preview_digest)
			throw new Error("invite_invalid");
		const reviewedIntent = await parseStoredRecipientReviewedIntent(invite.reviewed_intent_json, {
			target: { kind: "add_device", targetIdentityId: invite.target_identity_id },
			digest: invite.reviewed_preview_digest,
		});
		return {
			kind: "add_device",
			invite,
			target_identity_id: invite.target_identity_id,
			reviewed_preview_digest: invite.reviewed_preview_digest,
			reviewed_intent: reviewedIntent,
			bound: Boolean(invite.consumed_at),
		};
	}
	return null;
}

export function normalizeEpoch(value: number | null | undefined, fallback = 0): number {
	if (value == null) return fallback;
	if (!Number.isFinite(value) || value < 0)
		throw new Error("membershipEpoch must be non-negative.");
	return Math.trunc(value);
}

export function normalizeCoordinatorCreateScopeInput(opts: CoordinatorCreateScopeInput) {
	const scopeId = clean(opts.scopeId);
	const label = clean(opts.label);
	if (!scopeId || !label) throw new Error("scopeId and label are required.");
	return {
		scopeId,
		label,
		kind: clean(opts.kind) ?? "user",
		authorityType: clean(opts.authorityType) ?? "coordinator",
		coordinatorId: clean(opts.coordinatorId),
		groupId: clean(opts.groupId),
		manifestIssuerDeviceId: clean(opts.manifestIssuerDeviceId),
		membershipEpoch: normalizeEpoch(opts.membershipEpoch),
		manifestHash: clean(opts.manifestHash),
		status: clean(opts.status) ?? "active",
	};
}

function cleanRequiredUpdate(
	value: string | null | undefined,
	current: string,
	fieldName: string,
): string {
	if (value === undefined) return current;
	const cleaned = clean(value);
	if (!cleaned) throw new Error(`${fieldName} must not be empty.`);
	return cleaned;
}

function cleanNullableUpdate(
	value: string | null | undefined,
	current: string | null,
): string | null {
	return value === undefined ? current : clean(value);
}

export function normalizeCoordinatorUpdateScopeInput(
	opts: CoordinatorUpdateScopeInput,
	existing: CoordinatorScope,
) {
	const scopeId = clean(opts.scopeId);
	if (!scopeId) throw new Error("scopeId is required.");
	const requestedEpoch = opts.membershipEpoch == null ? null : normalizeEpoch(opts.membershipEpoch);
	if (requestedEpoch != null && requestedEpoch < existing.membership_epoch) {
		throw new Error("membershipEpoch must not move backwards.");
	}
	return {
		scopeId,
		label: cleanRequiredUpdate(opts.label, existing.label, "label"),
		kind: cleanRequiredUpdate(opts.kind, existing.kind, "kind"),
		authorityType: cleanRequiredUpdate(
			opts.authorityType,
			existing.authority_type,
			"authorityType",
		),
		coordinatorId: cleanNullableUpdate(opts.coordinatorId, existing.coordinator_id),
		groupId: cleanNullableUpdate(opts.groupId, existing.group_id),
		manifestIssuerDeviceId: cleanNullableUpdate(
			opts.manifestIssuerDeviceId,
			existing.manifest_issuer_device_id,
		),
		membershipEpoch: requestedEpoch ?? existing.membership_epoch,
		manifestHash: cleanNullableUpdate(opts.manifestHash, existing.manifest_hash),
		status: cleanRequiredUpdate(opts.status, existing.status, "status"),
	};
}

export function normalizeCoordinatorGrantScopeMembershipInput(
	opts: CoordinatorGrantScopeMembershipInput,
	scope: CoordinatorScope | null,
	existing: CoordinatorScopeMembership | null,
) {
	const scopeId = clean(opts.scopeId);
	const deviceId = clean(opts.deviceId);
	if (!scopeId || !deviceId) throw new Error("scopeId and deviceId are required.");
	validateMembershipScopeBindings(opts, scope);
	const membershipEpoch = normalizeMembershipEpoch(opts, scope, existing);
	return {
		scopeId,
		deviceId,
		role: clean(opts.role) ?? "member",
		membershipEpoch,
		coordinatorId: scope?.coordinator_id ?? null,
		groupId: scope?.group_id ?? null,
		manifestIssuerDeviceId:
			clean(opts.manifestIssuerDeviceId) ?? scope?.manifest_issuer_device_id ?? null,
		manifestHash: clean(opts.manifestHash) ?? scope?.manifest_hash ?? null,
		signedManifestJson: clean(opts.signedManifestJson),
		actorType: clean(opts.actorType),
		actorId: clean(opts.actorId),
	};
}

function validateMembershipScopeBindings(
	opts: CoordinatorGrantScopeMembershipInput,
	scope: CoordinatorScope | null,
): void {
	if (clean(opts.coordinatorId) && clean(opts.coordinatorId) !== scope?.coordinator_id) {
		throw new Error("membership coordinatorId must match the scope coordinatorId.");
	}
	if (clean(opts.groupId) && clean(opts.groupId) !== scope?.group_id) {
		throw new CoordinatorMembershipError("scope_group_mismatch");
	}
}

function normalizeMembershipEpoch(
	opts: CoordinatorGrantScopeMembershipInput,
	scope: CoordinatorScope | null,
	existing: CoordinatorScopeMembership | null,
): number {
	const requestedEpoch = opts.membershipEpoch == null ? null : normalizeEpoch(opts.membershipEpoch);
	const inheritedEpoch = scope?.membership_epoch ?? 0;
	if (requestedEpoch != null && requestedEpoch < inheritedEpoch) {
		throw new Error("membershipEpoch must not be lower than the scope membershipEpoch.");
	}
	if (requestedEpoch != null && existing) {
		const minimumEpoch =
			existing.status === "revoked" ? existing.membership_epoch + 1 : existing.membership_epoch;
		if (requestedEpoch < minimumEpoch) {
			throw new Error("membershipEpoch must not move backwards.");
		}
	}
	return (
		requestedEpoch ??
		(existing
			? Math.max(
					inheritedEpoch,
					existing.membership_epoch + (existing.status === "revoked" ? 1 : 0),
				)
			: inheritedEpoch)
	);
}

export function normalizeCoordinatorAuditLimit(limit: number | null | undefined): number {
	if (limit == null) return 100;
	if (!Number.isFinite(limit)) return 100;
	return Math.max(1, Math.min(1000, Math.trunc(limit)));
}
