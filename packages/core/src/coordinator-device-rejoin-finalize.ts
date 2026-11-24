import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { changedRows, writeGuarded } from "./coordinator-auth-read-set.js";
import { REJOIN_DESTINATION_CTES } from "./coordinator-device-rejoin-destinations.js";
import {
	type DeviceRejoinLinkEvidence,
	REJOIN_LINK_PIN_MATCH_SQL,
	readDeviceRejoinLinkStorage,
	rejoinLinkEvidenceCtes,
} from "./coordinator-device-rejoin-link-evidence.js";
import { verifyDeviceRejoinProof } from "./coordinator-device-rejoin-proof.js";

const ATTEMPTS = "coordinator_device_rejoin_attempts";
const DAY_MS = 86_400_000;
type Storage = NonNullable<Awaited<ReturnType<typeof readDeviceRejoinLinkStorage>>>;

export interface DeviceRejoinFinalizeScope {
	coordinatorId: string;
	origin: string;
	issuer: string;
	authConfigRevision: string;
	now: number;
}

export interface DeviceRejoinFinalizeInput {
	attemptId: string;
	deviceId: string;
	completion: string;
	signature: string;
}

interface ConfirmedAttempt extends DeviceRejoinLinkEvidence {
	state: "confirmed" | "finalized";
	finalized_at_ms: number | null;
	final_receipt_json: string | null;
	key_id: string;
	binding_id: string;
	identity_id: string;
	public_key: string;
	fingerprint: string;
	removal_digest: string;
	confirmation_hash: string;
	completion_secret_hash: string;
	own_tombstones_json: string;
	alias_removal_seqs_json: string;
	destinations_json: string;
}

export interface RejoinReceipt {
	attempt_id: string;
	device_id: string;
	identity_id: string;
	binding_id: string;
	group_ids: string[];
	lifted_removal_seqs: number[];
	finalized_at_ms: number;
}

const SCOPE = `a.coordinator_id = ? AND a.attempt_id = ? AND a.device_id = ?
 AND a.origin = ? AND a.issuer = ? AND a.auth_config_revision = ?
 AND a.created_at_ms <= ?`;
const ACTIVE = `${SCOPE} AND a.state = 'confirmed' AND a.expires_at_ms > ?`;

type FinalizeRefusal =
	| "blocked"
	| "removal_conflict"
	| "removal_changed"
	| "account_not_linked"
	| "no_destination"
	| "daily_limit"
	| "retry";

export type DeviceRejoinFinalizeResult =
	| { kind: "unavailable" }
	| { kind: "refused"; reason: FinalizeRefusal }
	| { kind: "finalized" | "prior_commit"; receipt: RejoinReceipt };

function activePins(c: DeviceRejoinFinalizeScope, i: DeviceRejoinFinalizeInput) {
	return [
		c.coordinatorId,
		i.attemptId,
		i.deviceId,
		c.origin,
		c.issuer,
		c.authConfigRevision,
		c.now,
		c.now,
	];
}

type OwnRemoval = [seq: number, group: string, key: string, fingerprint: string];

function receiptFor(
	row: ConfirmedAttempt,
	pins: { input: DeviceRejoinFinalizeInput; now: number },
) {
	const own = JSON.parse(row.own_tombstones_json) as OwnRemoval[];
	const aliases = JSON.parse(row.alias_removal_seqs_json) as number[];
	const destinations = JSON.parse(row.destinations_json) as [string, number | null][];
	const first = own[0];
	if (!first || destinations.length === 0) return null;
	const receipt: RejoinReceipt = {
		attempt_id: pins.input.attemptId,
		device_id: pins.input.deviceId,
		identity_id: row.identity_id,
		binding_id: row.binding_id,
		group_ids: destinations.map(([group]) => group),
		lifted_removal_seqs: [...own.map(([seq]) => seq), ...aliases].sort((a, b) => a - b),
		finalized_at_ms: pins.now,
	};
	return { receipt, tombstonePublicKey: first[2] };
}

async function verifyFinalize(
	backend: Pick<AuthLinkBackend, "first">,
	c: DeviceRejoinFinalizeScope,
	i: DeviceRejoinFinalizeInput,
) {
	const secret = decodeCoordinatorAuthProof32(i.completion);
	if (!secret) return null;
	const a = await backend.first<ConfirmedAttempt>({
		sql: `SELECT a.* FROM ${ATTEMPTS} a
 JOIN coordinator_device_removals t ON t.removal_seq = json_extract(a.own_tombstones_json, '$[0][0]')
 AND t.group_id = json_extract(a.own_tombstones_json, '$[0][1]')
 AND t.public_key = json_extract(a.own_tombstones_json, '$[0][2]')
 AND t.fingerprint = json_extract(a.own_tombstones_json, '$[0][3]')
 AND t.device_id = a.device_id AND t.key_id = a.key_id
 WHERE ${SCOPE} AND (a.state = 'finalized' OR (a.state = 'confirmed' AND a.expires_at_ms > ?))`,
		values: activePins(c, i),
	});
	if (!a || (await hashCoordinatorAuthProofBytes32(secret)) !== a.completion_secret_hash)
		return null;
	const prepared = receiptFor(a, { input: i, now: a.finalized_at_ms ?? c.now });
	if (!prepared) return null;
	const verified = await verifyDeviceRejoinProof(
		{
			operation: "finalize",
			origin: c.origin,
			coordinatorId: c.coordinatorId,
			authConfigRevision: c.authConfigRevision,
			attemptId: i.attemptId,
			deviceId: i.deviceId,
			issuer: c.issuer,
			keyId: a.key_id,
			publicKey: a.public_key,
			fingerprint: a.fingerprint,
			identityId: a.identity_id,
			bindingId: a.binding_id,
			removalDigest: a.removal_digest,
			confirmation: a.confirmation_hash,
			completion: i.completion,
		},
		{ tombstonePublicKey: prepared.tombstonePublicKey, signature: i.signature },
	);
	return verified ? { row: a, receipt: prepared.receipt } : null;
}

function finalizeEvidenceCtes(storage: Storage) {
	const absentQualification =
		storage === "unqualified"
			? "AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE tbl_name = 'coordinator_owner_enrollment_qualifications' COLLATE NOCASE)"
			: "";
	return `WITH RECURSIVE rejoin_link_clock(now_ms) AS (VALUES (?)),
attempt AS MATERIALIZED (SELECT a.* FROM ${ATTEMPTS} a WHERE ${ACTIVE} ${absentQualification}),
rejoin_link_scope AS MATERIALIZED (
 SELECT a.coordinator_id, a.identity_id, a.issuer, l.subject FROM attempt a
 JOIN coordinator_auth_account_links l ON l.coordinator_id = a.coordinator_id AND l.link_id = a.link_id
 AND l.identity_id = a.identity_id AND l.issuer = a.issuer
), ${rejoinLinkEvidenceCtes(storage)}, ${REJOIN_DESTINATION_CTES}`;
}

const DESTINATIONS_CHANGED = `EXISTS (SELECT 1 FROM json_each(a.destinations_json) j
 LEFT JOIN groups_with_reasons g ON g.group_id = json_extract(j.value, '$[0]')
 WHERE g.group_id IS NULL OR g.reason IS NOT NULL OR g.revision IS NOT json_extract(j.value, '$[1]'))`;

const DAILY_LIMIT_REACHED = `(SELECT count(*) FROM coordinator_device_rejoin_audit_log r
 WHERE r.coordinator_id = a.coordinator_id AND r.identity_id = a.identity_id
 AND r.finalized_at_ms > ?) >= 3`;

function winningUpdate(
	c: DeviceRejoinFinalizeScope,
	i: DeviceRejoinFinalizeInput,
	storage: Storage,
	row: ConfirmedAttempt,
	receipt: string,
): AuthLinkStatement {
	return {
		sql: `${finalizeEvidenceCtes(storage)}
UPDATE ${ATTEMPTS} AS a SET state = 'finalized', finalized_at_ms = ?, final_receipt_json = ?
FROM checked t, rejoin_link_evidence l
WHERE a.coordinator_id = t.coordinator_id AND a.attempt_id = t.attempt_id
 AND ${REJOIN_LINK_PIN_MATCH_SQL}
 AND a.link_id = ? AND a.link_authority_kind = ? AND a.link_generation = ?
 AND a.confirmation_hash = ? AND a.completion_secret_hash = ?
 AND a.binding_id = ? AND a.identity_id = ? AND a.removal_digest = ?
 AND a.key_id = ? AND a.public_key = ? AND a.fingerprint = ?
 AND a.own_tombstones_json = ? AND a.alias_removal_seqs_json = ? AND a.destinations_json = ?
 AND json_array_length(a.destinations_json) > 0
 AND NOT ${DESTINATIONS_CHANGED}
 AND NOT (${DAILY_LIMIT_REACHED})`,
		values: [
			c.now,
			...activePins(c, i),
			c.now,
			receipt,
			row.link_id,
			row.link_authority_kind,
			row.link_generation,
			row.confirmation_hash,
			row.completion_secret_hash,
			row.binding_id,
			row.identity_id,
			row.removal_digest,
			row.key_id,
			row.public_key,
			row.fingerprint,
			row.own_tombstones_json,
			row.alias_removal_seqs_json,
			row.destinations_json,
			c.now - DAY_MS,
		],
	};
}

function finalizeEffects(
	c: DeviceRejoinFinalizeScope,
	receipt: RejoinReceipt,
	encoded: string,
): AuthLinkStatement[] {
	const match =
		"a.coordinator_id = ? AND a.attempt_id = ? AND a.state = 'finalized' AND a.final_receipt_json = ?";
	const winner = [c.coordinatorId, receipt.attempt_id, encoded];
	const timestamp = new Date(c.now).toISOString();
	return [
		{
			sql: `UPDATE coordinator_device_removals SET lifted_at = ?, lifted_by_attempt_id = ?
 WHERE lifted_at IS NULL AND removal_seq IN (
 SELECT j.value FROM ${ATTEMPTS} a JOIN json_each(a.final_receipt_json,'$.lifted_removal_seqs') j WHERE ${match}
 )`,
			values: [timestamp, receipt.attempt_id, ...winner],
		},
		changedRows(receipt.lifted_removal_seqs.length),
		{
			sql: `INSERT INTO enrolled_devices (group_id, device_id, public_key, fingerprint, identity_id, enabled, created_at, key_id)
 SELECT r.group_id, a.device_id, r.public_key, r.fingerprint, a.identity_id, 1, ?, a.key_id
 FROM ${ATTEMPTS} a JOIN json_each(a.own_tombstones_json) j
 JOIN coordinator_device_removals r ON r.removal_seq = json_extract(j.value, '$[0]')
 JOIN json_each(a.final_receipt_json,'$.group_ids') g ON g.value = r.group_id
 WHERE ${match} AND r.lifted_by_attempt_id = a.attempt_id`,
			values: [timestamp, ...winner],
		},
		changedRows(receipt.group_ids.length),
		{
			sql: `INSERT INTO coordinator_device_rejoin_audit_log
 (coordinator_id, event_id, attempt_id, identity_id, device_id, binding_id, group_count, finalized_at_ms)
 SELECT a.coordinator_id, a.attempt_id, a.attempt_id, a.identity_id, a.device_id, a.binding_id,
 json_array_length(a.destinations_json), a.finalized_at_ms FROM ${ATTEMPTS} a WHERE ${match}`,
			values: winner,
		},
		changedRows(),
	];
}

/** A diagnostic read after rollback can explain a refusal but never return a success. */
async function finalizeRefusal(
	backend: AuthLinkBackend,
	c: DeviceRejoinFinalizeScope,
	i: DeviceRejoinFinalizeInput,
	storage: Storage,
): Promise<FinalizeRefusal> {
	const row = await backend.first<{ reason: FinalizeRefusal }>({
		sql: `${finalizeEvidenceCtes(storage)}
SELECT CASE
 WHEN EXISTS (SELECT 1 FROM coordinator_device_revocations r
  WHERE (r.subject_kind = 'device_id' AND r.subject_value = a.device_id)
  OR (r.subject_kind = 'ed25519_key' AND r.subject_value = a.key_id)) THEN 'blocked'
 WHEN EXISTS (SELECT 1 FROM coordinator_device_removals r
  WHERE r.lifted_at IS NULL AND r.device_id = a.device_id AND r.key_id IS NOT a.key_id) THEN 'removal_conflict'
 WHEN t.attempt_id IS NULL THEN 'removal_changed'
 WHEN l.link_id IS NULL THEN 'account_not_linked'
 WHEN NOT EXISTS (SELECT 1 FROM groups_with_reasons WHERE reason IS NULL) THEN 'no_destination'
 WHEN ${DESTINATIONS_CHANGED} THEN 'removal_changed'
 WHEN ${DAILY_LIMIT_REACHED} THEN 'daily_limit'
 ELSE 'retry' END AS reason
FROM attempt a LEFT JOIN checked t ON t.attempt_id = a.attempt_id
LEFT JOIN rejoin_link_evidence l ON ${REJOIN_LINK_PIN_MATCH_SQL}`,
		values: [c.now, ...activePins(c, i), c.now - DAY_MS],
	});
	return row?.reason ?? "retry";
}

export async function finalizeDeviceRejoin(
	backend: AuthLinkBackend,
	config: DeviceRejoinFinalizeScope,
	input: DeviceRejoinFinalizeInput,
): Promise<DeviceRejoinFinalizeResult> {
	const c = { ...config };
	const i = { ...input };
	if (!Number.isSafeInteger(c.now) || c.now < 0 || c.now > 8_640_000_000_000_000)
		return { kind: "unavailable" };
	const prepared = await verifyFinalize(backend, c, i);
	if (!prepared) return { kind: "unavailable" };
	const { row, receipt } = prepared;
	const encoded = JSON.stringify(receipt);
	if (row.state === "finalized") {
		if (row.final_receipt_json !== encoded) throw new Error("device_rejoin_receipt_invalid");
		return { kind: "prior_commit", receipt };
	}
	const storage = await readDeviceRejoinLinkStorage(backend);
	if (!storage) return { kind: "refused", reason: "account_not_linked" };
	const wrote = await writeGuarded(
		backend,
		[],
		[
			winningUpdate(c, i, storage, row, encoded),
			changedRows(),
			...finalizeEffects(c, receipt, encoded),
		],
	);
	if (wrote === "committed") return { kind: "finalized", receipt };
	return { kind: "refused", reason: await finalizeRefusal(backend, c, i, storage) };
}
