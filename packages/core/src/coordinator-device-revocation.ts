import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { hashEd25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	ed25519KeyIdForRevocation,
	parseSshEd25519PublicKeyForRevocation,
} from "./coordinator-ed25519-key-id-compat.js";

export interface CoordinatorDeviceRevocationRecord {
	readonly subject_kind: "device_id" | "ed25519_key";
	readonly subject_value: string;
	readonly revocation_id: string;
	readonly evidence_group_id: string;
	readonly evidence_device_id: string;
	readonly evidence_public_key: string;
	readonly evidence_fingerprint: string;
	readonly actor_id: string | null;
	readonly created_at: string;
}

export interface CoordinatorCreateDeviceRevocationInput {
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	/** Audit evidence only; this internal capability requires a trusted caller. */
	actorId?: string | null;
}
export interface CoordinatorListDeviceRevocationsInput {
	deviceId?: string;
	publicKey?: string;
}
export interface CoordinatorRecordAuthorizedNonceInput {
	groupId: string;
	deviceId: string;
	publicKey: string;
	nonce: string;
	createdAt: string;
}
export type CoordinatorCreateDeviceRevocationResult =
	| { kind: "revoked"; records: CoordinatorDeviceRevocationRecord[] }
	| { kind: "rejected"; error: "invalid_input" | "enrollment_mismatch" };
export type CoordinatorAuthorizedNonceResult =
	| "recorded"
	| "nonce_replay"
	| "device_revoked"
	| "unknown_device"
	| "device_disabled"
	| "group_not_found"
	| "group_archived";

export interface CoordinatorDeviceRevocationStore {
	createDeviceRevocation(
		input: CoordinatorCreateDeviceRevocationInput,
	): Promise<CoordinatorCreateDeviceRevocationResult>;
	listDeviceRevocations(
		input: CoordinatorListDeviceRevocationsInput,
	): Promise<CoordinatorDeviceRevocationRecord[]>;
	recordAuthorizedNonce(
		input: CoordinatorRecordAuthorizedNonceInput,
	): Promise<CoordinatorAuthorizedNonceResult>;
}

export const DEVICE_REVOCATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_device_revocations (
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('device_id', 'ed25519_key')),
  subject_value TEXT NOT NULL CHECK(
    (subject_kind = 'device_id' AND length(subject_value) BETWEEN 1 AND 256) OR
    (subject_kind = 'ed25519_key' AND length(subject_value) = 64
      AND subject_value NOT GLOB '*[^a-f0-9]*')),
  revocation_id TEXT NOT NULL,
  evidence_group_id TEXT NOT NULL,
  evidence_device_id TEXT NOT NULL,
  evidence_public_key TEXT NOT NULL,
  evidence_fingerprint TEXT NOT NULL,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_value)
);
`;

interface RevocationStatement {
	sql: string;
	values: (string | null)[];
	read?: boolean;
}
export interface DeviceRevocationBackend {
	/** All statements, including reads, execute in one transaction. */
	batch(statements: RevocationStatement[]): Promise<unknown[]>;
	all(statement: RevocationStatement): Promise<unknown>;
}

const INVALID_SCALAR = Symbol("invalid_input");
function own(input: unknown, key: string): unknown {
	if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(input, key);
	if (!descriptor) return undefined;
	return "value" in descriptor ? descriptor.value : INVALID_SCALAR;
}
function exactText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !value.includes("\0");
}
function captureRevocation(
	input: unknown,
): Readonly<Required<CoordinatorCreateDeviceRevocationInput>> | null {
	const groupId = own(input, "groupId"),
		deviceId = own(input, "deviceId");
	const publicKey = own(input, "publicKey"),
		fingerprint = own(input, "fingerprint");
	const actorId = own(input, "actorId") ?? null;
	if (
		!isAuthControllerId(groupId) ||
		!isAuthControllerId(deviceId) ||
		!exactText(publicKey) ||
		!exactText(fingerprint) ||
		(actorId !== null && !isAuthControllerId(actorId))
	)
		return null;
	return Object.freeze({ groupId, deviceId, publicKey, fingerprint, actorId });
}
function captureNonce(input: unknown): Readonly<CoordinatorRecordAuthorizedNonceInput> {
	const groupId = own(input, "groupId"),
		deviceId = own(input, "deviceId");
	const publicKey = own(input, "publicKey"),
		nonce = own(input, "nonce");
	const createdAt = own(input, "createdAt");
	if (
		!exactText(groupId) ||
		!exactText(deviceId) ||
		!exactText(publicKey) ||
		!exactText(nonce) ||
		!exactText(createdAt)
	)
		throw new Error("invalid_input");
	return Object.freeze({ groupId, deviceId, publicKey, nonce, createdAt });
}
function resultRows<T>(result: unknown): T[] {
	if (
		!result ||
		typeof result !== "object" ||
		("success" in result && result.success === false) ||
		!("results" in result) ||
		!Array.isArray(result.results)
	)
		throw new Error("device_revocation_incomplete");
	return result.results as T[];
}
function resultChanges(result: unknown): number {
	if (
		!result ||
		typeof result !== "object" ||
		("success" in result && result.success === false) ||
		!("meta" in result) ||
		!result.meta ||
		typeof result.meta !== "object" ||
		!("changes" in result.meta) ||
		!Number.isSafeInteger(result.meta.changes) ||
		(result.meta.changes as number) < 0
	)
		throw new Error("device_revocation_incomplete");
	return result.meta.changes as number;
}

function incompleteResult(): never {
	throw new Error("device_revocation_incomplete");
}

const CURRENT_TUPLE_SQL = `SELECT 1 FROM enrolled_devices
WHERE group_id = ? AND device_id = ? AND public_key = ? AND fingerprint = ?`;
const SUBJECTS_SQL = `SELECT * FROM coordinator_device_revocations WHERE
(subject_kind = 'device_id' AND subject_value = ?) OR
(subject_kind = 'ed25519_key' AND subject_value = ?)
ORDER BY subject_kind, subject_value`;
const NONCE_CONTEXT_SQL = `WITH input(group_id, device_id, public_key, nonce, created_at, key_id)
AS (VALUES (?, ?, ?, ?, ?, ?))`;
const REVOKED_SQL = `EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE
(r.subject_kind = 'device_id' AND r.subject_value = i.device_id) OR
(r.subject_kind = 'ed25519_key' AND r.subject_value = i.key_id))`;
const AUTHORIZED_NONCE_SQL = `${NONCE_CONTEXT_SQL}
INSERT INTO request_nonces(device_id, nonce, created_at)
SELECT i.device_id, i.nonce, i.created_at FROM input i
JOIN enrolled_devices e ON e.group_id = i.group_id AND e.device_id = i.device_id
JOIN groups g ON g.group_id = i.group_id
WHERE e.public_key = i.public_key AND e.enabled = 1 AND g.archived_at IS NULL
AND NOT ${REVOKED_SQL}
ON CONFLICT(device_id, nonce) DO NOTHING`;
const NONCE_CLASSIFY_SQL = `${NONCE_CONTEXT_SQL}
SELECT CASE
WHEN ${REVOKED_SQL} THEN 'device_revoked'
WHEN g.group_id IS NULL THEN 'group_not_found'
WHEN g.archived_at IS NOT NULL THEN 'group_archived'
WHEN e.device_id IS NULL OR e.public_key != i.public_key THEN 'unknown_device'
WHEN e.enabled != 1 THEN 'device_disabled'
ELSE 'nonce_replay' END AS status
FROM input i LEFT JOIN groups g ON g.group_id = i.group_id
LEFT JOIN enrolled_devices e ON e.group_id = i.group_id AND e.device_id = i.device_id`;

function revocationStatements(
	input: Required<CoordinatorCreateDeviceRevocationInput>,
	keyId: string | null,
	now: string,
): RevocationStatement[] {
	const tuple = [input.groupId, input.deviceId, input.publicKey, input.fingerprint];
	const subjects = [{ kind: "device_id", value: input.deviceId }];
	if (keyId) subjects.push({ kind: "ed25519_key", value: keyId });
	const revocationId = globalThis.crypto.randomUUID();
	const writes = subjects.map(({ kind, value }) => ({
		sql: `INSERT INTO coordinator_device_revocations(subject_kind, subject_value, revocation_id,
evidence_group_id, evidence_device_id, evidence_public_key, evidence_fingerprint, actor_id, created_at)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${CURRENT_TUPLE_SQL})
ON CONFLICT(subject_kind, subject_value) DO NOTHING`,
		values: [kind, value, revocationId, ...tuple, input.actorId, now, ...tuple],
	}));
	return [
		{ sql: CURRENT_TUPLE_SQL, values: tuple, read: true },
		...writes,
		{ sql: SUBJECTS_SQL, values: [input.deviceId, keyId], read: true },
	];
}

/** Internal storage capability only. Removal of the current tuple prevents creation and retry. */
export class DeviceRevocationOperations implements CoordinatorDeviceRevocationStore {
	constructor(
		private readonly backend: DeviceRevocationBackend,
		private readonly clock: () => number = Date.now,
	) {}

	async createDeviceRevocation(
		raw: CoordinatorCreateDeviceRevocationInput,
	): Promise<CoordinatorCreateDeviceRevocationResult> {
		const input = captureRevocation(raw);
		if (!input) return { kind: "rejected", error: "invalid_input" };
		const keyId = await ed25519KeyIdForRevocation(input.publicKey);
		const statements = revocationStatements(input, keyId, new Date(this.clock()).toISOString());
		const results = await this.backend.batch(statements).catch(incompleteResult);
		if (results.length !== statements.length) throw new Error("device_revocation_incomplete");
		for (const result of results.slice(1, -1)) resultChanges(result);
		if (resultRows(results[0]).length === 0)
			return { kind: "rejected", error: "enrollment_mismatch" };
		const records = resultRows<CoordinatorDeviceRevocationRecord>(results.at(-1));
		if (
			!records.some((r) => r.subject_kind === "device_id" && r.subject_value === input.deviceId) ||
			(keyId && !records.some((r) => r.subject_kind === "ed25519_key" && r.subject_value === keyId))
		)
			throw new Error("device_revocation_incomplete");
		return { kind: "revoked", records };
	}

	async listDeviceRevocations(
		input: CoordinatorListDeviceRevocationsInput,
	): Promise<CoordinatorDeviceRevocationRecord[]> {
		const deviceId = own(input, "deviceId"),
			publicKey = own(input, "publicKey");
		if (
			(deviceId !== undefined && !isAuthControllerId(deviceId)) ||
			(publicKey !== undefined && !exactText(publicKey)) ||
			(deviceId === undefined && publicKey === undefined)
		)
			throw new Error("invalid_input");
		const keyId =
			publicKey === undefined ? null : await ed25519KeyIdForRevocation(publicKey as string);
		return resultRows<CoordinatorDeviceRevocationRecord>(
			await this.backend
				.all({
					sql: SUBJECTS_SQL,
					values: [(deviceId as string | undefined) ?? null, keyId],
					read: true,
				})
				.catch(incompleteResult),
		);
	}

	async recordAuthorizedNonce(
		raw: CoordinatorRecordAuthorizedNonceInput,
	): Promise<CoordinatorAuthorizedNonceResult> {
		const input = captureNonce(raw);
		const parsedKey = parseSshEd25519PublicKeyForRevocation(input.publicKey);
		if (parsedKey.kind === "malformed_ed25519") return "unknown_device";
		const keyId = await hashEd25519KeyId(parsedKey);
		const values = [
			input.groupId,
			input.deviceId,
			input.publicKey,
			input.nonce,
			input.createdAt,
			keyId,
		];
		const results = await this.backend
			.batch([
				{ sql: AUTHORIZED_NONCE_SQL, values },
				{ sql: NONCE_CLASSIFY_SQL, values, read: true },
			])
			.catch(incompleteResult);
		if (results.length !== 2) throw new Error("device_revocation_incomplete");
		const changes = resultChanges(results[0]);
		const rows = resultRows<{ status: CoordinatorAuthorizedNonceResult }>(results[1]);
		if (rows.length !== 1 || changes > 1) throw new Error("device_revocation_incomplete");
		if (changes === 1) return "recorded";
		const status = rows[0]?.status;
		if (
			!status ||
			![
				"nonce_replay",
				"device_revoked",
				"unknown_device",
				"device_disabled",
				"group_not_found",
				"group_archived",
			].includes(status)
		)
			throw new Error("device_revocation_incomplete");
		return status;
	}
}
