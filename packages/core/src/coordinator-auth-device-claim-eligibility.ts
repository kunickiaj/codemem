import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { captureAuthLinkConfig, captureAuthLinkSigner } from "./coordinator-auth-link-input.js";
import {
	ed25519KeyIdForRevocation,
	parseSshEd25519PublicKeyForRevocation,
} from "./coordinator-ed25519-key-id-compat.js";

export interface CoordinatorDeviceClaimReadinessInput {
	/** The authenticated enrollment and the caller's pinned current local Identity. */
	signer: CoordinatorAuthLinkSigner;
	identityId: string;
	/** Internal retry context, never an instruction to ignore a different claimant. */
	attemptId?: string;
}
export type CoordinatorDeviceClaimReadiness =
	| { kind: "eligible"; authority: "device_claim"; identityId: string }
	| { kind: "unavailable" };

// These older tables have text keys, not canonical key-ID columns. Classify their
// actual key bytes once, then reject any newly introduced text key in the final
// SQL statement. Other row/Identity changes are checked live by the predicate.
const CURRENT_KEYS = `SELECT public_key FROM enrolled_devices
 UNION SELECT public_key FROM coordinator_auth_controller_attestations
 UNION SELECT public_key FROM coordinator_auth_link_attempts
 UNION SELECT bound_public_key AS public_key FROM coordinator_invites`;
const KEY_SNAPSHOT_SQL = `SELECT json_group_array(public_key) AS keys FROM (
 SELECT public_key FROM (${CURRENT_KEYS}) WHERE typeof(public_key) = 'text' ORDER BY public_key)`;

/** Shared by readiness and future INSERT/transition guards; 14 inputs bound once. */
export const AUTH_DEVICE_CLAIM_INPUT_SQL = `WITH claim_input(
 coordinator_id, identity_id, group_id, device_id, public_key, fingerprint, key_id,
 now_ms, now_iso, attempt_id, issuer, revision, key_snapshot, same_keys
) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)),
 claim_known_keys AS (SELECT value FROM claim_input p, json_each(p.key_snapshot)),
 claim_same_keys AS (SELECT value FROM claim_input p, json_each(p.same_keys))`;

const sameKey = (column: string) =>
	`EXISTS (SELECT 1 FROM claim_same_keys k WHERE k.value = ${column})`;
const otherSubject = (device: string, key: string) =>
	`(${device} IS NOT p.device_id OR NOT ${sameKey(key)})`;
const live = (alias: string) =>
	`${alias}.state IN ('pending','browser_claimed','oidc_verified','confirmed') AND ${alias}.expires_at_ms > p.now_ms`;
// Pending promises expire. Consumed evidence survives later expiry/revocation,
// but an invite revoked before consumption supplies no footprint.
const inviteLive = `(i.revoked_at IS NULL AND i.expires_at > p.now_iso)`;
const inviteConsumed = `(i.consumed_at IS NOT NULL AND i.consumed_at <> '' AND (i.revoked_at IS NULL OR i.revoked_at > i.consumed_at))`;
const inviteBinding = `(i.bound_device_id IS NOT NULL OR i.bound_public_key IS NOT NULL)`;
const completionJson = `CASE WHEN typeof(c.manifest_json) = 'text' AND json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END`;

/**
 * p is the single claim_input row. This is device-claim eligibility, never operator
 * authority. No group-wide member scan may turn unrelated people into a denial.
 * All NULL comparisons below deliberately reject mismatched/absent binding pins.
 */
export const AUTH_DEVICE_CLAIM_ELIGIBLE_SQL = `
 EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
 WHERE e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key
 AND e.fingerprint = p.fingerprint AND e.enabled = 1 AND g.archived_at IS NULL
 AND (e.identity_id IS NULL OR e.identity_id = p.identity_id))
 AND NOT EXISTS (SELECT public_key FROM (${CURRENT_KEYS}) WHERE typeof(public_key) = 'text'
 EXCEPT SELECT value FROM claim_known_keys)
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id)
 OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id))
 AND NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE
 ((e.device_id = p.device_id OR ${sameKey("e.public_key")}) AND e.identity_id IS NOT NULL AND e.identity_id <> p.identity_id)
 OR (e.identity_id = p.identity_id AND ${otherSubject("e.device_id", "e.public_key")}))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations a WHERE a.coordinator_id = p.coordinator_id AND (
 ((a.device_id = p.device_id OR ${sameKey("a.public_key")}) AND (a.revoked_at IS NOT NULL OR a.identity_id <> p.identity_id))
 OR ((a.identity_id = p.identity_id OR a.enrollment_identity_id = p.identity_id) AND ${otherSubject("a.device_id", "a.public_key")})
 OR (a.group_id = p.group_id AND a.device_id = p.device_id AND a.public_key = p.public_key
 AND a.fingerprint = p.fingerprint AND a.identity_id = p.identity_id AND a.revoked_at IS NULL AND a.revision = 1)))
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b WHERE
 ((b.device_id = p.device_id OR b.key_id = p.key_id) AND b.identity_id <> p.identity_id)
 OR (b.identity_id = p.identity_id AND (b.device_id IS NOT p.device_id OR b.key_id IS NOT p.key_id)))
 AND NOT EXISTS (SELECT 1 FROM coordinator_identity_group_grants g
 WHERE g.coordinator_id = p.coordinator_id AND g.identity_id = p.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_device_claims d WHERE d.coordinator_id = p.coordinator_id
 AND (d.identity_id = p.identity_id OR d.device_id = p.device_id OR d.key_id = p.key_id))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = p.coordinator_id AND l.identity_id = p.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_attempts a
 ON a.coordinator_id = l.coordinator_id AND a.link_id = l.link_id
 WHERE l.coordinator_id = p.coordinator_id AND l.identity_id <> p.identity_id
 AND (a.device_id = p.device_id OR ${sameKey("a.public_key")}))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_audit_log a
 ON a.coordinator_id = l.coordinator_id AND a.link_id = l.link_id
 WHERE l.coordinator_id = p.coordinator_id AND a.device_id = p.device_id AND l.identity_id <> p.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts o WHERE o.coordinator_id = p.coordinator_id
 AND ${live("o")} AND (o.device_id = p.device_id OR o.key_id = p.key_id OR o.identity_id = p.identity_id))
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts a WHERE a.coordinator_id = p.coordinator_id AND ${live("a")}
 AND NOT (a.attempt_id IS p.attempt_id AND a.authority_kind = 'device_claim' AND a.identity_id = p.identity_id
 AND a.group_id = p.group_id AND a.device_id = p.device_id AND a.public_key = p.public_key AND a.fingerprint = p.fingerprint)
 AND ((a.authority_kind = 'device_claim' AND a.identity_id <> p.identity_id AND (a.device_id = p.device_id OR ${sameKey("a.public_key")}))
 OR (a.identity_id = p.identity_id AND ${otherSubject("a.device_id", "a.public_key")})))
 AND NOT EXISTS (SELECT 1 FROM coordinator_invites i WHERE (
  (${inviteConsumed} AND (i.bound_device_id = p.device_id OR ${sameKey("i.bound_public_key")} OR i.bound_fingerprint = p.fingerprint)
 AND ((i.assigned_identity_id IS NOT NULL AND i.assigned_identity_id <> p.identity_id) OR (i.target_identity_id IS NOT NULL AND i.target_identity_id <> p.identity_id)))
 OR ((${inviteLive} OR ${inviteConsumed}) AND (
 ((i.assigned_identity_id = p.identity_id OR i.target_identity_id = p.identity_id)
 AND ((${inviteLive} AND (i.consumed_at IS NULL OR i.consumed_at = '')) OR (${inviteBinding} AND ${otherSubject("i.bound_device_id", "i.bound_public_key")})))
 OR (i.recipient_actor_id = p.identity_id AND ${inviteBinding} AND ${otherSubject("i.bound_device_id", "i.bound_public_key")})
 OR (i.inviter_actor_id = p.identity_id AND i.inviter_device_id IS NOT NULL AND i.inviter_device_id <> p.device_id)))))
 AND NOT EXISTS (SELECT 1 FROM coordinator_legacy_team_completions c, json_each(${completionJson}, '$.device_decisions') d
 WHERE json_extract(${completionJson}, '$.coordinator_id') = p.coordinator_id AND (
 ((json_extract(d.value, '$.device_id') = p.device_id OR json_extract(d.value, '$.key_fingerprint') = p.fingerprint)
 AND (json_extract(d.value, '$.decision') = 'excluded' OR json_extract(d.value, '$.identity_id') IS NOT p.identity_id))
 OR (json_extract(d.value, '$.identity_id') = p.identity_id
 AND (json_extract(d.value, '$.device_id') IS NOT p.device_id OR json_extract(d.value, '$.key_fingerprint') IS NOT p.fingerprint))))`;

function captureInput(input: CoordinatorDeviceClaimReadinessInput) {
	try {
		if (!input || typeof input !== "object" || Array.isArray(input)) return null;
		const identity = Object.getOwnPropertyDescriptor(input, "identityId");
		const signer = Object.getOwnPropertyDescriptor(input, "signer");
		const attempt = Object.getOwnPropertyDescriptor(input, "attemptId");
		const s = signer && "value" in signer ? captureAuthLinkSigner(signer.value) : null;
		if (!identity || !("value" in identity) || !isAuthControllerId(identity.value) || !s)
			return null;
		if (attempt && (!("value" in attempt) || !isAuthControllerId(attempt.value))) return null;
		if (!attempt && "attemptId" in input) return null;
		return { signer: s, identityId: identity.value, attemptId: attempt?.value ?? null };
	} catch {
		return null;
	}
}

/** Capture only server-derived key metadata; a later writer must include the SQL guard. */
export async function captureDeviceClaimEligibility(
	backend: Pick<AuthLinkBackend, "first">,
	input: CoordinatorDeviceClaimReadinessInput,
	config: CoordinatorAuthLinkConfig,
	now: number,
): Promise<{ identityId: string; values: AuthLinkStatement["values"] } | null> {
	const c = captureAuthLinkConfig(config);
	const i = captureInput(input);
	if (!c?.enabled || !i) return null;
	const target = parseSshEd25519PublicKeyForRevocation(i.signer.publicKey);
	if (target.kind !== "ed25519") return null;
	const keyId = await ed25519KeyIdForRevocation(i.signer.publicKey);
	if (!keyId) return null;
	const row = await backend.first<{ keys: string }>({ sql: KEY_SNAPSHOT_SQL, values: [] });
	const keys: unknown = JSON.parse(row?.keys ?? "null");
	if (!Array.isArray(keys) || !keys.every((key): key is string => typeof key === "string"))
		throw new Error("auth_device_claim_unavailable");
	const aliases = keys.filter((key) => {
		const parsed = parseSshEd25519PublicKeyForRevocation(key);
		return (
			parsed.kind === "ed25519" && parsed.blob.every((byte, index) => byte === target.blob[index])
		);
	});
	return {
		identityId: i.identityId,
		values: [
			c.coordinatorId,
			i.identityId,
			i.signer.groupId,
			i.signer.deviceId,
			i.signer.publicKey,
			i.signer.fingerprint,
			keyId,
			now,
			new Date(now).toISOString(),
			i.attemptId,
			c.issuer,
			c.revision,
			JSON.stringify(keys),
			JSON.stringify(aliases),
		],
	};
}
