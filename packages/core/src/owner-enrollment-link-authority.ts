import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import { authSchemaDefinitionCheck } from "./coordinator-auth-device-claim-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { authLinkLiveGenerationSql } from "./coordinator-auth-link-liveness.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import type { OwnerAuthorityAttempt } from "./coordinator-owner-enrollment-proof.js";
import { COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS } from "./coordinator-owner-enrollment-qualification-schema.js";
import { COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL } from "./coordinator-owner-enrollment-schema.js";

// Only the frozen 0036 table/authority guards and canonical 0035 ledger enable claims.
// Absence preserves legacy controller SQL; partial storage never enables a claim.
const attemptDefinitions =
	COORDINATOR_OWNER_ENROLLMENT_SCHEMA_SQL.match(
		/CREATE (?:TABLE|TRIGGER|INDEX)[\s\S]*?;(?=\s*(?:--|CREATE|$))/gu,
	) ?? [];
const requiredAttempts = attemptDefinitions.filter(
	(sql) =>
		/^CREATE TABLE/u.test(sql) ||
		/CREATE TRIGGER IF NOT EXISTS owner_enrollment_authority_/u.test(sql),
);
const readiness = [
	...requiredAttempts,
	...COORDINATOR_OWNER_ENROLLMENT_QUALIFICATION_SCHEMA_STATEMENTS,
]
	.map((sql) => {
		const check = authSchemaDefinitionCheck(sql).matches;
		if (!sql.startsWith("CREATE TABLE IF NOT EXISTS coordinator_owner_enrollment_attempts"))
			return check;
		// ALTER RENAME in official 0036 quotes this header only. Retain every body byte
		// for the full definition comparison, including quoted literals and CHECKs.
		const header = 'CREATE TABLE "coordinator_owner_enrollment_attempts"';
		return check.replace(
			"FROM sqlite_master WHERE",
			`FROM (SELECT type,name,CASE WHEN substr(sql,1,${header.length}) = '${header}'
 THEN 'CREATE TABLE coordinator_owner_enrollment_attempts' || substr(sql,${header.length + 1})
 ELSE sql END AS sql FROM sqlite_master) WHERE`,
		);
	})
	.join(" AND ");

/** Historical review birth, not current controller authority or old-device liveness. */
const QUALIFIED_LINKS = `SELECT l.coordinator_id,l.link_id,q.qualification_id
 FROM owner_claim_proven_links l
 JOIN coordinator_owner_enrollment_qualifications q ON q.coordinator_id=l.coordinator_id AND q.link_id=l.link_id
 JOIN coordinator_auth_device_claims d ON d.coordinator_id=l.coordinator_id AND d.claim_id=l.device_claim_id
 JOIN coordinator_auth_controller_attestations origin ON origin.coordinator_id=q.coordinator_id AND origin.attestation_id=q.controller_attestation_id
 WHERE l.authority_kind='device_claim' AND l.controller_attestation_id IS NULL
 AND q.revoked_at_ms IS NULL AND q.device_claim_id=d.claim_id AND q.identity_id=l.identity_id
 AND q.link_attempt_id=l.attempt_id AND q.link_auth_config_revision=l.auth_config_revision AND q.link_created_at_ms=l.created_at_ms
 AND q.source_group_id=d.group_id AND q.device_id=d.device_id AND q.public_key=d.public_key
 AND q.fingerprint=d.fingerprint AND q.key_id=d.key_id AND q.identity_id=d.identity_id
 AND origin.identity_id=q.identity_id AND origin.group_id=q.source_group_id AND origin.device_id=q.device_id
 AND origin.public_key=q.public_key AND origin.fingerprint=q.fingerprint
 AND origin.revision=q.controller_attestation_revision AND origin.revision=1
 AND origin.created_at=q.controller_attestation_created_at AND origin.review_receipt_id=q.review_receipt_id
 AND origin.evidence_digest=q.evidence_digest AND origin.enrollment_identity_id IS q.enrollment_identity_id
 AND (q.enrollment_identity_id IS NULL OR q.enrollment_identity_id=q.identity_id)
 AND (${authLinkLiveGenerationSql({ link: "l", connections: true })})`;

/** Scope SQL is private composition, with values from a session or stored attempt.
 * No scope means no rows, never a coordinator-wide authority scan.
 */
export async function readOwnerLinkAuthority(
	backend: AuthLinkBackend,
	time = Date.now(),
	scope: AuthLinkStatement = { sql: "0", values: [] },
) {
	const capturedScope = { sql: scope.sql, values: [...scope.values] };
	if (!Number.isSafeInteger(time) || time < 0) throw new Error("owner_authority_invalid_time");
	const column = await backend.first<{ present: number }>({
		sql: "SELECT EXISTS (SELECT 1 FROM pragma_table_info('coordinator_owner_enrollment_attempts') WHERE name='owner_qualification_id') AS present",
		values: [],
	});
	const hasPin = column?.present === 1;
	let qualified = false;
	if (hasPin && (await hasConnectionSessionSchema(backend))) {
		const result = await backend.first<{ ready: number }>({
			sql: `SELECT (${readiness}) AS ready`,
			values: [],
		});
		qualified = result?.ready === 1 && requiredAttempts.length === 3;
	}
	return ownerLinkAuthoritySql({ hasPin, qualified, time, scope: capturedScope });
}

/** Controller-only SQL: cannot admit a claim or use qualification evidence.
 * The attempt is the operation's SELECT * snapshot, never request JSON.
 * Optional qualification-schema reads add no authority to this legacy branch.
 */
export function controllerOwnerLinkAuthority(
	attempt: OwnerAuthorityAttempt,
	scope: AuthLinkStatement,
) {
	return ownerLinkAuthoritySql({
		hasPin: Object.hasOwn(attempt, "owner_qualification_id"),
		qualified: false,
		time: 0,
		scope: { sql: scope.sql, values: [...scope.values] },
	});
}

function ownerLinkAuthoritySql({
	hasPin,
	qualified,
	time,
	scope,
}: {
	hasPin: boolean;
	qualified: boolean;
	time: number;
	scope: AuthLinkStatement;
}) {
	const qualification = qualified
		? "(SELECT q.qualification_id FROM owner_qualified_links q WHERE q.coordinator_id=l.coordinator_id AND q.link_id=l.link_id)"
		: "NULL";
	const controller =
		"l.authority_kind='controller_attestation' AND l.controller_attestation_id IS NOT NULL AND l.device_claim_id IS NULL";
	const controllerPin = hasPin
		? `(${controller}) AND a.owner_qualification_id IS NULL`
		: `(${controller})`;
	const authorityPin = qualified
		? "l.owner_qualification_id IS a.owner_qualification_id"
		: controllerPin;
	// Materialize retained claim proof before adding qualification and attempt equality;
	// nesting all three in one predicate exceeds native D1's expression depth of 100.
	let withSql = "";
	if (qualified || scope.sql !== "0") {
		withSql = `WITH owner_scope_links AS MATERIALIZED (
 SELECT l.* FROM coordinator_auth_account_links l WHERE ${scope.sql})${
		qualified
			? `, owner_claim_proven_links AS MATERIALIZED (
 SELECT l.* FROM owner_scope_links l
 WHERE ${authDeviceClaimProvenanceSql({ link: "l", connections: true })}),
 owner_qualified_links AS MATERIALIZED (${QUALIFIED_LINKS} AND q.created_at_ms <= ${time}),
 owner_authorized_links AS MATERIALIZED (
 SELECT l.*,${qualification} AS owner_qualification_id FROM owner_scope_links l
 WHERE (${controller}) OR ${qualification} IS NOT NULL) `
			: ""
} `;
	}
	return {
		hasPin,
		values: scope.values,
		with: withSql,
		qualification,
		link: `((${controller}) OR ${qualification} IS NOT NULL)`,
		active: `EXISTS (SELECT 1 FROM ${qualified ? "owner_authorized_links" : "owner_scope_links"} l
 WHERE l.coordinator_id=a.coordinator_id AND l.link_id=a.link_id
 AND l.issuer=a.issuer AND l.subject=a.account_subject AND l.identity_id=a.identity_id
 AND l.attempt_id=a.link_attempt_id AND l.auth_config_revision=a.link_auth_config_revision AND l.revoked_at_ms IS NULL
 AND l.controller_attestation_id IS a.link_controller_attestation_id
 AND ${authorityPin})`,
	};
}
