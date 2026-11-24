import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { verifyDeviceRejoinProof } from "./coordinator-device-rejoin-proof.js";

export const DEVICE_REJOIN_STATUS_MAX_BODY_BYTES = 4 * 1024;
const STATUS_FIELDS = ["device_id", "timestamp_ms", "signature"] as const;
const POLL_WINDOW_MS = 5 * 60 * 1000;

export interface DeviceRejoinStatusInput {
	deviceId: string;
	timestampMs: number;
	signature: string;
}

type ParsedStatus =
	| { ok: true; input: DeviceRejoinStatusInput }
	| { ok: false; error: "device_rejoin_invalid_input" | "body_too_large" };

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Each poll needs its own fresh timestamp, including after the attempt deadline. */
export function isFreshDeviceRejoinStatus(timestampMs: unknown, now: unknown): boolean {
	return (
		isTimestamp(timestampMs) && isTimestamp(now) && Math.abs(timestampMs - now) <= POLL_WINDOW_MS
	);
}

/** Wire validation only. Authentication is a separate read-only operation. */
export function parseDeviceRejoinStatusBody(raw: Uint8Array): ParsedStatus {
	if (raw.byteLength > DEVICE_REJOIN_STATUS_MAX_BODY_BYTES)
		return { ok: false, error: "body_too_large" };
	const invalid = { ok: false, error: "device_rejoin_invalid_input" } as const;
	try {
		const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
		if (!data || typeof data !== "object" || Array.isArray(data)) return invalid;
		if (
			Object.keys(data).length !== STATUS_FIELDS.length ||
			!STATUS_FIELDS.every((field) => Object.hasOwn(data, field))
		)
			return invalid;
		const {
			device_id: deviceId,
			timestamp_ms: timestampMs,
			signature,
		} = data as Record<string, unknown>;
		if (!isAuthControllerId(deviceId) || !isTimestamp(timestampMs) || typeof signature !== "string")
			return invalid;
		return { ok: true, input: { deviceId, timestampMs, signature } };
	} catch {
		return invalid;
	}
}

/** Server-trusted configuration and the validated route attempt ID, never body pins. */
export interface DeviceRejoinStatusScope {
	coordinatorId: string | null;
	attemptId: string;
	origin: string;
	issuer: string;
	authConfigRevision: string;
	now: number;
}

interface StatusRow {
	state: string;
	expires_at_ms: number;
	key_id: string;
	public_key: string;
}

// A lifted tombstone still records the original signer. Status never substitutes an
// enrollment key or requires the removal to remain active.
const STATUS_SQL = `SELECT a.state, a.expires_at_ms, a.key_id, t.public_key
FROM coordinator_device_rejoin_attempts a
JOIN json_each(a.own_tombstones_json) p
JOIN coordinator_device_removals t
 ON t.removal_seq = json_extract(p.value, '$[0]')
 AND t.group_id = json_extract(p.value, '$[1]')
 AND t.public_key = json_extract(p.value, '$[2]')
 AND t.fingerprint = json_extract(p.value, '$[3]')
 AND t.device_id = a.device_id AND t.key_id = a.key_id
WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.device_id = ?
 AND a.origin = ? AND a.issuer = ? AND a.auth_config_revision = ?
ORDER BY t.removal_seq LIMIT 1`;

/**
 * Internal authentication primitive, not a response projection. Missing and invalid
 * proofs both return null. The trusted caller chooses expiry policy and projection.
 * No receipt or temporary browser/completion material is read or returned.
 */
export async function readVerifiedDeviceRejoinStatus(
	backend: Pick<AuthLinkBackend, "first">,
	scope: DeviceRejoinStatusScope,
	input: DeviceRejoinStatusInput,
): Promise<{ state: string; expiresAtMs: number; deadlineElapsed: boolean } | null> {
	const { coordinatorId, attemptId, origin, issuer, authConfigRevision, now } = scope;
	const { deviceId, timestampMs, signature } = input;
	if (
		!isAuthControllerId(coordinatorId) ||
		!isAuthControllerId(attemptId) ||
		!isAuthControllerId(deviceId) ||
		!isFreshDeviceRejoinStatus(timestampMs, now)
	)
		return null;
	const row = await backend.first<StatusRow>({
		sql: STATUS_SQL,
		values: [coordinatorId, attemptId, deviceId, origin, issuer, authConfigRevision],
	});
	if (!row) return null;
	if (
		!(await verifyDeviceRejoinProof(
			{ operation: "status", origin, attemptId, deviceId, keyId: row.key_id, timestampMs },
			{ tombstonePublicKey: row.public_key, signature },
		))
	)
		return null;
	return {
		state: row.state,
		expiresAtMs: row.expires_at_ms,
		deadlineElapsed: now >= row.expires_at_ms,
	};
}
