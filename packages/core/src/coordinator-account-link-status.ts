import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	type CoordinatorDeviceClaimReadiness,
	type CoordinatorDeviceClaimReadinessInput,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import { AUTH_CURRENT_LEGACY_ASSIGNMENT_SQL } from "./coordinator-auth-legacy-assignment.js";
import {
	AUTH_LINK_AUTHORITY_COLUMNS,
	AUTH_LINK_CONTROLLER_SOURCE_SQL,
	type AuthLinkBackend,
	authLinkControllerSourceValues,
	authLinkNow,
	captureAuthLinkConfig,
	captureAuthLinkSigner,
} from "./coordinator-auth-link.js";
import type { CoordinatorAccountLinkStatusV2 } from "./coordinator-auth-link-authority.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { authPersistenceError } from "./coordinator-auth-schema.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

/** Public device-authenticated response. No account identifiers or credentials. */
export type CoordinatorAccountLinkStatus = CoordinatorAccountLinkStatusV2;
export interface CoordinatorAccountLinkStatusStore {
	readAccountLinkStatus(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
		options: { identityId: string },
	): Promise<CoordinatorAccountLinkStatus>;
}
interface StatusRow {
	identity_id: string;
	link_id: string | null;
	issuer: string | null;
	revoked_at_ms: number | null;
	display_name: unknown;
	email: unknown;
	email_verified: unknown;
	authority: "device_claim" | "controller_attestation";
	valid: number;
	claim_count: number;
	controller_count: number;
	controller_identity: string | null;
}

function safeDisplayText(value: unknown, maxLength: number): string | undefined {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maxLength ||
		value.trim().length === 0 ||
		/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	)
		return undefined;
	return value;
}

function claimConflicts(row: StatusRow): boolean {
	return (
		row.claim_count > 0 &&
		(row.claim_count !== 1 ||
			row.valid !== 1 ||
			row.controller_count > 1 ||
			(row.controller_identity !== null && row.controller_identity !== row.identity_id))
	);
}

function projectStatus(
	base: Extract<CoordinatorAccountLinkStatus, { state: "review_required" | "conflict" }>,
	row: StatusRow | null,
	config: CoordinatorAuthLinkConfig,
	identityId: string,
): CoordinatorAccountLinkStatus {
	if (!row) return base;
	if (claimConflicts(row))
		return { ...base, state: "conflict", identityId: null, authority: null, account: null };
	if (row.valid !== 1 || row.controller_count > 1) return base;
	const derived = { ...base, identityId: row.identity_id, authority: row.authority };
	if (row.link_id === null) {
		if (row.identity_id !== identityId) return base;
		return { ...derived, state: "unlinked", account: null };
	}
	if (row.revoked_at_ms !== null) return { ...derived, state: "revoked", account: null };
	if (row.issuer !== config.issuer) return { ...base, state: "conflict" };
	if (row.identity_id !== identityId) return { ...derived, state: "linked", account: null };
	const account: NonNullable<CoordinatorAccountLinkStatus["account"]> = {};
	const displayName = safeDisplayText(row.display_name, 256);
	const email = row.email_verified === 1 ? safeDisplayText(row.email, 320) : undefined;
	if (displayName !== undefined) account.displayName = displayName;
	if (email !== undefined) account.email = email;
	return { ...derived, state: "linked", account };
}

/** Reads only. Rechecks the exact enrollment and controller after key derivation. */
export class AccountLinkStatusOperations implements CoordinatorAccountLinkStatusStore {
	constructor(
		private readonly backend: Pick<AuthLinkBackend, "first">,
		private readonly clock: () => number = Date.now,
	) {}

	/** Internal store capability only. It does not reserve a claim or expose account data. */
	async readAuthDeviceClaimReadiness(
		input: CoordinatorDeviceClaimReadinessInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorDeviceClaimReadiness> {
		const c = captureAuthLinkConfig(config);
		if (!c?.enabled) return { kind: "unavailable" };
		try {
			const captured = await captureDeviceClaimEligibility(
				this.backend,
				input,
				c,
				authLinkNow(this.clock),
			);
			if (!captured) return { kind: "unavailable" };
			const row = await this.backend.first<{ eligible: number }>({
				sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT CASE WHEN ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL} THEN 1 ELSE 0 END AS eligible FROM claim_input p`,
				values: captured.values,
			});
			if (row?.eligible !== 1) return { kind: "unavailable" };
			return { kind: "eligible", authority: "device_claim", identityId: captured.identityId };
		} catch (error) {
			throw authPersistenceError(error, "auth_device_claim_unavailable");
		}
	}

	async readAccountLinkStatus(
		signer: CoordinatorAuthLinkSigner,
		config: CoordinatorAuthLinkConfig,
		options: { identityId: string },
	): Promise<CoordinatorAccountLinkStatus> {
		const c = captureAuthLinkConfig(config);
		const s = captureAuthLinkSigner(signer);
		if (!c?.enabled || !s || !isAuthControllerId(options?.identityId))
			throw new Error("account_link_status_unavailable");
		const base: CoordinatorAccountLinkStatus = {
			version: 2,
			coordinatorId: c.coordinatorId,
			groupId: s.groupId,
			deviceId: s.deviceId,
			fingerprint: s.fingerprint,
			identityId: null,
			authority: null,
			state: "review_required",
			account: null,
		};
		try {
			const identityId = options.identityId;
			const keyId = await ed25519KeyIdForRevocation(s.publicKey);
			if (!keyId) return base;
			const captured = await captureDeviceClaimEligibility(
				this.backend,
				{ signer: s, identityId },
				c,
				authLinkNow(this.clock),
			);
			if (!captured) return base;
			// Authority, current enrollment, tombstones and metadata share one snapshot.
			const row = await this.backend.first<StatusRow>({
				sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL}, controller AS (
 SELECT ${AUTH_LINK_AUTHORITY_COLUMNS} ${AUTH_LINK_CONTROLLER_SOURCE_SQL}
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = a.device_id)
 OR (r.subject_kind = 'ed25519_key' AND r.subject_value = ?))),
  status_assignment AS MATERIALIZED (SELECT 1 FROM claim_input p
   WHERE ${AUTH_CURRENT_LEGACY_ASSIGNMENT_SQL} AND ${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL}
   AND ${AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL}
   AND ${AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL}),
  claims AS MATERIALIZED (SELECT d.identity_id, l.link_id, l.issuer, l.revoked_at_ms,
 CASE WHEN l.identity_id = d.identity_id
 AND EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
 WHERE e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key
 AND e.fingerprint = p.fingerprint AND e.enabled = 1 AND g.archived_at IS NULL
 AND (e.identity_id IS NULL OR e.identity_id = d.identity_id))
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id)
 OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id))
 AND ((d.group_id = p.group_id AND d.device_id = p.device_id
 AND d.key_id = p.key_id AND d.fingerprint = p.fingerprint
 AND ${authDeviceClaimProvenanceSql({ link: "l", canonicalKeyId: "?" })})
 OR (d.identity_id = p.identity_id AND d.device_id <> p.device_id
 AND d.key_id <> p.key_id AND d.fingerprint <> p.fingerprint
 AND EXISTS (SELECT 1 FROM status_assignment)
 AND ${authDeviceClaimProvenanceSql({ link: "l" })}))
 THEN 1 ELSE 0 END AS valid
 FROM claim_input p JOIN coordinator_auth_device_claims d ON d.coordinator_id = p.coordinator_id
 LEFT JOIN coordinator_auth_account_links l ON l.coordinator_id = d.coordinator_id AND l.device_claim_id = d.claim_id
 WHERE d.device_id = p.device_id OR d.key_id = p.key_id
 OR (d.identity_id = p.identity_id AND EXISTS (SELECT 1 FROM status_assignment))),
 candidates AS (
 SELECT *, 'device_claim' AS authority FROM claims
 UNION ALL SELECT a.controller_identity_id, l.link_id, l.issuer, l.revoked_at_ms, 1, 'controller_attestation'
 FROM controller a LEFT JOIN coordinator_auth_account_links l ON l.coordinator_id = ?
 AND l.identity_id = a.controller_identity_id AND l.authority_kind = 'controller_attestation'
 AND l.controller_attestation_id IS NOT NULL AND l.device_claim_id IS NULL
 WHERE NOT EXISTS (SELECT 1 FROM claims)
 UNION ALL SELECT p.identity_id, NULL, NULL, NULL, 1, 'device_claim' FROM claim_input p
 WHERE NOT EXISTS (SELECT 1 FROM claims) AND NOT EXISTS (SELECT 1 FROM controller)
 AND ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL})
 SELECT a.*, (SELECT count(*) FROM claims) AS claim_count,
 (SELECT count(*) FROM controller) AS controller_count,
 (SELECT controller_identity_id FROM controller LIMIT 1) AS controller_identity,
 m.display_name, m.email, m.email_verified FROM candidates a
 LEFT JOIN coordinator_auth_account_profiles m ON m.coordinator_id = ? AND m.link_id = a.link_id
 AND a.identity_id = ? LIMIT 1`,
				values: [
					...captured.values,
					...authLinkControllerSourceValues(c, s),
					keyId,
					keyId,
					c.coordinatorId,
					c.coordinatorId,
					identityId,
				],
			});
			return projectStatus(base, row, c, identityId);
		} catch (error) {
			throw authPersistenceError(error, "account_link_status_unavailable");
		}
	}
}
