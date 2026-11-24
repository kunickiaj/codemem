import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { changedRows, snapshotGuard, writeGuarded } from "./coordinator-auth-read-set.js";
import {
	readVerifiedRejoinStartEvidence,
	START_EVIDENCE_SQL,
} from "./coordinator-device-rejoin-start-evidence.js";
import {
	type DeviceRejoinStartInput,
	isFreshDeviceRejoinStart,
} from "./coordinator-device-rejoin-start-input.js";

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
type Backend = Pick<AuthLinkBackend, "first" | "batch">;

type StartResult =
	| {
			kind: "started" | "prior_start";
			body: {
				attempt_id: string;
				expires_at_ms: number;
				coordinator_id: string;
				origin: string;
				issuer: string;
				auth_config_revision: string;
				identity_id: string;
				binding_id: string;
				removal_digest: string;
			};
	  }
	| { kind: "unavailable" | "retry" };

type PreparedStart = {
	deviceId: string;
	insert(clock: () => number): Promise<StartResult>;
};

const EVIDENCE_MATCH = `e.binding_id = ? AND e.identity_id = ?
 AND e.own_tombstones_json = ? AND e.alias_removal_seqs_json = ?`;

function evidencePins(evidence: Evidence) {
	return [
		evidence.bindingId,
		evidence.identityId,
		JSON.stringify(evidence.ownTombstones),
		JSON.stringify(evidence.aliasRemovalSeqs),
	];
}

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
WHERE ${EVIDENCE_MATCH}
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
			...evidencePins(evidence),
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

/** Verifies possession before the caller spends a device-specific rate budget. */
export async function prepareVerifiedRejoinStart(
	backend: Backend,
	config: StartConfig,
	input: DeviceRejoinStartInput,
	now: number,
): Promise<PreparedStart | null> {
	const trusted = { ...config };
	const request = { ...input };
	const evidence = await readVerifiedRejoinStartEvidence(backend, trusted, request, now);
	if (!evidence) return null;
	return {
		deviceId: evidence.deviceId,
		insert: (clock) => writeVerifiedStart(backend, trusted, request, evidence, clock),
	};
}

async function writeVerifiedStart(
	backend: Backend,
	trusted: StartConfig,
	request: DeviceRejoinStartInput,
	evidence: Evidence,
	clock: () => number,
): Promise<StartResult> {
	const now = clock();
	if (
		!isFreshDeviceRejoinStart(request.timestampMs, now) ||
		now > Number.MAX_SAFE_INTEGER - ATTEMPT_TTL_MS
	)
		return { kind: "unavailable" };
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.publicKey));
	const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const replayGuard = snapshotGuard({
		sql: `NOT EXISTS (SELECT 1 FROM ${ATTEMPTS} WHERE coordinator_id = ? AND attempt_id = ?)`,
		values: [trusted.coordinatorId, request.attemptId],
	});
	const result = await writeGuarded(
		backend,
		[replayGuard],
		[
			evictionStatement(trusted.coordinatorId, evidence.deviceId, now),
			insertStatement(trusted, request, evidence, fingerprint, now),
			changedRows(),
		],
	);
	if (result === "changed")
		return readPriorStart(backend, trusted, request, evidence, fingerprint, clock());
	if (result === "unmatched") return diagnoseQuotaRefusal(backend, trusted, evidence, now);
	return startResponse("started", trusted, request, evidence, now + ATTEMPT_TTL_MS);
}

function startResponse(
	kind: "started" | "prior_start",
	trusted: StartConfig,
	request: DeviceRejoinStartInput,
	evidence: Evidence,
	expiresAtMs: number,
): StartResult {
	return {
		kind,
		body: {
			attempt_id: request.attemptId,
			expires_at_ms: expiresAtMs,
			coordinator_id: trusted.coordinatorId,
			origin: trusted.origin,
			issuer: trusted.issuer,
			auth_config_revision: trusted.authConfigRevision,
			identity_id: evidence.identityId,
			binding_id: evidence.bindingId,
			removal_digest: evidence.removalDigest,
		},
	};
}

/** The replay guard has already stopped the batch before its first write. Check the
 * stored attempt and current authority in the same read before returning any pins.
 */
async function readPriorStart(
	backend: Backend,
	config: StartConfig,
	input: DeviceRejoinStartInput,
	evidence: Evidence,
	fingerprint: string,
	now: number,
): Promise<StartResult> {
	if (!isFreshDeviceRejoinStart(input.timestampMs, now)) return { kind: "unavailable" };
	const row = await backend.first<{ expires_at_ms: number }>({
		sql: `WITH evidence AS MATERIALIZED (${START_EVIDENCE_SQL})
SELECT a.expires_at_ms FROM ${ATTEMPTS} a JOIN evidence e
 ON a.binding_id = e.binding_id AND a.identity_id = e.identity_id
 AND a.own_tombstones_json = e.own_tombstones_json
 AND a.alias_removal_seqs_json = e.alias_removal_seqs_json
WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.origin = ? AND a.issuer = ?
 AND a.auth_config_revision = ? AND a.device_id = ? AND a.key_id = ?
 AND a.public_key = ? AND a.fingerprint = ? AND a.browser_start_hash = ?
 AND a.loopback_redirect = ? AND a.removal_digest = ? AND ${EVIDENCE_MATCH}
 AND a.state IN ${LIVE_STATES} AND a.created_at_ms <= ? AND a.expires_at_ms > ?`,
		values: [
			evidence.deviceId,
			evidence.keyId,
			config.coordinatorId,
			config.coordinatorId,
			input.attemptId,
			config.origin,
			config.issuer,
			config.authConfigRevision,
			evidence.deviceId,
			evidence.keyId,
			input.publicKey,
			fingerprint,
			input.browserStartHash,
			input.loopbackRedirect,
			evidence.removalDigest,
			...evidencePins(evidence),
			now,
			now,
		],
	});
	if (!row) return { kind: "unavailable" };
	return startResponse("prior_start", config, input, evidence, row.expires_at_ms);
}

async function diagnoseQuotaRefusal(
	backend: Backend,
	config: StartConfig,
	evidence: Evidence,
	now: number,
): Promise<StartResult> {
	const blocked = await backend.first<{ full: number }>({
		sql: `WITH evidence AS MATERIALIZED (${START_EVIDENCE_SQL})
SELECT 1 AS full FROM evidence e
WHERE ${EVIDENCE_MATCH} AND (SELECT count(*) FROM ${ATTEMPTS} a
 WHERE a.coordinator_id = ? AND a.device_id = ?
 AND a.state IN ('oidc_verified', 'confirmed') AND a.expires_at_ms > ?) >= ?`,
		values: [
			evidence.deviceId,
			evidence.keyId,
			config.coordinatorId,
			...evidencePins(evidence),
			config.coordinatorId,
			evidence.deviceId,
			now,
			MAX_ACTIVE_ATTEMPTS,
		],
	});
	return { kind: blocked?.full === 1 ? "retry" : "unavailable" };
}

/**
 * The existing internal writer. Quota eviction and the exact evidence recheck
 * run in one batch. No failed insert can leave an eviction behind.
 */
export async function insertVerifiedRejoinStartAttempt(
	backend: Backend,
	config: StartConfig,
	input: DeviceRejoinStartInput,
	now: number,
): Promise<boolean> {
	const prepared = await prepareVerifiedRejoinStart(backend, config, input, now);
	return (await prepared?.insert(() => now))?.kind === "started";
}
