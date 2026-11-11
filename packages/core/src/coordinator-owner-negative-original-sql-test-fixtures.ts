/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Between the markers are the negative owner consistency builder from
 * coordinator-owner-negative-consistency.ts and the evidence statements it used from
 * coordinator-device-ownership-evidence-queries.ts, as they were on main at cab27c54e,
 * before the port to read-set validation, copied verbatim. Only the entry point's name
 * changed, and `export` was dropped from the copied evidence helpers. Code that is not
 * a statement builder (history capture, classification, schema and record checks) is
 * imported, as the original imported it. coordinator-owner-negative-equivalence.test.ts
 * runs it beside the read set and requires the same answers. Do not edit the copy to
 * follow later changes; delete this file with that test when the equivalence no longer
 * needs pinning.
 */
import {
	CONTROLLER_HISTORY_CTE,
	type ControllerHistorySnapshot,
	captureControllerHistory,
} from "./coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	classifyEvidence,
	type EvidenceRow,
	type EvidenceRows,
	type EvidenceSubject,
} from "./coordinator-device-ownership-evidence-classify.js";
import {
	BYTE_LIMIT,
	CONTROLLER_COLUMNS,
	type EvidenceQuery,
	RESOLUTION_COLUMNS,
	ROW_LIMIT,
} from "./coordinator-device-ownership-evidence-queries.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	captureLegacyOwnerResolutionRecord,
	classifyLegacyOwnerResolutionSchemaCatalog,
} from "./coordinator-legacy-owner-resolution-metadata.js";

// ---- verbatim copy starts ----
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

const EVIDENCE_QUERIES: EvidenceQuery[] = [
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

function readEvidenceQuery(query: EvidenceQuery, encoded: string): AuthLinkStatement {
	return {
		sql: `${prefix}, selected AS MATERIALIZED (${query.sql})
 SELECT CASE WHEN SUM(length(CAST(row AS BLOB))) OVER () <= ${BYTE_LIMIT} THEN row ELSE NULL END AS row FROM selected ORDER BY row`,
		values: [encoded],
	};
}

function atomicEvidenceQuery(encoded: string): AuthLinkStatement {
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

interface Backend {
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	all?<T>(statement: AuthLinkStatement): Promise<T[]>;
}

export interface NegativeOwnerConsistency extends AuthLinkStatement {
	/** Catalog, retained facts and original source only; unaffected by producer output. */
	retainedRecheck: AuthLinkStatement;
}

function consistencyResult(statement: AuthLinkStatement): NegativeOwnerConsistency {
	return { ...statement, retainedRecheck: statement };
}

async function captureNegativeCatalog(backend: Backend) {
	const catalog = await backend.first<{ objects: string }>({ sql: catalogSql, values: [] });
	if (!catalog || typeof catalog.objects !== "string") return null;
	const state = capturedCatalogState(catalog.objects);
	if (state === "unsupported" || (state === "missing" && catalog.objects !== "[]")) return null;
	return { ...catalog, state, pin: `(${catalogSql.replace(" AS objects", "")}) IS ?` };
}

/** Trusted subject metadata, not authority. Enrollment is optional for future
 * new-device producers; those producers must independently prove admission.
 */
export interface NegativeOwnerSubject {
	coordinatorId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	ownerIdentityId: string;
	enrollment?: { groupId: string };
	verifiedHistory?: ControllerHistorySnapshot;
}

const catalogSql = `SELECT json_group_array(json_array(type,name,tbl_name,sql)) AS objects
 FROM sqlite_master WHERE tbl_name='coordinator_legacy_owner_resolutions'`;

function capturedCatalogState(encoded: string) {
	const rows: unknown = JSON.parse(encoded);
	if (!Array.isArray(rows)) return "unsupported";
	const objects: { type: string; sql: string }[] = [];
	for (const row of rows) {
		if (
			!Array.isArray(row) ||
			row.length !== 4 ||
			typeof row[0] !== "string" ||
			typeof row[1] !== "string" ||
			row[2] !== "coordinator_legacy_owner_resolutions" ||
			(row[3] !== null && typeof row[3] !== "string")
		)
			return "unsupported";
		// The shared reader excludes SQLite's implicit indexes (SQL IS NULL).
		// Keep those objects in the full catalog pin, not the DDL comparison.
		if (row[3] !== null) objects.push({ type: row[0], sql: row[3] });
	}
	return classifyLegacyOwnerResolutionSchemaCatalog(objects);
}

function parseRows(values: { row: string | null }[]): EvidenceRow[] {
	if (values.length > ROW_LIMIT) throw new Error("ownership_evidence_too_large");
	return values.map(({ row }) => {
		if (typeof row !== "string") throw new Error("ownership_evidence_unavailable");
		const value: unknown = JSON.parse(row);
		if (
			!Array.isArray(value) ||
			value.some((v) => v !== null && typeof v !== "string" && typeof v !== "number")
		)
			throw new Error("ownership_evidence_unavailable");
		return value as EvidenceRow;
	});
}

async function captureEvidence(
	backend: Backend,
	subject: EvidenceSubject,
	legacyHistory: ControllerHistorySnapshot,
) {
	const base = {
		subject: { ...subject, fragments: legacyHistory.discoveryFragments },
		legacyHistory,
	};
	const parameters = JSON.stringify(base);
	const rows: EvidenceRows = {};
	const encodedRows: Record<string, string[]> = {};
	for (const query of EVIDENCE_QUERIES) {
		if (!backend.all) throw new Error("ownership_evidence_reader_unavailable");
		const values = await backend.all<{ row: string | null }>(readEvidenceQuery(query, parameters));
		rows[query.name] = parseRows(values);
		encodedRows[query.name] = values.map(({ row }) => String(row));
	}
	const encoded = JSON.stringify({ ...base, rows: encodedRows });
	if (new TextEncoder().encode(encoded).byteLength > BYTE_LIMIT)
		throw new Error("ownership_evidence_too_large");
	return { rows, encoded };
}

async function sourcePins(backend: Backend, rows: EvidenceRow[]): Promise<AuthLinkStatement> {
	const sources: EvidenceRow[] = [];
	for (const row of rows) {
		const resolution = await captureLegacyOwnerResolutionRecord(
			Object.fromEntries(RESOLUTION_COLUMNS.map((column, i) => [column, row[i]])),
		);
		if (!resolution) throw new Error("ownership_resolution_unavailable");
		const expected = [
			resolution.source_attestation_id,
			resolution.coordinator_id,
			resolution.owner_identity_id,
			resolution.source_group_id,
			resolution.device_id,
			resolution.source_public_key,
			resolution.source_fingerprint,
			resolution.source_review_receipt_id,
			resolution.source_evidence_digest,
			resolution.source_enrollment_identity_id,
			resolution.source_controller_revision,
			resolution.source_created_at,
			null,
		];
		const source = await backend.first<Record<string, unknown>>({
			sql: `SELECT ${CONTROLLER_COLUMNS.join(",")} FROM coordinator_auth_controller_attestations WHERE coordinator_id=? AND attestation_id=?`,
			values: [resolution.coordinator_id, resolution.source_attestation_id],
		});
		if (source && CONTROLLER_COLUMNS.every((column, i) => source[column] === expected[i]))
			sources.push(expected);
	}
	// One complete original source suffices; stale same-owner receipts do not
	// erase another original, unrevoked source. Metadata was validated separately.
	if (sources.length === 0) throw new Error("ownership_source_unavailable");
	return {
		sql: `SELECT EXISTS (SELECT 1 FROM json_each(?) pin WHERE EXISTS (
 SELECT 1 FROM coordinator_auth_controller_attestations source WHERE ${CONTROLLER_COLUMNS.map((column, i) => `source.${column} IS json_extract(pin.value,'$[${i}]')`).join(" AND ")})) AS matches`,
		values: [JSON.stringify(sources)],
	};
}

function absentSubjectResolutions(
	input: NegativeOwnerSubject,
	keyId: string | null,
): AuthLinkStatement {
	return {
		sql: `SELECT NOT EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions
 WHERE coordinator_id=? AND (device_id=? OR key_id=?)) AS matches`,
		values: [input.coordinatorId, input.deviceId, keyId],
	};
}

/** Returns only a negative write predicate. No result grants owner authority.
 * The missing-schema predicate deliberately never names the absent table.
 */
export async function prepareOriginalNegativeOwnerConsistency(
	backend: Backend,
	input: NegativeOwnerSubject,
): Promise<NegativeOwnerConsistency | null> {
	try {
		const catalog = await captureNegativeCatalog(backend);
		if (!catalog) return null;
		const catalogPin = catalog.pin;
		if (catalog.state === "missing") {
			return consistencyResult({
				sql: `SELECT ${catalogPin} AS matches`,
				values: [catalog.objects],
			});
		}
		const keyId = await ed25519KeyIdForRevocation(input.publicKey);
		const absent = absentSubjectResolutions(input, keyId);
		const result = await backend.first<{ matches: number }>(absent);
		if (!result) return null;
		// Ready deployments with no retained fact for this subject keep ordinary
		// admission semantics and limits. The winning write still pins absence.
		if (result.matches === 1)
			return consistencyResult({
				sql: `WITH consistency_absent AS MATERIALIZED (${absent.sql}) SELECT ${catalogPin}
 AND (SELECT matches FROM consistency_absent) AS matches`,
				values: [...absent.values, catalog.objects],
			});
		return await prepareResolvedOwnerConsistency(backend, input, keyId, catalog);
	} catch {
		return null;
	}
}

async function prepareResolvedOwnerConsistency(
	backend: Backend,
	input: NegativeOwnerSubject,
	keyId: string | null,
	catalog: { objects: string },
): Promise<NegativeOwnerConsistency | null> {
	const catalogPin = `(${catalogSql.replace(" AS objects", "")}) IS ?`;
	const history =
		input.verifiedHistory ??
		(await captureControllerHistory(
			{
				coordinatorId: input.coordinatorId,
				deviceId: input.deviceId,
				publicKey: input.publicKey,
				fingerprint: input.fingerprint,
			},
			<T>(sql: string, values: string[]) => {
				if (!backend.all) throw new Error("ownership_evidence_reader_unavailable");
				return backend.all<T>({ sql, values });
			},
		));
	const subject: EvidenceSubject = {
		coordinatorId: input.coordinatorId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
		groupId: input.enrollment?.groupId ?? "",
		// Legacy trusted seed callers can have opaque keys. They still receive
		// device checks; no canonical-key inference is made from opaque text.
		keyId: keyId ?? "",
	};
	const { rows, encoded } = await captureEvidence(backend, subject, history);
	const classificationRows = { ...rows };
	if (!input.enrollment)
		classificationRows.enrollment = [
			["", input.deviceId, input.publicKey, input.fingerprint, null, 1, null],
		];
	const classification = await classifyEvidence(
		classificationRows,
		subject,
		input.ownerIdentityId,
		history,
	);
	if (!["compatible", "weak_label_review_required"].includes(classification.decision)) return null;
	const sources = await sourcePins(backend, rows.resolutions ?? []);
	const evidence = atomicEvidenceQuery(encoded);
	const retainedRecheck = retainedFactsRecheck(
		input,
		keyId,
		rows.resolutions ?? [],
		sources,
		catalog,
	);
	return {
		sql: `WITH consistency_evidence AS MATERIALIZED (${evidence.sql}),
 consistency_sources AS MATERIALIZED (${sources.sql})
 SELECT ${catalogPin} AND (SELECT matches FROM consistency_evidence)
 AND (SELECT matches FROM consistency_sources) AS matches`,
		values: [...evidence.values, ...sources.values, catalog.objects],
		retainedRecheck,
	};
}

function retainedFactsRecheck(
	input: NegativeOwnerSubject,
	keyId: string | null,
	rows: EvidenceRow[],
	sources: AuthLinkStatement,
	catalog: { objects: string },
): AuthLinkStatement {
	return {
		sql: `WITH consistency_sources AS MATERIALIZED (${sources.sql}), consistency_facts AS MATERIALIZED (
 SELECT json_group_array(row) AS rows FROM (SELECT json_array(${RESOLUTION_COLUMNS.join(",")}) AS row
 FROM coordinator_legacy_owner_resolutions WHERE coordinator_id=? AND (device_id=? OR key_id=?) ORDER BY row))
 SELECT (${catalogSql.replace(" AS objects", "")}) IS ? AND (SELECT matches FROM consistency_sources)
 AND (SELECT rows FROM consistency_facts) IS ? AS matches`,
		values: [
			...sources.values,
			input.coordinatorId,
			input.deviceId,
			keyId,
			catalog.objects,
			JSON.stringify(rows.map((row) => JSON.stringify(row)).sort()),
		],
	};
}
// ---- verbatim copy ends ----
