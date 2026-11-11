/**
 * Test-only. This file exists only to pin equivalence with the pre-port SQL.
 *
 * Between the markers are, copied verbatim from main at 075d46647 before ownership
 * evidence moved to read-set guards: the evidence statements of
 * coordinator-device-ownership-evidence-queries.ts, and the collector class of
 * coordinator-device-ownership-evidence.ts. Only the class was renamed; its imports of
 * those statements now resolve to the copies above it. Everything else it imports is
 * unchanged since that commit. Do not edit the copy to follow later changes; delete this
 * file with coordinator-device-ownership-evidence-equivalence.test.ts.
 */
import {
	CONTROLLER_HISTORY_CTE,
	type ControllerHistorySnapshot,
	captureControllerHistory,
	captureControllerHistorySnapshot,
	controllerHistoryDiscoveryFragments,
} from "./coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	classifyEvidence,
	type EvidenceRow,
	type EvidenceRows,
	type EvidenceSubject,
	evidenceRows,
	hash,
	identifier,
	keyId,
	type OwnershipDecision,
} from "./coordinator-device-ownership-evidence-classify.js";
import { capturedOwnershipEvidenceDigest } from "./coordinator-device-ownership-evidence-digest.js";
import {
	captureLegacyOwnerResolutionRecord,
	classifyLegacyOwnerResolutionSchemaCatalog,
	type ReviewedWeakLabel,
	readLegacyOwnerResolutionSchemaState,
} from "./coordinator-legacy-owner-resolution-metadata.js";
// ---- verbatim copy starts ----
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

interface EvidenceBackend {
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	all<T>(statement: AuthLinkStatement): Promise<T[]>;
}
interface ActualSigner {
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
}
interface CollectionInput {
	canonicalOwnerId: string;
	actualSigner: ActualSigner;
	verifiedHistory: ControllerHistorySnapshot;
}
interface RecheckSnapshot {
	readonly version: 1;
}
type OwnershipCollection =
	| {
			kind: "collected";
			decision: OwnershipDecision;
			weakLabels: ReviewedWeakLabel[];
			recheckSnapshot: RecheckSnapshot;
	  }
	| { kind: "unavailable"; authorizationUnavailable: true };
type SourceVerification =
	| { kind: "verified_controller_source" | "source_missing" | "source_revoked" | "source_mismatch" }
	| { kind: "unavailable"; authorizationUnavailable: true };
const unavailable = { kind: "unavailable", authorizationUnavailable: true } as const;

function captureFields(value: unknown, fields: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_input");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error("invalid_input");
	if (Reflect.ownKeys(value).length !== fields.length) throw new Error("invalid_input");
	const copy: Record<string, unknown> = {};
	for (const field of fields) {
		const descriptor = Object.getOwnPropertyDescriptor(value, field);
		if (!descriptor || !("value" in descriptor)) throw new Error("invalid_input");
		copy[field] = descriptor.value;
	}
	return copy;
}

async function captureSigner(value: unknown, coordinatorId: string): Promise<EvidenceSubject> {
	const signer = captureFields(value, ["groupId", "deviceId", "publicKey", "fingerprint"]);
	if (!identifier(signer.groupId) || !identifier(signer.deviceId) || !hash(signer.fingerprint))
		throw new Error("invalid_signer");
	const canonicalKey = await keyId(signer.publicKey);
	return {
		coordinatorId,
		groupId: signer.groupId,
		deviceId: signer.deviceId,
		publicKey: String(signer.publicKey),
		fingerprint: signer.fingerprint,
		keyId: canonicalKey,
	};
}

function parseRows(rows: { row: string | null }[]): { encoded: string[]; parsed: EvidenceRow[] } {
	if (rows.length > ROW_LIMIT) throw new Error("evidence_too_large");
	const encoded: string[] = [];
	let bytes = 0;
	const parsed = rows.map(({ row }) => {
		if (typeof row !== "string") throw new Error("invalid_evidence");
		bytes += new TextEncoder().encode(row).byteLength;
		if (bytes > BYTE_LIMIT) throw new Error("evidence_too_large");
		const value: unknown = JSON.parse(row);
		if (
			!Array.isArray(value) ||
			value.some((item) => item !== null && typeof item !== "string" && typeof item !== "number")
		)
			throw new Error("invalid_evidence");
		encoded.push(row);
		return value as EvidenceRow;
	});
	return { encoded, parsed };
}

function requireCapturedCategory(category: CapturedEvidenceRow[]): CapturedEvidenceRow[] {
	const count = category[0]?.row_count;
	if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > ROW_LIMIT)
		throw new Error("invalid_evidence");
	if (category.length !== Math.max(1, count)) throw new Error("invalid_evidence");
	if (category.some((row) => row.row_count !== count)) throw new Error("invalid_evidence");
	if (count !== 0) return category;
	if (category[0]?.row !== null) throw new Error("invalid_evidence");
	return [];
}

function groupCapturedRows(captured: CapturedEvidenceRow[]): Map<string, CapturedEvidenceRow[]> {
	if (captured.length > EVIDENCE_QUERIES.length * (ROW_LIMIT + 1))
		throw new Error("evidence_too_large");
	const categories = new Map<string, CapturedEvidenceRow[]>(
		EVIDENCE_QUERIES.map(({ name }) => [name, []]),
	);
	for (const value of captured) {
		const row = captureFields(value, ["category", "row_count", "row"]);
		if (typeof row.category !== "string") throw new Error("invalid_evidence");
		const category = categories.get(row.category);
		if (!category) throw new Error("invalid_evidence");
		category.push(value);
	}
	for (const [name, category] of categories)
		categories.set(name, requireCapturedCategory(category));
	return categories;
}

function historyRows(history: ControllerHistorySnapshot): EvidenceRows {
	return {
		history: history.records.map((row) => [
			row.group_id,
			row.candidate_ref,
			row.manifest_version,
			row.completed_at,
			row.created_at,
			row.manifest_json,
		]),
		historyKeys: history.keys.map((row) => [row.public_key, row.fingerprint]),
		historyDiscovery: history.discoveryKeys.map((publicKey) => [publicKey]),
	};
}

function requireSameHistory(rows: EvidenceRows, history: ControllerHistorySnapshot): void {
	const expected = historyRows(history);
	for (const [name, values] of Object.entries(expected)) {
		if (
			JSON.stringify(values.map((row) => JSON.stringify(row)).sort()) !==
			JSON.stringify(
				evidenceRows(rows, name)
					.map((row) => JSON.stringify(row))
					.sort(),
			)
		)
			throw new Error("changed_history");
	}
}

function requireSupportedCapturedSchema(rows: EvidenceRows): void {
	const objects = evidenceRows(rows, "schema").map((row) => {
		if (
			row.length !== 4 ||
			typeof row[0] !== "string" ||
			typeof row[1] !== "string" ||
			row[2] !== "coordinator_legacy_owner_resolutions" ||
			typeof row[3] !== "string"
		)
			throw new Error("invalid_schema_evidence");
		return { type: row[0], sql: row[3] };
	});
	if (classifyLegacyOwnerResolutionSchemaCatalog(objects) !== "ready")
		throw new Error("unsupported_schema_evidence");
}

/** Internal read-only metadata collector. No result of this class grants access. */
export class OriginalDeviceOwnershipEvidence {
	private readonly snapshots = new WeakMap<object, { encoded: string; digest: string }>();
	private readonly coordinatorId: string;
	constructor(
		private readonly backend: EvidenceBackend,
		config: { coordinatorId: string },
	) {
		this.coordinatorId = config.coordinatorId;
	}

	async collect(input: CollectionInput): Promise<OwnershipCollection> {
		try {
			if (!identifier(this.coordinatorId)) return unavailable;
			const captured = captureFields(input, [
				"canonicalOwnerId",
				"actualSigner",
				"verifiedHistory",
			]);
			if (!identifier(captured.canonicalOwnerId)) return unavailable;
			const subject = await captureSigner(captured.actualSigner, this.coordinatorId);
			const history = await this.verifyHistory(captured.verifiedHistory, subject);
			if ((await readLegacyOwnerResolutionSchemaState(this.backend)) !== "ready")
				return unavailable;
			const { rows, encoded } = await this.captureRows(subject, history);
			requireSupportedCapturedSchema(rows);
			requireSameHistory(rows, history);
			const classification = await classifyEvidence(
				rows,
				subject,
				captured.canonicalOwnerId,
				history,
			);
			const matches = await this.backend.first<{ matches: number }>(atomicEvidenceQuery(encoded));
			if (matches?.matches !== 1) return unavailable;
			const digest = await capturedOwnershipEvidenceDigest(
				rows,
				subject,
				captured.canonicalOwnerId,
				history,
			);
			const recheckSnapshot = Object.freeze({ version: 1 as const });
			this.snapshots.set(recheckSnapshot, { encoded, digest });
			return { kind: "collected", ...classification, recheckSnapshot };
		} catch {
			return unavailable;
		}
	}

	private async verifyHistory(
		value: unknown,
		subject: EvidenceSubject,
	): Promise<ControllerHistorySnapshot> {
		const captured = captureControllerHistorySnapshot(value);
		if (!captured) throw new Error("invalid_history");
		const live = await captureControllerHistory(
			{
				coordinatorId: subject.coordinatorId,
				deviceId: subject.deviceId,
				publicKey: subject.publicKey,
				fingerprint: subject.fingerprint,
			},
			<T>(sql: string, values: string[]) => this.backend.all<T>({ sql, values }),
		);
		if (
			live.coordinatorId !== captured.coordinatorId ||
			live.deviceId !== captured.deviceId ||
			live.publicKey !== captured.publicKey ||
			live.fingerprint !== captured.fingerprint
		)
			throw new Error("changed_history");
		requireSameHistory(historyRows(live), captured);
		return live;
	}

	private async captureRows(
		subject: EvidenceSubject,
		legacyHistory: ControllerHistorySnapshot,
	): Promise<{ rows: EvidenceRows; encoded: string }> {
		const base = {
			subject: { ...subject, fragments: controllerHistoryDiscoveryFragments(subject.publicKey) },
			legacyHistory,
		};
		const parameters = JSON.stringify(base);
		const categories = groupCapturedRows(
			await this.backend.all<CapturedEvidenceRow>(readCombinedEvidenceQuery(parameters)),
		);
		const rows: EvidenceRows = {};
		const encodedRows: Record<string, string[]> = {};
		let bytes = parameters.length;
		for (const [name, category] of categories) {
			const values = parseRows(category);
			rows[name] = values.parsed;
			encodedRows[name] = values.encoded;
			bytes += values.encoded.reduce((total, row) => total + row.length, 0);
			if (bytes > BYTE_LIMIT) throw new Error("evidence_too_large");
		}
		const encoded = JSON.stringify({ ...base, rows: encodedRows });
		if (new TextEncoder().encode(encoded).byteLength > BYTE_LIMIT)
			throw new Error("evidence_too_large");
		return { rows, encoded };
	}

	/** A predicate for a future checked batch, never an admission or a write. */
	prepareAtomicRecheck(snapshot: RecheckSnapshot): AuthLinkStatement {
		const encoded = this.snapshots.get(snapshot)?.encoded;
		if (!encoded) return { sql: "SELECT 0 AS matches", values: [] };
		return atomicEvidenceQuery(encoded);
	}

	/** Private confirmation metadata; only this reader's original capture is accepted. */
	async reviewedEvidenceDigest(snapshot: unknown): Promise<string | null> {
		if (snapshot === null || typeof snapshot !== "object") return null;
		return this.snapshots.get(snapshot)?.digest ?? null;
	}

	async verifyControllerSource(input: {
		sourceRef: unknown;
		expectedOwnerId: string;
		actualSigner: ActualSigner;
	}): Promise<SourceVerification> {
		try {
			const captured = captureFields(input, ["sourceRef", "expectedOwnerId", "actualSigner"]);
			const reference = await captureLegacyOwnerResolutionRecord(captured.sourceRef);
			if (!reference || !identifier(captured.expectedOwnerId)) return unavailable;
			const subject = await captureSigner(captured.actualSigner, this.coordinatorId);
			if (
				reference.coordinator_id !== this.coordinatorId ||
				reference.owner_identity_id !== captured.expectedOwnerId ||
				reference.device_id !== subject.deviceId ||
				reference.key_id !== subject.keyId
			)
				return { kind: "source_mismatch" };
			const source = await this.backend.first<Record<string, string | number | null>>({
				sql: `SELECT ${CONTROLLER_COLUMNS.map((column) => (column === "public_key" ? "CASE WHEN length(CAST(public_key AS BLOB)) <= 4096 THEN public_key ELSE NULL END AS public_key" : column)).join(",")} FROM coordinator_auth_controller_attestations WHERE coordinator_id=? AND attestation_id=?`,
				values: [this.coordinatorId, reference.source_attestation_id],
			});
			if (!source) return { kind: "source_missing" };
			if (source.revoked_at !== null) return { kind: "source_revoked" };
			const expected = [
				reference.source_attestation_id,
				reference.coordinator_id,
				reference.owner_identity_id,
				reference.source_group_id,
				reference.device_id,
				reference.source_public_key,
				reference.source_fingerprint,
				reference.source_review_receipt_id,
				reference.source_evidence_digest,
				reference.source_enrollment_identity_id,
				reference.source_controller_revision,
				reference.source_created_at,
				null,
			];
			if (
				!CONTROLLER_COLUMNS.every((column, i) => source[column] === expected[i]) ||
				(await keyId(source.public_key)) !== subject.keyId
			)
				return { kind: "source_mismatch" };
			return { kind: "verified_controller_source" };
		} catch {
			return unavailable;
		}
	}
}
// ---- verbatim copy ends ----
