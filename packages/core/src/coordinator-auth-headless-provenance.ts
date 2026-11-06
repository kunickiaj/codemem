import { HEADLESS_LINK_PROVENANCE_TABLE as TABLE } from "./coordinator-auth-headless-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { AUTH_LINK_HEADLESS_MARKER_SQL } from "./coordinator-auth-link-headless.js";

export interface HeadlessLinkProvenance {
	coordinatorId: string;
	linkId: string;
	identityId: string;
	issuer: string;
	subject: string;
	attemptId: string;
	createdAtMs: number;
}
export type HeadlessLinkProvenanceQuery =
	| string
	| { identityId: string; issuer: string; subject: string };

/**
 * Selects only the link this finalize batch just wrote: the attempt must carry
 * the batch's own link ID, so an exact retry (which finalizes nothing) inserts
 * no row and cannot collide with the first one.
 */
export function headlessLinkProvenanceStatement(
	coordinatorId: string,
	attemptId: string,
	linkId: string,
): AuthLinkStatement {
	return {
		sql: `INSERT INTO ${TABLE} (coordinator_id, link_id, identity_id, issuer, subject, attempt_id, created_at_ms)
 SELECT t.coordinator_id, t.link_id, t.identity_id, t.issuer, t.account_subject, t.attempt_id, t.finalized_at_ms
 FROM coordinator_auth_link_attempts t JOIN coordinator_auth_account_links l
 ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id AND l.attempt_id = t.attempt_id
 WHERE t.coordinator_id = ? AND t.attempt_id = ? AND t.link_id = ? AND t.state = 'finalized'
 AND t.loopback_redirect = ${AUTH_LINK_HEADLESS_MARKER_SQL}`,
		values: [coordinatorId, attemptId, linkId],
	};
}

interface Row {
	coordinator_id: string;
	link_id: string;
	identity_id: string;
	issuer: string;
	subject: string;
	attempt_id: string;
	created_at_ms: number;
}

function lookup(coordinatorId: string, query: HeadlessLinkProvenanceQuery): AuthLinkStatement {
	const select = `SELECT * FROM ${TABLE} WHERE coordinator_id = ?`;
	if (typeof query === "string")
		return { sql: `${select} AND link_id = ?`, values: [coordinatorId, query] };
	return {
		sql: `${select} AND issuer = ? AND subject = ? AND identity_id = ?
 ORDER BY created_at_ms DESC, link_id DESC LIMIT 1`,
		values: [coordinatorId, query.issuer, query.subject, query.identityId],
	};
}

/**
 * Provenance for one link ID, or the most recent headless link of an account
 * to an Identity. Callers must first confirm the table exists (see
 * readHeadlessLinkBackend); a missing table throws.
 */
export async function readHeadlessLinkProvenance(
	backend: Pick<AuthLinkBackend, "first">,
	coordinatorId: string,
	query: HeadlessLinkProvenanceQuery,
): Promise<HeadlessLinkProvenance | null> {
	const row = await backend.first<Row>(lookup(coordinatorId, query));
	if (!row) return null;
	return {
		coordinatorId: row.coordinator_id,
		linkId: row.link_id,
		identityId: row.identity_id,
		issuer: row.issuer,
		subject: row.subject,
		attemptId: row.attempt_id,
		createdAtMs: row.created_at_ms,
	};
}
