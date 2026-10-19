import { hasConnectionSessionSchema } from "./coordinator-account-connection-session.js";
import {
	CONNECTION_NOT_REVOKED_SQL,
	CONNECTION_SIGNIN_ORDER_SQL,
} from "./coordinator-account-connection-storage.js";
import {
	historicalRevocationReadSql,
	historicalRevocationStatements,
} from "./coordinator-account-historical-revoke.js";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import {
	isCoordinatorAccountIssuer,
	parseCoordinatorAccountReference,
} from "./coordinator-auth-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import { authAccountLinkProvenanceSql } from "./coordinator-auth-link-provenance.js";
import { authPersistenceError } from "./coordinator-auth-schema.js";
import {
	AUTH_GUARDED_SIGNIN_PURGE_BATCH_MAX,
	AUTH_GUARDED_SIGNIN_PURGE_GRACE_MS,
	AUTH_GUARDED_SIGNIN_RECEIPT_PURGE_AGE_MS,
	AUTH_LINK_REDEEM_WINDOW_MS,
	AUTH_SESSION_MAX_LIVE_PER_LINK,
	AUTH_SESSION_TTL_MS,
	type CoordinatorAuthAccountLinkAdminStore,
	type CoordinatorAuthAccountLinkRevokeResult,
	type CoordinatorAuthAccountSignInInput,
	type CoordinatorAuthBoundLinkSessionRedeemInput,
	type CoordinatorAuthLinkSessionPreserveResult,
	type CoordinatorAuthLinkSessionRedeemInput,
	type CoordinatorAuthSession,
	type CoordinatorAuthSessionError,
	type CoordinatorAuthSessionIssueResult,
	type CoordinatorAuthSessionPurgeOptions,
	type CoordinatorAuthSessionPurgeResult,
	type CoordinatorAuthSessionScope,
	type CoordinatorAuthSessionSignOutResult,
	type CoordinatorAuthSessionStore,
} from "./coordinator-auth-session-contract.js";

export * from "./coordinator-auth-session-contract.js";

type Captured = Record<string, unknown>;
function capture(value: unknown, fields: readonly string[]): Captured | null {
	if (!value || typeof value !== "object") return null;
	try {
		if (Array.isArray(value)) return null;
		const result: Captured = {};
		for (const key of fields) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
			result[key] = descriptor.value;
		}
		return result;
	} catch {
		return null;
	}
}
function isHash(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}
function captureConfig(value: unknown): CoordinatorAuthLinkConfig | null {
	const c = capture(value, ["coordinatorId", "issuer", "revision", "enabled"]);
	if (
		!c ||
		!isAuthControllerId(c.coordinatorId) ||
		!isCoordinatorAccountIssuer(c.issuer) ||
		!isHash(c.revision) ||
		typeof c.enabled !== "boolean"
	)
		return null;
	return {
		coordinatorId: c.coordinatorId,
		issuer: c.issuer,
		revision: c.revision,
		enabled: c.enabled,
	};
}
function captureScope(value: unknown): CoordinatorAuthSessionScope | null {
	const s = capture(value, ["coordinatorId"]);
	return s && isAuthControllerId(s.coordinatorId) ? { coordinatorId: s.coordinatorId } : null;
}
function capturePurgeLimit(value: unknown): number | null {
	if (value === undefined) return AUTH_GUARDED_SIGNIN_PURGE_BATCH_MAX;
	if (!value || typeof value !== "object") return null;
	try {
		if (Array.isArray(value)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, "limit");
		if (!descriptor) return "limit" in value ? null : AUTH_GUARDED_SIGNIN_PURGE_BATCH_MAX;
		if (!Object.hasOwn(descriptor, "value")) return null;
		const limit: unknown = descriptor.value;
		if (typeof limit !== "number" || !Number.isSafeInteger(limit)) return null;
		return limit >= 1 && limit <= AUTH_GUARDED_SIGNIN_PURGE_BATCH_MAX ? limit : null;
	} catch {
		return null;
	}
}
function captureBrowserConfig(value: unknown): CoordinatorAuthBrowserConfig | null {
	const snapshot = capture(value, [
		"coordinatorId",
		"issuer",
		"revision",
		"enabled",
		"redirectUri",
	]);
	const c = captureConfig(snapshot);
	if (!c || !snapshot || typeof snapshot.redirectUri !== "string") return null;
	const redirectUri = snapshot.redirectUri;
	if (redirectUri.trim() !== redirectUri || /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(redirectUri))
		return null;
	try {
		const url = new URL(redirectUri);
		if (
			url.protocol !== "https:" ||
			url.href !== redirectUri ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			redirectUri.includes("?") ||
			redirectUri.includes("#")
		)
			return null;
	} catch {
		return null;
	}
	return { ...c, redirectUri };
}
function captureIssue(
	value: unknown,
	extra: string[],
): (Captured & { browserTransactionHash: string; credentialHash: string }) | null {
	const i = capture(value, ["browserTransactionHash", "credentialHash", ...extra]);
	if (!i || !isHash(i.browserTransactionHash) || !isHash(i.credentialHash)) return null;
	return {
		...i,
		browserTransactionHash: i.browserTransactionHash,
		credentialHash: i.credentialHash,
	};
}
function sessionNow(clock: () => number): number {
	let now: number;
	try {
		now = clock();
	} catch {
		throw new Error("auth_session_invalid_clock");
	}
	if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - AUTH_SESSION_TTL_MS)
		throw new Error("auth_session_invalid_clock");
	return now;
}

export { sessionNow as authSessionNow };

function rejected(
	error: CoordinatorAuthSessionError,
): Extract<CoordinatorAuthSessionIssueResult, { kind: "rejected" }> {
	return { kind: "rejected", error };
}
interface SessionRow {
	session_id: string;
	identity_id: string;
	link_id: string;
	issuer: string;
	subject: string;
	expires_at_ms: number;
}
interface ReceiptRow {
	session_id: string;
}
interface RedeemDiagnosis {
	browser_transaction_hash: string | null;
	state: string;
	issuer: string;
	auth_config_revision: string;
	finalized_at_ms: number | null;
	expires_at_ms: number;
}
function dto(row: SessionRow): CoordinatorAuthSession {
	return {
		sessionId: row.session_id,
		identityId: row.identity_id,
		linkId: row.link_id,
		account: { issuer: row.issuer, subject: row.subject },
		expiresAtMs: row.expires_at_ms,
	};
}
const SESSION_LINK_IDENTITY_SQL = `l.coordinator_id = s.coordinator_id AND l.link_id = s.link_id
 AND l.identity_id = s.identity_id AND l.issuer = s.issuer AND l.subject = s.subject`;
export function authSessionLinkMatchSql(options: { connections: boolean }): string {
	return `${SESSION_LINK_IDENTITY_SQL} AND ${authAccountLinkProvenanceSql("l", options)}`;
}
export const AUTH_SESSION_LINK_MATCH_SQL = authSessionLinkMatchSql({ connections: false });
export const AUTH_SESSION_LIVE_GUARD_SQL = `s.coordinator_id = ? AND s.credential_hash = ? AND s.issuer = ? AND s.auth_config_revision = ? AND s.revoked_at_ms IS NULL AND l.revoked_at_ms IS NULL AND s.expires_at_ms > ? AND s.created_at_ms <= ?`;
const RECEIPT_COLUMNS = `coordinator_id, browser_transaction_hash, source, attempt_id, link_id, session_id, auth_config_revision, created_at_ms`;
function redeemReceiptSelectSql(options: { connections: boolean }) {
	const ACCOUNT_PROVENANCE = authAccountLinkProvenanceSql("l", options);
	return `INSERT INTO coordinator_auth_session_receipts (${RECEIPT_COLUMNS})
 SELECT t.coordinator_id, t.browser_transaction_hash, 'link_redeem', t.attempt_id, t.link_id, ?, ?, ?
 FROM coordinator_auth_link_attempts t JOIN coordinator_auth_account_links l
 ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id AND l.attempt_id = t.attempt_id
 AND l.identity_id = t.identity_id AND l.issuer = t.issuer AND l.subject = t.account_subject
 AND l.auth_config_revision = t.auth_config_revision AND l.authority_kind = t.authority_kind
 AND ${ACCOUNT_PROVENANCE}
 WHERE t.coordinator_id = ? AND t.attempt_id = ? AND t.browser_transaction_hash = ?
 AND t.state = 'finalized' AND t.issuer = ? AND t.auth_config_revision = ? AND l.revoked_at_ms IS NULL
 AND ? >= t.finalized_at_ms AND ? < t.finalized_at_ms + 120000 AND ? < t.expires_at_ms`;
}
const BOUND_LINK_BROWSER_GUARD_SQL = `b.coordinator_id = t.coordinator_id
 AND b.browser_transaction_hash = t.browser_transaction_hash AND b.attempt_id = t.attempt_id
 AND b.binder_hash = ? AND b.purpose = 'link' AND b.state = 'consumed'
 AND b.issuer = ? AND b.auth_config_revision = ? AND b.redirect_uri = ?
 AND b.nonce IS NULL AND b.pkce_verifier IS NULL AND b.claim_token IS NOT NULL
 AND b.consumed_at_ms IS NOT NULL AND b.created_at_ms <= ?
 AND b.consumed_at_ms <= ? AND b.expires_at_ms > ?`;
function boundBrowserGuard(options: { connections: boolean }) {
	return `(${BOUND_LINK_BROWSER_GUARD_SQL})${options.connections ? ` AND (${CONNECTION_SIGNIN_ORDER_SQL}) AND (${CONNECTION_NOT_REVOKED_SQL})` : ""}`;
}
function boundRedeemSql(options: { connections: boolean }) {
	return `${redeemReceiptSelectSql(options)}
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE ${boundBrowserGuard(options)})
 ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING`;
}
function connectedPreserveCompletionSql(): string {
	return `WITH completion_links AS MATERIALIZED (SELECT l.* FROM coordinator_auth_account_links l WHERE l.coordinator_id = ? AND
 (l.link_id = (SELECT link_id FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?) OR l.link_id = (SELECT link_id FROM coordinator_auth_sessions WHERE coordinator_id = ? AND credential_hash = ?))
 AND (${authAccountLinkProvenanceSql("l", { connections: true })}) AND (${CONNECTION_NOT_REVOKED_SQL})),
 eligible_completion AS MATERIALIZED (SELECT t.coordinator_id,t.attempt_id,t.browser_transaction_hash FROM coordinator_auth_link_attempts t JOIN completion_links l
 ON (l.coordinator_id=t.coordinator_id AND l.link_id=t.link_id AND l.attempt_id=t.attempt_id)
 AND (l.identity_id=t.identity_id AND l.issuer=t.issuer AND l.subject=t.account_subject AND l.auth_config_revision=t.auth_config_revision AND l.authority_kind=t.authority_kind AND l.revoked_at_ms IS NULL)
 WHERE (t.coordinator_id = ? AND t.attempt_id = ? AND t.browser_transaction_hash = ? AND t.issuer = ? AND t.auth_config_revision = ? AND t.state = 'finalized')
 AND (t.created_at_ms <= ? AND t.finalized_at_ms <= ? AND ? < t.finalized_at_ms + 120000 AND t.expires_at_ms > ?)
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE ${boundBrowserGuard({ connections: true })})),
 live_existing_session AS MATERIALIZED (SELECT 1 FROM coordinator_auth_sessions s JOIN completion_links l ON ${SESSION_LINK_IDENTITY_SQL} WHERE (${AUTH_SESSION_LIVE_GUARD_SQL}) AND (${CONNECTION_NOT_REVOKED_SQL}))
 UPDATE coordinator_auth_link_attempts AS t SET state='session_redeemed' WHERE t.state='finalized'
 AND EXISTS (SELECT 1 FROM eligible_completion p WHERE p.coordinator_id=t.coordinator_id AND p.attempt_id=t.attempt_id AND p.browser_transaction_hash=t.browser_transaction_hash)
 AND EXISTS (SELECT 1 FROM live_existing_session)`;
}
function preserveCompletionSql(options: { connections: boolean }) {
	if (options.connections) return connectedPreserveCompletionSql();
	const ACCOUNT_PROVENANCE = authAccountLinkProvenanceSql("l", options),
		LINK_MATCH = authSessionLinkMatchSql(options);
	return `UPDATE coordinator_auth_link_attempts AS t SET state = 'session_redeemed'
 WHERE (t.coordinator_id = ? AND t.attempt_id = ? AND t.browser_transaction_hash = ? AND t.issuer = ? AND t.auth_config_revision = ? AND t.state = 'finalized')
 AND (t.created_at_ms <= ? AND t.finalized_at_ms <= ? AND ? < t.finalized_at_ms + 120000 AND t.expires_at_ms > ?)
 AND EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE (l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id AND l.attempt_id = t.attempt_id)
 AND (l.identity_id = t.identity_id AND l.issuer = t.issuer AND l.subject = t.account_subject)
 AND (l.auth_config_revision = t.auth_config_revision AND l.revoked_at_ms IS NULL AND l.authority_kind = t.authority_kind) AND ${ACCOUNT_PROVENANCE}
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE ${boundBrowserGuard(options)}))
 AND EXISTS (SELECT 1 FROM coordinator_auth_sessions s
 JOIN coordinator_auth_account_links l ON ${LINK_MATCH} WHERE (${AUTH_SESSION_LIVE_GUARD_SQL}))`;
}
const CONSUMED_BROWSER_GUARD_SQL = `b.coordinator_id = ? AND b.browser_transaction_hash = ?
 AND b.purpose = 'signin' AND b.attempt_id IS NULL AND b.state = 'consumed'
 AND b.nonce IS NULL AND b.pkce_verifier IS NULL AND b.claim_token IS NOT NULL
 AND b.issuer = ? AND b.auth_config_revision = ? AND b.redirect_uri = ?
 AND b.created_at_ms <= ? AND b.consumed_at_ms <= ? AND b.expires_at_ms > ?`;
function consumedSigninReceiptSql(options: { connections: boolean }) {
	const ACCOUNT_PROVENANCE = authAccountLinkProvenanceSql("l", options),
		LINK_MATCH = options.connections ? SESSION_LINK_IDENTITY_SQL : authSessionLinkMatchSql(options);
	// The capacity count references the same independently proven link row.
	return `${options.connections ? `WITH admissible_links AS MATERIALIZED (SELECT l.* FROM coordinator_auth_account_links l WHERE (l.coordinator_id = ? AND l.issuer = ? AND l.subject = ?) AND (${ACCOUNT_PROVENANCE}) AND (${CONNECTION_NOT_REVOKED_SQL})) ` : ""}INSERT INTO coordinator_auth_session_receipts (${RECEIPT_COLUMNS}, purge_eligible${options.connections ? ",source_order" : ""})
 SELECT b.coordinator_id, b.browser_transaction_hash, 'signin', NULL, l.link_id, ?, ?, ?, 1${options.connections ? ",b.start_order" : ""}
 FROM coordinator_auth_browser_transactions b JOIN ${options.connections ? "admissible_links" : "coordinator_auth_account_links"} l
 ON l.coordinator_id = b.coordinator_id AND l.issuer = b.issuer
 WHERE (${CONSUMED_BROWSER_GUARD_SQL}) AND l.subject = ? AND l.revoked_at_ms IS NULL ${options.connections ? "" : `AND ${ACCOUNT_PROVENANCE}`}
 ${options.connections ? `AND ${CONNECTION_NOT_REVOKED_SQL} AND ${CONNECTION_SIGNIN_ORDER_SQL}` : ""}
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts t
 WHERE t.coordinator_id = b.coordinator_id AND t.browser_transaction_hash = b.browser_transaction_hash)
 AND (SELECT COUNT(*) FROM coordinator_auth_sessions s WHERE ${LINK_MATCH}
 AND s.auth_config_revision = b.auth_config_revision AND s.revoked_at_ms IS NULL
 AND s.expires_at_ms > ?) < ${AUTH_SESSION_MAX_LIVE_PER_LINK}
 ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING`;
}
function sessionInsertSql(options: { connections: boolean }) {
	const ACCOUNT_PROVENANCE = authAccountLinkProvenanceSql("l", options);
	return `INSERT INTO coordinator_auth_sessions
 (coordinator_id, session_id, credential_hash, browser_transaction_hash, link_id, identity_id, issuer, subject, auth_config_revision, created_at_ms, expires_at_ms)
 SELECT r.coordinator_id, r.session_id, ?, r.browser_transaction_hash, r.link_id, l.identity_id, l.issuer, l.subject, r.auth_config_revision, r.created_at_ms, r.created_at_ms + 28800000
 FROM coordinator_auth_session_receipts r JOIN coordinator_auth_account_links l ON l.coordinator_id = r.coordinator_id AND l.link_id = r.link_id
 WHERE r.coordinator_id = ? AND r.browser_transaction_hash = ? AND r.session_id = ? AND l.revoked_at_ms IS NULL AND ${ACCOUNT_PROVENANCE}`;
}
function redeemConsumeSql(options: { connections: boolean }) {
	const ACCOUNT_PROVENANCE = authAccountLinkProvenanceSql("l", options);
	return `UPDATE coordinator_auth_link_attempts SET state = 'session_redeemed'
 WHERE coordinator_id = ? AND attempt_id = ? AND browser_transaction_hash = ? AND state = 'finalized'
 AND EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id = coordinator_auth_link_attempts.coordinator_id
 AND l.link_id = coordinator_auth_link_attempts.link_id AND l.attempt_id = coordinator_auth_link_attempts.attempt_id
 AND l.authority_kind = coordinator_auth_link_attempts.authority_kind AND l.revoked_at_ms IS NULL AND ${ACCOUNT_PROVENANCE})
 AND EXISTS (SELECT 1 FROM coordinator_auth_sessions s WHERE s.coordinator_id = coordinator_auth_link_attempts.coordinator_id AND s.session_id = ? AND s.browser_transaction_hash = coordinator_auth_link_attempts.browser_transaction_hash)`;
}
function issueReadSql(options: { connections: boolean }) {
	const LINK_MATCH = authSessionLinkMatchSql(options);
	return `SELECT s.session_id, s.identity_id, s.link_id, s.issuer, s.subject, s.expires_at_ms
 FROM coordinator_auth_session_receipts r JOIN coordinator_auth_sessions s
 ON s.coordinator_id = r.coordinator_id AND s.session_id = r.session_id AND s.browser_transaction_hash = r.browser_transaction_hash
 AND s.link_id = r.link_id AND s.auth_config_revision = r.auth_config_revision AND s.created_at_ms = r.created_at_ms
 JOIN coordinator_auth_account_links l ON ${LINK_MATCH}
 WHERE r.coordinator_id = ? AND r.browser_transaction_hash = ? AND r.session_id = ?
 AND s.credential_hash = ? AND r.auth_config_revision = ? AND r.created_at_ms = ? AND s.expires_at_ms = ? AND s.issuer = ?
 AND ((r.source = 'signin' AND r.attempt_id IS NULL) OR (r.source = 'link_redeem' AND EXISTS
 (SELECT 1 FROM coordinator_auth_link_attempts t WHERE t.coordinator_id = r.coordinator_id AND t.attempt_id = r.attempt_id
 AND t.state = 'session_redeemed' AND t.authority_kind = l.authority_kind AND t.link_id = r.link_id AND t.browser_transaction_hash = r.browser_transaction_hash
 AND t.identity_id = s.identity_id AND t.issuer = s.issuer AND t.account_subject = s.subject)))`;
}

const PURGE_GUARDED_SIGNIN_SESSIONS_SQL = `DELETE FROM coordinator_auth_sessions
 WHERE coordinator_id = ? AND expires_at_ms <= ? AND session_id IN
 (SELECT s.session_id FROM coordinator_auth_sessions s
 WHERE s.coordinator_id = ? AND s.expires_at_ms <= ?
 AND EXISTS (SELECT 1 FROM coordinator_auth_session_receipts r
 WHERE r.coordinator_id = s.coordinator_id AND r.session_id = s.session_id
 AND r.browser_transaction_hash = s.browser_transaction_hash AND r.link_id = s.link_id
 AND r.auth_config_revision = s.auth_config_revision AND r.created_at_ms = s.created_at_ms
 AND r.source = 'signin' AND r.attempt_id IS NULL AND r.purge_eligible = 1)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b
 WHERE b.coordinator_id = s.coordinator_id AND b.browser_transaction_hash = s.browser_transaction_hash)
 ORDER BY s.expires_at_ms, s.session_id LIMIT ?)`;
const PURGE_GUARDED_SIGNIN_RECEIPTS_SQL = `DELETE FROM coordinator_auth_session_receipts
 WHERE coordinator_id = ? AND purge_eligible = 1 AND source = 'signin' AND attempt_id IS NULL
 AND created_at_ms <= ? AND browser_transaction_hash IN
 (SELECT r.browser_transaction_hash FROM coordinator_auth_session_receipts r
 WHERE r.coordinator_id = ? AND r.purge_eligible = 1 AND r.source = 'signin'
 AND r.attempt_id IS NULL AND r.created_at_ms <= ?
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b
 WHERE b.coordinator_id = r.coordinator_id AND b.browser_transaction_hash = r.browser_transaction_hash)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_sessions s
 WHERE s.coordinator_id = r.coordinator_id AND s.session_id = r.session_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_sessions s
 WHERE s.coordinator_id = r.coordinator_id AND s.browser_transaction_hash = r.browser_transaction_hash)
 ORDER BY r.created_at_ms, r.browser_transaction_hash LIMIT ?)`;

/** Optional persistence only. Future callers authenticate browser/OIDC/CSRF/admin;
 * this capability creates no routes, actors, enrollment, role, or sync permission.
 */
export class AuthSessionOperations
	implements CoordinatorAuthSessionStore, CoordinatorAuthAccountLinkAdminStore
{
	constructor(
		private readonly backend: AuthLinkBackend,
		private readonly clock: () => number = Date.now,
	) {}
	async purgeAuthGuardedSigninSessions(
		scope: CoordinatorAuthSessionScope,
		options?: CoordinatorAuthSessionPurgeOptions,
	): Promise<CoordinatorAuthSessionPurgeResult> {
		return this.purgeGuardedSigninMetadata(
			scope,
			options,
			PURGE_GUARDED_SIGNIN_SESSIONS_SQL,
			AUTH_GUARDED_SIGNIN_PURGE_GRACE_MS,
		);
	}
	async purgeAuthGuardedSigninReceipts(
		scope: CoordinatorAuthSessionScope,
		options?: CoordinatorAuthSessionPurgeOptions,
	): Promise<CoordinatorAuthSessionPurgeResult> {
		return this.purgeGuardedSigninMetadata(
			scope,
			options,
			PURGE_GUARDED_SIGNIN_RECEIPTS_SQL,
			AUTH_GUARDED_SIGNIN_RECEIPT_PURGE_AGE_MS,
		);
	}
	private async purgeGuardedSigninMetadata(
		scope: CoordinatorAuthSessionScope,
		options: CoordinatorAuthSessionPurgeOptions | undefined,
		sql: string,
		ageMs: number,
	): Promise<CoordinatorAuthSessionPurgeResult> {
		const s = captureScope(scope);
		const limit = capturePurgeLimit(options);
		if (!s || limit === null) return { kind: "rejected", error: "invalid_input" };
		const cutoff = sessionNow(this.clock) - ageMs;
		try {
			const processedCount = await this.backend.run({
				sql,
				values: [s.coordinatorId, cutoff, s.coordinatorId, cutoff, limit],
			});
			return { kind: "purged", processedCount, more: processedCount === limit };
		} catch (error) {
			throw authPersistenceError(error, "auth_session_persistence_error");
		}
	}
	private async first<T>(statement: AuthLinkStatement): Promise<T | null> {
		try {
			return await this.backend.first<T>(statement);
		} catch (error) {
			throw authPersistenceError(error, "auth_session_persistence_error");
		}
	}
	private async connectionSchema(): Promise<boolean> {
		try {
			return await hasConnectionSessionSchema(this.backend);
		} catch (error) {
			throw authPersistenceError(error, "auth_session_persistence_error");
		}
	}
	private async batch(statements: AuthLinkStatement[]): Promise<void> {
		try {
			await this.backend.batch(statements);
		} catch (error) {
			throw authPersistenceError(error, "auth_session_persistence_error");
		}
	}
	async redeemAuthLinkSession(
		_input: CoordinatorAuthLinkSessionRedeemInput,
		_config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionIssueResult> {
		// Retired: this entry has no browser binder and cannot prove redemption.
		return rejected("attempt_unavailable");
	}
	/** Complete once while preserving the existing session and its own active account link. */
	async preserveAuthLinkSessionCompletion(
		input: CoordinatorAuthBoundLinkSessionRedeemInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthLinkSessionPreserveResult> {
		const c = captureBrowserConfig(config);
		const i = captureIssue(input, ["attemptId", "binderHash"]);
		if (!c || !i || !isAuthControllerId(i.attemptId) || !isHash(i.binderHash))
			return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = sessionNow(this.clock);
		// credentialHash names the existing live session, which may belong to another linked account.
		// Completion creates no receipt: it preserves that session and burns only this attempt.
		const connections = await this.connectionSchema();
		let changed: number;
		try {
			changed = await this.backend.run({
				sql: preserveCompletionSql({ connections }),
				values: [
					...(connections
						? [c.coordinatorId, c.coordinatorId, i.attemptId, c.coordinatorId, i.credentialHash]
						: []),
					c.coordinatorId,
					i.attemptId,
					i.browserTransactionHash,
					c.issuer,
					c.revision,
					now,
					now,
					now,
					now,
					i.binderHash,
					c.issuer,
					c.revision,
					c.redirectUri,
					now,
					now,
					now,
					c.coordinatorId,
					i.credentialHash,
					c.issuer,
					c.revision,
					now,
					now,
				],
			});
		} catch (error) {
			throw authPersistenceError(error, "auth_session_persistence_error");
		}
		if (changed !== 1) return rejected("attempt_unavailable");
		const row = await this.first<{ state: string }>({
			sql: `SELECT state FROM coordinator_auth_link_attempts
 WHERE coordinator_id = ? AND attempt_id = ? AND browser_transaction_hash = ?
 AND issuer = ? AND auth_config_revision = ?`,
			values: [c.coordinatorId, i.attemptId, i.browserTransactionHash, c.issuer, c.revision],
		});
		// A failed post-commit read must not release cookies or pretend the burn rolled back.
		if (row?.state !== "session_redeemed") throw new Error("auth_session_persistence_incomplete");
		return { kind: "preserved" };
	}
	/** Admission binds a finalized link to its consumed original browser transaction. */
	async redeemAuthLinkSessionWithBrowserTransaction(
		input: CoordinatorAuthBoundLinkSessionRedeemInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthSessionIssueResult> {
		const c = captureBrowserConfig(config);
		const i = captureIssue(input, ["attemptId", "binderHash"]);
		if (!c || !i || !isAuthControllerId(i.attemptId) || !isHash(i.binderHash))
			return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = sessionNow(this.clock);
		const sessionId = globalThis.crypto.randomUUID();
		// The receipt guard is the admission check; only its fresh winner can mint and consume.
		await this.batch([
			{
				sql: boundRedeemSql({ connections: await this.connectionSchema() }),
				values: [
					sessionId,
					c.revision,
					now,
					c.coordinatorId,
					i.attemptId,
					i.browserTransactionHash,
					c.issuer,
					c.revision,
					now,
					now,
					now,
					i.binderHash,
					c.issuer,
					c.revision,
					c.redirectUri,
					now,
					now,
					now,
				],
			},
			await this.sessionInsert(i, c, sessionId),
			{
				sql: redeemConsumeSql({ connections: await this.connectionSchema() }),
				values: [c.coordinatorId, i.attemptId, i.browserTransactionHash, sessionId],
			},
		]);
		const result = await this.issueReceipt(i, c, now, sessionId);
		if (result) return result;
		return this.diagnoseRedeem(i.attemptId, i.browserTransactionHash, c, now);
	}
	async signInWithAuthAccount(
		_input: CoordinatorAuthAccountSignInInput,
		_config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionIssueResult> {
		// Retired: trusted account JSON alone cannot bypass consumed-browser proof.
		return rejected("transaction_unavailable");
	}
	/** Admission only; the caller has already verified JWT, cookie binding and CSRF. */
	async signInWithConsumedBrowserTransaction(
		input: CoordinatorAuthAccountSignInInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthSessionIssueResult> {
		const c = captureBrowserConfig(config);
		const i = captureIssue(input, ["account"]);
		if (!c || !i) return rejected("invalid_input");
		const account = parseCoordinatorAccountReference(capture(i.account, ["issuer", "subject"]), {
			issuer: c.issuer,
		});
		if (!account.ok) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = sessionNow(this.clock);
		const sessionId = globalThis.crypto.randomUUID();
		const transactionValues = [
			c.coordinatorId,
			i.browserTransactionHash,
			c.issuer,
			c.revision,
			c.redirectUri,
			now,
			now,
			now,
		];
		// Admission and minting share one atomic batch, not a read-then-insert race.
		// Future-born current-config sessions reserve slots until they become readable.
		const connections = await this.connectionSchema();
		await this.batch([
			{
				sql: consumedSigninReceiptSql({ connections }),
				values: [
					...(connections
						? [c.coordinatorId, account.account.issuer, account.account.subject]
						: []),
					sessionId,
					c.revision,
					now,
					...transactionValues,
					account.account.subject,
					now,
				],
			},
			await this.sessionInsert(i, c, sessionId, { connections }),
		]);
		const result = await this.issueReceipt(i, c, now, sessionId, { connections });
		if (result) return result;
		const used = await this.first({
			sql: "SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND browser_transaction_hash = ?",
			values: [c.coordinatorId, i.browserTransactionHash],
		});
		if (used) return rejected("browser_transaction_used");
		// These reads choose rejection labels only; they never admit or reuse a receipt.
		const transaction = await this.first({
			sql: `SELECT 1 FROM coordinator_auth_browser_transactions b WHERE ${CONSUMED_BROWSER_GUARD_SQL}`,
			values: transactionValues,
		});
		if (!transaction) return rejected("transaction_unavailable");
		const link = await this.first({
			sql: "SELECT 1 FROM coordinator_auth_account_links WHERE coordinator_id = ? AND issuer = ? AND subject = ? AND revoked_at_ms IS NULL",
			values: [c.coordinatorId, c.issuer, account.account.subject],
		});
		if (!link) return rejected("account_not_linked");
		return rejected("session_limited");
	}
	private async sessionInsert(
		i: { credentialHash: string; browserTransactionHash: string },
		c: CoordinatorAuthLinkConfig,
		sessionId: string,
		options?: { connections: boolean },
	): Promise<AuthLinkStatement> {
		return {
			sql: sessionInsertSql({
				connections: options?.connections ?? (await this.connectionSchema()),
			}),
			values: [i.credentialHash, c.coordinatorId, i.browserTransactionHash, sessionId],
		};
	}
	private async issueReceipt(
		i: { credentialHash: string; browserTransactionHash: string },
		c: CoordinatorAuthLinkConfig,
		now: number,
		sessionId: string,
		options?: { connections: boolean },
	): Promise<CoordinatorAuthSessionIssueResult | null> {
		const receipt = await this.first<ReceiptRow>({
			sql: "SELECT session_id FROM coordinator_auth_session_receipts WHERE coordinator_id = ? AND browser_transaction_hash = ?",
			values: [c.coordinatorId, i.browserTransactionHash],
		});
		if (!receipt) {
			const orphan = await this.first({
				sql: "SELECT 1 FROM coordinator_auth_sessions WHERE coordinator_id = ? AND session_id = ?",
				values: [c.coordinatorId, sessionId],
			});
			if (orphan) throw new Error("auth_session_persistence_incomplete");
			return null;
		}
		if (receipt.session_id !== sessionId) return rejected("browser_transaction_used");
		// Reuse only the stricter SQL shape; the SELECT still checks current readiness.
		const connections = options?.connections === true || (await this.connectionSchema());
		const row = await this.first<SessionRow>({
			sql: `${issueReadSql({ connections })}${connections ? ` AND ${CONNECTION_NOT_REVOKED_SQL}` : ""}`,
			values: [
				c.coordinatorId,
				i.browserTransactionHash,
				sessionId,
				i.credentialHash,
				c.revision,
				now,
				now + AUTH_SESSION_TTL_MS,
				c.issuer,
			],
		});
		if (!row) throw new Error("auth_session_persistence_incomplete");
		return { kind: "issued", session: dto(row) };
	}
	private async diagnoseRedeem(
		attemptId: string,
		browserHash: string,
		c: CoordinatorAuthLinkConfig,
		now: number,
	): Promise<CoordinatorAuthSessionIssueResult> {
		const row = await this.first<RedeemDiagnosis>({
			sql: "SELECT browser_transaction_hash, state, issuer, auth_config_revision, finalized_at_ms, expires_at_ms FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?",
			values: [c.coordinatorId, attemptId],
		});
		if (!row || row.browser_transaction_hash !== browserHash)
			return rejected("attempt_unavailable");
		if (row.issuer !== c.issuer || row.auth_config_revision !== c.revision)
			return rejected("auth_config_changed");
		if (row.state !== "finalized" || row.finalized_at_ms === null || now < row.finalized_at_ms)
			return rejected("attempt_unavailable");
		if (now >= row.expires_at_ms || now >= row.finalized_at_ms + AUTH_LINK_REDEEM_WINDOW_MS)
			return rejected("redeem_window_expired");
		return rejected("attempt_unavailable");
	}
	async readAuthSession(
		credentialHash: string,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSession | null> {
		const c = captureConfig(config);
		if (!c?.enabled || !isHash(credentialHash)) return null;
		const now = sessionNow(this.clock);
		const connections = await this.connectionSchema();
		const row = await this.first<SessionRow>({
			sql: `SELECT s.session_id, s.identity_id, s.link_id, s.issuer, s.subject, s.expires_at_ms FROM coordinator_auth_sessions s JOIN coordinator_auth_account_links l ON ${authSessionLinkMatchSql({ connections })}
 WHERE ${AUTH_SESSION_LIVE_GUARD_SQL}${connections ? ` AND ${CONNECTION_NOT_REVOKED_SQL}` : ""}`,
			values: [c.coordinatorId, credentialHash, c.issuer, c.revision, now, now],
		});
		return row ? dto(row) : null;
	}
	async signOutAuthSession(
		credentialHash: string,
		scope: CoordinatorAuthSessionScope,
	): Promise<CoordinatorAuthSessionSignOutResult> {
		const s = captureScope(scope);
		if (!s || !isHash(credentialHash)) return { kind: "rejected", error: "invalid_input" };
		const now = sessionNow(this.clock);
		await this.batch([
			{
				sql: "UPDATE coordinator_auth_sessions SET revoked_at_ms = ? WHERE coordinator_id = ? AND credential_hash = ? AND revoked_at_ms IS NULL",
				values: [now, s.coordinatorId, credentialHash],
			},
		]);
		return { kind: "signed_out" };
	}
	/** Configured-admin authentication is the caller's prerequisite, never an actor label. */
	async revokeAuthAccountLink(
		input: { linkId: string },
		scope: CoordinatorAuthSessionScope,
	): Promise<CoordinatorAuthAccountLinkRevokeResult> {
		const s = captureScope(scope);
		const i = capture(input, ["linkId"]);
		if (!s || !i || !isAuthControllerId(i.linkId))
			return { kind: "rejected", error: "invalid_input" };
		const now = sessionNow(this.clock);
		if (await this.connectionSchema()) {
			const historical = await this.first({
				sql: `SELECT 1 FROM coordinator_auth_account_connection_history l WHERE l.coordinator_id = ? AND l.link_id = ? AND ${authAccountLinkProvenanceSql("l", { connections: true })}`,
				values: [s.coordinatorId, i.linkId],
			});
			if (historical) {
				await this.batch(historicalRevocationStatements(s.coordinatorId, i.linkId, now));
				const receipt = await this.first({
					sql: historicalRevocationReadSql(),
					values: [s.coordinatorId, i.linkId],
				});
				if (!receipt) throw new Error("auth_session_persistence_incomplete");
				return { kind: "revoked" };
			}
		}
		const connections = await this.connectionSchema();
		await this.batch(revokeStatements(i.linkId, s.coordinatorId, now, { connections }));
		const link = await this.first<{ revoked_at_ms: number | null }>({
			sql: `SELECT l.revoked_at_ms FROM coordinator_auth_account_links l WHERE l.coordinator_id = ? AND l.link_id = ? AND ${authAccountLinkProvenanceSql("l", { connections })}`,
			values: [s.coordinatorId, i.linkId],
		});
		if (!link) return { kind: "rejected", error: "link_unavailable" };
		const receipt = await this.first({
			sql: revokeReadSql({ connections }),
			values: [s.coordinatorId, i.linkId],
		});
		if (link.revoked_at_ms === null || !receipt)
			throw new Error("auth_session_persistence_incomplete");
		return { kind: "revoked" };
	}
}
function auditMatch(options: { connections: boolean }) {
	return `a.coordinator_id = l.coordinator_id AND a.link_id = l.link_id AND a.action = 'link_created'
 AND a.attempt_id = l.attempt_id AND a.identity_id = l.identity_id AND a.controller_attestation_id IS l.controller_attestation_id
 AND a.authority_kind = l.authority_kind AND a.device_claim_id IS l.device_claim_id AND ${authAccountLinkProvenanceSql("l", options)}
 AND a.auth_config_revision = l.auth_config_revision AND a.created_at_ms = l.created_at_ms`;
}
function revokeStatements(
	linkId: string,
	coordinatorId: string,
	now: number,
	options: { connections: boolean },
): AuthLinkStatement[] {
	const ACCOUNT_PROVENANCE = authAccountLinkProvenanceSql("l", options),
		AUDIT_MATCH = auditMatch(options);
	return [
		{
			sql: `UPDATE coordinator_auth_account_links AS l SET revoked_at_ms = ? WHERE l.coordinator_id = ? AND l.link_id = ? AND l.revoked_at_ms IS NULL AND ${ACCOUNT_PROVENANCE}`,
			values: [now, coordinatorId, linkId],
		},
		{
			sql: `INSERT INTO coordinator_auth_link_audit_log (coordinator_id, link_id, action, attempt_id, identity_id, group_id, device_id, fingerprint, controller_attestation_id, auth_config_revision, created_at_ms, authority_kind, device_claim_id)
 SELECT l.coordinator_id, l.link_id, 'link_revoked', a.attempt_id, a.identity_id, a.group_id, a.device_id, a.fingerprint, a.controller_attestation_id, a.auth_config_revision, l.revoked_at_ms, l.authority_kind, l.device_claim_id
 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_audit_log a ON ${AUDIT_MATCH}
 WHERE l.coordinator_id = ? AND l.link_id = ? AND l.revoked_at_ms IS NOT NULL
 ON CONFLICT(coordinator_id, link_id, action) DO NOTHING`,
			values: [coordinatorId, linkId],
		},
	];
}
function revokeReadSql(options: { connections: boolean }) {
	return `SELECT 1 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_audit_log a ON ${auditMatch(options)}
 JOIN coordinator_auth_link_audit_log r ON r.coordinator_id = l.coordinator_id AND r.link_id = l.link_id AND r.action = 'link_revoked'
 AND r.attempt_id = a.attempt_id AND r.identity_id = a.identity_id AND r.group_id = a.group_id AND r.device_id = a.device_id
 AND r.fingerprint = a.fingerprint AND r.controller_attestation_id IS a.controller_attestation_id AND r.authority_kind = a.authority_kind AND r.device_claim_id IS a.device_claim_id AND r.auth_config_revision = a.auth_config_revision AND r.created_at_ms = l.revoked_at_ms
 WHERE l.coordinator_id = ? AND l.link_id = ? AND l.revoked_at_ms IS NOT NULL`;
}
