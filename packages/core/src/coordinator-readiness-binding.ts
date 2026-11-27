import { isBoundaryReadinessGeneration } from "./boundary-readiness-generation.js";

export interface ReadinessPreparation {
	coordinatorId: string;
	groupId: string;
	generation: string;
}

export interface ReadinessBinding {
	coordinatorId: string;
	generation: string;
	keyId: string;
	publicKey: string;
	revision: number;
	filterEvidence: "none" | "present" | "unknown";
}

export function validReadinessBinding(binding: ReadinessBinding): boolean {
	return (
		typeof binding.coordinatorId === "string" &&
		binding.coordinatorId.startsWith("https://") &&
		isBoundaryReadinessGeneration(binding.generation) &&
		/^[a-f0-9]{64}$/u.test(binding.keyId) &&
		typeof binding.publicKey === "string" &&
		binding.publicKey.length > 0 &&
		Number.isSafeInteger(binding.revision) &&
		binding.revision > 0 &&
		["none", "present", "unknown"].includes(binding.filterEvidence)
	);
}

export const READINESS_BINDING_MIGRATION = "0057_bind_boundary_readiness.sql";
export const READINESS_AUDIENCE_COLUMN =
	"ALTER TABLE groups ADD COLUMN readiness_coordinator_id TEXT";
export const READINESS_BINDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS coordinator_readiness_bindings (
  group_id TEXT NOT NULL, device_id TEXT NOT NULL, record_id TEXT NOT NULL,
  coordinator_id TEXT NOT NULL, generation TEXT NOT NULL, key_id TEXT NOT NULL, public_key TEXT NOT NULL,
  sequence INTEGER NOT NULL, refresh_revision INTEGER NOT NULL, filter_evidence TEXT NOT NULL,
  PRIMARY KEY (group_id, device_id)
);
`;

export const READINESS_BINDING_PRESENT = `SELECT (
	EXISTS(SELECT 1 FROM pragma_table_info('groups') WHERE name='readiness_coordinator_id')
	AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='coordinator_readiness_bindings')
	) AS present`;

// Both the write and the decision read check the live enrollment, not merely
// the enrollment returned when the request signature was verified.
const ACTIVE_SIGNER = `FROM groups g
	JOIN enrolled_devices e ON e.group_id=g.group_id AND e.enabled=1
	WHERE g.readiness_coordinator_id=? AND g.readiness_generation=? AND g.group_id=? AND e.device_id=?
	AND g.archived_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE
		(r.subject_kind='device_id' AND r.subject_value=e.device_id) OR
		(r.subject_kind='ed25519_key' AND r.subject_value=e.key_id))`;

export function signerCondition(binding: ReadinessBinding, device: string[], sequence: number) {
	return {
		sql: `EXISTS (SELECT 1 ${ACTIVE_SIGNER} AND e.public_key=? AND e.key_id=?)
			AND NOT EXISTS (SELECT 1 FROM coordinator_readiness_bindings
				WHERE group_id=? AND device_id=? AND generation=? AND (sequence>=? OR refresh_revision>?))`,
		values: [
			binding.coordinatorId,
			binding.generation,
			...device,
			binding.publicKey,
			binding.keyId,
			...device,
			binding.generation,
			sequence,
			binding.revision,
		],
	};
}

export function bindAcceptedRecord(binding: ReadinessBinding, device: string[], recordId: string) {
	return {
		sql: `INSERT INTO coordinator_readiness_bindings
		(group_id,device_id,record_id,sequence,coordinator_id,generation,key_id,public_key,refresh_revision,filter_evidence)
		SELECT group_id,device_id,record_id,sequence,?,?,?,?,?,? FROM coordinator_boundary_readiness
		WHERE group_id=? AND device_id=? AND record_id=?
		ON CONFLICT(group_id,device_id) DO UPDATE SET record_id=excluded.record_id,sequence=excluded.sequence,
		coordinator_id=excluded.coordinator_id,generation=excluded.generation,key_id=excluded.key_id,public_key=excluded.public_key,
		refresh_revision=excluded.refresh_revision,filter_evidence=excluded.filter_evidence`,
		values: [
			binding.coordinatorId,
			binding.generation,
			binding.keyId,
			binding.publicKey,
			binding.revision,
			binding.filterEvidence,
			...device,
			recordId,
		],
	};
}

/** A legacy write or discard breaks the record_id join but retains the sequence floor. */
export function currentBinding(prep: ReadinessPreparation, deviceId: string) {
	return {
		sql: `SELECT b.record_id, b.sequence, b.key_id, b.refresh_revision, b.filter_evidence
		FROM coordinator_readiness_bindings b WHERE b.group_id=? AND b.device_id=?
		AND EXISTS (SELECT 1 ${ACTIVE_SIGNER} AND e.public_key=b.public_key AND e.key_id=b.key_id
			AND g.readiness_generation=b.generation AND g.readiness_coordinator_id=b.coordinator_id)`,
		values: [prep.groupId, deviceId, prep.coordinatorId, prep.generation, prep.groupId, deviceId],
		read: true,
	};
}
