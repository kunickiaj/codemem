import type {
	CoordinatorEnrollment,
	CoordinatorScope,
	CoordinatorScopeAuthorizationInput,
	CoordinatorScopeAuthorizationResult,
	CoordinatorScopeMembership,
} from "./coordinator-store-contract.js";

export const SCOPE_FIELDS = [
	"scope_id",
	"label",
	"kind",
	"authority_type",
	"coordinator_id",
	"group_id",
	"manifest_issuer_device_id",
	"membership_epoch",
	"manifest_hash",
	"status",
	"created_at",
	"updated_at",
] as const;
export const MEMBERSHIP_FIELDS = [
	"scope_id",
	"device_id",
	"role",
	"status",
	"membership_epoch",
	"coordinator_id",
	"group_id",
	"manifest_issuer_device_id",
	"manifest_hash",
	"signed_manifest_json",
	"updated_at",
] as const;
export const ENROLLMENT_FIELDS = [
	"group_id",
	"device_id",
	"public_key",
	"fingerprint",
	"identity_id",
	"display_name",
	"enabled",
	"created_at",
] as const;

const NULLABLE_FIELDS = new Set([
	"coordinator_id",
	"group_id",
	"manifest_issuer_device_id",
	"manifest_hash",
	"signed_manifest_json",
	"identity_id",
	"display_name",
]);
function text(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

export function captureScopeAuthorizationInput(
	raw: CoordinatorScopeAuthorizationInput,
): CoordinatorScopeAuthorizationInput {
	const group = Object.getOwnPropertyDescriptor(raw, "groupId");
	const scope = Object.getOwnPropertyDescriptor(raw, "scopeId");
	if (
		!group ||
		!scope ||
		!("value" in group) ||
		!("value" in scope) ||
		!text(group.value) ||
		!text(scope.value)
	)
		throw new Error("scope_authorization_unavailable");
	return { groupId: group.value, scopeId: scope.value };
}

/** Reject malformed storage instead of treating it as an empty snapshot. */
export function requireScopeAuthorizationRecord(row: unknown, fields: readonly string[]): void {
	if (!row || typeof row !== "object" || Array.isArray(row))
		throw new Error("scope_authorization_unavailable");
	const record = row as Record<string, unknown>;
	for (const field of fields) {
		if (!validField(field, record[field])) throw new Error("scope_authorization_unavailable");
	}
}

function validField(field: string, value: unknown): boolean {
	if (field === "membership_epoch" || field === "enabled")
		return Number.isSafeInteger(value) && (value as number) >= 0;
	// Key parsing decides whether string evidence is usable, including empty legacy text.
	if (field === "public_key") return typeof value === "string";
	if (field === "display_name" || field === "identity_id")
		return value === null || (typeof value === "string" && !value.includes("\0"));
	if (NULLABLE_FIELDS.has(field) && value === null) return true;
	return text(value);
}

export function scopeAuthorizationError(
	scope: CoordinatorScope,
	groupId: string,
): Extract<CoordinatorScopeAuthorizationResult, { kind: "rejected" }>["error"] | null {
	if (scope.group_id !== groupId || scope.authority_type !== "coordinator")
		return "scope_source_mismatch";
	if (scope.status !== "active") return "scope_inactive";
	return null;
}

/** Null legacy member source fields inherit the explicit scope source, never owner/issuer authority.
 * An unbound scope group cannot authorize; a null coordinator ID preserves group-bound legacy rows.
 * Neither source metadata nor roles and labels infer tenant ownership or account-session proof. */
export function isCurrentScopeMember(
	scope: CoordinatorScope,
	member: CoordinatorScopeMembership,
): boolean {
	if (
		member.scope_id !== scope.scope_id ||
		member.status !== "active" ||
		member.membership_epoch < scope.membership_epoch
	)
		return false;
	return (
		["group_id", "coordinator_id", "manifest_issuer_device_id", "manifest_hash"] as const
	).every((field) => member[field] === null || member[field] === scope[field]);
}

export interface CapturedScopeMember {
	membership: CoordinatorScopeMembership;
	enrollment: CoordinatorEnrollment;
	keyId: string;
}

export function parseScopeAuthorizationMembers(
	raw: unknown,
	captured: CapturedScopeMember[],
): CapturedScopeMember[] {
	if (typeof raw !== "string") throw new Error("scope_authorization_unavailable");
	const members: unknown = JSON.parse(raw);
	if (!Array.isArray(members)) throw new Error("scope_authorization_unavailable");
	const expected = new Set(captured.map((member) => JSON.stringify(member)));
	for (const member of members) {
		const encoded = JSON.stringify(member);
		if (!expected.delete(encoded)) throw new Error("scope_authorization_unavailable");
	}
	return (members as CapturedScopeMember[]).sort(compareMemberDeviceIds);
}

function compareMemberDeviceIds(left: CapturedScopeMember, right: CapturedScopeMember): number {
	const leftId = left.membership.device_id;
	const rightId = right.membership.device_id;
	if (leftId < rightId) return -1;
	if (leftId > rightId) return 1;
	return 0;
}

function pinned(alias: string, fields: readonly string[], path: string): string {
	return fields
		.map((field) => `${alias}.${field} IS json_extract(captured.value, '$.${path}${field}')`)
		.join(" AND ");
}

/** Final reads pin every captured DTO field and canonical revocation subject; no replacement key is promoted. */
export const READ_CURRENT_SCOPE_SQL = `SELECT s.* FROM json_each(?) captured
JOIN coordinator_scopes s ON ${pinned("s", SCOPE_FIELDS, "")}
JOIN groups g ON g.group_id = s.group_id WHERE g.archived_at IS NULL AND s.status = 'active'
AND s.authority_type = 'coordinator'`;
export const READ_CURRENT_SCOPE_MEMBERS_SQL = `SELECT captured.value FROM json_each(?) captured
JOIN coordinator_scope_memberships m ON ${pinned("m", MEMBERSHIP_FIELDS, "membership.")}
JOIN enrolled_devices e ON ${pinned("e", ENROLLMENT_FIELDS, "enrollment.")}
WHERE e.enabled = 1 AND m.status = 'active'
AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE
(r.subject_kind = 'device_id' AND r.subject_value = e.device_id) OR
(r.subject_kind = 'ed25519_key' AND r.subject_value = json_extract(captured.value, '$.keyId')))
ORDER BY m.device_id ASC`;

export const READ_SCOPE_AUTHORIZATION_SQL = `WITH current_scope AS (${READ_CURRENT_SCOPE_SQL})
SELECT current_scope.*, (SELECT json_group_array(json(value)) FROM
(${READ_CURRENT_SCOPE_MEMBERS_SQL})) AS members_json FROM current_scope`;
