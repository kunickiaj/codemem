import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import { authLinkLiveGenerationSql } from "./coordinator-auth-link-liveness.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";

const birthColumns = (alias: string) => CONNECTION_BIRTH_COLUMNS.map((col) => `${alias}.${col}`);

const endReceiptMatch = `u.coordinator_id = l.coordinator_id
 AND u.attempt_id = l.end_attempt_id AND u.target_link_id = l.link_id AND u.identity_id = l.identity_id
 AND u.issuer = l.issuer AND u.target_subject = l.subject
 AND u.state = 'completed' AND u.completed_at_ms = l.ended_at_ms`;

/** `rejoin_link_scope` supplies one trusted coordinator, Identity, issuer and subject.
 * Compose this into the winning statement. A previous SELECT is not authority.
 * Walk the base tables and consume the recursive CTE once. D1 expands each
 * reference to a CTE at prepare time, even when it is materialized.
 */
export const REJOIN_LINK_LINEAGE_CTES = `
rejoin_predecessors AS (
 SELECT ${birthColumns("l")}, t.prior_link_id, NULL AS ended_at_ms, NULL AS end_attempt_id
 FROM coordinator_auth_account_links l
 JOIN rejoin_link_scope s ON s.coordinator_id = l.coordinator_id AND s.identity_id = l.identity_id
 AND s.issuer = l.issuer AND s.subject = l.subject
 JOIN coordinator_auth_link_attempts t ON t.coordinator_id = l.coordinator_id AND t.attempt_id = l.attempt_id
 WHERE ${authLinkLiveGenerationSql({ link: "l", connections: true })}
 UNION
 SELECT ${birthColumns("h")}, t.prior_link_id, h.ended_at_ms, h.end_attempt_id
 FROM rejoin_predecessors w
 JOIN coordinator_auth_account_connection_history h ON h.coordinator_id = w.coordinator_id
 AND h.identity_id = w.identity_id AND h.link_id = w.prior_link_id
 AND h.successor_link_id = w.link_id AND h.ended_at_ms <= w.created_at_ms
 JOIN coordinator_auth_link_attempts t ON t.coordinator_id = h.coordinator_id AND t.attempt_id = h.attempt_id
), rejoin_proven_lineage AS MATERIALIZED (
 SELECT l.coordinator_id, l.identity_id, count(*) AS generation,
 max(l.link_id) FILTER (WHERE l.ended_at_ms IS NULL) AS live_link_id
 FROM rejoin_predecessors l
 WHERE ${authAccountLinkProvenanceSql("l", { connections: true })}
 AND (l.ended_at_ms IS NULL
  OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_unlinks u WHERE ${endReceiptMatch})
  OR EXISTS (SELECT 1 FROM coordinator_account_change_attempts u WHERE ${endReceiptMatch} AND u.intent = 'disconnect'))
 GROUP BY l.coordinator_id, l.identity_id
 HAVING count(*) FILTER (WHERE l.prior_link_id IS NULL) = 1
), rejoin_link_generation AS MATERIALIZED (
 SELECT l.*, p.generation
 FROM rejoin_proven_lineage p
 JOIN coordinator_auth_account_links l ON l.coordinator_id = p.coordinator_id
 AND l.identity_id = p.identity_id AND l.link_id = p.live_link_id
 WHERE p.generation = 1 + (SELECT count(*) FROM coordinator_auth_account_connection_history h
  WHERE h.coordinator_id = l.coordinator_id AND h.identity_id = l.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h
  WHERE h.coordinator_id = l.coordinator_id AND h.link_id = l.link_id)
 AND NOT EXISTS (
  SELECT 1 FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = l.coordinator_id AND t.identity_id = l.identity_id
  AND t.state IN ('finalized', 'session_redeemed')
  AND t.attempt_id <> l.attempt_id
  AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h
   WHERE h.coordinator_id = l.coordinator_id AND h.identity_id = l.identity_id AND h.attempt_id = t.attempt_id)
 )
)`;
