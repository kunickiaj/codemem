import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { changedRows, snapshotGuard, writeGuarded } from "./coordinator-auth-read-set.js";
import {
	readVerifiedRejoinStartEvidence,
	START_EVIDENCE_SQL,
} from "./coordinator-device-rejoin-start-evidence.js";
import type { DeviceRejoinStartInput } from "./coordinator-device-rejoin-start-input.js";

const ATTEMPT_TTL_MS = 600_000;
const MAX_ACTIVE_ATTEMPTS = 20;
const ATTEMPTS = "coordinator_device_rejoin_attempts";
const LIVE_STATES = "('pending', 'browser_claimed', 'oidc_verified', 'confirmed')";

type StartConfig = {
	coordinatorId: string;
	origin: string;
	issuer: string;
	authConfigRevision: string;
};

type Evidence = NonNullable<Awaited<ReturnType<typeof readVerifiedRejoinStartEvidence>>>;

function insertStatement(
	config: StartConfig,
	input: DeviceRejoinStartInput,
	evidence: Evidence,
	fingerprint: string,
	now: number,
): AuthLinkStatement {
	const { coordinatorId, origin, issuer, authConfigRevision } = config;
	return {
		sql: `WITH evidence AS MATERIALIZED (${START_EVIDENCE_SQL})
INSERT INTO ${ATTEMPTS} (coordinator_id, attempt_id, origin, device_id, public_key,
 key_id, fingerprint, identity_id, binding_id, issuer, auth_config_revision, removal_digest,
 own_tombstones_json, alias_removal_seqs_json, browser_start_hash, loopback_redirect,
 created_at_ms, expires_at_ms)
SELECT ?, ?, ?, ?, ?, ?, ?, e.identity_id, e.binding_id, ?, ?, ?,
 e.own_tombstones_json, e.alias_removal_seqs_json, ?, ?, ?, ?
FROM evidence e
WHERE e.binding_id = ? AND e.identity_id = ?
 AND e.own_tombstones_json = ? AND e.alias_removal_seqs_json = ?
 AND NOT EXISTS (SELECT 1 FROM ${ATTEMPTS} a WHERE a.coordinator_id = ? AND a.attempt_id = ?)
 AND (SELECT count(*) FROM ${ATTEMPTS} a WHERE a.coordinator_id = ? AND a.device_id = ?
  AND a.state IN ${LIVE_STATES}
  AND a.expires_at_ms > ?) < ?`,
		values: [
			evidence.deviceId,
			evidence.keyId,
			coordinatorId,
			coordinatorId,
			input.attemptId,
			origin,
			evidence.deviceId,
			input.publicKey,
			evidence.keyId,
			fingerprint,
			issuer,
			authConfigRevision,
			evidence.removalDigest,
			input.browserStartHash,
			input.loopbackRedirect,
			now,
			now + ATTEMPT_TTL_MS,
			evidence.bindingId,
			evidence.identityId,
			JSON.stringify(evidence.ownTombstones),
			JSON.stringify(evidence.aliasRemovalSeqs),
			coordinatorId,
			input.attemptId,
			coordinatorId,
			evidence.deviceId,
			now,
			MAX_ACTIVE_ATTEMPTS,
		],
	};
}

function evictionStatement(
	coordinatorId: string,
	deviceId: string,
	now: number,
): AuthLinkStatement {
	return {
		sql: `UPDATE ${ATTEMPTS} SET state = 'expired'
WHERE coordinator_id = ? AND attempt_id = (
 SELECT attempt_id FROM ${ATTEMPTS}
 WHERE coordinator_id = ? AND device_id = ?
  AND state IN ('pending', 'browser_claimed') AND expires_at_ms > ?
 ORDER BY created_at_ms, attempt_id LIMIT 1)
 AND (SELECT count(*) FROM ${ATTEMPTS}
  WHERE coordinator_id = ? AND device_id = ?
   AND state IN ${LIVE_STATES} AND expires_at_ms > ?) >= ?`,
		values: [
			coordinatorId,
			coordinatorId,
			deviceId,
			now,
			coordinatorId,
			deviceId,
			now,
			MAX_ACTIVE_ATTEMPTS,
		],
	};
}

/**
 * Admits an attempt with atomic quota eviction and a full evidence recheck.
 * Replay is checked before any write. A zero-row INSERT rolls back eviction too.
 * Retention cleanup and route/rate-limit integration remain separate. A false
 * result is internal and does not choose a wire error.
 */
export async function insertVerifiedRejoinStartAttempt(
	backend: Pick<AuthLinkBackend, "first" | "batch">,
	config: StartConfig,
	input: DeviceRejoinStartInput,
	now: number,
): Promise<boolean> {
	const trusted = { ...config };
	const request = { ...input };
	if (now > Number.MAX_SAFE_INTEGER - ATTEMPT_TTL_MS) return false;
	const evidence = await readVerifiedRejoinStartEvidence(backend, trusted, request, now);
	if (!evidence) return false;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.publicKey));
	const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const replayGuard = snapshotGuard({
		sql: `NOT EXISTS (SELECT 1 FROM ${ATTEMPTS} WHERE coordinator_id = ? AND attempt_id = ?)`,
		values: [trusted.coordinatorId, request.attemptId],
	});
	return (
		(await writeGuarded(
			backend,
			[replayGuard],
			[
				evictionStatement(trusted.coordinatorId, evidence.deviceId, now),
				insertStatement(trusted, request, evidence, fingerprint, now),
				changedRows(),
			],
		)) === "committed"
	);
}
