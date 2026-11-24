import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import { authLinkLiveGenerationSql } from "./coordinator-auth-link-liveness.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";

const birthColumns = (alias: string) => CONNECTION_BIRTH_COLUMNS.map((col) => `${alias}.${col}`);

/** `rejoin_link_scope` supplies one trusted coordinator, Identity, issuer and subject.
 * Compose this into the winning statement. A previous SELECT is not authority.
 */
export const REJOIN_LINK_LINEAGE_CTES = `
rejoin_live_link AS MATERIALIZED (
 SELECT l.* FROM coordinator_auth_account_links l
 JOIN rejoin_link_scope s ON s.coordinator_id = l.coordinator_id AND s.identity_id = l.identity_id
 AND s.issuer = l.issuer AND s.subject = l.subject
 WHERE ${authLinkLiveGenerationSql({ link: "l", connections: true })}
), rejoin_ended_links AS MATERIALIZED (
 SELECT h.* FROM coordinator_auth_account_connection_history h
 JOIN rejoin_live_link l ON l.coordinator_id = h.coordinator_id AND l.identity_id = h.identity_id
), rejoin_link_births AS MATERIALIZED (
 SELECT ${birthColumns("l")}, NULL AS successor_link_id, NULL AS ended_at_ms FROM rejoin_live_link l
 UNION ALL
 SELECT ${birthColumns("h")}, h.successor_link_id, h.ended_at_ms FROM rejoin_ended_links h
), rejoin_proven_births AS MATERIALIZED (
 SELECT l.*, t.prior_link_id FROM rejoin_link_births l
 JOIN coordinator_auth_link_attempts t ON t.coordinator_id = l.coordinator_id AND t.attempt_id = l.attempt_id
 WHERE ${authAccountLinkProvenanceSql("l", { connections: true })}
), rejoin_proven_ends AS MATERIALIZED (
 SELECT h.link_id FROM rejoin_ended_links h
 JOIN coordinator_auth_account_connection_unlinks u ON u.coordinator_id = h.coordinator_id
 AND u.attempt_id = h.end_attempt_id AND u.target_link_id = h.link_id AND u.identity_id = h.identity_id
 AND u.issuer = h.issuer AND u.target_subject = h.subject
 WHERE u.state = 'completed' AND u.completed_at_ms = h.ended_at_ms
 UNION
 SELECT h.link_id FROM rejoin_ended_links h
 JOIN coordinator_account_change_attempts u ON u.coordinator_id = h.coordinator_id
 AND u.attempt_id = h.end_attempt_id AND u.target_link_id = h.link_id AND u.identity_id = h.identity_id
 AND u.issuer = h.issuer AND u.target_subject = h.subject
 WHERE u.state = 'completed' AND u.completed_at_ms = h.ended_at_ms AND u.intent = 'disconnect'
), rejoin_predecessors(link_id) AS (
 SELECT b.link_id FROM rejoin_live_link l JOIN rejoin_proven_births b
 ON b.link_id = l.link_id AND b.ended_at_ms IS NULL
 UNION
 SELECT p.link_id FROM rejoin_predecessors walk
 JOIN rejoin_proven_births b ON b.link_id = walk.link_id
 JOIN rejoin_proven_births p ON p.link_id = b.prior_link_id
 AND p.successor_link_id = b.link_id AND p.ended_at_ms <= b.created_at_ms
 JOIN rejoin_proven_ends e ON e.link_id = p.link_id
), rejoin_link_generation AS MATERIALIZED (
 SELECT l.*, (SELECT count(*) FROM rejoin_predecessors) AS generation
 FROM rejoin_live_link l
 WHERE (SELECT count(*) FROM rejoin_predecessors) = 1 + (SELECT count(*) FROM rejoin_ended_links)
 AND EXISTS (SELECT 1 FROM rejoin_proven_births WHERE prior_link_id IS NULL)
 AND NOT EXISTS (
  SELECT 1 FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = l.coordinator_id AND t.identity_id = l.identity_id
  AND t.state IN ('finalized', 'session_redeemed')
  AND NOT EXISTS (SELECT 1 FROM rejoin_proven_births b WHERE b.attempt_id = t.attempt_id)
 )
)`;
