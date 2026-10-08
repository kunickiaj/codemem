import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";

export const AUTH_BROWSER_TXN_TTL_MS = 600000;
export const AUTH_SIGNIN_TXN_WINDOW_MS = 3600000;
export const AUTH_SIGNIN_TXN_MAX_STARTS_PER_WINDOW = 1024;
export const AUTH_SIGNIN_TXN_MAX_RETAINED = 4096;
export const AUTH_BROWSER_TXN_MAINTENANCE_BATCH_MAX = 32;
export const AUTH_SIGNIN_TXN_PURGE_AGE_MS = 7200000;
export const AUTH_SIGNIN_TXN_PURGE_BATCH_MAX = 256;

export interface CoordinatorAuthBrowserConfig extends CoordinatorAuthLinkConfig {
	redirectUri: string;
}
interface BrowserMaterials {
	stateHash: string;
	binderHash: string;
	nonce: string;
	pkceVerifier: string;
}
export type CoordinatorAuthBrowserTransactionStartInput = BrowserMaterials &
	({ purpose: "signin" } | { purpose: "link"; attemptId: string; browserStartHash?: string });
export interface CoordinatorAuthBrowserTransactionConsumeInput {
	stateHash: string;
	binderHash: string;
}
export interface CoordinatorAuthLinkBrowserTransactionResolveInput {
	attemptId: string;
	binderHash: string;
}
export type CoordinatorAuthBrowserTransactionError =
	| "invalid_input"
	| "auth_config_changed"
	| "transaction_limited"
	| "transaction_conflict"
	| "attempt_unavailable"
	| "attempt_expired"
	| "transaction_unavailable";
export interface CoordinatorAuthBrowserTransactionRejected {
	kind: "rejected";
	error: CoordinatorAuthBrowserTransactionError;
}
export type CoordinatorAuthBrowserTransactionStartResult =
	| { kind: "started"; expiresAtMs: number }
	| { kind: "rejected"; error: "clock_retention_blocked" }
	| CoordinatorAuthBrowserTransactionRejected;
/** Secrets are for the trusted SDK exchange caller only, never an HTTP or polling DTO. */
export type CoordinatorAuthBrowserTransactionConsumeResult =
	| ({ kind: "consumed"; browserTransactionHash: string; nonce: string; pkceVerifier: string } & (
			| { purpose: "signin" }
			| { purpose: "link"; attemptId: string }
	  ))
	| CoordinatorAuthBrowserTransactionRejected;
export interface CoordinatorAuthBrowserTransactionScope {
	coordinatorId: string;
}
export interface CoordinatorAuthBrowserTransactionMaintenanceOptions {
	limit?: number;
}
export interface CoordinatorAuthSigninBrowserTransactionCancelInput {
	binderHash: string;
}
export type CoordinatorAuthSigninBrowserTransactionCancelResult =
	| { kind: "cancelled" }
	| { kind: "unavailable" }
	| { kind: "rejected"; error: "invalid_input" };
export interface CoordinatorAuthBrowserTransactionRetirementOptions {
	/** Omit unused options; explicit undefined values are rejected. */
	attemptId?: string;
	limit?: number;
}
export type CoordinatorAuthBrowserTransactionRetirementResult =
	| { kind: "retired"; processedCount: number; more: boolean }
	| { kind: "rejected"; error: "invalid_input" };
export type CoordinatorAuthBrowserTransactionMaintenanceResult =
	| { kind: "maintained"; processedCount: number; more: boolean }
	| { kind: "rejected"; error: "invalid_input" };
export type CoordinatorAuthSigninBrowserTransactionPurgeResult =
	| { kind: "purged"; processedCount: number; more: boolean }
	| { kind: "rejected"; error: "invalid_input" };
export interface CoordinatorAuthBrowserTransactionStore {
	startAuthBrowserTransaction(
		input: CoordinatorAuthBrowserTransactionStartInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthBrowserTransactionStartResult>;
	consumeAuthBrowserTransaction(
		input: CoordinatorAuthBrowserTransactionConsumeInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthBrowserTransactionConsumeResult>;
	resolveAuthLinkBrowserTransaction(
		input: CoordinatorAuthLinkBrowserTransactionResolveInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<{ browserTransactionHash: string } | null>;
	maintainAuthBrowserTransactions(
		scope: CoordinatorAuthBrowserTransactionScope,
		options?: CoordinatorAuthBrowserTransactionMaintenanceOptions,
	): Promise<CoordinatorAuthBrowserTransactionMaintenanceResult>;
	purgeAuthSigninBrowserTransactions(
		scope: CoordinatorAuthBrowserTransactionScope,
		options?: CoordinatorAuthBrowserTransactionMaintenanceOptions,
	): Promise<CoordinatorAuthSigninBrowserTransactionPurgeResult>;
	cancelAuthSigninBrowserTransaction(
		input: CoordinatorAuthSigninBrowserTransactionCancelInput,
		scope: CoordinatorAuthBrowserTransactionScope,
	): Promise<CoordinatorAuthSigninBrowserTransactionCancelResult>;
	retireAuthBrowserTransactions(
		config: CoordinatorAuthBrowserConfig,
		options?: CoordinatorAuthBrowserTransactionRetirementOptions,
	): Promise<CoordinatorAuthBrowserTransactionRetirementResult>;
}

export const AUTH_BROWSER_TXN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS coordinator_auth_browser_transactions (
 coordinator_id TEXT NOT NULL CHECK (length(coordinator_id) BETWEEN 1 AND 256),
 browser_transaction_hash TEXT NOT NULL CHECK (length(browser_transaction_hash) = 64 AND browser_transaction_hash NOT GLOB '*[^0-9a-f]*'),
  purpose TEXT NOT NULL CHECK (purpose IN ('signin','link','owner_enroll')),
 attempt_id TEXT CHECK (attempt_id IS NULL OR length(attempt_id) BETWEEN 1 AND 256),
 state_hash TEXT NOT NULL CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
 binder_hash TEXT NOT NULL CHECK (length(binder_hash) = 64 AND binder_hash NOT GLOB '*[^0-9a-f]*'),
 issuer TEXT NOT NULL,
 auth_config_revision TEXT NOT NULL CHECK (length(auth_config_revision) = 64 AND auth_config_revision NOT GLOB '*[^0-9a-f]*'),
 redirect_uri TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('pending','consumed','expired')),
 nonce TEXT CHECK (nonce IS NULL OR (length(nonce) BETWEEN 43 AND 128 AND nonce NOT GLOB '*[^A-Za-z0-9._~-]*')),
 pkce_verifier TEXT CHECK (pkce_verifier IS NULL OR (length(pkce_verifier) BETWEEN 43 AND 128 AND pkce_verifier NOT GLOB '*[^A-Za-z0-9._~-]*')),
 claim_token TEXT,
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254140991),
 expires_at_ms INTEGER NOT NULL CHECK (typeof(expires_at_ms) = 'integer' AND expires_at_ms > created_at_ms AND expires_at_ms <= created_at_ms + 600000),
 consumed_at_ms INTEGER CHECK (consumed_at_ms IS NULL OR (typeof(consumed_at_ms) = 'integer' AND consumed_at_ms >= created_at_ms AND consumed_at_ms < expires_at_ms AND consumed_at_ms <= 9007199254740991)),
 PRIMARY KEY (coordinator_id, browser_transaction_hash),
 UNIQUE (coordinator_id, state_hash),
 UNIQUE (coordinator_id, binder_hash),
 UNIQUE (coordinator_id, attempt_id),
 UNIQUE (coordinator_id, claim_token),
  CHECK ((purpose IN ('link','owner_enroll') AND attempt_id IS NOT NULL) OR (purpose = 'signin' AND attempt_id IS NULL)),
 CHECK ((state = 'pending' AND nonce IS NOT NULL AND pkce_verifier IS NOT NULL) OR (state <> 'pending' AND nonce IS NULL AND pkce_verifier IS NULL)),
 CHECK ((state = 'consumed' AND claim_token IS NOT NULL AND consumed_at_ms IS NOT NULL) OR (state <> 'consumed' AND claim_token IS NULL AND consumed_at_ms IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_purpose_created
 ON coordinator_auth_browser_transactions(coordinator_id, purpose, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_auth_browser_txn_state_expiry
 ON coordinator_auth_browser_transactions(coordinator_id, state, expires_at_ms);
CREATE TABLE IF NOT EXISTS coordinator_auth_signin_purge_floors (
 coordinator_id TEXT NOT NULL PRIMARY KEY CHECK (length(coordinator_id) BETWEEN 1 AND 256),
 purged_through_created_at_ms INTEGER NOT NULL CHECK (typeof(purged_through_created_at_ms) = 'integer' AND purged_through_created_at_ms BETWEEN 0 AND 9007199254140991)
);
`;
