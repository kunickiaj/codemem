import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";

const history = "coordinator_auth_account_connection_history";
const current = "coordinator_auth_account_links";
const audit = "coordinator_auth_link_audit_log";
const auditColumns =
	"coordinator_id,link_id,action,attempt_id,identity_id,group_id,device_id,fingerprint,controller_attestation_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id";
const birthMatch = `a.coordinator_id=l.coordinator_id AND a.link_id=l.link_id AND a.action='link_created'
 AND (a.attempt_id=l.attempt_id AND a.identity_id=l.identity_id AND a.controller_attestation_id IS l.controller_attestation_id)
 AND (a.authority_kind=l.authority_kind AND a.device_claim_id IS l.device_claim_id AND a.auth_config_revision=l.auth_config_revision AND a.created_at_ms=l.created_at_ms)`;
const receiptMatch = `r.coordinator_id=l.coordinator_id AND r.link_id=l.link_id AND r.action='link_revoked'
 AND (r.attempt_id=a.attempt_id AND r.identity_id=a.identity_id AND r.group_id=a.group_id AND r.device_id=a.device_id AND r.fingerprint=a.fingerprint)
 AND (r.controller_attestation_id IS a.controller_attestation_id AND r.authority_kind=a.authority_kind AND r.device_claim_id IS a.device_claim_id AND r.auth_config_revision=a.auth_config_revision AND r.created_at_ms=l.revoked_at_ms)`;
function context(): string {
	return `WITH requested AS MATERIALIZED (SELECT l.* FROM ${history} l WHERE (l.coordinator_id=? AND l.link_id=?) AND (${authAccountLinkProvenanceSql("l", { connections: true })})),
 current_targets AS MATERIALIZED (SELECT l.* FROM ${current} l JOIN requested h ON h.coordinator_id=l.coordinator_id AND h.identity_id=l.identity_id),
 valid_current AS MATERIALIZED (SELECT l.coordinator_id,l.link_id FROM current_targets l WHERE ${authAccountLinkProvenanceSql("l", { connections: true })})`;
}
/** Audit proof is historical equality, not liveness: it remains valid after flags change. */
export function historicalRevocationReadSql(): string {
	const columns = CONNECTION_BIRTH_COLUMNS.join(",");
	return `/* historical_revocation_complete */ ${context()},
 auditable_links AS MATERIALIZED (SELECT ${columns} FROM requested UNION ALL SELECT ${CONNECTION_BIRTH_COLUMNS.map((c) => `l.${c}`).join(",")} FROM current_targets l JOIN valid_current v ON v.coordinator_id=l.coordinator_id AND v.link_id=l.link_id),
 receipts AS MATERIALIZED (SELECT l.coordinator_id,l.link_id FROM auditable_links l JOIN ${audit} a ON ${birthMatch} JOIN ${audit} r ON ${receiptMatch} WHERE l.revoked_at_ms IS NOT NULL)
 SELECT 1 AS revoked FROM requested h WHERE h.revoked_at_ms IS NOT NULL
 AND EXISTS (SELECT 1 FROM receipts r WHERE r.coordinator_id=h.coordinator_id AND r.link_id=h.link_id)
 AND NOT EXISTS (SELECT 1 FROM current_targets c LEFT JOIN receipts r ON r.coordinator_id=c.coordinator_id AND r.link_id=c.link_id WHERE c.revoked_at_ms IS NULL OR r.link_id IS NULL)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_sessions s WHERE s.coordinator_id=h.coordinator_id AND s.identity_id=h.identity_id AND s.revoked_at_ms IS NULL)`;
}
function insertAudit(source: "requested" | "current_targets"): string {
	return `${context()} INSERT INTO ${audit} (${auditColumns})
 SELECT l.coordinator_id,l.link_id,'link_revoked',a.attempt_id,a.identity_id,a.group_id,a.device_id,a.fingerprint,a.controller_attestation_id,a.auth_config_revision,l.revoked_at_ms,l.authority_kind,l.device_claim_id
 FROM ${source} l ${source === "current_targets" ? "JOIN valid_current v ON v.coordinator_id=l.coordinator_id AND v.link_id=l.link_id" : ""} JOIN ${audit} a ON ${birthMatch} WHERE l.revoked_at_ms IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM ${audit} r WHERE r.coordinator_id=l.coordinator_id AND r.link_id=l.link_id AND r.action='link_revoked')`;
}
/** Derive every replacement from the retained requested Identity inside this one
 * writer transaction; a separately read current-link ID must never drive these effects. */
export function historicalRevocationStatements(
	coordinator: string,
	link: string,
	now: number,
): AuthLinkStatement[] {
	const values = [coordinator, link];
	return [
		{
			sql: `${context()} UPDATE ${history} AS l SET revoked_at_ms=? WHERE l.revoked_at_ms IS NULL AND EXISTS (SELECT 1 FROM requested h WHERE h.coordinator_id=l.coordinator_id AND h.link_id=l.link_id)`,
			values: [...values, now],
		},
		{ sql: insertAudit("requested"), values },
		{
			sql: `${context()} UPDATE ${current} AS l SET revoked_at_ms=(SELECT revoked_at_ms FROM requested) WHERE l.revoked_at_ms IS NULL AND EXISTS (SELECT 1 FROM valid_current v WHERE v.coordinator_id=l.coordinator_id AND v.link_id=l.link_id)`,
			values,
		},
		{ sql: insertAudit("current_targets"), values },
		{
			sql: `${context()} UPDATE coordinator_auth_sessions SET revoked_at_ms=(SELECT revoked_at_ms FROM requested) WHERE revoked_at_ms IS NULL AND coordinator_id=? AND identity_id=(SELECT identity_id FROM requested)`,
			values: [...values, coordinator],
		},
		// A standalone invalid insert fails even when a trigger ignored a required effect.
		{
			sql: `INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE NOT EXISTS (${historicalRevocationReadSql()})`,
			values,
		},
	];
}
