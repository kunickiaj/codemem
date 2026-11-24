import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { REJOIN_LINK_LINEAGE_CTES } from "./coordinator-device-rejoin-link-lineage.js";
import { QUALIFICATION_READY } from "./coordinator-owner-enrollment-qualification.js";
import { QUALIFIED_CLAIM_LINK_MATCH_SQL } from "./owner-enrollment-link-authority.js";

export interface DeviceRejoinLinkEvidence {
	link_id: string;
	link_authority_kind: "controller_attestation" | "qualified_device_claim" | "device_claim";
	link_generation: number;
}

type QualificationStorage = "qualified" | "unqualified";

/** `rejoin_link_clock` supplies the trusted clock for qualification.
 * Consumers must require the complete connection schema before composing these CTEs.
 */
export function rejoinLinkEvidenceCtes(storage: QualificationStorage) {
	const kind =
		storage === "qualified"
			? `CASE WHEN EXISTS (SELECT 1 ${QUALIFIED_CLAIM_LINK_MATCH_SQL}
 AND q.created_at_ms <= (SELECT now_ms FROM rejoin_link_clock))
 THEN 'qualified_device_claim' ELSE l.authority_kind END`
			: "l.authority_kind";
	return `${REJOIN_LINK_LINEAGE_CTES},
rejoin_link_evidence AS MATERIALIZED (
 SELECT l.coordinator_id, l.identity_id, l.link_id, l.generation AS link_generation,
 ${kind} AS link_authority_kind
 FROM rejoin_link_generation l
)`;
}

/** SQLite installations may omit qualification storage. Partial storage cannot
 * silently change the meaning of a previously pinned qualified claim.
 */
export async function readDeviceRejoinLinkStorage(
	backend: Pick<AuthLinkBackend, "first" | "readAuthSchemaState">,
): Promise<QualificationStorage | null> {
	if (!(await hasConnectionSessionSchema(backend))) return null;
	const row = await backend.first<{ present: number; ready: number }>({
		sql: `SELECT EXISTS (SELECT 1 FROM sqlite_master
 WHERE tbl_name = 'coordinator_owner_enrollment_qualifications' COLLATE NOCASE) AS present,
 (${QUALIFICATION_READY}) AS ready`,
		values: [],
	});
	if (row?.ready === 1) return "qualified";
	if (row?.present === 0) return "unqualified";
	return null;
}

/** Join the winning attempt `a` directly to `rejoin_link_evidence l` in the write.
 * Nesting the lineage in an EXISTS exceeds D1's expression depth limit.
 */
export const REJOIN_LINK_PIN_MATCH_SQL = `l.coordinator_id = a.coordinator_id AND l.identity_id = a.identity_id
 AND l.link_id = a.link_id AND l.link_authority_kind = a.link_authority_kind
 AND l.link_generation = a.link_generation`;

/** The issuer and subject come from verified OIDC, and the Identity from the attempt. */
export async function readDeviceRejoinLinkEvidence(
	backend: Pick<AuthLinkBackend, "first" | "readAuthSchemaState">,
	scope: {
		coordinatorId: string;
		identityId: string;
		issuer: string;
		subject: string;
		now: number;
	},
): Promise<DeviceRejoinLinkEvidence | null> {
	if (!Number.isSafeInteger(scope.now) || scope.now < 0) return null;
	const storage = await readDeviceRejoinLinkStorage(backend);
	if (!storage) return null;
	return backend.first<DeviceRejoinLinkEvidence>({
		sql: `WITH RECURSIVE rejoin_link_scope(coordinator_id, identity_id, issuer, subject) AS (VALUES (?, ?, ?, ?)),
rejoin_link_clock(now_ms) AS (VALUES (?)),
${rejoinLinkEvidenceCtes(storage)}
SELECT link_id, link_authority_kind, link_generation FROM rejoin_link_evidence`,
		values: [scope.coordinatorId, scope.identityId, scope.issuer, scope.subject, scope.now],
	});
}
