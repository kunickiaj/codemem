import {
	decodeRelayCheckPacket,
	encodeRelayAdmissionBody,
	encodeRelayCheckPacket,
	encodeRelayRegistrationBody,
	type RelayAdmissionRole,
} from "./relay-admission-codec.js";
import {
	buildRelayAdmissionNonceStatement,
	captureRelayAdmissionParticipants,
} from "./relay-admission-participant-nonce.js";

// RFC 8032 public keys only. These fixtures test hashing and packet format,
// never signatures, budget authorization, or end-to-end admission.
export const PARTICIPANT_KEYS = [
	{
		publicKey:
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea fixture",
		keyId: "6db5e9b8a1bace1cdd9a7c6adb9e9396acc5073465d9fe8e3a0ef6d9c60d6d4f",
	},
	{
		publicKey:
			"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM fixture",
		keyId: "177e278a7eed71a607e964792d25927e3eb078504f7c1a6ec945283c53fd6230",
	},
] as const;

export function participantRows(groupId = "group-A", sourceDeviceId = "source") {
	const makeRow = (deviceId: string, publicKey: string, fingerprint: string) => ({
		group_id: groupId,
		device_id: deviceId,
		public_key: publicKey,
		fingerprint,
		identity_id: null as string | null,
		enabled: 1,
	});
	return [
		makeRow(sourceDeviceId, PARTICIPANT_KEYS[0].publicKey, "0".repeat(64)),
		makeRow("target", PARTICIPANT_KEYS[1].publicKey, "1".repeat(64)),
	] as const;
}

export type ParticipantFixtureOptions = {
	role?: RelayAdmissionRole | "registration";
	createdAt?: number;
	authorityId?: string;
	groupId?: string;
	sourceDeviceId?: string;
};

export async function participantFixture(options: ParticipantFixtureOptions = {}) {
	const role = options.role ?? "source";
	const createdAt = options.createdAt ?? 100;
	const namespace = {
		authorityId: options.authorityId ?? "a".repeat(64),
		groupId: options.groupId ?? "group-A",
		relayAudienceId: "f".repeat(64),
	};
	const rows = participantRows(namespace.groupId, options.sourceDeviceId);
	const context = {
		groupId: namespace.groupId,
		sourceDeviceId: rows[0].device_id,
		...(role === "registration" ? {} : { targetDeviceId: rows[1].device_id }),
	};
	const participants = await captureRelayAdmissionParticipants(
		role === "registration" ? rows.slice(0, 1) : rows,
		context,
	);
	if (!participants) throw new Error("valid public participant fixture rejected");
	const common = { ...namespace, createdAt, admitBefore: createdAt + 30 };
	let bodyBytes: Uint8Array;
	if (role === "registration") {
		bodyBytes = encodeRelayRegistrationBody({
			...common,
			deviceId: rows[0].device_id,
			keyId: PARTICIPANT_KEYS[0].keyId,
			socketChallengeId: "e".repeat(32),
		});
	} else {
		bodyBytes = encodeRelayAdmissionBody({
			...common,
			role,
			sourceDeviceId: rows[0].device_id,
			sourceKeyId: PARTICIPANT_KEYS[0].keyId,
			targetDeviceId: rows[1].device_id,
			targetKeyId: PARTICIPANT_KEYS[1].keyId,
			routeSessionId: "e".repeat(32),
			messageADigest: "d".repeat(64),
			routeNotAfter: createdAt + 55,
		});
	}
	const check = decodeRelayCheckPacket(
		encodeRelayCheckPacket({
			bodyBytes,
			timestamp: String(createdAt),
			nonce: "b".repeat(32),
			signatureBytes: new Uint8Array(64),
		}),
	);
	const input = { check, participants, namespace, policyRevision: 1, attemptId: "c".repeat(32) };
	const statement = buildRelayAdmissionNonceStatement(input);
	if (!statement) throw new Error("valid compiler fixture rejected");
	return { rows, context, input, statement };
}

// Ordinary coordinator tables, created only in a fresh :memory: test database.
// Native D1 tests use their migrated baseline instead of installing these.
export const PARTICIPANT_TEST_SCHEMA_SQL = `
CREATE TABLE groups(group_id TEXT PRIMARY KEY, archived_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE enrolled_devices(group_id TEXT NOT NULL,device_id TEXT NOT NULL,
 public_key TEXT NOT NULL,fingerprint TEXT NOT NULL,identity_id TEXT,
 enabled INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,PRIMARY KEY(group_id,device_id));
CREATE TABLE request_nonces(device_id TEXT NOT NULL,nonce TEXT NOT NULL,
 created_at TEXT NOT NULL,PRIMARY KEY(device_id,nonce));
CREATE TABLE coordinator_device_revocations(subject_kind TEXT NOT NULL,subject_value TEXT NOT NULL,
 revocation_id TEXT NOT NULL,evidence_group_id TEXT NOT NULL,evidence_device_id TEXT NOT NULL,
 evidence_public_key TEXT NOT NULL,evidence_fingerprint TEXT NOT NULL,actor_id TEXT,created_at TEXT NOT NULL,
 PRIMARY KEY(subject_kind,subject_value));`;

export const PARTICIPANT_GROUP_INSERT = "INSERT INTO groups(group_id,created_at) VALUES (?1,?2)";
export const PARTICIPANT_DEVICE_INSERT = `INSERT INTO enrolled_devices
(group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)`;
export const PARTICIPANT_REVOCATION_INSERT = `INSERT INTO coordinator_device_revocations
(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
VALUES (?1,?2,'fixture-revocation','unrelated-evidence-group','unrelated-device','public-fixture','fixture','1970-01-01T00:00:00.000Z')`;
export const PARTICIPANT_CREATED_AT = "1970-01-01T00:00:00.000Z";
