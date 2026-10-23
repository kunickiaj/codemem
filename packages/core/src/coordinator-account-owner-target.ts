import { readConnectionSchemaState } from "./coordinator-account-connection-schema.js";
import { CONNECTION_NOT_REVOKED_SQL } from "./coordinator-account-connection-storage.js";
import {
	type CoordinatorAuthControllerStore,
	isAuthControllerId,
} from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type {
	CoordinatorAuthLinkConfig,
	CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import {
	capture,
	captureAuthLinkConfig,
	captureAuthLinkSigner,
	isHash,
} from "./coordinator-auth-link-input.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { authPersistenceError } from "./coordinator-auth-schema.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

export interface CoordinatorAccountOwnerTargetInput {
	/** Explicit operator choice, not the local memory author or an enrollment label. */
	targetIdentityId: string;
	signer: CoordinatorAuthLinkSigner;
}
export interface CoordinatorAccountOwnerTargetStore {
	readAccountOwnerTarget(
		input: CoordinatorAccountOwnerTargetInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAccountOwnerTarget>;
}
export type CoordinatorAccountOwnerTarget =
	| { kind: "unavailable" }
	| {
			kind: "ready";
			targetIdentityId: string;
			/** The immutable link ID identifies the current connection generation. */
			linkId: string;
			currentGeneration: { authConfigRevision: string; createdAtMs: number };
			review: { attestationId: string; reviewReceiptId: string; evidenceDigest: string } | null;
	  };

interface TargetRow {
	link_id: string;
	auth_config_revision: string;
	created_at_ms: number;
	review_count: number;
	attestation_id: string | null;
}
const REVIEW_MATCH = `a.coordinator_id=l.coordinator_id AND a.group_id=e.group_id
 AND a.device_id=e.device_id AND a.fingerprint=e.fingerprint`;
const TARGET_SQL = `SELECT l.link_id,l.auth_config_revision,l.created_at_ms,
 (SELECT count(*) FROM coordinator_auth_controller_attestations a WHERE ${REVIEW_MATCH}) AS review_count,
 (SELECT a.attestation_id FROM coordinator_auth_controller_attestations a WHERE ${REVIEW_MATCH} LIMIT 1) AS attestation_id
 FROM coordinator_auth_account_links l
 JOIN enrolled_devices e ON e.group_id=? AND e.device_id=?
 JOIN groups g ON g.group_id=e.group_id
 WHERE l.coordinator_id=? AND l.identity_id=? AND l.issuer=?
 AND e.public_key=? AND e.fingerprint=? AND e.enabled=1 AND g.archived_at IS NULL
 AND (e.identity_id IS NULL OR e.identity_id=l.identity_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind='device_id' AND r.subject_value=e.device_id)
 OR (r.subject_kind='ed25519_key' AND r.subject_value=?))
 AND ${CONNECTION_NOT_REVOKED_SQL}
 AND ${authAccountLinkProvenanceSql("l", { connections: true })}`;

function validTarget(row: TargetRow | null): row is TargetRow {
	if (!row || !isAuthControllerId(row.link_id) || !isHash(row.auth_config_revision)) return false;
	if (!Number.isSafeInteger(row.created_at_ms) || row.created_at_ms < 0) return false;
	if (row.review_count === 0) return row.attestation_id === null;
	return row.review_count === 1 && isAuthControllerId(row.attestation_id);
}
function sameTarget(a: TargetRow, b: TargetRow | null): boolean {
	return (
		validTarget(b) &&
		a.link_id === b.link_id &&
		a.auth_config_revision === b.auth_config_revision &&
		a.created_at_ms === b.created_at_ms &&
		a.review_count === b.review_count &&
		a.attestation_id === b.attestation_id
	);
}

/** Trusted store read only. Future callers MUST authenticate the admin first.
 * A ready result is advisory, not approval to adopt a profile or mutate an account.
 * Null enrollment labels are accepted for review, never treated as ownership proof.
 */
export class AccountOwnerTargetOperations {
	constructor(
		private readonly backend: Pick<AuthLinkBackend, "first">,
		private readonly reviews: Pick<
			CoordinatorAuthControllerStore,
			"getActiveAuthControllerAttestation"
		>,
	) {}

	async readAccountOwnerTarget(
		input: CoordinatorAccountOwnerTargetInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAccountOwnerTarget> {
		const c = captureAuthLinkConfig(config);
		const fields = capture(input, ["targetIdentityId", "signer"]);
		const s = captureAuthLinkSigner(fields?.signer);
		const identityId = fields?.targetIdentityId;
		if (!c?.enabled || !s || !isAuthControllerId(identityId)) return { kind: "unavailable" };
		try {
			if ((await readConnectionSchemaState(this.backend)) !== "ready")
				return { kind: "unavailable" };
			const keyId = await ed25519KeyIdForRevocation(s.publicKey);
			if (!keyId) return { kind: "unavailable" };
			const statement = {
				sql: TARGET_SQL,
				values: [
					s.groupId,
					s.deviceId,
					c.coordinatorId,
					identityId,
					c.issuer,
					s.publicKey,
					s.fingerprint,
					keyId,
				],
			};
			const row = await this.backend.first<TargetRow>(statement);
			if (!validTarget(row)) return { kind: "unavailable" };
			const review = await this.readReview(row, c.coordinatorId, identityId, s);
			if (review === undefined) return { kind: "unavailable" };
			// The normal active-reader may await key derivation. Recheck the target afterward.
			if (!sameTarget(row, await this.backend.first<TargetRow>(statement)))
				return { kind: "unavailable" };
			if ((await readConnectionSchemaState(this.backend)) !== "ready")
				return { kind: "unavailable" };
			return {
				kind: "ready",
				targetIdentityId: identityId,
				linkId: row.link_id,
				currentGeneration: {
					authConfigRevision: row.auth_config_revision,
					createdAtMs: row.created_at_ms,
				},
				review,
			};
		} catch (error) {
			throw authPersistenceError(error, "account_owner_target_unavailable");
		}
	}

	private async readReview(
		row: TargetRow,
		coordinatorId: string,
		identityId: string,
		signer: CoordinatorAuthLinkSigner,
	): Promise<Extract<CoordinatorAccountOwnerTarget, { kind: "ready" }>["review"] | undefined> {
		if (row.attestation_id === null) return null;
		// Do not reparse review JSON or compare an immutable review to fresh history.
		const a = await this.reviews.getActiveAuthControllerAttestation(
			coordinatorId,
			row.attestation_id,
		);
		if (
			!a ||
			a.coordinator_id !== coordinatorId ||
			a.attestation_id !== row.attestation_id ||
			a.identity_id !== identityId ||
			a.group_id !== signer.groupId ||
			a.device_id !== signer.deviceId ||
			a.public_key !== signer.publicKey ||
			a.fingerprint !== signer.fingerprint ||
			a.revoked_at !== null ||
			a.revision !== 1 ||
			!isAuthControllerId(a.review_receipt_id) ||
			!isHash(a.evidence_digest)
		)
			return undefined;
		return {
			attestationId: a.attestation_id,
			reviewReceiptId: a.review_receipt_id,
			evidenceDigest: a.evidence_digest,
		};
	}
}
