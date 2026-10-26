import type { CoordinatorAccountLinkStatusStore } from "./coordinator-account-link-status.js";
import type {
	CoordinatorAccountOwnerTarget,
	CoordinatorAccountOwnerTargetStore,
} from "./coordinator-account-owner-target.js";
import type {
	CoordinatorAuthControllerStore,
	CoordinatorAuthControllerVerifiedSnapshot,
} from "./coordinator-auth-controller.js";
import type { ControllerHistoryEvidence } from "./coordinator-auth-controller-history.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import { legacyDecisionCountsAsOwner } from "./coordinator-legacy-team-completion.js";
import type { CoordinatorEnrollment } from "./coordinator-store-contract.js";

export type ExistingOwnerReviewCapabilities = Partial<
	CoordinatorAccountOwnerTargetStore &
		CoordinatorAccountLinkStatusStore &
		Pick<CoordinatorAuthControllerStore, "hasAuthControllerSubjectOwnerConflict">
>;
export interface CoordinatorControllerOwnerAdvisory {
	identity_id: string;
	link_id: string;
	auth_config_revision: string;
	created_at_ms: number;
	active_review: {
		attestation_id: string;
		review_receipt_id: string;
		evidence_digest: string;
	} | null;
}

/** No account profile or issuer data crosses this advisory boundary. */
export async function prepareExistingOwnerReview(options: {
	store: ExistingOwnerReviewCapabilities;
	enrollment: CoordinatorEnrollment | null;
	identityId: string;
	config: CoordinatorAuthLinkConfig;
	snapshot: CoordinatorAuthControllerVerifiedSnapshot;
}): Promise<{
	target?: CoordinatorControllerOwnerAdvisory;
	reason?: "account_owner_target_unavailable" | "account_owner_conflict";
}> {
	const { store, enrollment, identityId, config, snapshot } = options;
	if (
		!enrollment ||
		!store.readAccountOwnerTarget ||
		!store.readAccountLinkStatus ||
		!store.hasAuthControllerSubjectOwnerConflict ||
		!snapshot.legacyHistory
	)
		return { reason: "account_owner_target_unavailable" };
	const signer = {
		groupId: enrollment.group_id,
		deviceId: enrollment.device_id,
		publicKey: enrollment.public_key,
		fingerprint: enrollment.fingerprint,
	};
	try {
		const target = await store.readAccountOwnerTarget(
			{ targetIdentityId: identityId, signer },
			config,
		);
		if (target.kind !== "ready") return { reason: "account_owner_target_unavailable" };
		if (
			await store.hasAuthControllerSubjectOwnerConflict({
				identityId,
				history: snapshot.legacyHistory,
			})
		)
			return { reason: "account_owner_conflict" };
		const status = await store.readAccountLinkStatus(signer, config, { identityId });
		if (
			status.state === "conflict" ||
			status.state === "revoked" ||
			(status.identityId !== null && status.identityId !== identityId)
		)
			return { reason: "account_owner_conflict" };
		snapshot.accountOwnerTarget = {
			purpose: "existing_account_owner",
			coordinatorId: config.coordinatorId,
			targetIdentityId: identityId,
			issuer: config.issuer,
			linkId: target.linkId,
			authConfigRevision: target.currentGeneration.authConfigRevision,
			createdAtMs: target.currentGeneration.createdAtMs,
		};
		return { target: projectTarget(target) };
	} catch {
		return { reason: "account_owner_target_unavailable" };
	}
}

function projectTarget(
	target: Extract<CoordinatorAccountOwnerTarget, { kind: "ready" }>,
): CoordinatorControllerOwnerAdvisory {
	return {
		identity_id: target.targetIdentityId,
		link_id: target.linkId,
		auth_config_revision: target.currentGeneration.authConfigRevision,
		created_at_ms: target.currentGeneration.createdAtMs,
		active_review: target.review
			? {
					attestation_id: target.review.attestationId,
					review_receipt_id: target.review.reviewReceiptId,
					evidence_digest: target.review.evidenceDigest,
				}
			: null,
	};
}

/**
 * Hints are only subject assignments, never the other people in the retained
 * manifests, and never another device's guessed label.
 */
export function historicalOwnerHints(
	history: ControllerHistoryEvidence[],
	snapshot: CoordinatorAuthControllerVerifiedSnapshot,
): string[] {
	const subject = snapshot.legacyHistory;
	if (!subject) return [];
	const fingerprints = new Set([
		subject.fingerprint,
		...subject.keys.map((key) => key.fingerprint),
	]);
	const identities = history.flatMap((row) =>
		row.manifest.device_decisions
			.filter(
				(decision) =>
					legacyDecisionCountsAsOwner(decision) &&
					(decision.device_id === subject.deviceId || fingerprints.has(decision.key_fingerprint)),
			)
			.flatMap((decision) => (decision.identity_id ? [decision.identity_id] : [])),
	);
	return [...new Set(identities)].sort();
}
