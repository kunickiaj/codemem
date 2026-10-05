import {
	AUTH_BROWSER_TXN_MAINTENANCE_BATCH_MAX,
	AUTH_BROWSER_TXN_TTL_MS,
	AUTH_SIGNIN_TXN_MAX_RETAINED,
	AUTH_SIGNIN_TXN_MAX_STARTS_PER_WINDOW,
	AUTH_SIGNIN_TXN_PURGE_AGE_MS,
	AUTH_SIGNIN_TXN_PURGE_BATCH_MAX,
	AUTH_SIGNIN_TXN_WINDOW_MS,
	type CoordinatorAuthBrowserConfig,
	type CoordinatorAuthBrowserTransactionConsumeInput,
	type CoordinatorAuthBrowserTransactionConsumeResult,
	type CoordinatorAuthBrowserTransactionError,
	type CoordinatorAuthBrowserTransactionMaintenanceOptions,
	type CoordinatorAuthBrowserTransactionMaintenanceResult,
	type CoordinatorAuthBrowserTransactionRejected,
	type CoordinatorAuthBrowserTransactionRetirementOptions,
	type CoordinatorAuthBrowserTransactionRetirementResult,
	type CoordinatorAuthBrowserTransactionScope,
	type CoordinatorAuthBrowserTransactionStartInput,
	type CoordinatorAuthBrowserTransactionStartResult,
	type CoordinatorAuthBrowserTransactionStore,
	type CoordinatorAuthLinkBrowserTransactionResolveInput,
	type CoordinatorAuthSigninBrowserTransactionCancelInput,
	type CoordinatorAuthSigninBrowserTransactionCancelResult,
	type CoordinatorAuthSigninBrowserTransactionPurgeResult,
} from "./coordinator-auth-browser-transaction-contract.js";
import { isCoordinatorAccountIssuer } from "./coordinator-auth-contract.js";
import { isAuthControllerId, isAuthControllerUniqueError } from "./coordinator-auth-controller.js";
import {
	type AuthLinkBackend,
	type AuthLinkStatement,
	authLinkNow,
	captureAuthLinkBrowserStartHash,
} from "./coordinator-auth-link.js";

export * from "./coordinator-auth-browser-transaction-contract.js";

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
function isMaterial(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}
function isRedirect(value: unknown): value is string {
	if (typeof value !== "string" || value.trim() !== value || /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(value))
		return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.href === value &&
			!url.username &&
			!url.password &&
			!url.search &&
			!url.hash &&
			!value.includes("?") &&
			!value.includes("#")
		);
	} catch {
		return false;
	}
}
function captureConfig(value: unknown): CoordinatorAuthBrowserConfig | null {
	const c = capture(value, ["coordinatorId", "issuer", "revision", "enabled", "redirectUri"]);
	if (
		!c ||
		!isAuthControllerId(c.coordinatorId) ||
		!isCoordinatorAccountIssuer(c.issuer) ||
		!isHash(c.revision) ||
		typeof c.enabled !== "boolean" ||
		!isRedirect(c.redirectUri)
	)
		return null;
	return {
		coordinatorId: c.coordinatorId,
		issuer: c.issuer,
		revision: c.revision,
		enabled: c.enabled,
		redirectUri: c.redirectUri,
	};
}
function isSigninAttempt(value: object, attempt: PropertyDescriptor | undefined): boolean {
	if (attempt) return Object.hasOwn(attempt, "value") && attempt.value === undefined;
	return !("attemptId" in value);
}
function captureStart(value: unknown): CoordinatorAuthBrowserTransactionStartInput | null {
	const i = capture(value, ["purpose", "stateHash", "binderHash", "nonce", "pkceVerifier"]);
	if (
		!i ||
		!isHash(i.stateHash) ||
		!isHash(i.binderHash) ||
		!isMaterial(i.nonce) ||
		!isMaterial(i.pkceVerifier)
	)
		return null;
	try {
		// Never accept request nomination of the internal, server-generated transaction hash.
		if (
			Object.getOwnPropertyDescriptor(value, "browserTransactionHash") ||
			"browserTransactionHash" in (value as object)
		)
			return null;
		const attempt = Object.getOwnPropertyDescriptor(value, "attemptId");
		if (i.purpose === "signin") {
			if (!isSigninAttempt(value as object, attempt)) return null;
			return {
				purpose: "signin",
				stateHash: i.stateHash,
				binderHash: i.binderHash,
				nonce: i.nonce,
				pkceVerifier: i.pkceVerifier,
			};
		}
		if (
			i.purpose !== "link" ||
			!attempt ||
			!Object.hasOwn(attempt, "value") ||
			!isAuthControllerId(attempt.value)
		)
			return null;
		const browserStartHash = captureAuthLinkBrowserStartHash(value);
		if (browserStartHash === false) return null;
		return {
			purpose: "link",
			attemptId: attempt.value,
			...(browserStartHash === null ? {} : { browserStartHash }),
			stateHash: i.stateHash,
			binderHash: i.binderHash,
			nonce: i.nonce,
			pkceVerifier: i.pkceVerifier,
		};
	} catch {
		return null;
	}
}
function maintenanceLimit(
	value: unknown,
	max = AUTH_BROWSER_TXN_MAINTENANCE_BATCH_MAX,
): number | null {
	if (value === undefined) return max;
	if (!value || typeof value !== "object") return null;
	try {
		if (Array.isArray(value)) return null;
		const d = Object.getOwnPropertyDescriptor(value, "limit");
		if (!d) return "limit" in value ? null : max;
		if (!Object.hasOwn(d, "value")) return null;
		const limit: unknown = d.value;
		return typeof limit === "number" && Number.isSafeInteger(limit) && limit >= 1 && limit <= max
			? limit
			: null;
	} catch {
		return null;
	}
}
function captureRetirementOptions(value: unknown): { limit: number; attemptId?: string } | null {
	const limit = maintenanceLimit(value);
	if (limit === null) return null;
	if (value === undefined) return { limit };
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, "attemptId");
		if (!descriptor) return "attemptId" in (value as object) ? null : { limit };
		if (!Object.hasOwn(descriptor, "value") || !isAuthControllerId(descriptor.value)) return null;
		return { limit, attemptId: descriptor.value };
	} catch {
		return null;
	}
}
function rejected(
	error: CoordinatorAuthBrowserTransactionError,
): CoordinatorAuthBrowserTransactionRejected {
	return { kind: "rejected", error };
}
function transactionHash(): string {
	try {
		const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
		return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	} catch {
		throw new Error("browser_transaction_entropy_failed");
	}
}
function claimToken(): string {
	try {
		return globalThis.crypto.randomUUID();
	} catch {
		throw new Error("browser_transaction_entropy_failed");
	}
}
interface TransactionRow {
	browser_transaction_hash: string;
	purpose: "signin" | "link";
	attempt_id: string | null;
	nonce: string | null;
	pkce_verifier: string | null;
	expires_at_ms: number;
}
interface AttemptDiagnosis {
	issuer: string;
	auth_config_revision: string;
	state: string;
	expires_at_ms: number;
}
function isConsumableRow(
	row: TransactionRow,
): row is TransactionRow & { nonce: string; pkce_verifier: string } {
	if (
		!isHash(row.browser_transaction_hash) ||
		!isMaterial(row.nonce) ||
		!isMaterial(row.pkce_verifier)
	)
		return false;
	if (row.purpose === "signin") return row.attempt_id === null;
	return row.purpose === "link" && isAuthControllerId(row.attempt_id);
}
const TABLE = "coordinator_auth_browser_transactions";
const PURGE_FLOORS = "coordinator_auth_signin_purge_floors";
const COLUMNS = `coordinator_id, browser_transaction_hash, purpose, attempt_id, state_hash, binder_hash,
 issuer, auth_config_revision, redirect_uri, state, nonce, pkce_verifier, created_at_ms, expires_at_ms, claim_token, consumed_at_ms`;
// Force a uniqueness failure even when another admission guard suppresses a colliding insert.
const ASSERT_HASH_FRESH = `UNION ALL SELECT ${COLUMNS} FROM coordinator_auth_browser_transactions
 WHERE coordinator_id = ? AND browser_transaction_hash = ?`;
const FRESH_HASH = `NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions WHERE coordinator_id = ? AND browser_transaction_hash = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND browser_transaction_hash = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_session_receipts WHERE coordinator_id = ? AND browser_transaction_hash = ?)`;
function freshValues(c: CoordinatorAuthBrowserConfig, hash: string): (string | number)[] {
	return [c.coordinatorId, hash, c.coordinatorId, hash, c.coordinatorId, hash];
}
const MATCH_CONFIG =
	"b.coordinator_id = ? AND b.issuer = ? AND b.auth_config_revision = ? AND b.redirect_uri = ?";
function configValues(c: CoordinatorAuthBrowserConfig): string[] {
	return [c.coordinatorId, c.issuer, c.revision, c.redirectUri];
}
function assertLinkClaim(
	i: CoordinatorAuthBrowserTransactionStartInput & { purpose: "link" },
	c: CoordinatorAuthBrowserConfig,
	now: number,
	hash: string,
): AuthLinkStatement {
	// A suppressed claim must violate the pending-secret CHECK inside the same atomic batch.
	return {
		sql: `UPDATE ${TABLE} AS b SET nonce = NULL WHERE ${MATCH_CONFIG} AND b.browser_transaction_hash = ?
 AND b.state = 'pending' AND b.attempt_id = ? AND b.created_at_ms = ? AND NOT EXISTS
 (SELECT 1 FROM coordinator_auth_link_attempts a WHERE a.coordinator_id = b.coordinator_id AND a.attempt_id = b.attempt_id
 AND a.browser_transaction_hash = b.browser_transaction_hash AND a.state = 'browser_claimed'
 AND a.claimed_at_ms = ? AND a.issuer = b.issuer AND a.auth_config_revision = b.auth_config_revision
 AND a.expires_at_ms = b.expires_at_ms AND a.expires_at_ms > ?)`,
		values: [...configValues(c), hash, i.attemptId, now, now, now],
	};
}
function linkMatch(states: string): string {
	return `(b.purpose = 'signin' OR EXISTS (SELECT 1 FROM coordinator_auth_link_attempts a
 WHERE a.coordinator_id = b.coordinator_id AND a.attempt_id = b.attempt_id
 AND a.browser_transaction_hash = b.browser_transaction_hash AND a.issuer = b.issuer
 AND a.auth_config_revision = b.auth_config_revision AND a.expires_at_ms > ? AND a.state IN (${states})))`;
}
const LIVE_LINK = linkMatch("'browser_claimed'");
const RESOLVABLE_LINK = linkMatch(
	"'browser_claimed','oidc_verified','confirmed','finalized','session_redeemed'",
);

/** Persistence capability only; consumed secrets are returned solely to a trusted exchange caller. */
export class CoordinatorAuthBrowserTransactions implements CoordinatorAuthBrowserTransactionStore {
	constructor(
		private readonly backend: AuthLinkBackend,
		private readonly clock: () => number = Date.now,
	) {}
	private async first<T>(statement: AuthLinkStatement): Promise<T | null> {
		try {
			return await this.backend.first<T>(statement);
		} catch {
			throw new Error("auth_browser_transaction_persistence_error");
		}
	}
	async startAuthBrowserTransaction(
		input: CoordinatorAuthBrowserTransactionStartInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthBrowserTransactionStartResult> {
		const c = captureConfig(config);
		const i = captureStart(input);
		if (!c || !i) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const hash = transactionHash();
		if (i.purpose === "link") return this.startLink(i, c, now, hash);
		try {
			await this.backend.run({
				sql: `INSERT INTO ${TABLE} (${COLUMNS}) SELECT ?, ?, 'signin', NULL, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL
 WHERE ${FRESH_HASH}
 AND NOT EXISTS (SELECT 1 FROM ${PURGE_FLOORS} WHERE coordinator_id = ? AND purged_through_created_at_ms > ?)
 AND (SELECT count(*) FROM ${TABLE} WHERE coordinator_id = ? AND purpose = 'signin' AND created_at_ms > ?) < ?
 AND (SELECT count(*) FROM (SELECT 1 FROM ${TABLE} WHERE coordinator_id = ? AND purpose = 'signin' LIMIT ?)) < ?
 ${ASSERT_HASH_FRESH}`,
				values: [
					c.coordinatorId,
					hash,
					i.stateHash,
					i.binderHash,
					c.issuer,
					c.revision,
					c.redirectUri,
					i.nonce,
					i.pkceVerifier,
					now,
					now + AUTH_BROWSER_TXN_TTL_MS,
					...freshValues(c, hash),
					c.coordinatorId,
					now - AUTH_SIGNIN_TXN_WINDOW_MS,
					c.coordinatorId,
					now - AUTH_SIGNIN_TXN_WINDOW_MS,
					AUTH_SIGNIN_TXN_MAX_STARTS_PER_WINDOW,
					c.coordinatorId,
					AUTH_SIGNIN_TXN_MAX_RETAINED,
					AUTH_SIGNIN_TXN_MAX_RETAINED,
					c.coordinatorId,
					hash,
				],
			});
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected("transaction_conflict");
			throw new Error("auth_browser_transaction_persistence_error");
		}
		const row = await this.startedRow(i, c, hash, now);
		if (row) return { kind: "started", expiresAtMs: row.expires_at_ms };
		if (await this.hasConflict(i, c, hash)) return rejected("transaction_conflict");
		if (await this.isSigninRetentionBlocked(c.coordinatorId, now))
			return { kind: "rejected", error: "clock_retention_blocked" };
		return rejected("transaction_limited");
	}
	private async isSigninRetentionBlocked(coordinatorId: string, now: number): Promise<boolean> {
		const row = await this.first({
			sql: `SELECT 1 FROM ${PURGE_FLOORS} WHERE coordinator_id = ? AND purged_through_created_at_ms > ?`,
			values: [coordinatorId, now - AUTH_SIGNIN_TXN_WINDOW_MS],
		});
		return row !== null;
	}
	private async hasConflict(
		i: CoordinatorAuthBrowserTransactionStartInput,
		c: CoordinatorAuthBrowserConfig,
		hash: string,
	): Promise<boolean> {
		const row = await this.first({
			sql: `SELECT 1 FROM ${TABLE} WHERE coordinator_id = ? AND (state_hash = ? OR binder_hash = ? OR browser_transaction_hash = ?)
 UNION ALL SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND browser_transaction_hash = ?
 UNION ALL SELECT 1 FROM coordinator_auth_session_receipts WHERE coordinator_id = ? AND browser_transaction_hash = ? LIMIT 1`,
			values: [
				c.coordinatorId,
				i.stateHash,
				i.binderHash,
				hash,
				c.coordinatorId,
				hash,
				c.coordinatorId,
				hash,
			],
		});
		return row !== null;
	}
	private startedRow(
		i: CoordinatorAuthBrowserTransactionStartInput,
		c: CoordinatorAuthBrowserConfig,
		hash: string,
		now: number,
	): Promise<TransactionRow | null> {
		return this.first<TransactionRow>({
			sql: `SELECT b.* FROM ${TABLE} b WHERE ${MATCH_CONFIG} AND b.browser_transaction_hash = ?
 AND b.state_hash = ? AND b.binder_hash = ? AND b.nonce = ? AND b.pkce_verifier = ?
 AND b.purpose = ? AND b.attempt_id IS ? AND b.created_at_ms = ? AND b.state = 'pending' AND b.expires_at_ms > ? AND ${LIVE_LINK}`,
			values: [
				...configValues(c),
				hash,
				i.stateHash,
				i.binderHash,
				i.nonce,
				i.pkceVerifier,
				i.purpose,
				i.purpose === "link" ? i.attemptId : null,
				now,
				now,
				now,
			],
		});
	}
	private async startLink(
		i: CoordinatorAuthBrowserTransactionStartInput & { purpose: "link" },
		c: CoordinatorAuthBrowserConfig,
		now: number,
		hash: string,
	): Promise<CoordinatorAuthBrowserTransactionStartResult> {
		const browserStartHash = i.browserStartHash ?? null;
		const insert: AuthLinkStatement = {
			sql: `INSERT INTO ${TABLE} (${COLUMNS}) SELECT a.coordinator_id, ?, 'link', a.attempt_id, ?, ?, a.issuer,
 a.auth_config_revision, ?, 'pending', ?, ?, ?, a.expires_at_ms, NULL, NULL FROM coordinator_auth_link_attempts a
 WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.issuer = ? AND a.auth_config_revision = ?
 AND a.state = 'pending' AND a.browser_transaction_hash IS NULL AND a.expires_at_ms > ?
 AND ((a.browser_start_hash IS NULL AND ? IS NULL) OR a.browser_start_hash = ?) AND ${FRESH_HASH}
 ${ASSERT_HASH_FRESH}`,
			values: [
				hash,
				i.stateHash,
				i.binderHash,
				c.redirectUri,
				i.nonce,
				i.pkceVerifier,
				now,
				c.coordinatorId,
				i.attemptId,
				c.issuer,
				c.revision,
				now,
				browserStartHash,
				browserStartHash,
				...freshValues(c, hash),
				c.coordinatorId,
				hash,
			],
		};
		const claim: AuthLinkStatement = {
			sql: `UPDATE coordinator_auth_link_attempts SET state = 'browser_claimed', browser_transaction_hash = ?, claimed_at_ms = ?
 WHERE coordinator_id = ? AND attempt_id = ? AND issuer = ? AND auth_config_revision = ?
 AND state = 'pending' AND browser_transaction_hash IS NULL AND expires_at_ms > ?
 AND ((browser_start_hash IS NULL AND ? IS NULL) OR browser_start_hash = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_session_receipts r WHERE r.coordinator_id = ? AND r.browser_transaction_hash = ?)
 AND EXISTS (SELECT 1 FROM ${TABLE} b WHERE ${MATCH_CONFIG} AND b.browser_transaction_hash = ? AND b.attempt_id = ?
 AND b.purpose = 'link' AND b.state = 'pending' AND b.state_hash = ? AND b.binder_hash = ? AND b.created_at_ms = ?
 AND b.expires_at_ms = coordinator_auth_link_attempts.expires_at_ms)`,
			values: [
				hash,
				now,
				c.coordinatorId,
				i.attemptId,
				c.issuer,
				c.revision,
				now,
				browserStartHash,
				browserStartHash,
				c.coordinatorId,
				hash,
				...configValues(c),
				hash,
				i.attemptId,
				i.stateHash,
				i.binderHash,
				now,
			],
		};
		const assertClaim = assertLinkClaim(i, c, now, hash);
		try {
			await this.backend.batch([insert, claim, assertClaim]);
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected("transaction_conflict");
			throw new Error("auth_browser_transaction_persistence_incomplete");
		}
		return this.startLinkReceipt(i, c, now, hash);
	}
	private async startLinkReceipt(
		i: CoordinatorAuthBrowserTransactionStartInput & { purpose: "link" },
		c: CoordinatorAuthBrowserConfig,
		now: number,
		hash: string,
	): Promise<CoordinatorAuthBrowserTransactionStartResult> {
		const row = await this.startedRow(i, c, hash, now);
		if (row) return { kind: "started", expiresAtMs: row.expires_at_ms };
		if (await this.hasConflict(i, c, hash)) return rejected("transaction_conflict");
		return this.diagnoseAttempt(i.attemptId, c, now);
	}
	private async diagnoseAttempt(
		attemptId: string,
		c: CoordinatorAuthBrowserConfig,
		now: number,
	): Promise<CoordinatorAuthBrowserTransactionRejected> {
		const attempt = await this.first<AttemptDiagnosis>({
			sql: "SELECT issuer, auth_config_revision, state, expires_at_ms FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?",
			values: [c.coordinatorId, attemptId],
		});
		if (!attempt) return rejected("attempt_unavailable");
		if (attempt.state === "expired" || attempt.expires_at_ms <= now)
			return rejected("attempt_expired");
		if (attempt.issuer !== c.issuer || attempt.auth_config_revision !== c.revision)
			return rejected("auth_config_changed");
		return rejected("attempt_unavailable");
	}
	async consumeAuthBrowserTransaction(
		input: CoordinatorAuthBrowserTransactionConsumeInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthBrowserTransactionConsumeResult> {
		const c = captureConfig(config);
		const i = capture(input, ["stateHash", "binderHash"]);
		if (!c || !i || !isHash(i.stateHash) || !isHash(i.binderHash)) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const row = await this.first<TransactionRow>({
			sql: `SELECT b.* FROM ${TABLE} b WHERE ${MATCH_CONFIG} AND b.state_hash = ? AND b.binder_hash = ?
 AND b.state = 'pending' AND b.expires_at_ms > ? AND b.created_at_ms <= ? AND ${LIVE_LINK}`,
			values: [...configValues(c), i.stateHash, i.binderHash, now, now, now],
		});
		if (!row) return this.diagnoseTransactionConfig(i.stateHash, i.binderHash, c);
		if (!isConsumableRow(row)) return rejected("transaction_unavailable");
		const token = claimToken();
		try {
			await this.backend.run({
				sql: `UPDATE ${TABLE} AS b SET state = 'consumed', nonce = NULL, pkce_verifier = NULL, claim_token = ?, consumed_at_ms = ?
 WHERE ${MATCH_CONFIG} AND b.browser_transaction_hash = ? AND b.state_hash = ? AND b.binder_hash = ?
 AND b.state = 'pending' AND b.expires_at_ms > ? AND b.created_at_ms <= ? AND b.nonce = ? AND b.pkce_verifier = ? AND ${LIVE_LINK}`,
				values: [
					token,
					now,
					...configValues(c),
					row.browser_transaction_hash,
					i.stateHash,
					i.binderHash,
					now,
					now,
					row.nonce,
					row.pkce_verifier,
					now,
				],
			});
		} catch {
			throw new Error("auth_browser_transaction_persistence_error");
		}
		const winner = await this.first({
			sql: `SELECT 1 FROM ${TABLE} WHERE coordinator_id = ? AND browser_transaction_hash = ? AND state = 'consumed' AND claim_token = ?`,
			values: [c.coordinatorId, row.browser_transaction_hash, token],
		});
		if (!winner) return rejected("transaction_unavailable");
		const materials = {
			kind: "consumed" as const,
			browserTransactionHash: row.browser_transaction_hash,
			nonce: row.nonce,
			pkceVerifier: row.pkce_verifier,
		};
		if (row.purpose === "link" && row.attempt_id !== null)
			return { ...materials, purpose: "link", attemptId: row.attempt_id };
		return { ...materials, purpose: "signin" };
	}
	private async diagnoseTransactionConfig(
		stateHash: string,
		binderHash: string,
		c: CoordinatorAuthBrowserConfig,
	): Promise<CoordinatorAuthBrowserTransactionRejected> {
		const row = await this.first<{
			issuer: string;
			auth_config_revision: string;
			redirect_uri: string;
		}>({
			sql: `SELECT issuer, auth_config_revision, redirect_uri FROM ${TABLE} WHERE coordinator_id = ? AND state_hash = ? AND binder_hash = ?`,
			values: [c.coordinatorId, stateHash, binderHash],
		});
		if (
			row &&
			(row.issuer !== c.issuer ||
				row.auth_config_revision !== c.revision ||
				row.redirect_uri !== c.redirectUri)
		)
			return rejected("auth_config_changed");
		return rejected("transaction_unavailable");
	}
	async resolveAuthLinkBrowserTransaction(
		input: CoordinatorAuthLinkBrowserTransactionResolveInput,
		config: CoordinatorAuthBrowserConfig,
	): Promise<{ browserTransactionHash: string } | null> {
		const c = captureConfig(config);
		const i = capture(input, ["attemptId", "binderHash"]);
		if (!c || !i || !c.enabled || !isAuthControllerId(i.attemptId) || !isHash(i.binderHash))
			return null;
		const now = authLinkNow(this.clock);
		const row = await this.first<{ browser_transaction_hash: string }>({
			sql: `SELECT b.browser_transaction_hash FROM ${TABLE} b WHERE ${MATCH_CONFIG} AND b.purpose = 'link'
 AND b.attempt_id = ? AND b.binder_hash = ? AND b.state IN ('pending','consumed') AND b.expires_at_ms > ? AND ${RESOLVABLE_LINK}`,
			values: [...configValues(c), i.attemptId, i.binderHash, now, now],
		});
		return row ? { browserTransactionHash: row.browser_transaction_hash } : null;
	}
	async cancelAuthSigninBrowserTransaction(
		input: CoordinatorAuthSigninBrowserTransactionCancelInput,
		scope: CoordinatorAuthBrowserTransactionScope,
	): Promise<CoordinatorAuthSigninBrowserTransactionCancelResult> {
		const i = capture(input, ["binderHash"]);
		const s = capture(scope, ["coordinatorId"]);
		if (!i || !isHash(i.binderHash) || !s || !isAuthControllerId(s.coordinatorId))
			return { kind: "rejected", error: "invalid_input" };
		authLinkNow(this.clock);
		// Explicit cookie-owner intent remains valid across clock rollback.
		const match =
			"coordinator_id = ? AND binder_hash = ? AND purpose = 'signin' AND attempt_id IS NULL";
		const values = [s.coordinatorId, i.binderHash];
		try {
			await this.backend.run({
				sql: `UPDATE ${TABLE} SET state = 'expired', nonce = NULL, pkce_verifier = NULL
 WHERE ${match} AND state = 'pending'`,
				values,
			});
		} catch {
			throw new Error("auth_browser_transaction_persistence_error");
		}
		const row = await this.first({
			sql: `SELECT 1 FROM ${TABLE} WHERE ${match} AND state = 'expired' AND nonce IS NULL AND pkce_verifier IS NULL`,
			values,
		});
		return row ? { kind: "cancelled" } : { kind: "unavailable" };
	}
	async retireAuthBrowserTransactions(
		config: CoordinatorAuthBrowserConfig,
		options?: CoordinatorAuthBrowserTransactionRetirementOptions,
	): Promise<CoordinatorAuthBrowserTransactionRetirementResult> {
		const c = captureConfig(config);
		const o = captureRetirementOptions(options);
		if (!c || !o) return { kind: "rejected", error: "invalid_input" };
		const now = authLinkNow(this.clock);
		const attemptFilter = o.attemptId === undefined ? "" : "AND b.attempt_id = ?";
		const attemptValues = o.attemptId === undefined ? [] : [o.attemptId];
		let creationGuard = "b.created_at_ms <= ?";
		const creationValues = [now];
		if (o.attemptId !== undefined) {
			creationGuard = `(b.created_at_ms <= ? OR (b.purpose = 'link' AND NOT ${LIVE_LINK}))`;
			creationValues.push(now);
		}
		try {
			const processedCount = await this.backend.run({
				sql: `UPDATE ${TABLE} SET state = 'expired', nonce = NULL, pkce_verifier = NULL
 WHERE coordinator_id = ? AND state = 'pending' AND browser_transaction_hash IN
 (SELECT b.browser_transaction_hash FROM ${TABLE} b
 WHERE b.coordinator_id = ? AND b.state = 'pending' AND ${creationGuard} ${attemptFilter}
 AND (b.expires_at_ms <= ? OR ? = 0 OR b.issuer <> ? OR b.auth_config_revision <> ? OR b.redirect_uri <> ?
 OR (b.purpose = 'link' AND NOT ${LIVE_LINK}))
 ORDER BY b.expires_at_ms, b.browser_transaction_hash LIMIT ?)`,
				values: [
					c.coordinatorId,
					c.coordinatorId,
					...creationValues,
					...attemptValues,
					now,
					Number(c.enabled),
					c.issuer,
					c.revision,
					c.redirectUri,
					now,
					o.limit,
				],
			});
			return { kind: "retired", processedCount, more: processedCount === o.limit };
		} catch {
			throw new Error("auth_browser_transaction_persistence_error");
		}
	}
	async purgeAuthSigninBrowserTransactions(
		scope: CoordinatorAuthBrowserTransactionScope,
		options?: CoordinatorAuthBrowserTransactionMaintenanceOptions,
	): Promise<CoordinatorAuthSigninBrowserTransactionPurgeResult> {
		const s = capture(scope, ["coordinatorId"]);
		const limit = maintenanceLimit(options, AUTH_SIGNIN_TXN_PURGE_BATCH_MAX);
		if (!s || !isAuthControllerId(s.coordinatorId) || limit === null)
			return { kind: "rejected", error: "invalid_input" };
		const cutoff = authLinkNow(this.clock) - AUTH_SIGNIN_TXN_PURGE_AGE_MS;
		try {
			// Commit the monotonic floor first; the delete independently reads it atomically.
			await this.advanceSigninPurgeFloor(s.coordinatorId, cutoff);
			const processedCount = await this.deletePurgedSigninTransactions(
				s.coordinatorId,
				cutoff,
				limit,
			);
			return { kind: "purged", processedCount, more: processedCount === limit };
		} catch {
			throw new Error("auth_browser_transaction_persistence_error");
		}
	}
	private advanceSigninPurgeFloor(coordinatorId: string, cutoff: number): Promise<number> {
		return this.backend.run({
			sql: `INSERT INTO ${PURGE_FLOORS} (coordinator_id, purged_through_created_at_ms)
 SELECT ?, m FROM (SELECT max(created_at_ms) m FROM ${TABLE}
 WHERE coordinator_id = ? AND purpose = 'signin' AND attempt_id IS NULL AND created_at_ms <= ?)
 WHERE m IS NOT NULL ON CONFLICT(coordinator_id) DO UPDATE
 SET purged_through_created_at_ms = excluded.purged_through_created_at_ms
 WHERE excluded.purged_through_created_at_ms > ${PURGE_FLOORS}.purged_through_created_at_ms`,
			values: [coordinatorId, coordinatorId, cutoff],
		});
	}
	private deletePurgedSigninTransactions(
		coordinatorId: string,
		cutoff: number,
		limit: number,
	): Promise<number> {
		return this.backend.run({
			sql: `DELETE FROM ${TABLE}
 WHERE coordinator_id = ? AND purpose = 'signin' AND attempt_id IS NULL AND created_at_ms <= ?
 AND browser_transaction_hash IN (SELECT b.browser_transaction_hash FROM ${TABLE} b
 JOIN ${PURGE_FLOORS} f ON f.coordinator_id = b.coordinator_id
 WHERE b.coordinator_id = ? AND b.purpose = 'signin' AND b.attempt_id IS NULL
 AND b.created_at_ms <= f.purged_through_created_at_ms AND b.created_at_ms <= ?
 ORDER BY b.created_at_ms, b.browser_transaction_hash LIMIT ?)`,
			values: [coordinatorId, cutoff, coordinatorId, cutoff, limit],
		});
	}
	async maintainAuthBrowserTransactions(
		scope: CoordinatorAuthBrowserTransactionScope,
		options?: CoordinatorAuthBrowserTransactionMaintenanceOptions,
	): Promise<CoordinatorAuthBrowserTransactionMaintenanceResult> {
		const s = capture(scope, ["coordinatorId"]);
		const limit = maintenanceLimit(options);
		if (!s || !isAuthControllerId(s.coordinatorId) || limit === null)
			return { kind: "rejected", error: "invalid_input" };
		const now = authLinkNow(this.clock);
		try {
			const processedCount = await this.backend.run({
				sql: `UPDATE ${TABLE} SET state = 'expired', nonce = NULL, pkce_verifier = NULL
 WHERE coordinator_id = ? AND state = 'pending' AND expires_at_ms <= ? AND browser_transaction_hash IN
 (SELECT browser_transaction_hash FROM ${TABLE} WHERE coordinator_id = ? AND state = 'pending' AND expires_at_ms <= ?
 ORDER BY expires_at_ms, browser_transaction_hash LIMIT ?)`,
				values: [s.coordinatorId, now, s.coordinatorId, now, limit],
			});
			return { kind: "maintained", processedCount, more: processedCount === limit };
		} catch {
			throw new Error("auth_browser_transaction_persistence_error");
		}
	}
}
