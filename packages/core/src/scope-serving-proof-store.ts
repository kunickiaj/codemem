import { isBoundaryReadinessGeneration } from "./boundary-readiness-generation.js";
import type { Database } from "./db.js";
import { scopeEvidenceTableExists } from "./scope-membership-evidence.js";

type Preparation = { coordinatorId: string; groupId: string; generation: string };
type Envelope = { scopeId: string; deviceId: string; keyId: string; envelope: Uint8Array };

const SCHEMA = `CREATE TABLE IF NOT EXISTS scope_serving_preparations (
	coordinator_id TEXT NOT NULL, group_id TEXT NOT NULL, generation TEXT NOT NULL,
	PRIMARY KEY (coordinator_id,group_id), UNIQUE (coordinator_id,group_id,generation)
);
CREATE TABLE IF NOT EXISTS scope_serving_proofs_v2 (
	coordinator_id TEXT NOT NULL, group_id TEXT NOT NULL, generation TEXT NOT NULL,
	scope_id TEXT NOT NULL, device_id TEXT NOT NULL, key_id TEXT NOT NULL, envelope BLOB NOT NULL,
	PRIMARY KEY (coordinator_id,group_id,generation,scope_id,device_id),
	FOREIGN KEY (coordinator_id,group_id,generation)
		REFERENCES scope_serving_preparations(coordinator_id,group_id,generation)
);`;

/** Device-local step only. The caller must already have stopped v1 issuance and
 * drained serving and refreshes. No production operation starts preparation. */
export function prepareScopeServingStore(
	db: Database,
	input: Preparation,
	envelopes: readonly Envelope[],
): void {
	const { coordinatorId, groupId, generation } = input;
	if (!coordinatorId.trim() || !groupId.trim() || !isBoundaryReadinessGeneration(generation))
		throw new Error("Invalid scope serving preparation");
	db.transaction(() => {
		db.exec(SCHEMA);
		db.prepare(`INSERT INTO scope_serving_preparations VALUES (?,?,?)
			ON CONFLICT(coordinator_id,group_id) DO NOTHING`).run(coordinatorId, groupId, generation);
		if (
			!db
				.prepare(`SELECT 1 FROM scope_serving_preparations
			WHERE coordinator_id=? AND group_id=? AND generation=?`)
				.get(coordinatorId, groupId, generation)
		)
			throw new Error("Conflicting scope serving generation");
		if (scopeEvidenceTableExists(db))
			db.prepare(`DELETE FROM scope_membership_authorization_evidence
				WHERE coordinator_id=? AND group_id=?`).run(coordinatorId, groupId);
		for (const envelope of envelopes)
			storeScopeServingEnvelope(db, { ...envelope, coordinatorId, groupId, generation });
	}).immediate();
}

/** Stores opaque bytes for a future verifier. Storage confers no access and
 * never converts legacy evidence into a proof. */
function storeScopeServingEnvelope(
	db: Database,
	input: Preparation & { scopeId: string; deviceId: string; keyId: string; envelope: Uint8Array },
): void {
	if (
		!input.scopeId.trim() ||
		!input.deviceId.trim() ||
		!/^[a-f0-9]{64}$/u.test(input.keyId) ||
		!input.envelope.length
	)
		throw new Error("Invalid scope serving envelope");
	const result = db
		.prepare(`INSERT INTO scope_serving_proofs_v2
		(coordinator_id,group_id,generation,scope_id,device_id,key_id,envelope)
		SELECT coordinator_id,group_id,generation,?,?,?,? FROM scope_serving_preparations
		WHERE coordinator_id=? AND group_id=? AND generation=?
		ON CONFLICT(coordinator_id,group_id,generation,scope_id,device_id)
		DO UPDATE SET key_id=excluded.key_id,envelope=excluded.envelope`)
		.run(
			input.scopeId,
			input.deviceId,
			input.keyId,
			input.envelope,
			input.coordinatorId,
			input.groupId,
			input.generation,
		);
	if (result.changes !== 1) throw new Error("Missing scope serving preparation");
}
