import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { REJOIN_DESTINATION_CTES } from "./coordinator-device-rejoin-destinations.js";
import {
	type DeviceRejoinLinkEvidence,
	REJOIN_LINK_PIN_MATCH_SQL,
	readDeviceRejoinLinkStorage,
	rejoinLinkEvidenceCtes,
} from "./coordinator-device-rejoin-link-evidence.js";

const ATTEMPTS = "coordinator_device_rejoin_attempts";
const HASH = /^[0-9a-f]{64}$/u;
type Storage = NonNullable<Awaited<ReturnType<typeof readDeviceRejoinLinkStorage>>>;
type Backend = Pick<AuthLinkBackend, "first" | "readAuthSchemaState">;

/** The browser guard supplies the hashes, config and time. Neither comes from a form field. */
export interface DeviceRejoinConfirmationScope {
	coordinatorId: string;
	attemptId: string;
	origin: string;
	issuer: string;
	authConfigRevision: string;
	redirectUri: string;
	transactionHash: string;
	binderHash: string;
	now: number;
}

interface ReviewRow extends DeviceRejoinLinkEvidence {
	removal_digest: string;
	destinations_json: string;
	non_destinations_json: string;
}

function confirmationEvidence(
	c: DeviceRejoinConfirmationScope,
	storage: Storage,
): AuthLinkStatement {
	const bootstrapCheck =
		storage === "unqualified"
			? `AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE tbl_name = 'coordinator_owner_enrollment_qualifications' COLLATE NOCASE)`
			: "";
	return {
		sql: `WITH RECURSIVE rejoin_link_clock(now_ms) AS (VALUES (?)),
attempt AS MATERIALIZED (
 SELECT a.* FROM ${ATTEMPTS} a
 JOIN coordinator_auth_browser_transactions b ON b.coordinator_id = a.coordinator_id
 AND b.attempt_id = a.attempt_id AND b.browser_transaction_hash = a.browser_transaction_hash
 AND b.binder_hash = a.browser_binder_hash AND b.issuer = a.issuer
 AND b.auth_config_revision = a.auth_config_revision
 CROSS JOIN rejoin_link_clock t
 WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.origin = ?
 AND a.issuer = ? AND a.auth_config_revision = ?
 AND a.browser_transaction_hash = ? AND a.browser_binder_hash = ?
 AND a.state = 'oidc_verified' AND a.created_at_ms <= t.now_ms AND a.expires_at_ms > t.now_ms
 AND b.purpose = 'owner_enroll' AND b.state = 'consumed' AND b.redirect_uri = ?
 AND b.consumed_at_ms <= t.now_ms AND b.expires_at_ms > t.now_ms
 ${bootstrapCheck}
), rejoin_link_scope AS MATERIALIZED (
 SELECT a.coordinator_id, a.identity_id, a.issuer, l.subject
 FROM attempt a JOIN coordinator_auth_account_links l
 ON l.coordinator_id = a.coordinator_id AND l.link_id = a.link_id
 AND l.identity_id = a.identity_id AND l.issuer = a.issuer
), ${rejoinLinkEvidenceCtes(storage)}, ${REJOIN_DESTINATION_CTES},
rejoin_review AS MATERIALIZED (
 SELECT a.coordinator_id, a.attempt_id, a.removal_digest,
 l.link_id, l.link_authority_kind, l.link_generation,
 (SELECT json_group_array(json_array(group_id, revision) ORDER BY group_id COLLATE BINARY)
  FROM groups_with_reasons WHERE reason IS NULL) AS destinations_json,
 (SELECT json_group_array(json_array(group_id, reason) ORDER BY group_id COLLATE BINARY)
  FROM groups_with_reasons WHERE reason IS NOT NULL) AS non_destinations_json
 FROM checked a JOIN rejoin_link_evidence l ON ${REJOIN_LINK_PIN_MATCH_SQL}
 WHERE NOT EXISTS (SELECT 1 FROM groups_with_reasons WHERE reason = 'missing_group')
)`,
		values: [
			c.now,
			c.coordinatorId,
			c.attemptId,
			c.origin,
			c.issuer,
			c.authConfigRevision,
			c.transactionHash,
			c.binderHash,
			c.redirectUri,
		],
	};
}

async function readReview(backend: Backend, scope: DeviceRejoinConfirmationScope) {
	if (!Number.isSafeInteger(scope.now) || scope.now < 0) return null;
	if (!HASH.test(scope.transactionHash) || !HASH.test(scope.binderHash)) return null;
	const storage = await readDeviceRejoinLinkStorage(backend);
	if (!storage) return null;
	const { sql, values } = confirmationEvidence(scope, storage);
	const row = await backend.first<ReviewRow>({
		sql: `${sql}\nSELECT * FROM rejoin_review`,
		values,
	});
	return row ? { row, sql, values } : null;
}

async function reviewHash(attemptId: string, review: ReviewRow): Promise<string> {
	const body = JSON.stringify([
		"codemem-device-rejoin-confirmation-v1",
		attemptId,
		review.removal_digest,
		[review.link_id, review.link_authority_kind, review.link_generation],
		JSON.parse(review.destinations_json),
		JSON.parse(review.non_destinations_json),
	]);
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Review the destinations after OIDC, before showing the confirmation form. */
export async function readDeviceRejoinConfirmation(
	backend: Backend,
	scope: DeviceRejoinConfirmationScope,
) {
	const input = { ...scope };
	const review = await readReview(backend, input);
	if (!review) return null;
	return {
		destinationsJson: review.row.destinations_json,
		nonDestinationsJson: review.row.non_destinations_json,
		confirmation: await reviewHash(input.attemptId, review.row),
	};
}

/** The guarded form supplies its rendered commitment and the hash of a newly minted secret. */
export async function confirmDeviceRejoinAttempt(
	backend: Backend & Pick<AuthLinkBackend, "run">,
	input: DeviceRejoinConfirmationScope & { confirmation: string; completionSecretHash: string },
): Promise<boolean> {
	const { confirmation, completionSecretHash, ...scope } = input;
	if (!HASH.test(confirmation) || !HASH.test(completionSecretHash)) return false;
	const review = await readReview(backend, scope);
	if (!review || review.row.destinations_json === "[]") return false;
	if ((await reviewHash(scope.attemptId, review.row)) !== confirmation) return false;
	const { sql, values, row } = review;
	const changed = await backend.run({
		sql: `${sql}
UPDATE ${ATTEMPTS} AS a SET state = 'confirmed',
 destinations_json = r.destinations_json, non_destinations_json = r.non_destinations_json,
 confirmation_hash = ?, completion_secret_hash = ?
FROM rejoin_review r
WHERE a.coordinator_id = r.coordinator_id AND a.attempt_id = r.attempt_id
 AND r.removal_digest = ? AND r.link_id = ? AND r.link_authority_kind = ? AND r.link_generation = ?
 AND r.destinations_json = ? AND r.non_destinations_json = ?
 AND (a.destinations_json IS NULL OR a.destinations_json = r.destinations_json)
 AND (a.non_destinations_json IS NULL OR a.non_destinations_json = r.non_destinations_json)
 AND a.confirmation_hash IS NULL AND a.completion_secret_hash IS NULL`,
		values: [
			...values,
			confirmation,
			completionSecretHash,
			row.removal_digest,
			row.link_id,
			row.link_authority_kind,
			row.link_generation,
			row.destinations_json,
			row.non_destinations_json,
		],
	});
	return changed === 1;
}
