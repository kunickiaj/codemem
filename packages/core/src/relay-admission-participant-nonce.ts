import type { CapturedPeerEnrollment } from "./coordinator-peer-discovery.js";
import {
	RELAY_ADMISSION_CLOCK_SQL,
	type RelayAdmissionNonceAssociation,
} from "./relay-admission-clock.js";
import {
	type DecodedRelayCheck,
	decodeRelayCheckPacket,
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
} from "./relay-admission-codec.js";
import {
	RELAY_ADMISSION_METADATA_GATE_SQL,
	RELAY_ADMISSION_METADATA_RETURNING_SQL,
} from "./relay-admission-metadata-schema.js";
import { parseRelayEd25519PublicKey, relayEd25519KeyId } from "./relay-ed25519.js";

export const RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL = `SELECT group_id, device_id, public_key,
 fingerprint, identity_id, enabled FROM enrolled_devices
 WHERE group_id = ?1 AND (device_id = ?2 OR device_id = ?3)`;

export interface RelayAdmissionParticipantContext {
	readonly groupId: string;
	readonly sourceDeviceId: string;
	readonly targetDeviceId?: string;
}
export type HashedRelayAdmissionParticipant = CapturedPeerEnrollment & { readonly keyId: string };
export interface CapturedRelayAdmissionParticipants {
	readonly source: HashedRelayAdmissionParticipant;
	readonly target: HashedRelayAdmissionParticipant | null;
}
export interface RelayAdmissionNamespace {
	readonly authorityId: string;
	readonly groupId: string;
	readonly relayAudienceId: string;
}
export interface RelayAdmissionNonceStatementOptions {
	readonly check: DecodedRelayCheck;
	readonly participants: CapturedRelayAdmissionParticipants;
	readonly namespace: RelayAdmissionNamespace;
	readonly policyRevision: number;
	readonly attemptId: string;
}
export interface RelayAdmissionNonceStatement {
	readonly sql: string;
	readonly bindings: readonly (string | number | null)[];
	readonly association: RelayAdmissionNonceAssociation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDevice(value: unknown): value is string {
	return typeof value === "string" && /^[\x21-\x7e]{1,64}$/.exec(value)?.[0] === value;
}

function isGroup(value: unknown): value is string {
	if (typeof value !== "string" || value !== value.trim()) return false;
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) return false;
	}
	const size = new TextEncoder().encode(value).length;
	return size >= 1 && size <= 128;
}

function captureTuple(value: unknown): CapturedPeerEnrollment | null {
	if (!isRecord(value)) return null;
	const { group_id, device_id, public_key, fingerprint, identity_id, enabled } = value;
	if (
		!isGroup(group_id) ||
		!isDevice(device_id) ||
		typeof public_key !== "string" ||
		typeof fingerprint !== "string" ||
		(identity_id !== null && typeof identity_id !== "string") ||
		enabled !== 1
	)
		return null;
	parseRelayEd25519PublicKey(public_key);
	return Object.freeze({ group_id, device_id, public_key, fingerprint, identity_id, enabled });
}

function captureRequestedRows(rows: unknown, context: RelayAdmissionParticipantContext) {
	const { groupId, sourceDeviceId, targetDeviceId } = context;
	if (!isGroup(groupId) || !isDevice(sourceDeviceId)) return null;
	if (
		targetDeviceId !== undefined &&
		(!isDevice(targetDeviceId) || sourceDeviceId === targetDeviceId)
	)
		return null;
	const expectedCount = targetDeviceId === undefined ? 1 : 2;
	if (!Array.isArray(rows) || rows.length !== expectedCount) return null;
	const tuples = rows.map(captureTuple);
	if (tuples.some((tuple) => !tuple || tuple.group_id !== groupId)) return null;
	const source = tuples.find((tuple) => tuple?.device_id === sourceDeviceId);
	const target = tuples.find((tuple) => tuple?.device_id === targetDeviceId) ?? null;
	if (!source || (targetDeviceId !== undefined && !target)) return null;
	return { source, target };
}

/** Own and validate both requested tuples before the first asynchronous hash. */
export async function captureRelayAdmissionParticipants(
	rows: unknown,
	context: RelayAdmissionParticipantContext,
): Promise<CapturedRelayAdmissionParticipants | null> {
	try {
		const captured = captureRequestedRows(rows, context);
		if (!captured) return null;
		const source = Object.freeze({
			...captured.source,
			keyId: await relayEd25519KeyId(captured.source.public_key),
		});
		let target: HashedRelayAdmissionParticipant | null = null;
		if (captured.target) {
			target = Object.freeze({
				...captured.target,
				keyId: await relayEd25519KeyId(captured.target.public_key),
			});
		}
		return Object.freeze({ source, target });
	} catch {
		return null;
	}
}

function captureHashedTuple(value: unknown): HashedRelayAdmissionParticipant | null {
	if (!isRecord(value) || !Object.isFrozen(value)) return null;
	const keyId = value.keyId;
	if (typeof keyId !== "string" || keyId.length !== 64 || !/^[0-9a-f]+$/.test(keyId)) return null;
	const tuple = captureTuple(value);
	return tuple ? Object.freeze({ ...tuple, keyId }) : null;
}

function captureCheck(check: DecodedRelayCheck): DecodedRelayCheck | null {
	const { kind, value, bodyBytes, timestamp, nonce, signatureBytes } = check;
	if (!(bodyBytes instanceof Uint8Array) || !(signatureBytes instanceof Uint8Array)) return null;
	const ownedBody = new Uint8Array(bodyBytes);
	const ownedSignature = new Uint8Array(signatureBytes);
	let encoded: Uint8Array;
	if (kind === "admission") encoded = encodeRelayAdmissionBody({ ...value });
	else if (kind === "registration") encoded = encodeRelayRegistrationBody({ ...value });
	else return null;
	if (
		encoded.length !== ownedBody.length ||
		!encoded.every((byte, index) => byte === ownedBody[index])
	)
		return null;
	return decodeRelayCheckPacket(
		encodeRelayCheckPacket({
			bodyBytes: ownedBody,
			timestamp,
			nonce,
			signatureBytes: ownedSignature,
		}),
	);
}

function matchesParticipant(
	tuple: HashedRelayAdmissionParticipant,
	groupId: string,
	deviceId: string,
	keyId: string,
): boolean {
	return tuple.group_id === groupId && tuple.device_id === deviceId && tuple.keyId === keyId;
}

// Only the two literal parameter slots below can enter this static SQL fragment.
function currentParticipantSql(slot: "?9" | "?10"): string {
	return `EXISTS (SELECT 1 FROM enrolled_devices e
 JOIN groups g ON g.group_id = e.group_id
 WHERE e.group_id = ?6 AND e.group_id = json_extract(${slot}, '$.group_id')
 AND e.device_id = json_extract(${slot}, '$.device_id')
 AND e.public_key = json_extract(${slot}, '$.public_key')
 AND e.fingerprint = json_extract(${slot}, '$.fingerprint')
 AND e.identity_id IS json_extract(${slot}, '$.identity_id')
 AND e.enabled = json_extract(${slot}, '$.enabled') AND e.enabled = 1
 AND g.archived_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE
  (r.subject_kind = 'device_id' AND r.subject_value = e.device_id)
  OR (r.subject_kind = 'ed25519_key' AND r.subject_value = json_extract(${slot}, '$.keyId'))))`;
}

const NONCE_SQL = `INSERT INTO request_nonces(device_id, nonce, created_at)
 SELECT ?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE ${RELAY_ADMISSION_CLOCK_SQL} >= 0
 AND ?11 <= ${RELAY_ADMISSION_CLOCK_SQL} + 5000 AND ${RELAY_ADMISSION_CLOCK_SQL} < ?4
 AND json_extract(?9, '$.device_id') = ?1 AND ${currentParticipantSql("?9")}
 AND ((?10 IS NULL AND ?12 IS NULL) OR
  (?10 IS NOT NULL AND ?12 IS NOT NULL AND json_extract(?10, '$.device_id') != ?1
   AND ?12 - ${RELAY_ADMISSION_CLOCK_SQL} > 0
   AND ?12 - ${RELAY_ADMISSION_CLOCK_SQL} <= 60000 AND ${currentParticipantSql("?10")}))
 AND ${RELAY_ADMISSION_METADATA_GATE_SQL}
 ON CONFLICT(device_id, nonce) DO NOTHING
 RETURNING device_id AS deviceId, nonce, ?3 AS attemptId,
 ${RELAY_ADMISSION_CLOCK_SQL} AS decidedAtMs, created_at AS createdAt,
 ${RELAY_ADMISSION_METADATA_RETURNING_SQL}`;

function captureStatementParticipants(participants: CapturedRelayAdmissionParticipants) {
	const { source: sourceInput, target: targetInput } = participants;
	if (!Object.isFrozen(participants)) return null;
	const source = captureHashedTuple(sourceInput);
	const target = targetInput === null ? null : captureHashedTuple(targetInput);
	if (!source || (targetInput !== null && !target)) return null;
	return { source, target };
}

function matchCheckParticipants(
	decoded: DecodedRelayCheck,
	participants: CapturedRelayAdmissionParticipants,
) {
	const { source, target } = participants;
	const { groupId } = decoded.value;
	if (decoded.kind === "registration") {
		const { deviceId, keyId } = decoded.value;
		if (target !== null || !matchesParticipant(source, groupId, deviceId, keyId)) return null;
		return { deviceId, routeNotAfterMs: null };
	}
	const route = decoded.value;
	if (!target || !matchesParticipant(target, groupId, route.targetDeviceId, route.targetKeyId))
		return null;
	if (!matchesParticipant(source, groupId, route.sourceDeviceId, route.sourceKeyId)) return null;
	return { deviceId: route.sourceDeviceId, routeNotAfterMs: route.routeNotAfter * 1000 };
}

function compileStatement(
	options: RelayAdmissionNonceStatementOptions,
): RelayAdmissionNonceStatement | null {
	const { check, participants, namespace, policyRevision, attemptId } = options;
	const { authorityId, groupId, relayAudienceId } = namespace;
	const captured = captureStatementParticipants(participants);
	const decoded = captureCheck(check);
	if (!decoded || !captured) return null;
	const matched = matchCheckParticipants(decoded, captured);
	if (!matched) return null;
	const { source, target } = captured;
	const { deviceId, routeNotAfterMs } = matched;
	if (
		!Number.isSafeInteger(policyRevision) ||
		policyRevision <= 0 ||
		typeof attemptId !== "string" ||
		attemptId.length !== 32 ||
		!/^[0-9a-f]+$/.test(attemptId)
	)
		return null;
	const body = decoded.value;
	if (
		body.authorityId !== authorityId ||
		body.groupId !== groupId ||
		body.relayAudienceId !== relayAudienceId
	)
		return null;
	return Object.freeze({
		sql: NONCE_SQL,
		bindings: Object.freeze([
			deviceId,
			decoded.nonce,
			attemptId,
			body.admitBefore * 1000,
			authorityId,
			groupId,
			relayAudienceId,
			policyRevision,
			JSON.stringify(source),
			target === null ? null : JSON.stringify(target),
			body.createdAt * 1000,
			routeNotAfterMs,
		]),
		association: Object.freeze({ deviceId, nonce: decoded.nonce, attemptId }),
	});
}

/**
 * Private, unwired SQL compiler only. It executes no database operations, authenticates
 * no claims, and grants no admission. Frozen tuples must come from the capture helper.
 * Context and capture provenance remain caller-owned. Signature verification, durable
 * ingress, device budgets, and the final eligibility decision belong to the orchestrator.
 */
export function buildRelayAdmissionNonceStatement(
	options: RelayAdmissionNonceStatementOptions,
): RelayAdmissionNonceStatement | null {
	try {
		return compileStatement(options);
	} catch {
		return null;
	}
}
