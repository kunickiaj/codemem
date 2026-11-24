import {
	hasConnectionSessionSchema,
	orderedBrowserStartStatements,
} from "./coordinator-account-connection-session.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { changedRows, writeGuarded } from "./coordinator-auth-read-set.js";
import {
	type DeviceRejoinBrowserScope,
	REJOIN_ATTEMPTS_TABLE,
	REJOIN_HASH,
} from "./coordinator-device-rejoin-browser-evidence.js";
import { REJOIN_DESTINATION_CTES } from "./coordinator-device-rejoin-destinations.js";

type Config = Omit<DeviceRejoinBrowserScope, "attemptId" | "transactionHash" | "binderHash">;
type Claim = DeviceRejoinBrowserScope & {
	startCode: string;
	stateHash: string;
	nonce: string;
	pkceVerifier: string;
};

const SCOPE = `a.coordinator_id = ? AND a.origin = ? AND a.issuer = ?
 AND a.auth_config_revision = ? AND a.created_at_ms <= ? AND a.expires_at_ms > ?`;

function scope(c: Config) {
	return [c.coordinatorId, c.origin, c.issuer, c.authConfigRevision, c.now, c.now];
}

function validTime(now: number): boolean {
	return Number.isSafeInteger(now) && now >= 0;
}

function claimStatements(p: Claim, startHash: string): AuthLinkStatement[] {
	return [
		{
			sql: `WITH attempt AS MATERIALIZED (
 SELECT a.* FROM ${REJOIN_ATTEMPTS_TABLE} a WHERE ${SCOPE}
 AND a.attempt_id = ? AND a.state = 'pending' AND a.browser_start_hash = ?
 AND a.browser_transaction_hash IS NULL AND a.browser_binder_hash IS NULL
), ${REJOIN_DESTINATION_CTES}
INSERT INTO coordinator_auth_browser_transactions (
 coordinator_id, browser_transaction_hash, purpose, attempt_id, state_hash, binder_hash, issuer,
 auth_config_revision, redirect_uri, state, nonce, pkce_verifier, created_at_ms, expires_at_ms)
SELECT a.coordinator_id, ?, 'owner_enroll', a.attempt_id, ?, ?, a.issuer, a.auth_config_revision,
 ?, 'pending', ?, ?, ?, a.expires_at_ms FROM checked a
WHERE NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b
 WHERE b.coordinator_id = a.coordinator_id
 AND (b.attempt_id = a.attempt_id OR b.browser_transaction_hash = ?
 OR b.state_hash = ? OR b.binder_hash = ?))`,
			values: [
				...scope(p),
				p.attemptId,
				startHash,
				p.transactionHash,
				p.stateHash,
				p.binderHash,
				p.redirectUri,
				p.nonce,
				p.pkceVerifier,
				p.now,
				p.transactionHash,
				p.stateHash,
				p.binderHash,
			],
		},
		changedRows(),
		{
			sql: `UPDATE ${REJOIN_ATTEMPTS_TABLE} AS a SET state = 'browser_claimed',
 browser_transaction_hash = ?, browser_binder_hash = ?
 WHERE ${SCOPE} AND a.attempt_id = ? AND a.state = 'pending' AND a.browser_start_hash = ?
 AND a.browser_transaction_hash IS NULL AND a.browser_binder_hash IS NULL`,
			values: [p.transactionHash, p.binderHash, ...scope(p), p.attemptId, startHash],
		},
		changedRows(),
	];
}

/** The CSRF-checked form supplies its start code; OIDC and the cookie supply the other pins. */
export async function claimDeviceRejoinBrowser(
	backend: AuthLinkBackend,
	input: Claim,
): Promise<boolean> {
	const p = { ...input };
	if (
		!validTime(p.now) ||
		![p.transactionHash, p.stateHash, p.binderHash].every((hash) => REJOIN_HASH.test(hash))
	)
		return false;
	const code = decodeCoordinatorAuthProof32(p.startCode);
	if (!code) return false;
	const startHash = await hashCoordinatorAuthProofBytes32(code);
	if (!(await hasConnectionSessionSchema(backend))) return false;
	const writes = claimStatements(p, startHash);
	return (
		(await writeGuarded(
			backend,
			[],
			orderedBrowserStartStatements(writes, p.coordinatorId, p.transactionHash),
		)) === "committed"
	);
}

const PENDING_CALLBACK = `FROM coordinator_auth_browser_transactions b
 JOIN ${REJOIN_ATTEMPTS_TABLE} a ON a.coordinator_id = b.coordinator_id AND a.attempt_id = b.attempt_id
 AND a.browser_transaction_hash = b.browser_transaction_hash AND a.browser_binder_hash = b.binder_hash
 AND a.issuer = b.issuer AND a.auth_config_revision = b.auth_config_revision
 WHERE ${SCOPE} AND a.state = 'browser_claimed' AND b.purpose = 'owner_enroll'
 AND b.state = 'pending' AND b.redirect_uri = ? AND b.state_hash = ? AND b.binder_hash = ?
 AND b.created_at_ms <= ? AND b.expires_at_ms > ?`;

type PendingCallback = {
	attempt_id: string;
	browser_transaction_hash: string;
	nonce: string;
	pkce_verifier: string;
	loopback_redirect: string;
	identity_id: string;
	device_id: string;
	fingerprint: string;
};

/**
 * Null means the callback doesn't match this flow. A matched callback is single-use:
 * spend that transaction before reading the provider response or using its account.
 */
export async function consumeDeviceRejoinCallback(
	backend: Pick<AuthLinkBackend, "first" | "run">,
	input: Config & { stateHash: string; binderHash: string },
) {
	const p = { ...input };
	if (!validTime(p.now) || !REJOIN_HASH.test(p.stateHash) || !REJOIN_HASH.test(p.binderHash))
		return null;
	const pins = [...scope(p), p.redirectUri, p.stateHash, p.binderHash, p.now, p.now];
	const row = await backend.first<PendingCallback>({
		sql: `SELECT a.attempt_id, b.browser_transaction_hash, b.nonce, b.pkce_verifier,
 a.loopback_redirect, a.identity_id, a.device_id, a.fingerprint
 ${PENDING_CALLBACK}`,
		values: pins,
	});
	if (!row) return null;
	const claimToken = crypto.randomUUID();
	const changed = await backend.run({
		sql: `UPDATE coordinator_auth_browser_transactions
SET state = 'consumed', consumed_at_ms = ?, claim_token = ?, nonce = NULL, pkce_verifier = NULL
WHERE rowid = (SELECT b.rowid ${PENDING_CALLBACK}
 AND b.browser_transaction_hash = ? AND b.nonce = ? AND b.pkce_verifier = ?)`,
		values: [
			p.now,
			claimToken,
			...pins,
			row.browser_transaction_hash,
			row.nonce,
			row.pkce_verifier,
		],
	});
	if (changed !== 1) return { kind: "refused" as const };
	return {
		kind: "consumed" as const,
		claimToken,
		attemptId: row.attempt_id,
		transactionHash: row.browser_transaction_hash,
		nonce: row.nonce,
		pkceVerifier: row.pkce_verifier,
		loopbackRedirect: row.loopback_redirect,
		identityId: row.identity_id,
		deviceId: row.device_id,
		fingerprint: row.fingerprint,
	};
}
