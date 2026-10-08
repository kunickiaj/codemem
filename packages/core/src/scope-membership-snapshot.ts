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

export interface ScopeMembershipCatalog {
	version: 1;
	items: CoordinatorScope[];
}

export interface ScopeMembershipSnapshot {
	authorization_version: 1;
	scope: CoordinatorScope;
	items: Array<{
		membership: CoordinatorScopeMembership;
		enrollment: CoordinatorEnrollment;
		key_id: string;
	}>;
}

function requireEnvelope(raw: unknown, versionField: string): Record<string, unknown> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Invalid current scope snapshot.");
	const envelope = raw as Record<string, unknown>;
	if (envelope[versionField] !== 1 || !Array.isArray(envelope.items))
		throw new Error("Current scope snapshot version 1 and items required.");
	return envelope;
}

function requireScope(raw: unknown, groupId: string): CoordinatorScope {
	requireScopeAuthorizationRecord(raw, SCOPE_FIELDS);
	const scope = raw as CoordinatorScope;
	if (scopeAuthorizationError(scope, groupId)) throw new Error("Invalid scope source or status.");
	return scope;
}

export function normalizeScopeCatalog(raw: unknown, groupId: string): CoordinatorScope[] {
	const envelope = requireEnvelope(raw, "version");
	const scopes = (envelope.items as unknown[]).map((item) => requireScope(item, groupId));
	if (new Set(scopes.map((scope) => scope.scope_id)).size !== scopes.length)
		throw new Error("Duplicate scope in catalog.");
	return scopes;
}

function requireMember(raw: unknown, scope: CoordinatorScope): CoordinatorScopeMembership {
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("Invalid current scope member.");
	const member = raw as ScopeMembershipSnapshot["items"][number];
	requireScopeAuthorizationRecord(member.membership, MEMBERSHIP_FIELDS);
	requireScopeAuthorizationRecord(member.enrollment, ENROLLMENT_FIELDS);
	const { membership, enrollment } = member;
	// Legacy fingerprints are stored tuple evidence; canonical identity comes from the key blob.
	const parsed = parseSshEd25519PublicKeyForRevocation(enrollment.public_key);
	if (
		!isCurrentScopeMember(scope, membership) ||
		enrollment.enabled !== 1 ||
		enrollment.group_id !== scope.group_id ||
		enrollment.device_id !== membership.device_id ||
		parsed.kind !== "ed25519" ||
		createHash("sha256").update(parsed.blob).digest("hex") !== member.key_id
	)
		throw new Error("Current scope member evidence mismatch.");
	return membership;
}

export function normalizeScopeSnapshot(
	raw: unknown,
	catalogScope: CoordinatorScope,
	groupId: string,
	coordinatorId: string,
): {
	scope: CoordinatorScope;
	memberships: CoordinatorScopeMembership[];
	sourceCoordinatorId: string | null;
} {
	const envelope = requireEnvelope(raw, "authorization_version");
	const source = requireScope(envelope.scope, groupId);
	if (
		source.scope_id !== catalogScope.scope_id ||
		source.membership_epoch < catalogScope.membership_epoch ||
		source.coordinator_id !== catalogScope.coordinator_id
	)
		throw new Error("Current scope snapshot source mismatch.");
	const members = (envelope.items as unknown[]).map((item) => requireMember(item, source));
	if (new Set(members.map((member) => member.device_id)).size !== members.length)
		throw new Error("Duplicate device in current scope snapshot.");
	// The configured cache authority can be a URL, not the server's coordinator ID.
	const scope = { ...source, coordinator_id: coordinatorId };
	const memberships = members.map((member) => ({
		...member,
		coordinator_id: coordinatorId,
		group_id: groupId,
	}));
	return { scope, memberships, sourceCoordinatorId: source.coordinator_id };
}
