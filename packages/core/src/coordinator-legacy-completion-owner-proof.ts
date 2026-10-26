import {
	type ControllerHistoryRecord,
	type ControllerHistorySnapshot,
	controllerHistoryDiscoveryFragments,
	parseControllerHistoryRecord,
} from "./coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	classifyEvidence,
	type EvidenceRow,
	type EvidenceRows,
	type EvidenceSubject,
	identifier,
	keyId,
} from "./coordinator-device-ownership-evidence-classify.js";
import {
	CONTROLLER_COLUMNS,
	RESOLUTION_COLUMNS,
} from "./coordinator-device-ownership-evidence-queries.js";
import {
	LEGACY_OWNER_COMPATIBLE_SQL,
	LEGACY_OWNER_INPUT_SQL,
} from "./coordinator-legacy-owner-compatibility.js";
import {
	canonicalReviewedWeakLabels,
	captureLegacyOwnerResolutionRecord,
	classifyLegacyOwnerResolutionSchemaCatalog,
	type LegacyOwnerResolutionRecord,
} from "./coordinator-legacy-owner-resolution-metadata.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "./coordinator-legacy-team-completion.js";

interface Backend {
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	all<T>(statement: AuthLinkStatement): Promise<T[]>;
}

/** Internal capability, meaningful only to this module's WeakMap. */
export interface LegacyCompletionOwnerProof {
	readonly version: 1;
}

interface Subject extends EvidenceSubject {
	owner: string;
	fragments: string[];
	fingerprints: string[];
}
interface KeyMetadata {
	public_key: string;
	key_id: string | null;
	fingerprint: string | null;
}
interface Snapshot {
	coordinator: string;
	subjects: Subject[];
	active: Subject[];
	keys: KeyMetadata[];
	rows: Record<string, string[]>;
	approved: string[];
}
interface ProofSql {
	/** Append after LEGACY_OWNER_INPUT_SQL, which already starts WITH. */
	readonly ctes: string;
	readonly currentSql: string;
	readonly compatibleSql: string;
	/** Bind after the three LEGACY_OWNER_INPUT_SQL values. */
	readonly values: readonly string[];
}

// A single JSON bind must fit D1's 2 MB string/value limit. This aggregate
// ceiling is separate from the established per-subject row/history ceilings.
// Oversized captures are unavailable, never a smaller permitted roster.
const MAX_CAPTURE_BYTES = 2_000_000;
const MAX_SUBJECT_ROWS = 500;
const MAX_SUBJECT_BYTES = 2_000_000;
const MAX_HISTORY_BYTES = 750_000;
const MAX_DISCOVERY_KEYS = 8192;
const MAX_HISTORY_KEYS = 4096;
const encoder = new TextEncoder();
const snapshots = new WeakMap<LegacyCompletionOwnerProof, ProofSql>();
const table = "coordinator_legacy_owner_resolutions";
const catalogSql = `SELECT json_array(type,name,tbl_name,sql) AS row
 FROM sqlite_master WHERE tbl_name='${table}' AND sql IS NOT NULL`;

function bytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

function requireProof(condition: unknown): asserts condition {
	if (!condition) throw new Error("completion_manifest_unavailable");
}

function rowset(columns: string[], from: string): string {
	return `SELECT DISTINCT json_array(${columns.join(",")}) AS row FROM ${from}`;
}

/** Keep original JSON scalar spellings, including numeric formatting and string
 * escapes. Parsing/stringifying cells would change e.g. 1.0 or escaped Unicode.
 */
function rowAtoms(row: string): string[] {
	const atoms =
		row.match(/"(?:[^"\\]|\\.)*"|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu) ?? [];
	requireProof(`[${atoms.join(",")}]` === row);
	return atoms;
}

function encodeRows(rows: Snapshot["rows"]): {
	atoms: string[];
	rows: Record<string, number[][]>;
} {
	const atoms: string[] = [];
	const indexes = new Map<string, number>();
	const intern = (atom: string): number => {
		const existing = indexes.get(atom);
		if (existing !== undefined) return existing;
		const index = atoms.length;
		atoms.push(atom);
		indexes.set(atom, index);
		return index;
	};
	return {
		atoms,
		rows: Object.fromEntries(
			Object.entries(rows).map(([name, values]) => [
				name,
				values.map((row) => rowAtoms(row).map(intern)),
			]),
		),
	};
}

/** SQL needs only selector fields. Active subjects refer to this shared roster;
 * expected row cells refer to one private dictionary of original JSON lexemes.
 */
function encodeSnapshot(snapshot: Snapshot): string {
	const active = new Set(snapshot.active);
	return JSON.stringify({
		...snapshot,
		subjects: snapshot.subjects.map(({ deviceId, keyId, publicKey, fragments, fingerprints }) => ({
			deviceId,
			keyId,
			publicKey,
			fragments,
			fingerprints,
		})),
		active: snapshot.subjects.flatMap((subject, index) => (active.has(subject) ? [index] : [])),
		...encodeRows(snapshot.rows),
	});
}

const subjectColumns = ["deviceId", "keyId", "publicKey", "fragments", "fingerprints"]
	.map((name) => `json_extract(j.value,'$.${name}') AS ${name}`)
	.join(",");
const subjectCtes = `completion_proof_input(value) AS MATERIALIZED (SELECT ?),
 completion_proof_atoms(atom_index,lexeme) AS MATERIALIZED (
 SELECT j.key,j.value FROM completion_proof_input i,json_each(i.value,'$.atoms') j),
 completion_proof_subjects AS MATERIALIZED (
 SELECT j.key AS ordinal,j.value,${subjectColumns} FROM completion_proof_input i,json_each(i.value,'$.subjects') j),
 completion_proof_active AS MATERIALIZED (
 SELECT s.* FROM completion_proof_input i,json_each(i.value,'$.active') j
 JOIN completion_proof_subjects s ON s.ordinal=j.value),
 completion_proof_fragments(fragment) AS MATERIALIZED (
 SELECT DISTINCT f.value FROM completion_proof_active s,json_each(s.fragments) f),
 completion_proof_fingerprints(fingerprint) AS MATERIALIZED (
 SELECT DISTINCT f.value FROM completion_proof_active s,json_each(s.value,'$.fingerprints') f),
 completion_proof_approved AS MATERIALIZED (
 SELECT j.value FROM completion_proof_input i,json_each(i.value,'$.approved') j),
 completion_proof_keys AS MATERIALIZED (
 SELECT json_extract(j.value,'$.public_key') AS public_key,
 json_extract(j.value,'$.key_id') AS key_id,
 json_extract(j.value,'$.fingerprint') AS fingerprint
 FROM completion_proof_input i,json_each(i.value,'$.keys') j)`;
const coordinator = `(SELECT json_extract(value,'$.coordinator') FROM completion_proof_input)`;
const field = (name: string) => `s.${name}`;
const collision = (device: string, key: string) =>
	`(${device} IN (SELECT deviceId FROM completion_proof_active) OR ${key} IN (SELECT keyId FROM completion_proof_active))`;

// Conservative text discovery has the same ordinary-key fast path and malformed
// token fallback as the accepted single-subject reader. JS alone decides aliases.
// Materialize token parsing before roster matching: inlining it into each
// correlated fragment check repeats whitespace/token work for every subject.
// Distributing the existential OR preserves its rowset while sharing lookup sets.
const discoveryCtes = `completion_proof_key_sources AS NOT MATERIALIZED (
 SELECT 'enrollment' AS source,group_id AS id,device_id,public_key,fingerprint FROM enrolled_devices
 UNION ALL SELECT 'controller',attestation_id,device_id,public_key,fingerprint
 FROM coordinator_auth_controller_attestations WHERE coordinator_id=${coordinator}
 UNION ALL SELECT 'invite',invite_id,bound_device_id,bound_public_key,bound_fingerprint
 FROM coordinator_invites WHERE consumed_at IS NOT NULL),
 completion_proof_lines AS NOT MATERIALIZED (
 SELECT *,ltrim(replace(replace(replace(replace(replace(public_key,char(9),' '),char(10),' '),char(11),' '),char(12),' '),char(13),' '),' ') AS line
 FROM completion_proof_key_sources),
 completion_proof_tails AS NOT MATERIALIZED (
 SELECT *,CASE WHEN substr(line,1,12)='ssh-ed25519 ' THEN ltrim(substr(line,13),' ') ELSE NULL END AS tail FROM completion_proof_lines),
 completion_proof_tokens AS MATERIALIZED (
 SELECT *,CASE WHEN tail IS NOT NULL THEN substr(tail,1,instr(tail || ' ',' ')-1) ELSE NULL END AS token FROM completion_proof_tails),
 completion_proof_discovery AS MATERIALIZED (
 SELECT t.* FROM completion_proof_tokens t WHERE EXISTS (SELECT 1 FROM completion_proof_active)
 AND (t.device_id IN (SELECT deviceId FROM completion_proof_active)
 OR t.public_key IN (SELECT publicKey FROM completion_proof_active) OR instr(t.public_key,char(0))>0
 OR t.token IS NULL OR t.token GLOB '*[^A-Za-z0-9+/=_-]*'
 OR EXISTS (SELECT 1 FROM completion_proof_fragments f
 WHERE instr(replace(replace(t.token,'-','+'),'_','/'),f.fragment)>0)))`;

const resolutionSql = rowset(
	RESOLUTION_COLUMNS,
	`${table} r WHERE r.coordinator_id=${coordinator}
 AND (r.device_id IN (SELECT deviceId FROM completion_proof_subjects)
 OR r.key_id IN (SELECT keyId FROM completion_proof_subjects))`,
);
const historyParsed = `CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END`;
const historyDecision = `CASE WHEN d.type='object' THEN d.value ELSE '{}' END`;
// Share exact device/fingerprint lookups within each statement, not across capture
// and INSERT. Only malformed text discovery still needs per-subject matching.
const historySql = rowset(
	"c.group_id,c.candidate_ref,c.manifest_version,c.completed_at,c.created_at,c.manifest_json".split(
		",",
	),
	`coordinator_legacy_team_completions c
 WHERE (json_extract(${historyParsed},'$.coordinator_id')=${coordinator}
 OR json_extract(${historyParsed},'$.coordinator_id') IS NULL)
 AND (EXISTS (SELECT 1 FROM json_each(${historyParsed},'$.device_decisions') d
 WHERE json_extract(${historyDecision},'$.device_id') IN (SELECT deviceId FROM completion_proof_active)
 OR json_extract(${historyDecision},'$.key_fingerprint') IN (SELECT fingerprint FROM completion_proof_fingerprints)
 OR ((d.type<>'object' OR json_type(${historyDecision},'$.device_id') IS NOT 'text'
 OR json_type(${historyDecision},'$.key_fingerprint') IS NOT 'text')
 AND EXISTS (SELECT 1 FROM completion_proof_active s WHERE
 instr(CASE WHEN d.type='text' THEN json_quote(d.value) ELSE d.value END,json_quote(${field("deviceId")}))>0
 OR EXISTS (SELECT 1 FROM json_each(s.value,'$.fingerprints') f WHERE instr(d.value,f.value)>0))))
 OR ((json_valid(c.manifest_json)=0 OR json_type(${historyParsed},'$.device_decisions') IS NOT 'array')
 AND EXISTS (SELECT 1 FROM completion_proof_active s WHERE instr(c.manifest_json,json_quote(${field("deviceId")}))>0
 OR EXISTS (SELECT 1 FROM json_each(s.value,'$.fingerprints') f WHERE instr(c.manifest_json,f.value)>0))))`,
);

function evidenceQueries(): Record<string, string> {
	return {
		schema: catalogSql,
		resolutions: resolutionSql,
		discovery: rowset(["source", "id"], "completion_proof_discovery WHERE source<>'enrollment'"),
		bindings: rowset(
			"device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at".split(
				",",
			),
			`coordinator_device_ownership_bindings WHERE ${collision("device_id", "key_id")}`,
		),
		claims: rowset(
			"claim_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,key_id,attempt_id,issuer,auth_config_revision,created_at_ms".split(
				",",
			),
			`coordinator_auth_device_claims WHERE coordinator_id=${coordinator} AND ${collision("device_id", "key_id")}`,
		),
		controllers: rowset(
			CONTROLLER_COLUMNS.map((column) => `c.${column}`),
			`coordinator_auth_controller_attestations c WHERE c.coordinator_id=${coordinator}
 AND (c.attestation_id IN (SELECT id FROM completion_proof_discovery WHERE source='controller')
 OR c.attestation_id IN (SELECT json_extract(row,'$[8]') FROM completion_observed_resolutions))`,
		),
		invites: rowset(
			"invite_id,group_id,policy,created_at,expires_at,consumed_at,revoked_at,bound_device_id,bound_public_key,bound_fingerprint,invite_kind,assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest".split(
				",",
			),
			"coordinator_invites WHERE invite_id IN (SELECT id FROM completion_proof_discovery WHERE source='invite')",
		),
		enrollment: rowset(
			"e.group_id,e.device_id,e.public_key,e.fingerprint,e.identity_id,e.enabled,g.archived_at".split(
				",",
			),
			`enrolled_devices e LEFT JOIN groups g ON g.group_id=e.group_id
 LEFT JOIN completion_proof_keys k ON k.public_key=e.public_key AND k.fingerprint=e.fingerprint
 WHERE ${collision("e.device_id", "k.key_id")}`,
		),
		revocations: rowset(
			"subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,actor_id,created_at".split(
				",",
			),
			`coordinator_device_revocations v WHERE EXISTS (SELECT 1 FROM completion_proof_active s
 WHERE (v.subject_kind='device_id' AND v.subject_value=${field("deviceId")})
 OR (v.subject_kind='ed25519_key' AND v.subject_value=${field("keyId")}))`,
		),
		history: historySql,
		historyKeys: rowset(
			["public_key", "fingerprint"],
			"completion_proof_discovery WHERE source<>'invite'",
		),
		historyDiscovery: rowset(["public_key"], "completion_proof_discovery WHERE source<>'invite'"),
	};
}

function capturePrefix(queries: Record<string, string>): string {
	const resolutions = queries.resolutions;
	requireProof(resolutions);
	return `WITH ${subjectCtes},${discoveryCtes},completion_observed_resolutions(row) AS MATERIALIZED (${resolutions})`;
}

async function readRows(
	backend: Backend,
	sql: string,
	parameters: string[] = [],
): Promise<{ encoded: string[]; parsed: EvidenceRow[] }> {
	const selected = await backend.all<{ row: string | null }>({
		sql: `SELECT CASE WHEN SUM(length(CAST(row AS BLOB))) OVER ()<=${MAX_CAPTURE_BYTES}
 THEN row ELSE NULL END AS row FROM (${sql}) LIMIT ${MAX_CAPTURE_BYTES + 1}`,
		values: parameters,
	});
	const encoded: string[] = [];
	const parsed = selected.map(({ row }) => {
		requireProof(typeof row === "string");
		const value: unknown = JSON.parse(row);
		requireProof(
			Array.isArray(value) &&
				value.every(
					(item) => item === null || typeof item === "string" || typeof item === "number",
				),
		);
		encoded.push(row);
		return value as EvidenceRow;
	});
	requireProof(bytes(encoded) <= MAX_CAPTURE_BYTES);
	return { encoded, parsed };
}

async function requestedSubjects(input: {
	backend: Backend;
	groupId: string;
	manifestJson: string;
	keyMetadata: string;
}): Promise<{ subjects: Subject[]; coordinator: string; keys: KeyMetadata[] }> {
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest(JSON.parse(input.manifestJson));
	requireProof(
		canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest) === input.manifestJson,
	);
	requireProof(identifier(input.groupId));
	const selected = await input.backend.all<{
		device_id: string;
		public_key: string;
		fingerprint: string;
		identity_id: string;
		key_id: string;
	}>({
		sql: `${LEGACY_OWNER_INPUT_SQL} SELECT r.*,e.public_key FROM legacy_owner_requested r
 JOIN enrolled_devices e ON e.group_id=? AND e.device_id=r.device_id AND e.fingerprint=r.fingerprint`,
		values: [input.manifestJson, input.groupId, input.keyMetadata, input.groupId],
	});
	requireProof(
		selected.length === manifest.device_decisions.filter((d) => d.decision === "included").length,
	);
	const subjects: Subject[] = [];
	for (const row of selected) {
		requireProof(identifier(row.identity_id) && (await keyId(row.public_key)) === row.key_id);
		subjects.push({
			coordinatorId: manifest.coordinator_id,
			groupId: input.groupId,
			deviceId: row.device_id,
			publicKey: row.public_key,
			fingerprint: row.fingerprint,
			keyId: row.key_id,
			owner: row.identity_id,
			fragments: controllerHistoryDiscoveryFragments(row.public_key),
			fingerprints: [row.fingerprint],
		});
	}
	return { subjects, coordinator: manifest.coordinator_id, keys: JSON.parse(input.keyMetadata) };
}

function relevantFact(row: EvidenceRow, subject: Subject): boolean {
	return row[3] === subject.deviceId || row[4] === subject.keyId;
}

function historyRecord(row: EvidenceRow): ControllerHistoryRecord {
	return Object.fromEntries(
		[
			"group_id",
			"candidate_ref",
			"manifest_version",
			"completed_at",
			"created_at",
			"manifest_json",
		].map((column, i) => [column, row[i]]),
	) as unknown as ControllerHistoryRecord;
}

async function canonicalKeys(rows: EvidenceRows): Promise<Map<string, string>> {
	const keys = new Set<string>();
	for (const row of rows.historyKeys ?? []) keys.add(String(row[0]));
	for (const row of rows.controllers ?? []) keys.add(String(row[5]));
	for (const row of rows.invites ?? []) keys.add(String(row[8]));
	const result = new Map<string, string>();
	for (const text of keys) {
		try {
			result.set(text, await keyId(text));
		} catch {
			// Discovery is not proof. Relevant device collisions still reach the
			// classifier, which rejects malformed source key text.
		}
	}
	return result;
}

function discoversKey(publicKey: string, subject: Subject): boolean {
	if (publicKey === subject.publicKey || publicKey.includes("\u0000")) return true;
	const line = publicKey.replace(/[\t\n\v\f\r]/gu, " ").replace(/^ +/u, "");
	if (!line.startsWith("ssh-ed25519 ")) return true;
	const token = line.slice(12).replace(/^ +/u, "").split(" ")[0] ?? "";
	if (/[^A-Za-z0-9+/=_-]/u.test(token)) return true;
	const normalized = token.replaceAll("-", "+").replaceAll("_", "/");
	return subject.fragments.some((fragment) => normalized.includes(fragment));
}

/** Internal capture preparation; not exported from the package entrypoint. */
export function prepareCompletionHistory(
	rows: EvidenceRow[],
	decode: (text: string) => unknown = JSON.parse,
) {
	return rows.map((row) => {
		const record = historyRecord(row);
		let decoded = false;
		let value: unknown;
		return {
			row,
			record,
			decode: () => {
				if (decoded) return value;
				decoded = true;
				try {
					value = decode(record.manifest_json);
				} catch {
					// A failed raw decode is not itself denial: each subject still
					// checks whether this malformed row plausibly references it.
				}
				return value;
			},
		};
	});
}

/** Internal subject view; canonical validation remains subject-specific. */
export function subjectHistory(
	rows: EvidenceRows,
	subject: Subject,
	keys: Map<string, string>,
	prepared: ReturnType<typeof prepareCompletionHistory>,
): ControllerHistorySnapshot {
	const pairs = (rows.historyKeys ?? []).filter(
		(row) => keys.get(String(row[0])) === subject.keyId,
	);
	requireProof(pairs.length <= MAX_HISTORY_KEYS);
	const fingerprints = new Set([subject.fingerprint, ...pairs.map((row) => String(row[1]))]);
	const records = prepared.filter(({ record, decode }) => {
		// The SQL selector retains malformed plausible matches. Do not silently drop
		// them while partitioning a shared capture into individual classifier views.
		const value = decode();
		const manifest = value as { device_decisions?: unknown[] };
		if (!Array.isArray(manifest?.device_decisions)) {
			requireProof(!record.manifest_json.includes(JSON.stringify(subject.deviceId)));
			requireProof(![...fingerprints].some((fp) => record.manifest_json.includes(fp)));
			return false;
		}
		return manifest.device_decisions.some((decision) => {
			const d = decision as { device_id?: string; key_fingerprint?: string } | null;
			if (d?.device_id === subject.deviceId || fingerprints.has(String(d?.key_fingerprint)))
				return true;
			if (typeof d?.device_id === "string" && typeof d?.key_fingerprint === "string") return false;
			const text = JSON.stringify(decision);
			return (
				text.includes(JSON.stringify(subject.deviceId)) ||
				[...fingerprints].some((fp) => text.includes(fp))
			);
		});
	});
	requireProof(
		records.length <= MAX_SUBJECT_ROWS && bytes(records.map(({ row }) => row)) <= MAX_HISTORY_BYTES,
	);
	const history: ControllerHistorySnapshot = {
		...subject,
		keys: pairs.map((row) => ({ public_key: String(row[0]), fingerprint: String(row[1]) })),
		discoveryKeys: (rows.historyDiscovery ?? [])
			.map((row) => String(row[0]))
			.filter((publicKey) => discoversKey(publicKey, subject)),
		discoveryFragments: subject.fragments,
		fingerprints: [...fingerprints].sort(),
		records: records.map(({ record }) => {
			parseControllerHistoryRecord(record, subject.coordinatorId);
			return record;
		}),
	};
	requireProof(bytes(history) <= MAX_HISTORY_BYTES);
	return history;
}

function subjectRows(
	rows: EvidenceRows,
	subject: Subject,
	keys: Map<string, string>,
	history: ControllerHistorySnapshot,
): EvidenceRows {
	const matches = (row: EvidenceRow, device: number, key: number) =>
		row[device] === subject.deviceId ||
		keys.get(String(row[key])) === subject.keyId ||
		discoversKey(String(row[key]), subject);
	const selected: EvidenceRows = {
		bindings: (rows.bindings ?? []).filter(
			(r) => r[0] === subject.deviceId || r[1] === subject.keyId,
		),
		claims: (rows.claims ?? []).filter((r) => r[4] === subject.deviceId || r[7] === subject.keyId),
		controllers: (rows.controllers ?? []).filter((r) => matches(r, 4, 5)),
		invites: (rows.invites ?? []).filter((r) => matches(r, 7, 8)),
		enrollment: (rows.enrollment ?? []).filter(
			(r) => r[0] === subject.groupId && r[1] === subject.deviceId,
		),
		resolutions: (rows.resolutions ?? []).filter((r) => relevantFact(r, subject)),
		revocations: (rows.revocations ?? []).filter(
			(r) =>
				(r[0] === "device_id" && r[1] === subject.deviceId) ||
				(r[0] === "ed25519_key" && r[1] === subject.keyId),
		),
	};
	for (const values of Object.values(selected)) requireProof(values.length <= MAX_SUBJECT_ROWS);
	requireProof(
		(selected.controllers?.length ?? 0) + (selected.invites?.length ?? 0) <= MAX_SUBJECT_ROWS,
	);
	requireProof(bytes(selected) <= MAX_SUBJECT_BYTES);
	requireProof(history.discoveryKeys.length <= MAX_DISCOVERY_KEYS);
	return selected;
}

function originalSourceMatches(
	resolution: LegacyOwnerResolutionRecord,
	source: EvidenceRow,
	subject: Subject,
	keys: Map<string, string>,
): boolean {
	const expected: EvidenceRow = [
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
	return (
		source.length === expected.length &&
		source.every((value, i) => value === expected[i]) &&
		keys.get(String(source[5])) === subject.keyId
	);
}

async function hasOriginalSource(
	rows: EvidenceRows,
	subject: Subject,
	keys: Map<string, string>,
): Promise<boolean> {
	for (const row of rows.resolutions ?? []) {
		const resolution = await captureLegacyOwnerResolutionRecord(
			Object.fromEntries(RESOLUTION_COLUMNS.map((column, i) => [column, row[i]])),
		);
		requireProof(resolution);
		if (
			resolution.coordinator_id === subject.coordinatorId &&
			resolution.device_id === subject.deviceId &&
			resolution.key_id === subject.keyId &&
			resolution.owner_identity_id === subject.owner &&
			(rows.controllers ?? []).some((source) =>
				originalSourceMatches(resolution, source, subject, keys),
			)
		)
			return true;
	}
	return false;
}

async function approveSubject(
	rows: EvidenceRows,
	subject: Subject,
	keys: Map<string, string>,
	prepared: ReturnType<typeof prepareCompletionHistory>,
): Promise<boolean> {
	const history = subjectHistory(rows, subject, keys, prepared);
	const selected = subjectRows(rows, subject, keys, history);
	const classification = await classifyEvidence(selected, subject, subject.owner, history);
	if (!["compatible", "weak_label_review_required"].includes(classification.decision)) return false;
	// Duplicate weak source tuples cannot be attributed to one reviewed origin.
	// Stored reviewed-label strings are never consulted as positive authority.
	if (canonicalReviewedWeakLabels(classification.weakLabels) === null) return false;
	const enrollments = (rows.enrollment ?? []).filter(
		(row) => row[1] === subject.deviceId || keys.get(String(row[2])) === subject.keyId,
	);
	requireProof(enrollments.length <= MAX_SUBJECT_ROWS && bytes(enrollments) <= MAX_SUBJECT_BYTES);
	for (const row of enrollments) {
		if (row[4] === null || row[4] === subject.owner) continue;
		const verifiedOrigin = classification.weakLabels.some(
			(weak) =>
				weak.label === row[4] &&
				(row[0] === subject.groupId || (weak.group_id === row[0] && weak.device_id === row[1])),
		);
		if (!verifiedOrigin) return false;
	}
	return hasOriginalSource(selected, subject, keys);
}

function pinSql(queries: Record<string, string>): { ctes: string; predicate: string } {
	const stages: string[] = [];
	const predicates: string[] = [];
	for (const [name, sql] of Object.entries(queries)) {
		if (name !== "resolutions")
			stages.push(`completion_observed_${name}(row) AS MATERIALIZED (${sql})`);
		stages.push(`completion_expected_${name}(row) AS MATERIALIZED (
 SELECT '[' || group_concat(a.lexeme,',' ORDER BY c.key) || ']'
 FROM completion_proof_input i,json_each(i.value,'$.rows.${name}') r,
 json_each(r.value) c JOIN completion_proof_atoms a ON a.atom_index=c.value
 GROUP BY r.key)`);
		stages.push(`completion_added_${name}(row) AS MATERIALIZED (
 SELECT row FROM completion_observed_${name} EXCEPT SELECT row FROM completion_expected_${name})`);
		stages.push(`completion_removed_${name}(row) AS MATERIALIZED (
 SELECT row FROM completion_expected_${name} EXCEPT SELECT row FROM completion_observed_${name})`);
		predicates.push(
			`NOT EXISTS (SELECT 1 FROM completion_added_${name})`,
			`NOT EXISTS (SELECT 1 FROM completion_removed_${name})`,
		);
	}
	return { ctes: stages.join(",\n"), predicate: predicates.join(" AND ") };
}

const approvedSubject = `EXISTS (SELECT 1 FROM completion_proof_approved a
 WHERE a.value=json_array(r.device_id,r.key_id,r.identity_id))`;

// Only the two weak-label branches gain an exception. Intra-roster owner
// assignments and ledger bindings retain the exact existing checks.
function replaceExactlyOnce(sql: string, target: string, replacement: string): string {
	if (sql.split(target).length !== 2) throw new Error("legacy_owner_compatible_sql_drifted");
	return sql.replace(target, replacement);
}

// Fails at load rather than silently dropping an exception if the source SQL changes.
const recoveredCompatibleSql = replaceExactlyOnce(
	replaceExactlyOnce(
		LEGACY_OWNER_COMPATIBLE_SQL,
		"WHERE e.identity_id IS NOT NULL AND e.identity_id <> r.identity_id",
		`WHERE e.identity_id IS NOT NULL AND e.identity_id <> r.identity_id AND NOT (${approvedSubject})`,
	),
	"AND json_extract(d.value, '$.identity_id') <> r.identity_id",
	`AND json_extract(d.value, '$.identity_id') <> r.identity_id AND NOT (${approvedSubject})`,
);

function remember(sql: ProofSql): LegacyCompletionOwnerProof {
	const token = Object.freeze({ version: 1 as const });
	snapshots.set(token, Object.freeze({ ...sql, values: Object.freeze([...sql.values]) }));
	return token;
}

function finishCapture(
	snapshot: Snapshot,
	queries: Record<string, string>,
	options: { compatible: boolean; recovered: boolean; missing?: boolean },
): LegacyCompletionOwnerProof {
	const encoded = encodeSnapshot(snapshot);
	requireProof(encoder.encode(encoded).byteLength <= MAX_CAPTURE_BYTES);
	const pin = pinSql(queries);
	let ctes = `,${subjectCtes}`;
	if (!options.missing) {
		ctes += `,${discoveryCtes},completion_observed_resolutions(row) AS MATERIALIZED (${resolutionSql})`;
	}
	ctes += `,${pin.ctes}`;
	let compatibleSql = "0";
	if (options.compatible) {
		compatibleSql = LEGACY_OWNER_COMPATIBLE_SQL;
		if (options.recovered) compatibleSql = recoveredCompatibleSql;
	}
	return remember({ ctes, currentSql: pin.predicate, compatibleSql, values: [encoded] });
}

async function captureReady(
	backend: Backend,
	snapshot: Snapshot,
): Promise<LegacyCompletionOwnerProof> {
	const queries = evidenceQueries();
	const initialPrefix = `WITH ${subjectCtes}`;
	const facts = await readRows(backend, `${initialPrefix} ${resolutionSql}`, [
		encodeSnapshot(snapshot),
	]);
	snapshot.rows.resolutions = facts.encoded;
	snapshot.active = snapshot.subjects.filter((s) => facts.parsed.some((r) => relevantFact(r, s)));
	if (snapshot.active.length === 0)
		return finishCapture(
			snapshot,
			{ schema: catalogSql, resolutions: resolutionSql },
			{ compatible: true, recovered: false },
		);
	const rows: EvidenceRows = { resolutions: facts.parsed };
	const prefix = capturePrefix(queries);
	// Capture the shared key inventory once before selecting history by verified
	// aliases. History bytes and source rows are stored once, not per roster member.
	for (const name of ["historyKeys", "historyDiscovery"]) {
		const sql = queries[name];
		requireProof(sql);
		const result = await readRows(backend, `${prefix} ${sql}`, [encodeSnapshot(snapshot)]);
		rows[name] = result.parsed;
		snapshot.rows[name] = result.encoded;
	}
	const aliasKeys = await canonicalKeys(rows);
	for (const subject of snapshot.active) {
		subject.fingerprints = [
			...new Set([
				subject.fingerprint,
				...(rows.historyKeys ?? [])
					.filter((row) => aliasKeys.get(String(row[0])) === subject.keyId)
					.map((row) => String(row[1])),
			]),
		].sort();
	}
	for (const [name, sql] of Object.entries(queries)) {
		if (Object.hasOwn(snapshot.rows, name)) continue;
		const result = await readRows(backend, `${prefix} ${sql}`, [encodeSnapshot(snapshot)]);
		rows[name] = result.parsed;
		snapshot.rows[name] = result.encoded;
	}
	const keys = await canonicalKeys(rows);
	const prepared = prepareCompletionHistory(rows.history ?? []);
	let compatible = true;
	for (const subject of snapshot.active) {
		if (!(await approveSubject(rows, subject, keys, prepared))) {
			compatible = false;
			continue;
		}
		snapshot.approved.push(JSON.stringify([subject.deviceId, subject.keyId, subject.owner]));
	}
	return finishCapture(snapshot, queries, { compatible, recovered: true });
}

/** Read-only capture. No submitted approved-subject list or source reference is accepted.
 * Call only after the stores validate the canonical manifest and its source binding.
 */
export async function captureLegacyCompletionOwnerProof(input: {
	backend: Backend;
	groupId: string;
	manifestJson: string;
	keyMetadata: string;
}): Promise<LegacyCompletionOwnerProof> {
	try {
		const requested = await requestedSubjects(input);
		const catalog = await readRows(input.backend, catalogSql);
		const state = classifyLegacyOwnerResolutionSchemaCatalog(
			catalog.parsed.map(([type, name, tbl_name, sql]) => ({ type, name, tbl_name, sql })),
		);
		const snapshot: Snapshot = {
			...requested,
			active: [],
			rows: { schema: catalog.encoded },
			approved: [],
		};
		if (state === "unsupported")
			return remember({ ctes: "", currentSql: "0", compatibleSql: "0", values: [] });
		if (state === "missing")
			return finishCapture(
				snapshot,
				{ schema: catalogSql },
				{ compatible: true, recovered: false, missing: true },
			);
		return await captureReady(input.backend, snapshot);
	} catch {
		return remember({ ctes: "", currentSql: "0", compatibleSql: "0", values: [] });
	}
}

/** The winning INSERT must use both predicates. A token by itself grants nothing.
 * Keep LEGACY_OWNER_SOURCE_CURRENT_SQL and all ordinary completion checks as well.
 */
export function legacyCompletionOwnerProofSql(proof: LegacyCompletionOwnerProof): ProofSql {
	return snapshots.get(proof) ?? { ctes: "", currentSql: "0", compatibleSql: "0", values: [] };
}
