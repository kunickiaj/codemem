import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import type { CoordinatorAccountReference } from "./coordinator-auth-contract.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";

export const AUTH_SESSION_TTL_MS = 28800000;
export const AUTH_SESSION_MAX_LIVE_PER_LINK = 10;
export const AUTH_LINK_REDEEM_WINDOW_MS = 120000;
export const AUTH_GUARDED_SIGNIN_PURGE_GRACE_MS = 86400000;
export const AUTH_GUARDED_SIGNIN_RECEIPT_PURGE_AGE_MS = 115200000;
export const AUTH_GUARDED_SIGNIN_PURGE_BATCH_MAX = 256;
/** Server metadata only: never a bearer credential or its commitment. */
export interface CoordinatorAuthSession {
	sessionId: string;
	identityId: string;
	linkId: string;
	account: CoordinatorAccountReference;
	expiresAtMs: number;
}
export type CoordinatorAuthSessionError =
	| "invalid_input"
	| "auth_config_changed"
	| "attempt_unavailable"
	| "redeem_window_expired"
	| "browser_transaction_used"
	| "transaction_unavailable"
	| "session_limited"
	| "account_not_linked";
export type CoordinatorAuthSessionIssueResult =
	| { kind: "issued"; session: CoordinatorAuthSession }
	| { kind: "rejected"; error: CoordinatorAuthSessionError };
/** Hashes come from trusted browser authentication and a fresh 32-byte server generator.
 * Shape validation is not cryptographic evidence; raw credentials never enter this API.
 */
export interface CoordinatorAuthLinkSessionRedeemInput {
	attemptId: string;
	browserTransactionHash: string;
	credentialHash: string;
}
/** Binding hashes are derived and resolved by the trusted server, never nominated by HTTP JSON. */
export interface CoordinatorAuthBoundLinkSessionRedeemInput
	extends CoordinatorAuthLinkSessionRedeemInput {
	binderHash: string;
}
/** Account claims must already be independently verified by the server's OIDC ceremony. */
export interface CoordinatorAuthAccountSignInInput {
	browserTransactionHash: string;
	account: CoordinatorAccountReference;
	credentialHash: string;
}
/** Scope comes from trusted server configuration, not network JSON. */
export interface CoordinatorAuthSessionScope {
	coordinatorId: string;
}
export interface CoordinatorAuthSessionPurgeOptions {
	limit?: number;
}
export type CoordinatorAuthSessionPurgeResult =
	| { kind: "purged"; processedCount: number; more: boolean }
	| { kind: "rejected"; error: "invalid_input" };
export type CoordinatorAuthSessionSignOutResult =
	| { kind: "signed_out" }
	| { kind: "rejected"; error: "invalid_input" };
export type CoordinatorAuthAccountLinkRevokeResult =
	| { kind: "revoked" }
	| { kind: "rejected"; error: "invalid_input" | "link_unavailable" };
export interface CoordinatorAuthSessionStore {
	/** Optional metadata cleanup only; more is an operational hint, not authority. */
	purgeAuthGuardedSigninSessions(
		scope: CoordinatorAuthSessionScope,
		options?: CoordinatorAuthSessionPurgeOptions,
	): Promise<CoordinatorAuthSessionPurgeResult>;
	purgeAuthGuardedSigninReceipts(
		scope: CoordinatorAuthSessionScope,
		options?: CoordinatorAuthSessionPurgeOptions,
	): Promise<CoordinatorAuthSessionPurgeResult>;
	redeemAuthLinkSession(
		input: CoordinatorAuthLinkSessionRedeemInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionIssueResult>;
	redeemAuthLinkSessionWithBrowserTransaction(
		input: CoordinatorAuthBoundLinkSessionRedeemInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthSessionIssueResult>;
	signInWithAuthAccount(
		input: CoordinatorAuthAccountSignInInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionIssueResult>;
	/** Caller already verified OIDC claims, original browser binding and CSRF.
	 * Hashes are trusted server metadata, never accepted from HTTP JSON.
	 */
	signInWithConsumedBrowserTransaction(
		input: CoordinatorAuthAccountSignInInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthSessionIssueResult>;
	readAuthSession(
		credentialHash: string,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSession | null>;
	signOutAuthSession(
		credentialHash: string,
		scope: CoordinatorAuthSessionScope,
	): Promise<CoordinatorAuthSessionSignOutResult>;
}
/** Separate admin capability: future callers MUST authenticate the configured admin.
 * Browser sessions and caller-supplied actor labels never supply this authority.
 */
export interface CoordinatorAuthAccountLinkAdminStore {
	revokeAuthAccountLink(
		input: { linkId: string },
		scope: CoordinatorAuthSessionScope,
	): Promise<CoordinatorAuthAccountLinkRevokeResult>;
}

// Empty tables only: no foreign keys, backfill, profiles, or provider tokens.
export const AUTH_SESSION_RETENTION_COLUMN_SQL = `purge_eligible INTEGER NOT NULL DEFAULT 0 CHECK (typeof(purge_eligible) = 'integer' AND purge_eligible IN (0,1) AND (purge_eligible = 0 OR (source = 'signin' AND attempt_id IS NULL)))`;
export const AUTH_SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_session_receipts (
 coordinator_id TEXT NOT NULL,
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 source TEXT NOT NULL CHECK (source IN ('link_redeem','signin')),
 attempt_id TEXT,
 link_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199225940991),
 ${AUTH_SESSION_RETENTION_COLUMN_SQL},
 PRIMARY KEY (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, session_id),
 UNIQUE (coordinator_id, attempt_id),
 CHECK ((source = 'link_redeem' AND attempt_id IS NOT NULL) OR (source = 'signin' AND attempt_id IS NULL))
);
CREATE TABLE IF NOT EXISTS coordinator_auth_sessions (
 coordinator_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 credential_hash TEXT NOT NULL CHECK (length(credential_hash) = 64 AND credential_hash NOT GLOB '*[^0-9a-f]*'),
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
 link_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199225940991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms BETWEEN 0 AND 9007199254740991 AND expires_at_ms = created_at_ms + 28800000),
 revoked_at_ms INTEGER CHECK (revoked_at_ms IS NULL OR (typeof(revoked_at_ms) = 'integer' AND revoked_at_ms BETWEEN 0 AND 9007199254740991)),
 PRIMARY KEY (coordinator_id, session_id),
 UNIQUE (coordinator_id, credential_hash),
 UNIQUE (coordinator_id, browser_transaction_hash)
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_link_config_expiry
 ON coordinator_auth_sessions(coordinator_id, link_id, auth_config_revision, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry
 ON coordinator_auth_sessions(coordinator_id, expires_at_ms, session_id);
CREATE INDEX IF NOT EXISTS idx_auth_session_receipts_purge
 ON coordinator_auth_session_receipts(coordinator_id, purge_eligible, created_at_ms, browser_transaction_hash);
`;
