import { parseSshEd25519PublicKeyForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	type CoordinatorLegacyTeamCompletionManifestV1,
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
	requireCoordinatorLegacyTeamCompletionCandidateBinding,
} from "./coordinator-legacy-team-completion.js";

export interface ControllerHistoryRecord {
	group_id: string;
	candidate_ref: string;
	manifest_version: number;
	completed_at: string;
	created_at: string;
	manifest_json: string;
}
interface HistoryKey {
	public_key: string;
	fingerprint: string;
}
export interface ControllerHistorySnapshot {
	coordinatorId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	/** Actual canonical subject aliases, not discovery-filter matches. */
	keys: HistoryKey[];
	/** Private race-check inputs; never part of the operator's evidence digest. */
	discoveryKeys: string[];
	discoveryFragments: string[];
	fingerprints: string[];
	records: ControllerHistoryRecord[];
}
export interface ControllerHistoryEvidence extends ControllerHistoryRecord {
	manifest: CoordinatorLegacyTeamCompletionManifestV1;
}
export interface ControllerHistoryInput {
	coordinatorId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
}

const MAX_BYTES = 750_000;
const MAX_KEYS = 4096;
const MAX_DISCOVERY_KEYS = 8192;
const MAX_RECORDS = 500;

// This same predicate selects preview evidence and detects newly relevant rows in
// the winning write. Malformed unrelated records are not a reason to deny review.
// Unparseable rows containing a target reference require operator investigation.
// Enrollment removal must not erase an attested key/fingerprint binding. UNION
// deduplicates the ordinary new review's existing enrollment pair, while the
// coordinator filter prevents another namespace's retained keys entering proof.
// Only canonical parsing below selects aliases; manifest fingerprints add no keys.
export const CONTROLLER_HISTORY_CTE = `history_input AS MATERIALIZED (
 SELECT json_extract(value, '$.legacyHistory') AS value FROM snapshot
), history_key_sources AS NOT MATERIALIZED (
 SELECT public_key, fingerprint FROM enrolled_devices
 UNION
 SELECT a.public_key, a.fingerprint FROM coordinator_auth_controller_attestations a
 CROSS JOIN history_input h
 WHERE a.coordinator_id = json_extract(h.value, '$.coordinatorId')
), history_rows AS NOT MATERIALIZED (
 SELECT c.*, CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END AS parsed
 FROM coordinator_legacy_team_completions c
), live_history AS MATERIALIZED (
 SELECT c.group_id, c.candidate_ref, c.manifest_version, c.completed_at, c.created_at,
 CASE WHEN length(CAST(c.manifest_json AS BLOB)) <= ${MAX_BYTES} THEN c.manifest_json ELSE NULL END AS manifest_json
 FROM history_rows c CROSS JOIN history_input h
 WHERE h.value IS NOT NULL
 AND (json_extract(c.parsed, '$.coordinator_id') = json_extract(h.value, '$.coordinatorId')
      OR json_extract(c.parsed, '$.coordinator_id') IS NULL)
 AND (EXISTS (
  SELECT 1 FROM json_each(c.parsed, '$.device_decisions') d
  WHERE json_extract(CASE WHEN d.type = 'object' THEN d.value ELSE '{}' END, '$.device_id') = json_extract(h.value, '$.deviceId')
   OR json_extract(CASE WHEN d.type = 'object' THEN d.value ELSE '{}' END, '$.key_fingerprint')
      IN (SELECT value FROM json_each(h.value, '$.fingerprints'))
 ) OR ((json_valid(c.manifest_json) = 0 OR json_type(c.parsed, '$.device_decisions') IS NOT 'array') AND (
  instr(c.manifest_json, json_quote(json_extract(h.value, '$.deviceId'))) > 0
  OR EXISTS (SELECT 1 FROM json_each(h.value, '$.fingerprints') f
   WHERE instr(c.manifest_json, f.value) > 0)
 ))) LIMIT ${MAX_RECORDS + 1}
), snapshot_history AS MATERIALIZED (
 SELECT json_extract(j.value, '$.group_id') AS group_id,
  json_extract(j.value, '$.candidate_ref') AS candidate_ref,
  json_extract(j.value, '$.manifest_version') AS manifest_version,
  json_extract(j.value, '$.completed_at') AS completed_at,
  json_extract(j.value, '$.created_at') AS created_at,
  json_extract(j.value, '$.manifest_json') AS manifest_json
 FROM history_input h, json_each(h.value, '$.records') j
), snapshot_history_keys AS MATERIALIZED (
 SELECT json_extract(j.value, '$.public_key') AS public_key,
  json_extract(j.value, '$.fingerprint') AS fingerprint
 FROM history_input h, json_each(h.value, '$.keys') j
), snapshot_discovery_keys AS MATERIALIZED (
 SELECT j.value AS public_key FROM history_input h, json_each(h.value, '$.discoveryKeys') j
), discovery_lines AS NOT MATERIALIZED (
 SELECT public_key,
  ltrim(replace(replace(replace(replace(replace(public_key,
   char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' '), ' ') AS line
 FROM history_key_sources
), discovery_tails AS NOT MATERIALIZED (
 SELECT public_key, CASE WHEN substr(line, 1, 12) = 'ssh-ed25519 '
  THEN ltrim(substr(line, 13), ' ') ELSE NULL END AS tail FROM discovery_lines
), discovery_tokens AS NOT MATERIALIZED (
 SELECT public_key, CASE WHEN tail IS NOT NULL
  THEN substr(tail, 1, instr(tail || ' ', ' ') - 1) ELSE NULL END AS token
 FROM discovery_tails
), live_discovery_keys AS MATERIALIZED (
 SELECT DISTINCT e.public_key FROM discovery_tokens e CROSS JOIN history_input h
 WHERE e.public_key = json_extract(h.value, '$.publicKey')
 OR instr(e.public_key, char(0)) > 0
 OR e.token IS NULL
 OR EXISTS (SELECT 1 FROM json_each(h.value, '$.discoveryFragments') f
  WHERE instr(replace(replace(e.token, '-', '+'), '_', '/'), f.value) > 0)
 OR e.token GLOB '*[^A-Za-z0-9+/=_-]*'
 LIMIT ${MAX_DISCOVERY_KEYS + 1}
), live_history_keys AS MATERIALIZED (
 SELECT DISTINCT e.public_key, e.fingerprint FROM history_key_sources e
 WHERE e.public_key IN (SELECT public_key FROM snapshot_history_keys)
 LIMIT ${MAX_KEYS + 1}
)`;

export const CONTROLLER_HISTORY_KEYS_SQL = `WITH snapshot(value) AS (SELECT ?),
 ${CONTROLLER_HISTORY_CTE}
 SELECT public_key FROM live_discovery_keys ORDER BY public_key`;

const CONTROLLER_HISTORY_SUBJECT_KEYS_SQL = `WITH snapshot(value) AS (SELECT ?),
 ${CONTROLLER_HISTORY_CTE}
 SELECT public_key, fingerprint FROM live_history_keys ORDER BY public_key, fingerprint`;

export const CONTROLLER_HISTORY_SELECT_SQL = `WITH snapshot(value) AS (SELECT ?),
 ${CONTROLLER_HISTORY_CTE}
 SELECT group_id, candidate_ref, manifest_version, completed_at, created_at,
 CASE WHEN SUM(length(CAST(manifest_json AS BLOB))) OVER () <= ${MAX_BYTES}
 THEN manifest_json ELSE NULL END AS manifest_json
 FROM live_history ORDER BY group_id, candidate_ref LIMIT ${MAX_RECORDS + 1}`;

export const CONTROLLER_HISTORY_GUARD = `AND (
 (SELECT value FROM history_input) IS NULL OR (
 json_extract((SELECT value FROM history_input), '$.deviceId') = e.device_id
 AND json_extract((SELECT value FROM history_input), '$.publicKey') = e.public_key
 AND json_extract((SELECT value FROM history_input), '$.fingerprint') = e.fingerprint
 AND (SELECT count(*) FROM live_history) = (SELECT count(*) FROM snapshot_history)
 AND NOT EXISTS (SELECT * FROM live_history EXCEPT SELECT * FROM snapshot_history)
 AND NOT EXISTS (SELECT * FROM live_history_keys EXCEPT SELECT * FROM snapshot_history_keys)
 AND NOT EXISTS (SELECT * FROM snapshot_history_keys EXCEPT SELECT * FROM live_history_keys)
 AND NOT EXISTS (SELECT * FROM live_discovery_keys EXCEPT SELECT * FROM snapshot_discovery_keys)
 AND NOT EXISTS (SELECT * FROM snapshot_discovery_keys EXCEPT SELECT * FROM live_discovery_keys)
 ))`;

export function parseControllerHistoryRecord(
	row: ControllerHistoryRecord,
	coordinatorId: string,
): ControllerHistoryEvidence {
	if (typeof row.group_id !== "string" || typeof row.manifest_json !== "string")
		throw new Error("legacy_history_invalid");
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest(JSON.parse(row.manifest_json));
	requireCoordinatorLegacyTeamCompletionCandidateBinding(manifest, row.group_id);
	// Historical Team IDs are retained as evidence, not reinterpreted as owner authority.
	if (
		manifest.coordinator_id !== coordinatorId ||
		manifest.candidate_ref !== row.candidate_ref ||
		manifest.version !== row.manifest_version ||
		manifest.completed_at !== row.completed_at ||
		typeof row.created_at !== "string" ||
		!Number.isFinite(Date.parse(row.created_at)) ||
		canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest) !== row.manifest_json
	)
		throw new Error("legacy_history_invalid");
	return { ...row, manifest };
}

function matchingSubjectKeys(publicKey: string, candidates: string[]): string[] {
	const subject = parseSshEd25519PublicKeyForRevocation(publicKey);
	return candidates.filter((candidate) => {
		if (candidate === publicKey) return true;
		if (subject.kind !== "ed25519") return false;
		const parsed = parseSshEd25519PublicKeyForRevocation(candidate);
		return (
			parsed.kind === "ed25519" && subject.blob.every((byte, index) => byte === parsed.blob[index])
		);
	});
}

/** Discovery only: canonical parsing above, never a fragment match, decides alias identity.
 * For any wire offset, one raw-key offset in 0..2 starts on a base64 triplet
 * boundary. Its 27 bytes end before padding and encode to 36 contiguous chars.
 * SQL normalizes URL-safe characters. Any other non-base64 token character
 * (including Buffer-ignored junk or Unicode) takes the conservative GLOB path.
 * ASCII whitespace separates the key type, encoded token and ignored comments;
 * only that token is inspected, never comment punctuation or names. Prefixes
 * outside this ordinary syntax (such as Unicode separators) remain candidates.
 * Embedded NUL also remains a candidate: SQLite token functions stop there,
 * whereas the compatibility base64 decoder can ignore it inside the token.
 */
export function controllerHistoryDiscoveryFragments(publicKey: string): string[] {
	const subject = parseSshEd25519PublicKeyForRevocation(publicKey);
	if (subject.kind !== "ed25519") return [];
	const raw = subject.blob.subarray(19);
	return [0, 1, 2].map((offset) => btoa(String.fromCharCode(...raw.subarray(offset, offset + 27))));
}

function subjectFingerprints(fingerprint: string, keys: HistoryKey[]): string[] {
	return [...new Set([fingerprint, ...keys.map((key) => key.fingerprint)])].sort();
}

/** Discovery false positives pin classification races, but are not reviewed ownership evidence. */
export function controllerHistoryDigestEvidence(history: ControllerHistorySnapshot | undefined) {
	if (!history) return undefined;
	const { discoveryKeys: _keys, discoveryFragments: _fragments, ...evidence } = history;
	return evidence;
}

/** Both backends use the same targeted SELECT, limits and canonical parser. */
export async function captureControllerHistory(
	input: ControllerHistoryInput,
	all: <T>(sql: string, values: string[]) => Promise<T[]>,
): Promise<ControllerHistorySnapshot> {
	const discoveryFragments = controllerHistoryDiscoveryFragments(input.publicKey);
	const candidates = await all<{ public_key: string }>(CONTROLLER_HISTORY_KEYS_SQL, [
		JSON.stringify({ legacyHistory: { ...input, discoveryFragments } }),
	]);
	if (candidates.length > MAX_DISCOVERY_KEYS) throw new Error("legacy_history_too_large");
	const discoveryKeys = candidates.map((key) => key.public_key);
	const subjectKeys = matchingSubjectKeys(input.publicKey, discoveryKeys);
	const keys = await all<HistoryKey>(CONTROLLER_HISTORY_SUBJECT_KEYS_SQL, [
		JSON.stringify({
			legacyHistory: {
				coordinatorId: input.coordinatorId,
				keys: subjectKeys.map((public_key) => ({ public_key })),
			},
		}),
	]);
	if (keys.length > MAX_KEYS) throw new Error("legacy_history_too_large");
	const history: ControllerHistorySnapshot = {
		...input,
		keys,
		discoveryKeys,
		discoveryFragments,
		fingerprints: subjectFingerprints(input.fingerprint, keys),
		records: [],
	};
	const rows = await all<ControllerHistoryRecord>(CONTROLLER_HISTORY_SELECT_SQL, [
		JSON.stringify({ legacyHistory: history }),
	]);
	if (rows.length > MAX_RECORDS) throw new Error("legacy_history_too_large");
	history.records = rows.map((row) => {
		const { manifest: _manifest, ...record } = parseControllerHistoryRecord(
			row,
			input.coordinatorId,
		);
		return record;
	});
	const captured = captureControllerHistorySnapshot(history);
	if (!captured) throw new Error("legacy_history_invalid");
	return captured;
}

function captureData(value: unknown, budget: { remaining: number }, depth = 0): unknown {
	if (--budget.remaining < 0 || depth > 12) throw new Error("legacy_history_invalid");
	if (typeof value === "string") {
		budget.remaining -= value.length;
		if (budget.remaining < 0) throw new Error("legacy_history_too_large");
		return value;
	}
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (!value || typeof value !== "object") throw new Error("legacy_history_invalid");
	const copy = captureProperties(value, budget, depth);
	if (!Array.isArray(value)) return copy;
	const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		!Number.isSafeInteger(length) ||
		length > MAX_DISCOVERY_KEYS ||
		Object.keys(copy).length !== length
	)
		throw new Error("legacy_history_invalid");
	return Array.from({ length }, (_, index) => {
		if (!Object.hasOwn(copy, index)) throw new Error("legacy_history_invalid");
		return copy[String(index)];
	});
}

function captureProperties(
	value: object,
	budget: { remaining: number },
	depth: number,
): Record<string, unknown> {
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === "length") continue;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor || !Object.hasOwn(descriptor, "value"))
			throw new Error("legacy_history_invalid");
		copy[key] = captureData(descriptor.value, budget, depth + 1);
	}
	return copy;
}

function stringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function sameStringSet(left: string[], right: string[]): boolean {
	const expected = new Set(left);
	return (
		expected.size === left.length &&
		right.length === expected.size &&
		right.every((item) => expected.delete(item))
	);
}

function validSubjectDiscovery(snapshot: ControllerHistorySnapshot): boolean {
	if (
		!stringList(snapshot.discoveryKeys) ||
		snapshot.discoveryKeys.length > MAX_DISCOVERY_KEYS ||
		!Array.isArray(snapshot.discoveryFragments) ||
		JSON.stringify(snapshot.discoveryFragments) !==
			JSON.stringify(controllerHistoryDiscoveryFragments(snapshot.publicKey)) ||
		!sameStringSet(snapshot.discoveryKeys, snapshot.discoveryKeys)
	)
		return false;
	const expected = matchingSubjectKeys(snapshot.publicKey, snapshot.discoveryKeys);
	const actual = [...new Set(snapshot.keys.map((key) => key.public_key))];
	if (!sameStringSet(expected, actual)) return false;
	if (
		new Set(snapshot.keys.map((key) => JSON.stringify([key.public_key, key.fingerprint]))).size !==
		snapshot.keys.length
	)
		return false;
	return (
		JSON.stringify(snapshot.fingerprints) ===
		JSON.stringify(subjectFingerprints(snapshot.fingerprint, snapshot.keys))
	);
}

/** Capture JSON data without invoking getters or toJSON on store capability inputs. */
export function captureControllerHistorySnapshot(value: unknown): ControllerHistorySnapshot | null {
	try {
		const encoded = JSON.stringify(captureData(value, { remaining: MAX_BYTES }));
		if (!encoded || new TextEncoder().encode(encoded).byteLength > MAX_BYTES) return null;
		const snapshot = JSON.parse(encoded) as ControllerHistorySnapshot;
		if (
			!snapshot ||
			!Array.isArray(snapshot.keys) ||
			snapshot.keys.length > MAX_KEYS ||
			!Array.isArray(snapshot.fingerprints) ||
			!Array.isArray(snapshot.records) ||
			snapshot.records.length > MAX_RECORDS ||
			![
				snapshot.coordinatorId,
				snapshot.deviceId,
				snapshot.publicKey,
				snapshot.fingerprint,
				...snapshot.fingerprints,
			].every((field) => typeof field === "string" && field.length > 0) ||
			!snapshot.keys.every(
				(key) => typeof key.public_key === "string" && typeof key.fingerprint === "string",
			)
		)
			return null;
		if (!validSubjectDiscovery(snapshot)) return null;
		const ids = new Set<string>();
		for (const row of snapshot.records) {
			parseControllerHistoryRecord(row, snapshot.coordinatorId);
			const id = JSON.stringify([row.group_id, row.candidate_ref]);
			if (ids.has(id)) return null;
			ids.add(id);
		}
		return snapshot;
	} catch {
		return null;
	}
}

export function parseControllerHistoryEvidence(
	value: unknown,
	coordinatorId: string,
): ControllerHistoryEvidence[] {
	const copy = captureData(value, { remaining: MAX_BYTES * 3 });
	if (!Array.isArray(copy) || copy.length > MAX_RECORDS) throw new Error("legacy_history_invalid");
	return copy.map((row: ControllerHistoryEvidence) => {
		const evidence = parseControllerHistoryRecord(row, coordinatorId);
		if (
			JSON.stringify(evidence.manifest) !==
			canonicalCoordinatorLegacyTeamCompletionManifestJson(row.manifest)
		)
			throw new Error("legacy_history_invalid");
		return evidence;
	});
}
