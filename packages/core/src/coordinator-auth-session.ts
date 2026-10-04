import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import {
	isCoordinatorAccountIssuer,
	parseCoordinatorAccountReference,
} from "./coordinator-auth-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
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

function rejected(error: CoordinatorAuthSessionError): CoordinatorAuthSessionIssueResult {
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
export const AUTH_SESSION_LINK_MATCH_SQL = `l.coordinator_id = s.coordinator_id AND l.link_id = s.link_id
 AND l.identity_id = s.identity_id AND l.issuer = s.issuer AND l.subject = s.subject`;
const LINK_MATCH = AUTH_SESSION_LINK_MATCH_SQL;
export const AUTH_SESSION_LIVE_GUARD_SQL = `s.coordinator_id = ? AND s.credential_hash = ? AND s.issuer = ? AND s.auth_config_revision = ? AND s.revoked_at_ms IS NULL AND l.revoked_at_ms IS NULL AND s.expires_at_ms > ? AND s.created_at_ms <= ?`;
const RECEIPT_COLUMNS = `coordinator_id, browser_transaction_hash, source, attempt_id, link_id, session_id, auth_config_revision, created_at_ms`;
const REDEEM_RECEIPT_SELECT_SQL = `INSERT INTO coordinator_auth_session_receipts (${RECEIPT_COLUMNS})
 SELECT t.coordinator_id, t.browser_transaction_hash, 'link_redeem', t.attempt_id, t.link_id, ?, ?, ?
 FROM coordinator_auth_link_attempts t JOIN coordinator_auth_account_links l
 ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id AND l.attempt_id = t.attempt_id
 AND l.identity_id = t.identity_id AND l.issuer = t.issuer AND l.subject = t.account_subject
 AND l.auth_config_revision = t.auth_config_revision
 WHERE t.coordinator_id = ? AND t.attempt_id = ? AND t.browser_transaction_hash = ?
 AND t.state = 'finalized' AND t.issuer = ? AND t.auth_config_revision = ? AND l.revoked_at_ms IS NULL
 AND ? >= t.finalized_at_ms AND ? < t.finalized_at_ms + 120000 AND ? < t.expires_at_ms`;
const REDEEM_RECEIPT_SQL = `${REDEEM_RECEIPT_SELECT_SQL}
 ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING`;
const BOUND_LINK_BROWSER_GUARD_SQL = `b.coordinator_id = t.coordinator_id
 AND b.browser_transaction_hash = t.browser_transaction_hash AND b.attempt_id = t.attempt_id
 AND b.binder_hash = ? AND b.purpose = 'link' AND b.state = 'consumed'
 AND b.issuer = ? AND b.auth_config_revision = ? AND b.redirect_uri = ?
 AND b.nonce IS NULL AND b.pkce_verifier IS NULL AND b.claim_token IS NOT NULL
 AND b.consumed_at_ms IS NOT NULL AND b.created_at_ms <= ?
 AND b.consumed_at_ms <= ? AND b.expires_at_ms > ?`;
const BOUND_LINK_REDEEM_RECEIPT_SQL = `${REDEEM_RECEIPT_SELECT_SQL}
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE ${BOUND_LINK_BROWSER_GUARD_SQL})
 ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING`;
const SIGNIN_RECEIPT_SQL = `INSERT INTO coordinator_auth_session_receipts (${RECEIPT_COLUMNS})
 SELECT l.coordinator_id, ?, 'signin', NULL, l.link_id, ?, ?, ? FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = ? AND l.issuer = ? AND l.subject = ? AND l.revoked_at_ms IS NULL
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts t WHERE t.coordinator_id = l.coordinator_id AND t.browser_transaction_hash = ?)
 ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING`;
const CONSUMED_BROWSER_GUARD_SQL = `b.coordinator_id = ? AND b.browser_transaction_hash = ?
 AND b.purpose = 'signin' AND b.attempt_id IS NULL AND b.state = 'consumed'
 AND b.nonce IS NULL AND b.pkce_verifier IS NULL AND b.claim_token IS NOT NULL
 AND b.issuer = ? AND b.auth_config_revision = ? AND b.redirect_uri = ?
 AND b.created_at_ms <= ? AND b.consumed_at_ms <= ? AND b.expires_at_ms > ?`;
const CONSUMED_SIGNIN_RECEIPT_SQL = `INSERT INTO coordinator_auth_session_receipts (${RECEIPT_COLUMNS}, purge_eligible)
 SELECT b.coordinator_id, b.browser_transaction_hash, 'signin', NULL, l.link_id, ?, ?, ?, 1
 FROM coordinator_auth_browser_transactions b JOIN coordinator_auth_account_links l
 ON l.coordinator_id = b.coordinator_id AND l.issuer = b.issuer
 WHERE ${CONSUMED_BROWSER_GUARD_SQL} AND l.subject = ? AND l.revoked_at_ms IS NULL
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts t
 WHERE t.coordinator_id = b.coordinator_id AND t.browser_transaction_hash = b.browser_transaction_hash)
 AND (SELECT COUNT(*) FROM coordinator_auth_sessions s WHERE ${LINK_MATCH}
 AND s.auth_config_revision = b.auth_config_revision AND s.revoked_at_ms IS NULL
 AND s.expires_at_ms > ?) < ${AUTH_SESSION_MAX_LIVE_PER_LINK}
 ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING`;
const SESSION_INSERT_SQL = `INSERT INTO coordinator_auth_sessions
 (coordinator_id, session_id, credential_hash, browser_transaction_hash, link_id, identity_id, issuer, subject, auth_config_revision, created_at_ms, expires_at_ms)
 SELECT r.coordinator_id, r.session_id, ?, r.browser_transaction_hash, r.link_id, l.identity_id, l.issuer, l.subject, r.auth_config_revision, r.created_at_ms, r.created_at_ms + 28800000
 FROM coordinator_auth_session_receipts r JOIN coordinator_auth_account_links l ON l.coordinator_id = r.coordinator_id AND l.link_id = r.link_id
 WHERE r.coordinator_id = ? AND r.browser_transaction_hash = ? AND r.session_id = ?`;
const REDEEM_CONSUME_SQL = `UPDATE coordinator_auth_link_attempts SET state = 'session_redeemed'
 WHERE coordinator_id = ? AND attempt_id = ? AND browser_transaction_hash = ? AND state = 'finalized'
 AND EXISTS (SELECT 1 FROM coordinator_auth_sessions s WHERE s.coordinator_id = coordinator_auth_link_attempts.coordinator_id AND s.session_id = ? AND s.browser_transaction_hash = coordinator_auth_link_attempts.browser_transaction_hash)`;
const ISSUE_READ_SQL = `SELECT s.session_id, s.identity_id, s.link_id, s.issuer, s.subject, s.expires_at_ms
 FROM coordinator_auth_session_receipts r JOIN coordinator_auth_sessions s
 ON s.coordinator_id = r.coordinator_id AND s.session_id = r.session_id AND s.browser_transaction_hash = r.browser_transaction_hash
 AND s.link_id = r.link_id AND s.auth_config_revision = r.auth_config_revision AND s.created_at_ms = r.created_at_ms
 JOIN coordinator_auth_account_links l ON ${LINK_MATCH}
 WHERE r.coordinator_id = ? AND r.browser_transaction_hash = ? AND r.session_id = ?
 AND s.credential_hash = ? AND r.auth_config_revision = ? AND r.created_at_ms = ? AND s.expires_at_ms = ? AND s.issuer = ?
 AND ((r.source = 'signin' AND r.attempt_id IS NULL) OR (r.source = 'link_redeem' AND EXISTS
 (SELECT 1 FROM coordinator_auth_link_attempts t WHERE t.coordinator_id = r.coordinator_id AND t.attempt_id = r.attempt_id
 AND t.state = 'session_redeemed' AND t.link_id = r.link_id AND t.browser_transaction_hash = r.browser_transaction_hash
 AND t.identity_id = s.identity_id AND t.issuer = s.issuer AND t.account_subject = s.subject)))`;

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
		} catch {
			throw new Error("auth_session_persistence_error");
		}
	}
	private async first<T>(statement: AuthLinkStatement): Promise<T | null> {
		try {
			return await this.backend.first<T>(statement);
		} catch {
			throw new Error("auth_session_persistence_error");
		}
	}
	private async batch(statements: AuthLinkStatement[]): Promise<void> {
		try {
			await this.backend.batch(statements);
		} catch {
			throw new Error("auth_session_persistence_error");
		}
	}
	async redeemAuthLinkSession(
		input: CoordinatorAuthLinkSessionRedeemInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionIssueResult> {
		const c = captureConfig(config);
		const i = captureIssue(input, ["attemptId"]);
		if (!c || !i || !isAuthControllerId(i.attemptId)) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = sessionNow(this.clock);
		const sessionId = globalThis.crypto.randomUUID();
		await this.batch([
			{
				sql: REDEEM_RECEIPT_SQL,
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
				],
			},
			this.sessionInsert(i, c, sessionId),
			{
				sql: REDEEM_CONSUME_SQL,
				values: [c.coordinatorId, i.attemptId, i.browserTransactionHash, sessionId],
			},
		]);
		const result = await this.issueReceipt(i, c, now, sessionId);
		if (result) return result;
		return this.diagnoseRedeem(i.attemptId, i.browserTransactionHash, c, now);
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
				sql: BOUND_LINK_REDEEM_RECEIPT_SQL,
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
			this.sessionInsert(i, c, sessionId),
			{
				sql: REDEEM_CONSUME_SQL,
				values: [c.coordinatorId, i.attemptId, i.browserTransactionHash, sessionId],
			},
		]);
		const result = await this.issueReceipt(i, c, now, sessionId);
		if (result) return result;
		return this.diagnoseRedeem(i.attemptId, i.browserTransactionHash, c, now);
	}
	async signInWithAuthAccount(
		input: CoordinatorAuthAccountSignInInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthSessionIssueResult> {
		const c = captureConfig(config);
		const i = captureIssue(input, ["account"]);
		if (!c || !i) return rejected("invalid_input");
		const account = parseCoordinatorAccountReference(capture(i.account, ["issuer", "subject"]), {
			issuer: c.issuer,
		});
		if (!account.ok) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = sessionNow(this.clock);
		const sessionId = globalThis.crypto.randomUUID();
		await this.batch([
			{
				sql: SIGNIN_RECEIPT_SQL,
				values: [
					i.browserTransactionHash,
					sessionId,
					c.revision,
					now,
					c.coordinatorId,
					account.account.issuer,
					account.account.subject,
					i.browserTransactionHash,
				],
			},
			this.sessionInsert(i, c, sessionId),
		]);
		const result = await this.issueReceipt(i, c, now, sessionId);
		if (result) return result;
		const used = await this.first({
			sql: "SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND browser_transaction_hash = ?",
			values: [c.coordinatorId, i.browserTransactionHash],
		});
		return rejected(used ? "browser_transaction_used" : "account_not_linked");
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
		await this.batch([
			{
				sql: CONSUMED_SIGNIN_RECEIPT_SQL,
				values: [sessionId, c.revision, now, ...transactionValues, account.account.subject, now],
			},
			this.sessionInsert(i, c, sessionId),
		]);
		const result = await this.issueReceipt(i, c, now, sessionId);
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
	private sessionInsert(
		i: { credentialHash: string; browserTransactionHash: string },
		c: CoordinatorAuthLinkConfig,
		sessionId: string,
	): AuthLinkStatement {
		return {
			sql: SESSION_INSERT_SQL,
			values: [i.credentialHash, c.coordinatorId, i.browserTransactionHash, sessionId],
		};
	}
	private async issueReceipt(
		i: { credentialHash: string; browserTransactionHash: string },
		c: CoordinatorAuthLinkConfig,
		now: number,
		sessionId: string,
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
		const row = await this.first<SessionRow>({
			sql: ISSUE_READ_SQL,
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
		const row = await this.first<SessionRow>({
			sql: `SELECT s.session_id, s.identity_id, s.link_id, s.issuer, s.subject, s.expires_at_ms FROM coordinator_auth_sessions s JOIN coordinator_auth_account_links l ON ${LINK_MATCH}
 WHERE ${AUTH_SESSION_LIVE_GUARD_SQL}`,
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
		await this.batch(revokeStatements(i.linkId, s.coordinatorId, now));
		const link = await this.first<{ revoked_at_ms: number | null }>({
			sql: "SELECT revoked_at_ms FROM coordinator_auth_account_links WHERE coordinator_id = ? AND link_id = ?",
			values: [s.coordinatorId, i.linkId],
		});
		if (!link) return { kind: "rejected", error: "link_unavailable" };
		const receipt = await this.first({ sql: REVOKE_READ_SQL, values: [s.coordinatorId, i.linkId] });
		if (link.revoked_at_ms === null || !receipt)
			throw new Error("auth_session_persistence_incomplete");
		return { kind: "revoked" };
	}
}
const AUDIT_MATCH = `a.coordinator_id = l.coordinator_id AND a.link_id = l.link_id AND a.action = 'link_created'
 AND a.attempt_id = l.attempt_id AND a.identity_id = l.identity_id AND a.controller_attestation_id = l.controller_attestation_id
 AND a.auth_config_revision = l.auth_config_revision AND a.created_at_ms = l.created_at_ms`;
function revokeStatements(linkId: string, coordinatorId: string, now: number): AuthLinkStatement[] {
	return [
		{
			sql: "UPDATE coordinator_auth_account_links SET revoked_at_ms = ? WHERE coordinator_id = ? AND link_id = ? AND revoked_at_ms IS NULL",
			values: [now, coordinatorId, linkId],
		},
		{
			sql: `INSERT INTO coordinator_auth_link_audit_log (coordinator_id, link_id, action, attempt_id, identity_id, group_id, device_id, fingerprint, controller_attestation_id, auth_config_revision, created_at_ms)
 SELECT l.coordinator_id, l.link_id, 'link_revoked', a.attempt_id, a.identity_id, a.group_id, a.device_id, a.fingerprint, a.controller_attestation_id, a.auth_config_revision, l.revoked_at_ms
 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_audit_log a ON ${AUDIT_MATCH}
 WHERE l.coordinator_id = ? AND l.link_id = ? AND l.revoked_at_ms IS NOT NULL
 ON CONFLICT(coordinator_id, link_id, action) DO NOTHING`,
			values: [coordinatorId, linkId],
		},
	];
}
const REVOKE_READ_SQL = `SELECT 1 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_audit_log a ON ${AUDIT_MATCH}
 JOIN coordinator_auth_link_audit_log r ON r.coordinator_id = l.coordinator_id AND r.link_id = l.link_id AND r.action = 'link_revoked'
 AND r.attempt_id = a.attempt_id AND r.identity_id = a.identity_id AND r.group_id = a.group_id AND r.device_id = a.device_id
 AND r.fingerprint = a.fingerprint AND r.controller_attestation_id = a.controller_attestation_id AND r.auth_config_revision = a.auth_config_revision AND r.created_at_ms = l.revoked_at_ms
 WHERE l.coordinator_id = ? AND l.link_id = ? AND l.revoked_at_ms IS NOT NULL`;
