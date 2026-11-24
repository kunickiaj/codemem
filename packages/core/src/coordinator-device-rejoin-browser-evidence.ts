import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import type { readDeviceRejoinLinkStorage } from "./coordinator-device-rejoin-link-evidence.js";

export const REJOIN_ATTEMPTS_TABLE = "coordinator_device_rejoin_attempts";
export const REJOIN_HASH = /^[0-9a-f]{64}$/u;
export type RejoinLinkStorage = NonNullable<
	Awaited<ReturnType<typeof readDeviceRejoinLinkStorage>>
>;

/** The browser guard supplies the hashes, config and time. Neither comes from a form field. */
export interface DeviceRejoinBrowserScope {
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

type Phase = { state: "browser_claimed"; claimToken: string } | { state: "oidc_verified" };

export function validRejoinBrowserScope(c: DeviceRejoinBrowserScope): boolean {
	return (
		Number.isSafeInteger(c.now) &&
		c.now >= 0 &&
		REJOIN_HASH.test(c.transactionHash) &&
		REJOIN_HASH.test(c.binderHash)
	);
}

/** The caller appends CTEs to the transaction's exact, single-attempt scope. */
export function rejoinConsumedBrowserCtes(
	c: DeviceRejoinBrowserScope,
	storage: RejoinLinkStorage,
	phase: Phase,
): AuthLinkStatement {
	const bootstrapCheck =
		storage === "unqualified"
			? `AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE tbl_name = 'coordinator_owner_enrollment_qualifications' COLLATE NOCASE)`
			: "";
	const requiresClaim = phase.state === "browser_claimed" ? "AND b.claim_token = ?" : "";
	return {
		sql: `WITH RECURSIVE rejoin_link_clock(now_ms) AS (VALUES (?)),
attempt AS MATERIALIZED (
 SELECT a.* FROM ${REJOIN_ATTEMPTS_TABLE} a
 JOIN coordinator_auth_browser_transactions b ON b.coordinator_id = a.coordinator_id
 AND b.attempt_id = a.attempt_id AND b.browser_transaction_hash = a.browser_transaction_hash
 AND b.binder_hash = a.browser_binder_hash AND b.issuer = a.issuer
 AND b.auth_config_revision = a.auth_config_revision
 CROSS JOIN rejoin_link_clock t
 WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.origin = ?
 AND a.issuer = ? AND a.auth_config_revision = ?
 AND a.browser_transaction_hash = ? AND a.browser_binder_hash = ?
 AND a.state = ? AND a.created_at_ms <= t.now_ms AND a.expires_at_ms > t.now_ms
 AND b.purpose = 'owner_enroll' AND b.state = 'consumed' AND b.redirect_uri = ?
 AND b.consumed_at_ms <= t.now_ms AND b.expires_at_ms > t.now_ms
 ${bootstrapCheck} ${requiresClaim}
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
			phase.state,
			c.redirectUri,
			...(phase.state === "browser_claimed" ? [phase.claimToken] : []),
		],
	};
}
