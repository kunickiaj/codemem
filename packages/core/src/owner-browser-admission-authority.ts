import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { AUTH_SESSION_LIVE_GUARD_SQL } from "./coordinator-auth-session.js";
import { ownerExcludedLegacyDecisionSql } from "./coordinator-owner-enrollment-commit.js";
import type { OwnerEnrollmentResolvedOwner } from "./owner-enrollment-admission.js";
import { readOwnerLinkAuthority } from "./owner-enrollment-link-authority.js";

export const OWNER_ADMISSION_SCHEMA_READY_SQL = `EXISTS (SELECT 1 FROM pragma_table_info('coordinator_owner_enrollment_attempts')
 WHERE name = 'admission_owner_hash') AND (SELECT count(*) FROM sqlite_master
 WHERE type = 'trigger' AND tbl_name = 'coordinator_owner_enrollment_attempts'
 AND name IN ('owner_enrollment_admission_insert','owner_enrollment_admission_update')) = 2`;

export async function ownerAdmissionSchemaReady(backend: AuthLinkBackend): Promise<boolean> {
	const row = await backend.first<{ ready: number }>({
		sql: `SELECT (${OWNER_ADMISSION_SCHEMA_READY_SQL}) AS ready`,
		values: [],
	});
	return row?.ready === 1;
}

/** Uses the management session's full database-derived provenance, not a new login shortcut.
 * Alias a supplies the pending device so exclusions are identical to callback/commit.
 * Controller enrollment is historical evidence: its old device need not remain active.
 */
async function authoritySql(
	backend: AuthLinkBackend,
	time: number,
	coordinatorId: string,
	sessionCookieHash: string,
) {
	// The credential's unique session selects at most one link before any proof work.
	// This is only a work scope: the live session and all authority guards still win below.
	const scope = {
		sql: `l.coordinator_id=? AND l.link_id=(SELECT link_id FROM coordinator_auth_sessions
 WHERE coordinator_id=? AND credential_hash=?)`,
		values: [coordinatorId, coordinatorId, sessionCookieHash],
	};
	const connections = await hasConnectionSessionSchema(backend);
	const authority = await readOwnerLinkAuthority(backend, time, scope);
	return {
		values: authority.values,
		// Isolate the full session provenance from grant/exact-owner/INSERT predicates.
		// Native D1 counts nested provenance toward its expression-depth limit of 100.
		with: `${authority.with ? `${authority.with},` : "WITH"} owner_admission_proven_links AS MATERIALIZED (
 SELECT l.* FROM owner_scope_links l WHERE ${authAccountLinkProvenanceSql("l", { connections })}),
 owner_admission_links AS MATERIALIZED (
 SELECT l.* FROM owner_admission_proven_links l WHERE ${authority.link}
 ${connections ? `AND (${CONNECTION_NOT_REVOKED_SQL})` : ""}),
 owner_admission_sessions AS MATERIALIZED (
 SELECT s.coordinator_id,s.identity_id,s.link_id,s.issuer,s.subject,l.authority_kind,l.controller_attestation_id
 FROM coordinator_auth_sessions s JOIN owner_admission_links l
 ON l.coordinator_id=s.coordinator_id AND l.link_id=s.link_id AND l.identity_id=s.identity_id
 AND l.issuer=s.issuer AND l.subject=s.subject WHERE (${AUTH_SESSION_LIVE_GUARD_SQL}))`,
		from: `FROM (SELECT ? AS coordinator_id,? AS device_id,? AS fingerprint) a
 JOIN owner_admission_sessions s ON s.coordinator_id = a.coordinator_id
 WHERE EXISTS (SELECT 1 FROM coordinator_identity_group_grants r JOIN groups g ON g.group_id = r.group_id
 WHERE r.coordinator_id = s.coordinator_id AND r.identity_id = s.identity_id
 AND r.status = 'active' AND r.revoked_at IS NULL AND g.archived_at IS NULL
 AND NOT ${ownerExcludedLegacyDecisionSql("r.group_id")})`,
	};
}
function sessionValues(config: CoordinatorAuthBrowserConfig, hash: string, time: number) {
	return [config.coordinatorId, hash, config.issuer, config.revision, time, time];
}

export async function readOwnerAdmissionAuthority(input: {
	backend: AuthLinkBackend;
	config: CoordinatorAuthBrowserConfig;
	sessionCookieHash: string;
	time: number;
	deviceId: string;
	fingerprint: string;
}): Promise<OwnerEnrollmentResolvedOwner | null> {
	const { backend, config, sessionCookieHash, time, deviceId, fingerprint } = input;
	const authority = await authoritySql(backend, time, config.coordinatorId, sessionCookieHash);
	const row = await backend.first<{
		identity_id: string;
		link_id: string;
		issuer: string;
		subject: string;
	}>({
		sql: `${authority.with} SELECT s.identity_id,s.link_id,s.issuer,s.subject ${authority.from}`,
		values: [
			...authority.values,
			...sessionValues(config, sessionCookieHash, time),
			config.coordinatorId,
			deviceId,
			fingerprint,
		],
	});
	return row
		? {
				coordinatorId: config.coordinatorId,
				issuer: row.issuer,
				subject: row.subject,
				identityId: row.identity_id,
				linkId: row.link_id,
			}
		: null;
}

/** Materialized by the winning INSERT; revocation/config/grant races cannot create a new attempt. */
export async function ownerAdmissionSessionGuard(input: {
	backend: AuthLinkBackend;
	config: CoordinatorAuthBrowserConfig;
	sessionCookieHash: string;
	owner: OwnerEnrollmentResolvedOwner;
	deviceId: string;
	fingerprint: string;
	time: number;
}): Promise<AuthLinkStatement> {
	const { backend, config, sessionCookieHash, owner, deviceId, fingerprint, time } = input;
	const authority = await authoritySql(backend, time, config.coordinatorId, sessionCookieHash);
	return {
		sql: `${authority.with} SELECT 1 ${authority.from}
 AND s.link_id = ? AND s.identity_id = ? AND s.issuer = ? AND s.subject = ?`,
		values: [
			...authority.values,
			...sessionValues(config, sessionCookieHash, time),
			config.coordinatorId,
			deviceId,
			fingerprint,
			owner.linkId,
			owner.identityId,
			owner.issuer,
			owner.subject,
		],
	};
}
