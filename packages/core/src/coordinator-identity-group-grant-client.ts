import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorIdentityGroupGrant } from "./coordinator-identity-group-grant.js";

export function isCoordinatorControllerAttestationReference(value: unknown): value is string {
	return (
		typeof value === "string" && value.length === 78 && /^controller-v1:[a-f0-9]{64}$/.test(value)
	);
}

export interface CoordinatorIdentityGroupGrantActionResult {
	kind: "created" | "existing";
	grant: CoordinatorIdentityGroupGrant;
}

/** Return only validated transport-grant fields, never arbitrary server output. */
export function parseCoordinatorIdentityGroupGrantResponse(
	payload: Record<string, unknown> | null,
): CoordinatorIdentityGroupGrantActionResult {
	const value = payload?.grant;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("identity_group_grant_response_invalid");
	const grant = value as Record<string, unknown>;
	if (
		(payload?.kind !== "created" && payload?.kind !== "existing") ||
		!isAuthControllerId(grant.coordinator_id) ||
		!isAuthControllerId(grant.identity_id) ||
		!isAuthControllerId(grant.group_id) ||
		!isAuthControllerId(grant.source_receipt_id) ||
		grant.status !== "active" ||
		grant.source_kind !== "controller_attestation" ||
		typeof grant.revision !== "number" ||
		!Number.isSafeInteger(grant.revision) ||
		grant.revision < 1 ||
		!isAuthControllerId(grant.created_at) ||
		!Number.isFinite(Date.parse(grant.created_at)) ||
		grant.revoked_at !== null
	)
		throw new Error("identity_group_grant_response_invalid");
	return {
		kind: payload.kind,
		grant: {
			coordinator_id: grant.coordinator_id,
			identity_id: grant.identity_id,
			group_id: grant.group_id,
			status: grant.status,
			revision: grant.revision,
			source_kind: grant.source_kind,
			source_receipt_id: grant.source_receipt_id,
			created_at: grant.created_at,
			revoked_at: grant.revoked_at,
		},
	};
}
