export const AUTH_LINK_PURPOSE = "coordinator-account-link-v1";
export const AUTH_LINK_ATTEMPT_TTL_MS = 600000;
export const AUTH_LINK_MAX_ACTIVE_PER_DEVICE = 2;
export const AUTH_LINK_MAX_ACTIVE_PER_IDENTITY = 3;
export const AUTH_LINK_CREATE_WINDOW_MS = 3600000;
export const AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW = 6;
export const AUTH_LINK_RETENTION_WINDOW_MS = 2592000000;
export const AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION = 60;
export const AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR = 10000;
export const AUTH_LINK_EXPIRE_BATCH_MAX = 32;
/** Trusted server configuration, never request JSON. */
export interface CoordinatorAuthLinkConfig {
	coordinatorId: string;
	issuer: string;
	revision: string;
	enabled: boolean;
}
/** Already verified request key possession; SQL supplies controller authority. */
export interface CoordinatorAuthLinkSigner {
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
}
export type CoordinatorAuthLinkRequester =
	| { kind: "device"; signer: CoordinatorAuthLinkSigner }
	| { kind: "browser"; browserTransactionHash: string };
export type CoordinatorAuthLinkState =
	| "pending"
	| "browser_claimed"
	| "oidc_verified"
	| "confirmed"
	| "finalized"
	| "session_redeemed"
	| "expired"
	| "failed";
export interface CoordinatorAuthLinkStatus {
	attemptId: string;
	state: CoordinatorAuthLinkState;
	expiresAtMs: number;
}
export type CoordinatorAuthLinkError =
	| "invalid_input"
	| "controller_not_active"
	| "attempt_conflict"
	| "attempt_limited"
	| "attempt_unavailable"
	| "attempt_expired"
	| "auth_config_changed"
	| "link_conflict";
export interface CoordinatorAuthLinkRejected {
	kind: "rejected";
	error: CoordinatorAuthLinkError;
}
export interface CoordinatorAuthLinkMaintenanceOptions {
	limit?: number;
}
export type CoordinatorAuthLinkMaintenanceResult =
	| { kind: "maintained"; processedCount: number; more: boolean }
	| CoordinatorAuthLinkRejected;
export type CoordinatorAuthLinkResult =
	| { kind: "applied" | "existing"; status: CoordinatorAuthLinkStatus }
	| CoordinatorAuthLinkRejected;
export type CoordinatorAuthLinkCreateResult =
	| { kind: "created" | "existing"; status: CoordinatorAuthLinkStatus; identityId: string }
	| CoordinatorAuthLinkRejected;
export type CoordinatorAuthLinkOidcResult =
	| {
			kind: "applied";
			status: CoordinatorAuthLinkStatus;
			target: { identityId: string; groupId: string; deviceId: string };
	  }
	| CoordinatorAuthLinkRejected;
export interface CoordinatorAuthLinkCreateInput {
	attemptId: string;
	signer: CoordinatorAuthLinkSigner;
	runtimeVerifierHash: string;
	loopbackRedirect: string;
}
export interface CoordinatorAuthLinkClaimInput {
	attemptId: string;
	browserTransactionHash: string;
}
export interface CoordinatorAuthLinkOidcInput extends CoordinatorAuthLinkClaimInput {
	account: { issuer: string; subject: string };
}
export interface CoordinatorAuthLinkConfirmInput extends CoordinatorAuthLinkClaimInput {
	completionSecretHash: string;
}
export interface CoordinatorAuthLinkFinalizeInput {
	purpose: typeof AUTH_LINK_PURPOSE;
	coordinatorId: string;
	attemptId: string;
	groupId: string;
	identityId: string;
	deviceId: string;
	fingerprint: string;
	runtimeVerifierHash: string;
	completionSecretHash: string;
	signer: CoordinatorAuthLinkSigner;
}
export interface CoordinatorAuthLinkFailInput {
	attemptId: string;
	requester: CoordinatorAuthLinkRequester;
	reason: "cancelled" | "provider_failure" | "config_failure";
}
export interface CoordinatorAuthLinkStore {
	maintainAuthLinkAttempts(
		config: CoordinatorAuthLinkConfig,
		options?: CoordinatorAuthLinkMaintenanceOptions,
	): Promise<CoordinatorAuthLinkMaintenanceResult>;
	createAuthLinkAttempt(
		input: CoordinatorAuthLinkCreateInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkCreateResult>;
	claimAuthLinkAttempt(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult>;
	recordAuthLinkOidcVerified(
		input: CoordinatorAuthLinkOidcInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkOidcResult>;
	confirmAuthLinkAttempt(
		input: CoordinatorAuthLinkConfirmInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult>;
	readAuthLinkCompletionDestination(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<{ destination: string } | null>;
	finalizeAuthLinkAttempt(
		input: CoordinatorAuthLinkFinalizeInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult>;
	failAuthLinkAttempt(
		input: CoordinatorAuthLinkFailInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult>;
	getAuthLinkAttemptStatus(
		attemptId: string,
		requester: CoordinatorAuthLinkRequester,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkStatus | null>;
}
export interface CoordinatorAuthLinkOptions {
	authClock?: () => number;
}

export const AUTH_LINK_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_link_attempts (
 coordinator_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 public_key TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT NOT NULL,
 controller_review_receipt_id TEXT NOT NULL,
 controller_revision INTEGER NOT NULL CHECK (controller_revision = 1),
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 runtime_verifier_hash TEXT NOT NULL CHECK (length(runtime_verifier_hash) = 64 AND runtime_verifier_hash NOT GLOB '*[^0-9a-f]*'),
 loopback_redirect TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','browser_claimed','oidc_verified','confirmed','finalized','session_redeemed','expired','failed')),
 browser_transaction_hash TEXT CHECK (browser_transaction_hash IS NULL OR (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*')),
 account_subject TEXT CHECK (account_subject IS NULL OR length(account_subject) BETWEEN 1 AND 255),
 completion_secret_hash TEXT CHECK (completion_secret_hash IS NULL OR (length(completion_secret_hash) = 64 AND completion_secret_hash NOT GLOB '*[^0-9a-f]*')),
 link_id TEXT,
 failure_reason TEXT CHECK (failure_reason IS NULL OR failure_reason IN ('device_cancelled','browser_cancelled','provider_failure','config_failure')),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms >= 0 AND created_at_ms <= 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms = created_at_ms + 600000),
 claimed_at_ms INTEGER,
 oidc_verified_at_ms INTEGER,
 confirmed_at_ms INTEGER,
 finalized_at_ms INTEGER,
 failed_at_ms INTEGER,
 PRIMARY KEY (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, runtime_verifier_hash),
 UNIQUE (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, completion_secret_hash),
 UNIQUE (coordinator_id, link_id),
 CHECK (state <> 'pending' OR (browser_transaction_hash IS NULL AND account_subject IS NULL AND completion_secret_hash IS NULL AND link_id IS NULL)),
 CHECK (state NOT IN ('browser_claimed','oidc_verified','confirmed','finalized','session_redeemed') OR browser_transaction_hash IS NOT NULL),
 CHECK (state NOT IN ('oidc_verified','confirmed','finalized','session_redeemed') OR account_subject IS NOT NULL),
 CHECK (state NOT IN ('confirmed','finalized','session_redeemed') OR completion_secret_hash IS NOT NULL),
 CHECK ((state IN ('finalized','session_redeemed') AND link_id IS NOT NULL AND finalized_at_ms IS NOT NULL) OR (state NOT IN ('finalized','session_redeemed') AND link_id IS NULL AND finalized_at_ms IS NULL)),
 CHECK ((state = 'failed' AND failure_reason IS NOT NULL AND failed_at_ms IS NOT NULL) OR (state <> 'failed' AND failure_reason IS NULL AND failed_at_ms IS NULL))
);
CREATE TABLE IF NOT EXISTS coordinator_auth_account_links (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 issuer TEXT NOT NULL,
 subject TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 255),
 identity_id TEXT NOT NULL,
 attempt_id TEXT NOT NULL,
 controller_attestation_id TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 revoked_at_ms INTEGER,
 PRIMARY KEY (coordinator_id, link_id),
 UNIQUE (coordinator_id, issuer, subject),
 UNIQUE (coordinator_id, identity_id),
 UNIQUE (coordinator_id, attempt_id)
);
CREATE TABLE IF NOT EXISTS coordinator_auth_link_audit_log (
 coordinator_id TEXT NOT NULL,
 link_id TEXT NOT NULL,
 action TEXT NOT NULL CHECK (action IN ('link_created','link_revoked')),
 attempt_id TEXT NOT NULL,
 identity_id TEXT NOT NULL,
 group_id TEXT NOT NULL,
 device_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
 controller_attestation_id TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL,
 PRIMARY KEY (coordinator_id, link_id, action)
);
CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_device_created
 ON coordinator_auth_link_attempts(coordinator_id, group_id, device_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_identity_expiry
 ON coordinator_auth_link_attempts(coordinator_id, identity_id, expires_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_link_attempts_state_expiry
 ON coordinator_auth_link_attempts(coordinator_id, state, expires_at_ms);`;
