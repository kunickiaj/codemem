import type { Database } from "better-sqlite3";

/** The device whose retained legacy ownership is checked, as the race changes see it. */
export interface RaceSubject {
	coordinatorId: string;
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
	ownerIdentityId: string;
}

export interface NegativeOwnerChange {
	/** The fact that changes, and the reads of the negative owner check that select it. */
	fact: string;
	reads: string;
	/** Optional setup before the reads, so the fact exists to change. */
	arrange?(db: Database, s: RaceSubject): void;
	change(db: Database, s: RaceSubject): void;
	/** Sites where the fact cannot change, with the reason. */
	skip?: Partial<Record<"binding", string>>;
}

const RACED_AT = "2026-10-20T00:00:00.000Z";
const UNPARSED_KEY = "raced unparsed key";

function insert(db: Database, table: string, row: Record<string, unknown>): void {
	const keys = Object.keys(row);
	db.prepare(
		`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
	).run(...Object.values(row));
}

/** A consumed Team invite that assigned this device to its owner: compatible evidence. */
function ownInvite(s: RaceSubject): Record<string, unknown> {
	return {
		invite_id: "raced-own-invite",
		group_id: s.groupId,
		token: "raced-own-invite-token",
		policy: "auto_admit",
		created_at: "2026-10-01T00:00:00.000Z",
		expires_at: "2026-12-01T00:00:00.000Z",
		consumed_at: "2026-10-02T00:00:00.000Z",
		bound_device_id: s.deviceId,
		bound_public_key: s.publicKey,
		bound_fingerprint: s.fingerprint,
		invite_kind: "team_member",
		assigned_identity_id: s.ownerIdentityId,
		recipient_actor_id: s.ownerIdentityId,
		reviewed_preview_digest: "a".repeat(64),
	};
}

/**
 * One change per read of the negative owner check, each made after the reads and before
 * the write. Several facts are selected by more than one read; `reads` names them all.
 */
export const NEGATIVE_OWNER_CHANGES: NegativeOwnerChange[] = [
	{
		fact: "the resolution table gains an index",
		reads: "catalog, schema",
		change: (db) =>
			db.exec(
				"CREATE INDEX raced_resolution_index ON coordinator_legacy_owner_resolutions(created_at)",
			),
	},
	{
		fact: "a second retained resolution for the device",
		reads: "retained resolutions, resolutions",
		change: (db) =>
			db.exec(`INSERT INTO coordinator_legacy_owner_resolutions SELECT coordinator_id,'raced-resolution',resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at
 FROM coordinator_legacy_owner_resolutions LIMIT 1`),
	},
	{
		fact: "a consumed invite whose key cannot be ruled out",
		reads: "discovery",
		change: (db, s) =>
			insert(db, "coordinator_invites", {
				...ownInvite(s),
				invite_id: "raced-unparsed-invite",
				token: "raced-unparsed-invite-token",
				bound_device_id: "raced-other-device",
				bound_public_key: UNPARSED_KEY,
			}),
	},
	{
		fact: "an ownership binding of the device",
		reads: "bindings",
		change: (db, s) =>
			insert(db, "coordinator_device_ownership_bindings", {
				device_id: s.deviceId,
				key_id: "e".repeat(64),
				identity_id: "raced-identity",
				coordinator_id: s.coordinatorId,
				binding_id: "raced-binding",
				provenance: "owner_enrollment",
				source_ref: "raced-source",
				bound_at: RACED_AT,
			}),
	},
	{
		fact: "an account claim of the device",
		reads: "claims",
		change: (db, s) =>
			insert(db, "coordinator_auth_device_claims", {
				claim_id: "raced-claim",
				coordinator_id: s.coordinatorId,
				identity_id: "raced-identity",
				group_id: s.groupId,
				device_id: s.deviceId,
				public_key: s.publicKey,
				fingerprint: s.fingerprint,
				key_id: "c".repeat(64),
				attempt_id: "raced-attempt",
				issuer: "https://raced.example.test",
				auth_config_revision: "d".repeat(64),
				created_at_ms: 1,
			}),
		skip: { binding: "the binding needs the device's own claim, and claims are immutable" },
	},
	{
		fact: "the device's group is archived",
		reads: "enrollment",
		change: (db, s) =>
			db.prepare("UPDATE groups SET archived_at=? WHERE group_id=?").run(RACED_AT, s.groupId),
	},
	{
		fact: "a revocation of the device",
		reads: "revocations",
		change: (db, s) =>
			insert(db, "coordinator_device_revocations", {
				subject_kind: "device_id",
				subject_value: s.deviceId,
				revocation_id: "raced-revocation",
				evidence_group_id: s.groupId,
				evidence_device_id: s.deviceId,
				evidence_public_key: s.publicKey,
				evidence_fingerprint: s.fingerprint,
				created_at: RACED_AT,
			}),
	},
	{
		// Unparseable manifests match by raw text, so no other check reads this row.
		fact: "an unparseable legacy completion naming the device",
		reads: "history",
		change: (db, s) =>
			insert(db, "coordinator_legacy_team_completions", {
				group_id: "raced-group",
				candidate_ref: "raced-candidate",
				manifest_version: 1,
				manifest_json: `not json ${JSON.stringify(s.deviceId)}`,
				completed_at: RACED_AT,
				created_at: RACED_AT,
			}),
	},
	{
		fact: "another device enrolled with the same key",
		reads: "historyKeys",
		change: (db, s) =>
			insert(db, "enrolled_devices", {
				group_id: "raced-group",
				device_id: "raced-same-key-device",
				public_key: s.publicKey,
				fingerprint: "f".repeat(64),
				enabled: 1,
				created_at: RACED_AT,
			}),
	},
	{
		fact: "an enrolled key that cannot be ruled out",
		reads: "historyDiscovery",
		change: (db) =>
			insert(db, "enrolled_devices", {
				group_id: "raced-group",
				device_id: "raced-unparsed-device",
				public_key: UNPARSED_KEY,
				fingerprint: "f".repeat(64),
				enabled: 1,
				created_at: RACED_AT,
			}),
	},
	{
		fact: "the original controller review is revoked",
		reads: "controllers, sources",
		change: (db, s) =>
			db
				.prepare(
					"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE coordinator_id=? AND device_id=? AND revoked_at IS NULL",
				)
				.run(RACED_AT, s.coordinatorId, s.deviceId),
	},
	{
		fact: "a consumed invite of the device is revoked",
		reads: "invites",
		arrange: (db, s) => insert(db, "coordinator_invites", ownInvite(s)),
		change: (db) =>
			db
				.prepare("UPDATE coordinator_invites SET revoked_at=? WHERE invite_id='raced-own-invite'")
				.run(RACED_AT),
	},
];
