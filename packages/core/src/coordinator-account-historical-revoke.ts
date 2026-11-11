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
// The requested row's Identity. The last two checks need no provenance of their own: the
// first check refuses a requested row without it, and the three only ever hold together.
const requestedIdentity = `SELECT identity_id FROM ${history} WHERE coordinator_id=? AND link_id=?`;
// Aliases l: the provenance expression names its row l.
const receiptOf = `EXISTS (SELECT 1 FROM ${audit} a JOIN ${audit} r ON ${receiptMatch} WHERE ${birthMatch})`;
const provenOf = `(${authAccountLinkProvenanceSql("l", { connections: true })})`;

/**
 * Audit proof is historical equality, not liveness: it remains valid after flags change.
 * The revocation is complete when all three checks hold. Each is a plain statement with
 * its own small nesting, where the old single statement nested them all through WITH
 * stages, past production D1's limit. Every check binds the coordinator and link once
 * per use of the requested row, in order.
 */
export function historicalRevocationChecks(coordinator: string, link: string): AuthLinkStatement[] {
	// The marker names each check of the completion read, as it named the old statement.
	const marked = (statement: AuthLinkStatement) => ({
		...statement,
		sql: `/* historical_revocation_complete */ ${statement.sql}`,
	});
	return [
		// The requested row itself is revoked with its receipt.
		{
			sql: `SELECT EXISTS (SELECT 1 FROM ${history} l WHERE l.coordinator_id=? AND l.link_id=?
 AND ${provenOf} AND l.revoked_at_ms IS NOT NULL AND ${receiptOf}) AS ok`,
			values: [coordinator, link],
		},
		// Every current link of its Identity is revoked, valid, and has its receipt: as many
		// links qualify as there are. A count keeps the deep provenance expression out of a
		// negated subquery, within production D1's expression depth.
		{
			sql: `SELECT (SELECT count(*) FROM ${current} l WHERE l.coordinator_id=?
 AND l.identity_id IN (${requestedIdentity}))
 = (SELECT count(*) FROM ${current} l WHERE l.coordinator_id=? AND l.identity_id IN (${requestedIdentity})
 AND l.revoked_at_ms IS NOT NULL AND ${provenOf} AND ${receiptOf}) AS ok`,
			values: [coordinator, coordinator, link, coordinator, coordinator, link],
		},
		// No session of that Identity is live.
		{
			sql: `SELECT NOT EXISTS (SELECT 1 FROM coordinator_auth_sessions s WHERE s.coordinator_id=?
 AND s.revoked_at_ms IS NULL AND s.identity_id IN (${requestedIdentity})) AS ok`,
			values: [coordinator, coordinator, link],
		},
	].map(marked);
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
		// A standalone invalid insert fails even when a trigger ignored a required effect,
		// once for each check of a complete revocation.
		...historicalRevocationChecks(coordinator, link).map((check) => ({
			sql: `INSERT INTO coordinator_auth_account_connection_orders (coordinator_id,last_order) SELECT NULL,0 WHERE NOT (SELECT ok FROM (${check.sql}))`,
			values: check.values,
		})),
	];
}
