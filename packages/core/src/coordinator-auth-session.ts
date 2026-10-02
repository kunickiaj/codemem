import {
	isCoordinatorAccountIssuer,
	parseCoordinatorAccountReference,
} from "./coordinator-auth-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { CoordinatorAuthLinkConfig } from "./coordinator-auth-link-contract.js";
import {
	AUTH_LINK_REDEEM_WINDOW_MS,
	AUTH_SESSION_TTL_MS,
	type CoordinatorAuthAccountLinkAdminStore,
	type CoordinatorAuthAccountLinkRevokeResult,
	type CoordinatorAuthAccountSignInInput,
	type CoordinatorAuthLinkSessionRedeemInput,
	type CoordinatorAuthSession,
	type CoordinatorAuthSessionError,
	type CoordinatorAuthSessionIssueResult,
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
const LINK_MATCH = `l.coordinator_id = s.coordinator_id AND l.link_id = s.link_id
 AND l.identity_id = s.identity_id AND l.issuer = s.issuer AND l.subject = s.subject`;
const RECEIPT_COLUMNS = `coordinator_id, browser_transaction_hash, source, attempt_id, link_id, session_id, auth_config_revision, created_at_ms`;
const REDEEM_RECEIPT_SQL = `INSERT INTO coordinator_auth_session_receipts (${RECEIPT_COLUMNS})
 SELECT t.coordinator_id, t.browser_transaction_hash, 'link_redeem', t.attempt_id, t.link_id, ?, ?, ?
 FROM coordinator_auth_link_attempts t JOIN coordinator_auth_account_links l
 ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id AND l.attempt_id = t.attempt_id
 AND l.identity_id = t.identity_id AND l.issuer = t.issuer AND l.subject = t.account_subject
 AND l.auth_config_revision = t.auth_config_revision
 WHERE t.coordinator_id = ? AND t.attempt_id = ? AND t.browser_transaction_hash = ?
 AND t.state = 'finalized' AND t.issuer = ? AND t.auth_config_revision = ? AND l.revoked_at_ms IS NULL
 AND ? >= t.finalized_at_ms AND ? < t.finalized_at_ms + 120000 AND ? < t.expires_at_ms
 ON CONFLICT(coordinator_id, browser_transaction_hash) DO NOTHING`;
const SIGNIN_RECEIPT_SQL = `INSERT INTO coordinator_auth_session_receipts (${RECEIPT_COLUMNS})
 SELECT l.coordinator_id, ?, 'signin', NULL, l.link_id, ?, ?, ? FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = ? AND l.issuer = ? AND l.subject = ? AND l.revoked_at_ms IS NULL
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts t WHERE t.coordinator_id = l.coordinator_id AND t.browser_transaction_hash = ?)
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
 WHERE s.coordinator_id = ? AND s.credential_hash = ? AND s.issuer = ? AND s.auth_config_revision = ? AND s.revoked_at_ms IS NULL AND l.revoked_at_ms IS NULL AND s.expires_at_ms > ? AND s.created_at_ms <= ?`,
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
