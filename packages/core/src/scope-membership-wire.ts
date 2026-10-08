import { createHash } from "node:crypto";
import { parseSshEd25519PublicKeyForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	ENROLLMENT_FIELDS,
	isCurrentScopeMember,
	MEMBERSHIP_FIELDS,
	requireScopeAuthorizationRecord,
	SCOPE_FIELDS,
	scopeAuthorizationError,
} from "./coordinator-scope-authorization.js";
import type {
	CoordinatorEnrollment,
	CoordinatorScope,
	CoordinatorScopeMembership,
} from "./coordinator-store-contract.js";

function unavailable(): never {
	throw new Error("scope_authorization_unavailable");
}

function items(payload: Record<string, unknown> | null, versionField: string): unknown[] {
	if (payload?.[versionField] !== 1 || !Array.isArray(payload.items)) unavailable();
	return payload.items;
}

export function decodeScopeCatalogue(
	payload: Record<string, unknown> | null,
	groupId: string,
): CoordinatorScope[] {
	const seen = new Set<string>();
	return items(payload, "version").map((raw) => {
		requireScopeAuthorizationRecord(raw, SCOPE_FIELDS);
		const scope = raw as CoordinatorScope;
		if (scopeAuthorizationError(scope, groupId) || seen.has(scope.scope_id)) unavailable();
		seen.add(scope.scope_id);
		return scope;
	});
}

function decodeMember(raw: unknown, scope: CoordinatorScope): CoordinatorScopeMembership {
	requireScopeAuthorizationRecord(raw, ["key_id"]);
	const item = raw as Record<string, unknown>;
	requireScopeAuthorizationRecord(item.membership, MEMBERSHIP_FIELDS);
	requireScopeAuthorizationRecord(item.enrollment, ENROLLMENT_FIELDS);
	const membership = item.membership as CoordinatorScopeMembership;
	const enrollment = item.enrollment as CoordinatorEnrollment;
	if (
		!isCurrentScopeMember(scope, membership) ||
		enrollment.group_id !== scope.group_id ||
		enrollment.device_id !== membership.device_id ||
		enrollment.enabled !== 1 ||
		typeof item.key_id !== "string" ||
		!/^[a-f0-9]{64}$/.test(item.key_id)
	)
		unavailable();
	// Preserve the producer's legacy fingerprint tuple without redefining its canonical key ID.
	const parsed = parseSshEd25519PublicKeyForRevocation(enrollment.public_key);
	if (
		parsed.kind !== "ed25519" ||
		createHash("sha256").update(parsed.blob).digest("hex") !== item.key_id
	)
		unavailable();
	return membership;
}

export function decodeScopeMembers(
	payload: Record<string, unknown> | null,
	catalogueScope: CoordinatorScope | undefined,
	groupId: string,
	scopeId: string,
): CoordinatorScopeMembership[] {
	const rows = items(payload, "authorization_version");
	requireScopeAuthorizationRecord(payload?.scope, SCOPE_FIELDS);
	const scope = payload?.scope as CoordinatorScope;
	// The legacy fetcher interface cannot carry newer scope metadata to reconciliation.
	// Reject a catalogue/snapshot race rather than mark that older tuple fresh.
	if (
		!catalogueScope ||
		scope.scope_id !== scopeId ||
		scopeAuthorizationError(scope, groupId) ||
		SCOPE_FIELDS.some((field) => scope[field] !== catalogueScope[field])
	)
		unavailable();
	const seen = new Set<string>();
	return rows.map((raw) => {
		const membership = decodeMember(raw, scope);
		if (seen.has(membership.device_id)) unavailable();
		seen.add(membership.device_id);
		return membership;
	});
}
