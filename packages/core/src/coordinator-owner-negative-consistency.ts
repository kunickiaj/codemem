import {
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
	atomicEvidenceQuery,
	BYTE_LIMIT,
	CONTROLLER_COLUMNS,
	EVIDENCE_QUERIES,
	RESOLUTION_COLUMNS,
	ROW_LIMIT,
	readEvidenceQuery,
} from "./coordinator-device-ownership-evidence-queries.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	captureLegacyOwnerResolutionRecord,
	classifyLegacyOwnerResolutionSchemaCatalog,
} from "./coordinator-legacy-owner-resolution-metadata.js";

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
export async function prepareNegativeOwnerConsistency(
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

/** Compatibility for old internal callers, never infer a coordinator namespace. */
export async function prepareUnknownNamespaceOwnerConsistency(
	backend: Backend,
	input: Pick<NegativeOwnerSubject, "deviceId" | "publicKey">,
): Promise<NegativeOwnerConsistency | null> {
	try {
		const catalog = await captureNegativeCatalog(backend);
		if (!catalog) return null;
		if (catalog.state === "missing")
			return consistencyResult({
				sql: `SELECT ${catalog.pin} AS matches`,
				values: [catalog.objects],
			});
		const keyId = await ed25519KeyIdForRevocation(input.publicKey);
		const absent: AuthLinkStatement = {
			sql: "SELECT NOT EXISTS (SELECT 1 FROM coordinator_legacy_owner_resolutions WHERE device_id=? OR key_id=?) AS matches",
			values: [input.deviceId, keyId],
		};
		if ((await backend.first<{ matches: number }>(absent))?.matches !== 1) return null;
		return consistencyResult({
			sql: `WITH consistency_absent AS MATERIALIZED (${absent.sql}) SELECT ${catalog.pin} AND (SELECT matches FROM consistency_absent) AS matches`,
			values: [...absent.values, catalog.objects],
		});
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

/** Keep the ordinary authority and evidence trees in independent materialized
 * root stages instead of nesting one predicate beneath the other's SQL tree.
 */
export function withNegativeOwnerConsistency(
	statement: AuthLinkStatement,
	predicate: AuthLinkStatement,
): AuthLinkStatement {
	if (!statement.sql.trimStart().startsWith("WITH "))
		throw new Error("invalid_controller_statement");
	return {
		sql: `WITH negative_owner_consistency AS MATERIALIZED (${predicate.sql}), ${statement.sql.trimStart().slice(5)} AND (SELECT matches FROM negative_owner_consistency)`,
		values: [...predicate.values, ...statement.values],
	};
}

/** Compose only trusted producer statements; all captured data remains bound. */
export function withNegativeOwnerWrite(
	statement: AuthLinkStatement,
	predicate: AuthLinkStatement,
): AuthLinkStatement {
	const sql = statement.sql.trimStart();
	const tail = sql.startsWith("WITH ") ? sql.slice(5) : sql;
	const separator = sql.startsWith("WITH ") ? "," : "";
	const conflict = tail.indexOf("ON CONFLICT");
	const beforeConflict = conflict < 0 ? tail : tail.slice(0, conflict);
	const afterConflict = conflict < 0 ? "" : tail.slice(conflict);
	return {
		sql: `WITH negative_owner_consistency AS MATERIALIZED (${predicate.sql})${separator} ${beforeConflict} AND (SELECT matches FROM negative_owner_consistency) ${afterConflict}`,
		values: [...predicate.values, ...statement.values],
	};
}
