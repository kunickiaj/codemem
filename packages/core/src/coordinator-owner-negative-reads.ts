import type { ControllerHistorySnapshot } from "./coordinator-auth-controller-history.js";
import type { AuthRead } from "./coordinator-auth-read-set.js";
import type { EvidenceSubject } from "./coordinator-device-ownership-evidence-classify.js";
import {
	BYTE_LIMIT,
	CONTROLLER_COLUMNS,
	RESOLUTION_COLUMNS,
	ROW_LIMIT,
} from "./coordinator-device-ownership-evidence-queries.js";

/**
 * The plain reads behind the negative owner check. Each one returns what one stage of the
 * evidence statement in coordinator-device-ownership-evidence-queries.ts selected, with
 * that statement's values bound directly instead of read from a JSON snapshot, so no read
 * needs a WITH clause.
 */

const RESOLUTIONS = "coordinator_legacy_owner_resolutions";
const HISTORY_MANIFEST_LIMIT = 750_000;

/** The resolution table's schema objects, in creation order as the old pin compared them. */
export const NEGATIVE_CATALOG_READ: AuthRead = {
	sql: `SELECT json_array(type,name,tbl_name,sql) AS row FROM sqlite_master WHERE tbl_name='${RESOLUTIONS}' ORDER BY rowid`,
	values: [],
};

/** Retained resolutions of the subject. A NULL key ID matches only by device. */
export function retainedResolutionsRead(
	subject: { coordinatorId: string; deviceId: string },
	keyId: string | null,
): AuthRead {
	return {
		sql: `SELECT json_array(${RESOLUTION_COLUMNS.join(",")}) AS row FROM ${RESOLUTIONS}
 WHERE coordinator_id=? AND (device_id=? OR key_id=?) ORDER BY row`,
		values: [subject.coordinatorId, subject.deviceId, keyId],
	};
}

/** Resolutions of the device or key in any coordinator, for callers with no namespace. */
export function anyNamespaceResolutionsRead(deviceId: string, keyId: string | null): AuthRead {
	return {
		sql: `SELECT json_array(${RESOLUTION_COLUMNS.join(",")}) AS row FROM ${RESOLUTIONS}
 WHERE device_id=? OR key_id=? ORDER BY row`,
		values: [deviceId, keyId],
	};
}

/**
 * One evidence category as its old stage returned it: at most ROW_LIMIT + 1 rows, each the
 * exact `json_array` text, or NULL in every row once the rows together pass BYTE_LIMIT.
 * The text is passed through as a JSON string so its byte count is the one SQLite made.
 * The LIMIT cannot hide a change: more than ROW_LIMIT rows refuse the decision, and up to
 * that, the read returns every row.
 */
function evidenceRead(columns: string, from: string, values: AuthRead["values"]): AuthRead {
	return {
		sql: `SELECT json_quote(capped || '') AS row FROM (
 SELECT CASE WHEN SUM(length(CAST(row AS BLOB))) OVER () <= ${BYTE_LIMIT} THEN row ELSE NULL END AS capped, row AS raw
 FROM (SELECT json_array(${columns}) AS row FROM ${from} LIMIT ${ROW_LIMIT + 1})) ORDER BY raw`,
		values,
	};
}

/** Adds the old stages' `line`, `tail` and `token` columns to the rows of `source`. */
function tokenized(source: string): string {
	const line =
		"ltrim(replace(replace(replace(replace(replace(public_key,char(9),' '),char(10),' '),char(11),' '),char(12),' '),char(13),' '),' ')";
	return `(SELECT *,CASE WHEN tail IS NOT NULL THEN substr(tail,1,instr(tail || ' ',' ') - 1) ELSE NULL END AS token
 FROM (SELECT *,CASE WHEN substr(line,1,12) = 'ssh-ed25519 ' THEN ltrim(substr(line,13),' ') ELSE NULL END AS tail
 FROM (SELECT *,${line} AS line FROM (${source}))))`;
}

// Keys whose token could encode the subject key, or that ordinary parsing cannot rule out.
const SUSPECT_TOKEN = `instr(public_key,char(0)) > 0 OR token IS NULL OR token GLOB '*[^A-Za-z0-9+/=_-]*'
 OR EXISTS (SELECT 1 FROM json_each(?) f WHERE instr(replace(replace(token,'-','+'),'_','/'),f.value) > 0)`;

// Invites and groups are server-local tables: neither has a coordinator column.
const DISCOVERY_SOURCES = `SELECT 'controller' AS source,attestation_id AS id,device_id,public_key
 FROM coordinator_auth_controller_attestations WHERE coordinator_id=?
 UNION ALL SELECT 'invite',invite_id,bound_device_id,bound_public_key FROM coordinator_invites WHERE consumed_at IS NOT NULL`;
const HISTORY_KEY_SOURCES = `SELECT public_key,fingerprint FROM enrolled_devices
 UNION SELECT a.public_key,a.fingerprint FROM coordinator_auth_controller_attestations a WHERE a.coordinator_id=?`;

const DECISION = "CASE WHEN d.type = 'object' THEN d.value ELSE '{}' END";
// The old live_history stage, reading the subject from bound values.
const HISTORY_MATCH = `(json_extract(c.parsed,'$.coordinator_id') = ? OR json_extract(c.parsed,'$.coordinator_id') IS NULL)
 AND (EXISTS (SELECT 1 FROM json_each(c.parsed,'$.device_decisions') d
 WHERE json_extract(${DECISION},'$.device_id') = ?
 OR json_extract(${DECISION},'$.key_fingerprint') IN (SELECT value FROM json_each(?))
 OR ((d.type <> 'object' OR json_type(${DECISION},'$.device_id') IS NOT 'text' OR json_type(${DECISION},'$.key_fingerprint') IS NOT 'text')
 AND (instr(CASE WHEN d.type = 'text' THEN json_quote(d.value) ELSE d.value END,json_quote(?)) > 0
 OR EXISTS (SELECT 1 FROM json_each(?) f WHERE instr(d.value,f.value) > 0))))
 OR ((json_valid(c.manifest_json) = 0 OR json_type(c.parsed,'$.device_decisions') IS NOT 'array')
 AND (instr(c.manifest_json,json_quote(?)) > 0 OR EXISTS (SELECT 1 FROM json_each(?) f WHERE instr(c.manifest_json,f.value) > 0))))`;
const LIVE_HISTORY = `(SELECT c.group_id,c.candidate_ref,c.manifest_version,c.completed_at,c.created_at,
 CASE WHEN length(CAST(c.manifest_json AS BLOB)) <= ${HISTORY_MANIFEST_LIMIT} THEN c.manifest_json ELSE NULL END AS manifest_json
 FROM (SELECT c.*,CASE WHEN json_valid(c.manifest_json) THEN c.manifest_json ELSE '{}' END AS parsed
 FROM coordinator_legacy_team_completions c) c WHERE ${HISTORY_MATCH})`;

export interface EvidenceReadInput {
	subject: EvidenceSubject;
	history: ControllerHistorySnapshot;
}

/** The subject's own rows. Controllers and invites are read next, by the IDs discovered. */
function subjectReads(s: EvidenceSubject, fragments: string) {
	return {
		discovery: evidenceRead(
			"source,id",
			`${tokenized(DISCOVERY_SOURCES)} WHERE device_id=? OR public_key=? OR ${SUSPECT_TOKEN}`,
			[s.coordinatorId, s.deviceId, s.publicKey, fragments],
		),
		bindings: evidenceRead(
			"device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at",
			"coordinator_device_ownership_bindings WHERE device_id=? OR key_id=?",
			[s.deviceId, s.keyId],
		),
		claims: evidenceRead(
			"claim_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,key_id,attempt_id,issuer,auth_config_revision,created_at_ms",
			"coordinator_auth_device_claims WHERE coordinator_id=? AND (device_id=? OR key_id=?)",
			[s.coordinatorId, s.deviceId, s.keyId],
		),
		enrollment: evidenceRead(
			"e.group_id,e.device_id,e.public_key,e.fingerprint,e.identity_id,e.enabled,g.archived_at",
			"enrolled_devices e JOIN groups g ON g.group_id=e.group_id WHERE e.group_id=? AND e.device_id=?",
			[s.groupId, s.deviceId],
		),
		revocations: evidenceRead(
			"subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,actor_id,created_at",
			"coordinator_device_revocations WHERE (subject_kind='device_id' AND subject_value=?) OR (subject_kind='ed25519_key' AND subject_value=?)",
			[s.deviceId, s.keyId],
		),
		resolutions: evidenceRead(
			RESOLUTION_COLUMNS.join(","),
			`${RESOLUTIONS} WHERE coordinator_id=? AND (device_id=? OR key_id=?)`,
			[s.coordinatorId, s.deviceId, s.keyId],
		),
		schema: evidenceRead(
			"type,name,tbl_name,sql",
			`sqlite_master WHERE tbl_name='${RESOLUTIONS}' AND sql IS NOT NULL`,
			[],
		),
	};
}

/** The legacy history rows and keys that the captured history snapshot must still match. */
function historyReads(h: ControllerHistorySnapshot, fragments: string) {
	const fingerprints = JSON.stringify(h.fingerprints);
	return {
		history: evidenceRead(
			"group_id,candidate_ref,manifest_version,completed_at,created_at,manifest_json",
			LIVE_HISTORY,
			[
				h.coordinatorId,
				h.deviceId,
				fingerprints,
				h.deviceId,
				fingerprints,
				h.deviceId,
				fingerprints,
			],
		),
		historyKeys: evidenceRead(
			"public_key,fingerprint",
			`(SELECT DISTINCT public_key,fingerprint FROM (${HISTORY_KEY_SOURCES})
 WHERE public_key IN (SELECT value FROM json_each(?)))`,
			[h.coordinatorId, JSON.stringify(h.keys.map((key) => key.public_key))],
		),
		historyDiscovery: evidenceRead(
			"public_key",
			`(SELECT DISTINCT public_key FROM ${tokenized(HISTORY_KEY_SOURCES)} WHERE public_key=? OR ${SUSPECT_TOKEN})`,
			[h.coordinatorId, h.publicKey, fragments],
		),
	};
}

/**
 * The rows the controller review's history guard compared with the reviewed snapshot,
 * with that guard's own limits: one more row than the snapshot may hold, so a larger live
 * set can never equal it. Plain rows ordered by their whole text; no byte cap applies.
 */
export function controllerHistoryReads(h: ControllerHistorySnapshot): Record<string, AuthRead> {
	const fingerprints = JSON.stringify(h.fingerprints);
	const fragments = JSON.stringify(h.discoveryFragments);
	const rows = (columns: string, from: string, limit: number, values: AuthRead["values"]) => ({
		sql: `SELECT json_array(${columns}) AS row FROM ${from} ORDER BY row LIMIT ${limit}`,
		values,
	});
	return {
		history: rows(
			"group_id,candidate_ref,manifest_version,completed_at,created_at,manifest_json",
			LIVE_HISTORY,
			501,
			[
				h.coordinatorId,
				h.deviceId,
				fingerprints,
				h.deviceId,
				fingerprints,
				h.deviceId,
				fingerprints,
			],
		),
		historyKeys: rows(
			"public_key,fingerprint",
			`(SELECT DISTINCT public_key,fingerprint FROM (${HISTORY_KEY_SOURCES})
 WHERE public_key IN (SELECT value FROM json_each(?)))`,
			4097,
			[h.coordinatorId, JSON.stringify(h.keys.map((key) => key.public_key))],
		),
		historyDiscovery: rows(
			"public_key",
			`(SELECT DISTINCT public_key FROM ${tokenized(HISTORY_KEY_SOURCES)} WHERE public_key=? OR ${SUSPECT_TOKEN})`,
			8193,
			[h.coordinatorId, h.publicKey, fragments],
		),
	};
}

/** Every category but controllers and invites, which depend on the discovered IDs. */
export function evidenceReads({ subject, history }: EvidenceReadInput): Record<string, AuthRead> {
	const fragments = JSON.stringify(history.discoveryFragments);
	return { ...subjectReads(subject, fragments), ...historyReads(history, fragments) };
}

/** Controller reviews and consumed invites among the discovered keys, as the old stages joined them. */
export function discoveredReads(
	subject: EvidenceSubject,
	discovered: { controllers: string[]; invites: string[] },
): Record<string, AuthRead> {
	return {
		controllers: evidenceRead(
			CONTROLLER_COLUMNS.join(","),
			"coordinator_auth_controller_attestations WHERE coordinator_id=? AND attestation_id IN (SELECT value FROM json_each(?))",
			[subject.coordinatorId, JSON.stringify(discovered.controllers)],
		),
		invites: evidenceRead(
			"invite_id,group_id,policy,created_at,expires_at,consumed_at,revoked_at,bound_device_id,bound_public_key,bound_fingerprint,invite_kind,assigned_identity_id,target_identity_id,recipient_actor_id,reviewed_preview_digest",
			"coordinator_invites WHERE invite_id IN (SELECT value FROM json_each(?))",
			[JSON.stringify(discovered.invites)],
		),
	};
}

/** Whether one of the resolutions' original sources is still exactly as reviewed. */
export function sourcesRead(pin: AuthRead): AuthRead {
	return {
		sql: `SELECT json_object('matches',matches) AS row FROM (${pin.sql})`,
		values: pin.values,
	};
}
