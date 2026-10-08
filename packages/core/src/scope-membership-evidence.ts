import { createHash } from "node:crypto";
import { parseSshEd25519PublicKeyForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import type { CoordinatorScope, CoordinatorScopeMembership } from "./coordinator-store-contract.js";
import type { Database } from "./db.js";
import {
	normalizeScopeSnapshot,
	type ScopeMembershipSnapshot,
} from "./scope-membership-snapshot.js";

type Batch = ReturnType<typeof normalizeScopeSnapshot>;
type Authority = { coordinatorId: string; groupId: string };
type EvidenceRow = { scope_id: string; device_id: string; evidence_json: string };

// Deliberately excludes presentation labels and timestamps, not authority facts.
const SCOPE_AUTHORITY_FIELDS = [
	"scope_id",
	"kind",
	"authority_type",
	"coordinator_id",
	"group_id",
	"manifest_issuer_device_id",
	"membership_epoch",
	"manifest_hash",
	"status",
] as const;
const MEMBER_AUTHORITY_FIELDS = [
	"scope_id",
	"device_id",
	"role",
	"status",
	"membership_epoch",
	"coordinator_id",
	"group_id",
	"manifest_issuer_device_id",
	"manifest_hash",
	"signed_manifest_json",
] as const;

export function scopeEvidenceTableExists(db: Database): boolean {
	return !!db
		.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get("scope_membership_authorization_evidence");
}

function ensureEvidenceTable(db: Database): void {
	db.exec(`CREATE TABLE IF NOT EXISTS scope_membership_authorization_evidence (
		coordinator_id TEXT NOT NULL, group_id TEXT NOT NULL,
		scope_id TEXT NOT NULL, device_id TEXT NOT NULL, evidence_json TEXT NOT NULL,
		PRIMARY KEY (coordinator_id, group_id, scope_id, device_id)
	)`);
}

function sameFields<T>(left: T, right: T, fields: readonly (keyof T)[]): boolean {
	return fields.every((field) => left[field] === right[field]);
}

function matchesRows(
	batch: Batch,
	scope: CoordinatorScope,
	member: CoordinatorScopeMembership,
): boolean {
	const captured = batch.memberships[0];
	if (!captured) return false;
	return (
		sameFields(batch.scope, scope, SCOPE_AUTHORITY_FIELDS) &&
		batch.memberships.length === 1 &&
		sameFields(captured, member, MEMBER_AUTHORITY_FIELDS)
	);
}

function parseEvidence(raw: string, authority: Authority): Batch | null {
	try {
		const snapshot = JSON.parse(raw) as ScopeMembershipSnapshot;
		const batch = normalizeScopeSnapshot(
			snapshot,
			snapshot.scope,
			authority.groupId,
			authority.coordinatorId,
		);
		return batch.evidence.items.length === 1 ? batch : null;
	} catch {
		return null;
	}
}

function singleMemberEvidence(batch: Batch, index: number): ScopeMembershipSnapshot {
	const item = batch.evidence.items[index];
	if (!item) throw new Error("Scope authorization evidence unavailable.");
	return { ...batch.evidence, items: [item] };
}

/** Called only inside the whole-group cache transaction; never backfills historical rows. */
export function reconcileScopeAuthorizationEvidence(
	db: Database,
	batches: Batch[],
	authority: Authority,
	options: { removalOnly: boolean },
): void {
	if (options.removalOnly) {
		pruneEvidence(db, batches, authority);
		return;
	}
	ensureEvidenceTable(db);
	db.prepare(
		"DELETE FROM scope_membership_authorization_evidence WHERE coordinator_id = ? AND group_id = ?",
	).run(authority.coordinatorId, authority.groupId);
	const insert = db.prepare(`INSERT INTO scope_membership_authorization_evidence
		(coordinator_id, group_id, scope_id, device_id, evidence_json) VALUES (?, ?, ?, ?, ?)`);
	for (const batch of batches) {
		for (const [index, member] of batch.memberships.entries()) {
			insert.run(
				authority.coordinatorId,
				authority.groupId,
				batch.scope.scope_id,
				member.device_id,
				JSON.stringify(singleMemberEvidence(batch, index)),
			);
		}
	}
}

function sameProof(previous: Batch, current: Batch): boolean {
	const oldItem = previous.evidence.items[0];
	const item = current.evidence.items[0];
	const member = current.memberships[0];
	if (!oldItem || !item || !member) return false;
	return (
		matchesRows(previous, current.scope, member) &&
		previous.sourceCoordinatorId === current.sourceCoordinatorId &&
		oldItem.key_id === item.key_id &&
		sameFields(oldItem.membership, item.membership, MEMBER_AUTHORITY_FIELDS) &&
		sameFields(oldItem.enrollment, item.enrollment, [
			"group_id",
			"device_id",
			"fingerprint",
			"enabled",
		])
	);
}

function pruneEvidence(db: Database, batches: Batch[], authority: Authority): void {
	if (!scopeEvidenceTableExists(db)) return;
	const rows = db
		.prepare(`SELECT scope_id, device_id, evidence_json
		FROM scope_membership_authorization_evidence WHERE coordinator_id = ? AND group_id = ?`)
		.all(authority.coordinatorId, authority.groupId) as EvidenceRow[];
	const remove = db.prepare(`DELETE FROM scope_membership_authorization_evidence
		WHERE coordinator_id = ? AND group_id = ? AND scope_id = ? AND device_id = ?`);
	for (const row of rows) {
		const batch = batches.find((item) => item.scope.scope_id === row.scope_id);
		const index =
			batch?.memberships.findIndex((member) => member.device_id === row.device_id) ?? -1;
		const old = parseEvidence(row.evidence_json, authority);
		const current =
			batch && index >= 0
				? normalizeScopeSnapshot(
						singleMemberEvidence(batch, index),
						batch.evidence.scope,
						authority.groupId,
						authority.coordinatorId,
					)
				: null;
		if (!old || !current || !sameProof(old, current))
			remove.run(authority.coordinatorId, authority.groupId, row.scope_id, row.device_id);
	}
}

/** Evidence is not a lease: freshness policy remains with the caller. Malformed storage denies. */
export function getRetainedScopeAuthorizationKey(
	db: Database,
	scope: CoordinatorScope,
	member: CoordinatorScopeMembership,
	expectedPublicKey?: string,
): string | null {
	try {
		if (!scope.coordinator_id || !scope.group_id || !scopeEvidenceTableExists(db)) return null;
		const authority = { coordinatorId: scope.coordinator_id, groupId: scope.group_id };
		const row = db
			.prepare(`SELECT evidence_json FROM scope_membership_authorization_evidence
			WHERE coordinator_id = ? AND group_id = ? AND scope_id = ? AND device_id = ?`)
			.get(authority.coordinatorId, authority.groupId, scope.scope_id, member.device_id) as
			| EvidenceRow
			| undefined;
		const proof = row && parseEvidence(row.evidence_json, authority);
		if (!proof || !matchesRows(proof, scope, member)) return null;
		const keyId = proof.evidence.items[0]?.key_id;
		if (!keyId) return null;
		if (expectedPublicKey !== undefined) {
			const parsed = parseSshEd25519PublicKeyForRevocation(expectedPublicKey);
			if (
				parsed.kind !== "ed25519" ||
				createHash("sha256").update(parsed.blob).digest("hex") !== keyId
			)
				return null;
		}
		return keyId;
	} catch {
		return null;
	}
}
