/**
 * Authority contract for coordinator account links.
 *
 * Every link attempt, account link, and link audit row names its authority source:
 * - `controller_attestation`: an admin-reviewed attestation for the exact enrolled key.
 * - `device_claim`: an eligible enrolled-key claim while an attempt is pending.
 *   Link and audit rows reference proof committed after Google verification and
 *   device finalization. It is never an operator review.
 *
 * Rows store the kind explicitly and reference only the record that matches it.
 * Readers must fail closed on any row whose references disagree with its kind.
 */

import { isAuthControllerId as isReference } from "./coordinator-auth-controller.js";

export const AUTH_LINK_AUTHORITY_KINDS = ["controller_attestation", "device_claim"] as const;
export type CoordinatorAuthLinkAuthorityKind = (typeof AUTH_LINK_AUTHORITY_KINDS)[number];

export type CoordinatorAuthLinkAttemptAuthority =
	| {
			kind: "controller_attestation";
			controllerAttestationId: string;
			controllerReviewReceiptId: string;
	  }
	| { kind: "device_claim" };

export type CoordinatorAuthLinkRecordAuthority =
	| { kind: "controller_attestation"; controllerAttestationId: string }
	| { kind: "device_claim"; deviceClaimId: string };

/** Link-attempt columns. A pending device claim has no committed claim record yet. */
export interface AuthLinkAttemptAuthorityRow {
	authority_kind: unknown;
	controller_attestation_id: unknown;
	controller_review_receipt_id: unknown;
	controller_revision: unknown;
}

/** Account-link and audit columns. */
export interface AuthLinkRecordAuthorityRow {
	authority_kind: unknown;
	controller_attestation_id: unknown;
	device_claim_id: unknown;
}

/** Returns null for a corrupt row; callers must treat that as no authority. */
export function readAuthLinkAttemptAuthority(
	row: AuthLinkAttemptAuthorityRow,
): CoordinatorAuthLinkAttemptAuthority | null {
	if (row.authority_kind === "device_claim") {
		const unreferenced =
			row.controller_attestation_id === null &&
			row.controller_review_receipt_id === null &&
			row.controller_revision === null;
		return unreferenced ? { kind: "device_claim" } : null;
	}
	if (row.authority_kind !== "controller_attestation") return null;
	if (
		!isReference(row.controller_attestation_id) ||
		!isReference(row.controller_review_receipt_id) ||
		row.controller_revision !== 1
	)
		return null;
	return {
		kind: "controller_attestation",
		controllerAttestationId: row.controller_attestation_id,
		controllerReviewReceiptId: row.controller_review_receipt_id,
	};
}

/** Returns null for a corrupt row; callers must treat that as no authority. */
export function readAuthLinkRecordAuthority(
	row: AuthLinkRecordAuthorityRow,
): CoordinatorAuthLinkRecordAuthority | null {
	if (row.authority_kind === "device_claim") {
		if (row.controller_attestation_id !== null || !isReference(row.device_claim_id)) return null;
		return { kind: "device_claim", deviceClaimId: row.device_claim_id };
	}
	if (row.authority_kind !== "controller_attestation") return null;
	if (!isReference(row.controller_attestation_id) || row.device_claim_id !== null) return null;
	return { kind: "controller_attestation", controllerAttestationId: row.controller_attestation_id };
}

/**
 * Operator-only consumers accept no other source kind. This classifies a stored
 * reference; callers must still resolve and validate the referenced attestation.
 */
export function isOperatorReviewedAuthority(
	authority: CoordinatorAuthLinkRecordAuthority | null,
): boolean {
	return authority?.kind === "controller_attestation";
}

interface AccountLinkStatusSubject {
	version: 2;
	coordinatorId: string;
	groupId: string;
	deviceId: string;
	fingerprint: string;
}
type AccountMetadata = { email?: string; displayName?: string };

/**
 * Signed-device account-link status for the requested Identity.
 * `unlinked` is eligibility only; for `device_claim` nothing is verified or
 * reserved until the same operation's device finalization commits.
 * `account` is null whenever the link Identity differs from the requested one.
 */
export type CoordinatorAccountLinkStatusV2 = AccountLinkStatusSubject &
	(
		| {
				state: "review_required" | "conflict";
				identityId: null;
				authority: null;
				account: null;
		  }
		| {
				state: "unlinked";
				identityId: string;
				authority: CoordinatorAuthLinkAuthorityKind;
				account: null;
		  }
		| {
				state: "linked";
				identityId: string;
				authority: CoordinatorAuthLinkAuthorityKind;
				account: AccountMetadata | null;
		  }
		| {
				state: "revoked";
				identityId: string;
				authority: CoordinatorAuthLinkAuthorityKind;
				account: null;
		  }
	);
