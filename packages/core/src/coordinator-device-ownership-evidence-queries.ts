import { CONTROLLER_HISTORY_CTE } from "./coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";

export const ROW_LIMIT = 500;
export const BYTE_LIMIT = 750_000;
export interface EvidenceQuery {
	name: string;
	sql: string;
}

const controllerColumns =
	"attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at";
export const CONTROLLER_COLUMNS = controllerColumns.split(",");
export const RESOLUTION_COLUMNS =
	"coordinator_id,resolution_id,resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at".split(
		",",
	);

// Invites and groups are server-local tables: neither has a coordinator column.
// Their stored bound subject is the constraint; labels never supply a namespace.
const sources = `ownership_input AS MATERIALIZED (
 SELECT json_extract(value,'$.subject') AS value FROM snapshot
), ownership_key_sources AS NOT MATERIALIZED (
 SELECT 'controller' AS source, attestation_id AS id, device_id, public_key FROM coordinator_auth_controller_attestations
 WHERE coordinator_id = (SELECT json_extract(value,'$.coordinatorId') FROM ownership_input)
 UNION ALL
 SELECT 'invite', invite_id, bound_device_id, bound_public_key FROM coordinator_invites WHERE consumed_at IS NOT NULL
), ownership_lines AS NOT MATERIALIZED (
 SELECT *, ltrim(replace(replace(replace(replace(replace(public_key,char(9),' '),char(10),' '),char(11),' '),char(12),' '),char(13),' '),' ') AS line
 FROM ownership_key_sources
), ownership_tails AS NOT MATERIALIZED (
 SELECT *, CASE WHEN substr(line,1,12) = 'ssh-ed25519 ' THEN ltrim(substr(line,13),' ') ELSE NULL END AS tail FROM ownership_lines
), ownership_tokens AS NOT MATERIALIZED (
 SELECT *, CASE WHEN tail IS NOT NULL THEN substr(tail,1,instr(tail || ' ',' ') - 1) ELSE NULL END AS token FROM ownership_tails
), ownership_discovery AS MATERIALIZED (
 SELECT source,id FROM ownership_tokens CROSS JOIN ownership_input p
 WHERE device_id = json_extract(p.value,'$.deviceId')
 OR public_key = json_extract(p.value,'$.publicKey')
 OR instr(public_key,char(0)) > 0 OR token IS NULL
 OR token GLOB '*[^A-Za-z0-9+/=_-]*'
 OR EXISTS (SELECT 1 FROM json_each(p.value,'$.fragments') f
 WHERE instr(replace(replace(token,'-','+'),'_','/'),f.value) > 0)
 LIMIT ${ROW_LIMIT + 1}
)`;

function rowQuery(name: string, columns: string[], from: string): EvidenceQuery {
	return {
		name,
		sql: `SELECT json_array(${columns.join(",")}) AS row FROM ${from} LIMIT ${ROW_LIMIT + 1}`,
	};
}
const subject = (field: string) => `(SELECT json_extract(value,'$.${field}') FROM ownership_input)`;

export const EVIDENCE_QUERIES: EvidenceQuery[] = [
	rowQuery("discovery", ["source", "id"], "ownership_discovery"),
	rowQuery(
		"bindings",
		"device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at".split(
			",",
		),
		`coordinator_device_ownership_bindings WHERE device_id=${subject("deviceId")} OR key_id=${subject("keyId")}`,
	),
	rowQuery(
		"claims",
		"claim_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,key_id,attempt_id,issuer,auth_config_revision,created_at_ms".split(
			",",
		),
		`coordinator_auth_device_claims WHERE coordinator_id=${subject("coordinatorId")} AND (device_id=${subject("deviceId")} OR key_id=${subject("keyId")})`,
	),
	rowQuery(
		"controllers",
		CONTROLLER_COLUMNS,
		`coordinator_auth_controller_attestations WHERE coordinator_id=${subject("coordinatorId")} AND attestation_id IN (SELECT id FROM ownership_discovery WHERE source='controller')`,
	),
	rowQuery(
		"invites",
		"invite_id,group_id,policy,created_at,expires_at,consumed_at,revoked_at,bound_device_id,bound_public_key,bound_fingerprint,invite_kind,assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest".split(
			",",
		),
		"coordinator_invites WHERE invite_id IN (SELECT id FROM ownership_discovery WHERE source='invite')",
	),
	rowQuery(
		"enrollment",
		"e.group_id,e.device_id,e.public_key,e.fingerprint,e.identity_id,e.enabled,g.archived_at".split(
			",",
		),
		`enrolled_devices e JOIN groups g ON g.group_id=e.group_id WHERE e.group_id=${subject("groupId")} AND e.device_id=${subject("deviceId")}`,
	),
	rowQuery(
		"revocations",
		"subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,actor_id,created_at".split(
			",",
		),
		`coordinator_device_revocations WHERE (subject_kind='device_id' AND subject_value=${subject("deviceId")}) OR (subject_kind='ed25519_key' AND subject_value=${subject("keyId")})`,
	),
	rowQuery(
		"resolutions",
		RESOLUTION_COLUMNS,
		`coordinator_legacy_owner_resolutions WHERE coordinator_id=${subject("coordinatorId")} AND (device_id=${subject("deviceId")} OR key_id=${subject("keyId")})`,
	),
	rowQuery(
		"schema",
		["type", "name", "tbl_name", "sql"],
		"sqlite_master WHERE tbl_name='coordinator_legacy_owner_resolutions' AND sql IS NOT NULL",
	),
	rowQuery(
		"history",
		"group_id,candidate_ref,manifest_version,completed_at,created_at,manifest_json".split(","),
		"live_history",
	),
	rowQuery("historyKeys", ["public_key", "fingerprint"], "live_history_keys"),
	rowQuery("historyDiscovery", ["public_key"], "live_discovery_keys"),
];

// Stream unfiltered inventory and key normalization; materialize only filtered
// discovery and rowset comparisons so unrelated key text is not copied repeatedly.
const prefix = `WITH snapshot(value) AS MATERIALIZED (SELECT ?),
 ${CONTROLLER_HISTORY_CTE}, ${sources}`;

export function readEvidenceQuery(query: EvidenceQuery, encoded: string): AuthLinkStatement {
	return {
		sql: `${prefix}, selected AS MATERIALIZED (${query.sql})
 SELECT CASE WHEN SUM(length(CAST(row AS BLOB))) OVER () <= ${BYTE_LIMIT} THEN row ELSE NULL END AS row FROM selected ORDER BY row`,
		values: [encoded],
	};
}

export interface CapturedEvidenceRow {
	category: string;
	row_count: number;
	row: string | null;
}

const CATEGORY_BLOCK_SIZE = 5;

export function readCombinedEvidenceQuery(encoded: string): AuthLinkStatement {
	const stages = EVIDENCE_QUERIES.map(
		({ name, sql }) => `selected_${name}(row) AS MATERIALIZED (${sql})`,
	);
	const categories = EVIDENCE_QUERIES.map(
		({ name }) => `SELECT '${name}' AS category,
 (SELECT count(*) FROM selected_${name}) AS row_count, s.row
 FROM (SELECT 1) LEFT JOIN selected_${name} s ON 1`,
	);
	const blocks: string[] = [];
	for (let offset = 0; offset < categories.length; offset += CATEGORY_BLOCK_SIZE) {
		const name = `category_block_${offset}`;
		stages.push(
			`${name} AS MATERIALIZED (${categories.slice(offset, offset + CATEGORY_BLOCK_SIZE).join("\nUNION ALL\n")})`,
		);
		blocks.push(`SELECT * FROM ${name}`);
	}
	stages.push(`captured AS (${blocks.join("\nUNION ALL\n")})`);
	return {
		// Independent branches avoid rescanning other categories for each emitted row.
		// Materialized blocks keep each compound SELECT within D1's five-term limit.
		// Empty categories retain an explicit count/NULL marker. Bound the entire
		// response, not just each category, before evidence text crosses the backend.
		sql: `${prefix}, ${stages.join(",\n")}
 SELECT category, row_count,
 CASE WHEN SUM(length(CAST(row AS BLOB))) OVER () <= ${BYTE_LIMIT} THEN row ELSE NULL END AS row
 FROM captured ORDER BY category, row`,
		values: [encoded],
	};
}

export function atomicEvidenceQuery(encoded: string): AuthLinkStatement {
	const stages = EVIDENCE_QUERIES.flatMap(({ name, sql }) => [
		`observed_${name}(row) AS MATERIALIZED (${sql})`,
		`expected_${name}(row) AS MATERIALIZED (SELECT j.value FROM snapshot s,json_each(s.value,'$.rows.${name}') j)`,
		`difference_${name}(row) AS MATERIALIZED (
 SELECT row FROM observed_${name} EXCEPT SELECT row FROM expected_${name})`,
		`missing_${name}(row) AS MATERIALIZED (
 SELECT row FROM expected_${name} EXCEPT SELECT row FROM observed_${name})`,
	]);
	const matches = EVIDENCE_QUERIES.flatMap(({ name }) => [
		`NOT EXISTS (SELECT 1 FROM difference_${name})`,
		`NOT EXISTS (SELECT 1 FROM missing_${name})`,
	]).join(" AND ");
	return {
		sql: `${prefix}, ${stages.join(",\n")} SELECT ${matches} AS matches`,
		values: [encoded],
	};
}
