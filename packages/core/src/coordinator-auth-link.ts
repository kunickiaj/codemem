import {
	isCoordinatorAccountIssuer,
	parseCoordinatorAccountReference,
} from "./coordinator-auth-contract.js";
import { isAuthControllerId, isAuthControllerUniqueError } from "./coordinator-auth-controller.js";
import {
	AUTH_LINK_ATTEMPT_TTL_MS,
	AUTH_LINK_CREATE_WINDOW_MS,
	AUTH_LINK_EXPIRE_BATCH_MAX,
	AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
	AUTH_LINK_MAX_ACTIVE_PER_IDENTITY,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
	AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
	AUTH_LINK_PURPOSE,
	AUTH_LINK_RETENTION_WINDOW_MS,
	type CoordinatorAuthLinkClaimInput,
	type CoordinatorAuthLinkConfig,
	type CoordinatorAuthLinkConfirmInput,
	type CoordinatorAuthLinkCreateInput,
	type CoordinatorAuthLinkCreateResult,
	type CoordinatorAuthLinkError,
	type CoordinatorAuthLinkFailInput,
	type CoordinatorAuthLinkFinalizeInput,
	type CoordinatorAuthLinkMaintenanceOptions,
	type CoordinatorAuthLinkMaintenanceResult,
	type CoordinatorAuthLinkOidcInput,
	type CoordinatorAuthLinkOidcResult,
	type CoordinatorAuthLinkRejected,
	type CoordinatorAuthLinkRequester,
	type CoordinatorAuthLinkResult,
	type CoordinatorAuthLinkSigner,
	type CoordinatorAuthLinkState,
	type CoordinatorAuthLinkStatus,
	type CoordinatorAuthLinkStore,
} from "./coordinator-auth-link-contract.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";

export * from "./coordinator-auth-link-contract.js";
export interface AuthLinkStatement {
	sql: string;
	values: (string | number | null)[];
}
export interface AuthLinkBackend {
	first<T>(statement: AuthLinkStatement): Promise<T | null>;
	run(statement: AuthLinkStatement): Promise<number>;
	batch(statements: AuthLinkStatement[]): Promise<void>;
}
interface Attempt {
	coordinator_id: string;
	attempt_id: string;
	identity_id: string;
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	controller_attestation_id: string;
	controller_review_receipt_id: string;
	controller_revision: number;
	issuer: string;
	auth_config_revision: string;
	runtime_verifier_hash: string;
	loopback_redirect: string;
	state: CoordinatorAuthLinkState;
	browser_transaction_hash: string | null;
	account_subject: string | null;
	completion_secret_hash: string | null;
	link_id: string | null;
	failure_reason: string | null;
	created_at_ms: number;
	expires_at_ms: number;
}
type Captured = Record<string, unknown>;
const HASH = /^[0-9a-f]{64}$/;
function isHash(value: unknown): value is string {
	return typeof value === "string" && value.length === 64 && HASH.test(value);
}
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
	return c as unknown as CoordinatorAuthLinkConfig;
}
function isPublicKey(value: unknown): value is string {
	if (typeof value !== "string" || value.length > 4096) return false;
	const flat = value.replace(/[\r\n]/g, "");
	return flat.length > 0 && flat.trim() === flat && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(flat);
}
function captureSigner(value: unknown): CoordinatorAuthLinkSigner | null {
	const s = capture(value, ["groupId", "deviceId", "publicKey", "fingerprint"]);
	if (
		!s ||
		!isAuthControllerId(s.groupId) ||
		!isAuthControllerId(s.deviceId) ||
		!isPublicKey(s.publicKey) ||
		!isHash(s.fingerprint)
	)
		return null;
	return s as unknown as CoordinatorAuthLinkSigner;
}
function captureRequester(value: unknown): CoordinatorAuthLinkRequester | null {
	const k = capture(value, ["kind"]);
	if (k?.kind === "device") {
		const s = capture(value, ["signer"]);
		const signer = captureSigner(s?.signer);
		return signer ? { kind: "device", signer } : null;
	}
	if (k?.kind !== "browser") return null;
	const b = capture(value, ["browserTransactionHash"]);
	return isHash(b?.browserTransactionHash)
		? { kind: "browser", browserTransactionHash: b.browserTransactionHash }
		: null;
}
export function authLinkNow(clock: () => number): number {
	let now: number;
	try {
		now = clock();
	} catch {
		throw new Error("auth_link_invalid_clock");
	}
	if (
		!Number.isSafeInteger(now) ||
		now < 0 ||
		now > Number.MAX_SAFE_INTEGER - AUTH_LINK_ATTEMPT_TTL_MS
	)
		throw new Error("auth_link_invalid_clock");
	return now;
}
function rejected(error: CoordinatorAuthLinkError): CoordinatorAuthLinkRejected {
	return { kind: "rejected", error };
}
function isTerminal(row: Attempt): boolean {
	return ["expired", "failed", "finalized", "session_redeemed"].includes(row.state);
}
function status(row: Attempt, now: number): CoordinatorAuthLinkStatus {
	const state = !isTerminal(row) && now >= row.expires_at_ms ? "expired" : row.state;
	return { attemptId: row.attempt_id, state, expiresAtMs: row.expires_at_ms };
}
function configMatches(row: Attempt, c: CoordinatorAuthLinkConfig): boolean {
	return (
		c.enabled &&
		row.coordinator_id === c.coordinatorId &&
		row.issuer === c.issuer &&
		row.auth_config_revision === c.revision
	);
}
function signerMatches(row: Attempt, s: CoordinatorAuthLinkSigner): boolean {
	return (
		row.group_id === s.groupId &&
		row.device_id === s.deviceId &&
		row.public_key === s.publicKey &&
		row.fingerprint === s.fingerprint
	);
}
function requesterMatches(row: Attempt, r: CoordinatorAuthLinkRequester): boolean {
	if (r.kind === "device") return signerMatches(row, r.signer);
	return row.browser_transaction_hash === r.browserTransactionHash;
}
function diagnose(
	row: Attempt | null,
	c: CoordinatorAuthLinkConfig,
	now: number,
): CoordinatorAuthLinkRejected {
	if (!row) return rejected("attempt_unavailable");
	if (!configMatches(row, c)) return rejected("auth_config_changed");
	if (row.state === "expired") return rejected("attempt_expired");
	if (!isTerminal(row) && row.expires_at_ms <= now) return rejected("attempt_expired");
	return rejected("attempt_unavailable");
}
const LIVE_CONFIG = "coordinator_id = ? AND issuer = ? AND auth_config_revision = ? AND ? = 1";
function configValues(c: CoordinatorAuthLinkConfig): (string | number)[] {
	return [c.coordinatorId, c.issuer, c.revision, Number(c.enabled)];
}
const AUTHORITY = `EXISTS (SELECT 1 FROM coordinator_auth_controller_attestations a
 JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
 JOIN groups g ON g.group_id = a.group_id
 WHERE a.coordinator_id = coordinator_auth_link_attempts.coordinator_id
 AND a.attestation_id = coordinator_auth_link_attempts.controller_attestation_id AND a.review_receipt_id = coordinator_auth_link_attempts.controller_review_receipt_id
 AND a.revision = coordinator_auth_link_attempts.controller_revision AND a.revoked_at IS NULL
 AND a.identity_id = coordinator_auth_link_attempts.identity_id
 AND a.group_id = coordinator_auth_link_attempts.group_id AND a.device_id = coordinator_auth_link_attempts.device_id
 AND a.public_key = coordinator_auth_link_attempts.public_key AND a.fingerprint = coordinator_auth_link_attempts.fingerprint
 AND e.enabled = 1 AND g.archived_at IS NULL AND e.public_key = a.public_key AND e.fingerprint = a.fingerprint
 AND (e.identity_id IS NULL OR e.identity_id = a.identity_id))`;
const CREATE_SOURCE_SQL = `FROM coordinator_auth_controller_attestations a
 JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
 JOIN groups g ON g.group_id = a.group_id
 WHERE a.coordinator_id = ? AND a.group_id = ? AND a.device_id = ? AND a.public_key = ? AND a.fingerprint = ?
 AND a.revoked_at IS NULL AND a.revision = 1 AND ? = 1 AND e.enabled = 1 AND g.archived_at IS NULL
 AND e.public_key = a.public_key AND e.fingerprint = a.fingerprint AND (e.identity_id IS NULL OR e.identity_id = a.identity_id)`;
const CREATE_SQL = `INSERT INTO coordinator_auth_link_attempts (
 coordinator_id, attempt_id, identity_id, group_id, device_id, public_key, fingerprint,
 controller_attestation_id, controller_review_receipt_id, controller_revision,
 issuer, auth_config_revision, runtime_verifier_hash, loopback_redirect, state, created_at_ms, expires_at_ms)
 SELECT ?, ?, a.identity_id, a.group_id, a.device_id, a.public_key, a.fingerprint,
 a.attestation_id, a.review_receipt_id, a.revision, ?, ?, ?, ?, 'pending', ?, ?
 ${CREATE_SOURCE_SQL}
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = a.coordinator_id AND t.group_id = a.group_id AND t.device_id = a.device_id
  AND t.state IN ('pending','browser_claimed','oidc_verified','confirmed') AND t.expires_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = a.coordinator_id AND t.identity_id = a.identity_id
  AND t.state IN ('pending','browser_claimed','oidc_verified','confirmed') AND t.expires_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = a.coordinator_id AND t.group_id = a.group_id AND t.device_id = a.device_id
  AND t.created_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = a.coordinator_id AND t.group_id = a.group_id AND t.device_id = a.device_id
  AND t.created_at_ms > ?) < ?
 AND (SELECT count(*) FROM (SELECT 1 FROM coordinator_auth_link_attempts t
  WHERE t.coordinator_id = a.coordinator_id AND t.state NOT IN ('finalized','session_redeemed') LIMIT ?)) < ?`;
const MAINTENANCE_CANDIDATE_SQL = `link_id IS NULL AND (
 (state IN ('pending','browser_claimed','oidc_verified','confirmed') AND expires_at_ms <= ?)
 OR (state IN ('failed','expired') AND account_subject IS NOT NULL))`;
const MAINTENANCE_SQL = `UPDATE coordinator_auth_link_attempts
 SET state = CASE WHEN state = 'failed' THEN 'failed' ELSE 'expired' END, account_subject = NULL
 WHERE coordinator_id = ? AND ${MAINTENANCE_CANDIDATE_SQL}
 AND attempt_id IN (SELECT attempt_id FROM coordinator_auth_link_attempts
  WHERE coordinator_id = ? AND ${MAINTENANCE_CANDIDATE_SQL}
  ORDER BY expires_at_ms, attempt_id LIMIT ?)`;
function captureMaintenanceLimit(options: unknown): number | null {
	if (options === undefined) return AUTH_LINK_EXPIRE_BATCH_MAX;
	if (!options || typeof options !== "object") return null;
	try {
		if (Array.isArray(options)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(options, "limit");
		if (!descriptor) {
			if ("limit" in options) return null;
			return AUTH_LINK_EXPIRE_BATCH_MAX;
		}
		if (!Object.hasOwn(descriptor, "value")) return null;
		const limit: unknown = descriptor.value;
		if (
			typeof limit !== "number" ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > AUTH_LINK_EXPIRE_BATCH_MAX
		)
			return null;
		return limit;
	} catch {
		return null;
	}
}
function createSourceValues(
	c: CoordinatorAuthLinkConfig,
	s: CoordinatorAuthLinkSigner,
): (string | number)[] {
	return [c.coordinatorId, s.groupId, s.deviceId, s.publicKey, s.fingerprint, Number(c.enabled)];
}

/** Optional persistence capability. No token verification, routes, sessions or grants. */
export class AuthLinkOperations implements CoordinatorAuthLinkStore {
	constructor(
		private readonly backend: AuthLinkBackend,
		private readonly clock: () => number = Date.now,
	) {}
	private read(attemptId: string, c: CoordinatorAuthLinkConfig): Promise<Attempt | null> {
		return this.first<Attempt>({
			sql: "SELECT * FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?",
			values: [c.coordinatorId, attemptId],
		});
	}
	private async first<T>(statement: AuthLinkStatement): Promise<T | null> {
		try {
			return await this.backend.first<T>(statement);
		} catch {
			throw new Error("auth_link_persistence_error");
		}
	}
	private async execute(
		statement: AuthLinkStatement,
		conflict: CoordinatorAuthLinkError,
	): Promise<number | CoordinatorAuthLinkRejected> {
		try {
			return await this.backend.run(statement);
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected(conflict);
			throw new Error("auth_link_persistence_error");
		}
	}
	async maintainAuthLinkAttempts(
		config: CoordinatorAuthLinkConfig,
		options?: CoordinatorAuthLinkMaintenanceOptions,
	): Promise<CoordinatorAuthLinkMaintenanceResult> {
		const c = captureConfig(config);
		const limit = captureMaintenanceLimit(options);
		if (!c || limit === null) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const result = await this.execute(
			{
				sql: MAINTENANCE_SQL,
				values: [c.coordinatorId, now, c.coordinatorId, now, limit],
			},
			"attempt_conflict",
		);
		if (typeof result !== "number") return result;
		return { kind: "maintained", processedCount: result, more: result === limit };
	}
	async createAuthLinkAttempt(
		input: CoordinatorAuthLinkCreateInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkCreateResult> {
		const c = captureConfig(config);
		const i = capture(input, ["attemptId", "signer", "runtimeVerifierHash", "loopbackRedirect"]);
		const s = captureSigner(i?.signer);
		if (
			!c ||
			!i ||
			!s ||
			!isAuthControllerId(i.attemptId) ||
			!isHash(i.runtimeVerifierHash) ||
			!parseCoordinatorAuthLoopback(i.loopbackRedirect).ok
		)
			return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const values = [
			c.coordinatorId,
			i.attemptId,
			c.issuer,
			c.revision,
			i.runtimeVerifierHash,
			i.loopbackRedirect as string,
			now,
			now + AUTH_LINK_ATTEMPT_TTL_MS,
			...createSourceValues(c, s),
			now,
			AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
			now,
			AUTH_LINK_MAX_ACTIVE_PER_IDENTITY,
			now - AUTH_LINK_CREATE_WINDOW_MS,
			AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
			now - AUTH_LINK_RETENTION_WINDOW_MS,
			AUTH_LINK_MAX_CREATES_PER_DEVICE_RETENTION,
			AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
			AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
		];
		const result = await this.execute({ sql: CREATE_SQL, values }, "attempt_conflict");
		const row = await this.read(i.attemptId, c);
		if (result === 0) {
			if (row) return this.createRetry(row, i, s, c, now);
			const active = await this.first({
				sql: `SELECT 1 ${CREATE_SOURCE_SQL}`,
				values: createSourceValues(c, s),
			});
			return rejected(active ? "attempt_limited" : "controller_not_active");
		}
		if (typeof result !== "number") return this.createRetry(row, i, s, c, now);
		if (!row) throw new Error("auth_link_persistence_incomplete");
		return { kind: "created", status: status(row, now), identityId: row.identity_id };
	}
	private async createRetry(
		row: Attempt | null,
		i: Captured,
		s: CoordinatorAuthLinkSigner,
		c: CoordinatorAuthLinkConfig,
		now: number,
	): Promise<CoordinatorAuthLinkCreateResult> {
		if (
			!row ||
			!configMatches(row, c) ||
			!signerMatches(row, s) ||
			row.runtime_verifier_hash !== i.runtimeVerifierHash ||
			row.loopback_redirect !== i.loopbackRedirect ||
			row.state === "expired" ||
			row.expires_at_ms <= now
		)
			return rejected("attempt_conflict");
		const active = await this.first({
			sql: `SELECT 1 FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${LIVE_CONFIG} AND ${AUTHORITY}`,
			values: [row.attempt_id, ...configValues(c)],
		});
		if (!active) return rejected("controller_not_active");
		return { kind: "existing", status: status(row, now), identityId: row.identity_id };
	}
	private async transition(
		i: { attemptId: string; browserTransactionHash: string },
		c: CoordinatorAuthLinkConfig,
		now: number,
		update: AuthLinkStatement,
	): Promise<CoordinatorAuthLinkResult> {
		const result = await this.execute(update, "attempt_conflict");
		if (typeof result !== "number") return result;
		const row = await this.read(i.attemptId, c);
		if (!result) {
			if (
				row &&
				row.browser_transaction_hash !== null &&
				row.browser_transaction_hash !== i.browserTransactionHash
			)
				return rejected("attempt_unavailable");
			return diagnose(row, c, now);
		}
		if (!row || row.browser_transaction_hash !== i.browserTransactionHash)
			throw new Error("auth_link_persistence_incomplete");
		return { kind: "applied", status: status(row, now) };
	}
	private browserInput(
		input: unknown,
		extra: string[] = [],
	): (CoordinatorAuthLinkClaimInput & Captured) | null {
		const i = capture(input, ["attemptId", "browserTransactionHash", ...extra]);
		if (!i || !isAuthControllerId(i.attemptId) || !isHash(i.browserTransactionHash)) return null;
		return i as CoordinatorAuthLinkClaimInput & Captured;
	}
	async claimAuthLinkAttempt(
		input: CoordinatorAuthLinkClaimInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = this.browserInput(input);
		if (!c || !i) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const update = {
			sql: `UPDATE coordinator_auth_link_attempts SET state = 'browser_claimed', browser_transaction_hash = ?, claimed_at_ms = ? WHERE attempt_id = ? AND ${LIVE_CONFIG} AND expires_at_ms > ? AND state = 'pending' AND browser_transaction_hash IS NULL AND NOT EXISTS (SELECT 1 FROM coordinator_auth_session_receipts r WHERE r.coordinator_id = coordinator_auth_link_attempts.coordinator_id AND r.browser_transaction_hash = ?)`,
			values: [
				i.browserTransactionHash,
				now,
				i.attemptId,
				...configValues(c),
				now,
				i.browserTransactionHash,
			],
		};
		const result = await this.transition(i, c, now, update);
		if (result.kind !== "rejected" || result.error !== "attempt_unavailable") return result;
		const row = await this.read(i.attemptId, c);
		if (
			row &&
			configMatches(row, c) &&
			row.expires_at_ms > now &&
			row.state === "browser_claimed" &&
			row.browser_transaction_hash === i.browserTransactionHash
		)
			return { kind: "existing", status: status(row, now) };
		return result;
	}
	/** Caller supplies independently server-verified OIDC claims; this does not validate JWTs. */
	async recordAuthLinkOidcVerified(
		input: CoordinatorAuthLinkOidcInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkOidcResult> {
		const c = captureConfig(config);
		const i = this.browserInput(input, ["account"]);
		if (!c || !i) return rejected("invalid_input");
		const accountValue = capture(i.account, ["issuer", "subject"]);
		const account = parseCoordinatorAccountReference(accountValue, { issuer: c.issuer });
		if (!account.ok) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const result = await this.transition(i, c, now, {
			sql: `UPDATE coordinator_auth_link_attempts SET state = 'oidc_verified', account_subject = ?, oidc_verified_at_ms = ? WHERE attempt_id = ? AND ${LIVE_CONFIG} AND expires_at_ms > ? AND state = 'browser_claimed' AND browser_transaction_hash = ? AND account_subject IS NULL`,
			values: [
				account.account.subject,
				now,
				i.attemptId,
				...configValues(c),
				now,
				i.browserTransactionHash,
			],
		});
		if (result.kind === "rejected") return result;
		const row = await this.read(i.attemptId, c);
		if (!row) throw new Error("auth_link_persistence_incomplete");
		return {
			kind: "applied",
			status: result.status,
			target: { identityId: row.identity_id, groupId: row.group_id, deviceId: row.device_id },
		};
	}
	/** completionSecretHash must come from the trusted coordinator generator, not request nomination. */
	async confirmAuthLinkAttempt(
		input: CoordinatorAuthLinkConfirmInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = this.browserInput(input, ["completionSecretHash"]);
		if (!c || !i || !isHash(i.completionSecretHash)) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		return this.transition(i, c, now, {
			sql: `UPDATE coordinator_auth_link_attempts SET state = 'confirmed', completion_secret_hash = ?, confirmed_at_ms = ? WHERE attempt_id = ? AND ${LIVE_CONFIG} AND expires_at_ms > ? AND state = 'oidc_verified' AND browser_transaction_hash = ? AND completion_secret_hash IS NULL`,
			values: [
				i.completionSecretHash,
				now,
				i.attemptId,
				...configValues(c),
				now,
				i.browserTransactionHash,
			],
		});
	}
	async getAuthLinkAttemptStatus(
		attemptId: string,
		requester: CoordinatorAuthLinkRequester,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkStatus | null> {
		const c = captureConfig(config);
		const r = captureRequester(requester);
		if (!c || !r || !isAuthControllerId(attemptId) || !c.enabled) return null;
		const now = authLinkNow(this.clock);
		const row = await this.read(attemptId, c);
		if (!row || !configMatches(row, c) || !requesterMatches(row, r)) return null;
		return status(row, now);
	}
	async failAuthLinkAttempt(
		input: CoordinatorAuthLinkFailInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = capture(input, ["attemptId", "requester", "reason"]);
		const r = captureRequester(i?.requester);
		if (
			!c ||
			!i ||
			!r ||
			!isAuthControllerId(i.attemptId) ||
			!["cancelled", "provider_failure", "config_failure"].includes(i.reason as string) ||
			(r.kind === "device" && i.reason !== "cancelled")
		)
			return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		const now = authLinkNow(this.clock);
		const reason = i.reason === "cancelled" ? `${r.kind}_cancelled` : (i.reason as string);
		const proof = requesterGuard(r);
		const result = await this.execute(
			{
				sql: `UPDATE coordinator_auth_link_attempts SET state = 'failed', failure_reason = ?, failed_at_ms = ? WHERE attempt_id = ? AND ${LIVE_CONFIG} AND expires_at_ms > ? AND state IN ('pending','browser_claimed','oidc_verified','confirmed') AND ${proof.sql}`,
				values: [reason, now, i.attemptId, ...configValues(c), now, ...proof.values],
			},
			"attempt_conflict",
		);
		if (typeof result !== "number") return result;
		const row = await this.read(i.attemptId, c);
		if (row && !requesterMatches(row, r)) return rejected("attempt_unavailable");
		if (
			row &&
			configMatches(row, c) &&
			requesterMatches(row, r) &&
			row.state === "failed" &&
			row.failure_reason === reason
		)
			return { kind: result ? "applied" : "existing", status: status(row, now) };
		return diagnose(row, c, now);
	}
	async finalizeAuthLinkAttempt(
		input: CoordinatorAuthLinkFinalizeInput,
		config: CoordinatorAuthLinkConfig,
	): Promise<CoordinatorAuthLinkResult> {
		const c = captureConfig(config);
		const i = captureFinalize(input, c);
		if (!c || !i) return rejected("invalid_input");
		if (!c.enabled) return rejected("auth_config_changed");
		if (
			i.groupId !== i.signer.groupId ||
			i.deviceId !== i.signer.deviceId ||
			i.fingerprint !== i.signer.fingerprint
		)
			return rejected("attempt_unavailable");
		const now = authLinkNow(this.clock);
		const linkId = globalThis.crypto.randomUUID();
		try {
			await this.backend.batch(finalizeStatements(i, c, now, linkId));
		} catch (error) {
			if (isAuthControllerUniqueError(error)) return rejected("link_conflict");
			throw new Error("auth_link_persistence_error");
		}
		return this.finalizeReceipt(i, c, now, linkId);
	}
	private async finalizeReceipt(
		i: CoordinatorAuthLinkFinalizeInput,
		c: CoordinatorAuthLinkConfig,
		now: number,
		linkId: string,
	): Promise<CoordinatorAuthLinkResult> {
		const row = await this.read(i.attemptId, c);
		if (
			row &&
			configMatches(row, c) &&
			finalizeMatches(row, i) &&
			["finalized", "session_redeemed"].includes(row.state)
		) {
			const receipt = await this.first({
				sql: RECEIPT_SQL,
				values: [c.coordinatorId, i.attemptId, row.link_id],
			});
			if (!receipt) throw new Error("auth_link_persistence_incomplete");
			return { kind: row.link_id === linkId ? "applied" : "existing", status: status(row, now) };
		}
		if (row && !finalizeMatches(row, i)) return rejected("attempt_unavailable");
		const diagnosis = diagnose(row, c, now);
		if (
			!row ||
			diagnosis.error !== "attempt_unavailable" ||
			row.state !== "confirmed" ||
			!finalizeMatches(row, i)
		)
			return diagnosis;
		return rejected("controller_not_active");
	}
}
function requesterGuard(r: CoordinatorAuthLinkRequester): AuthLinkStatement {
	if (r.kind === "browser")
		return { sql: "browser_transaction_hash = ?", values: [r.browserTransactionHash] };
	return {
		sql: "group_id = ? AND device_id = ? AND public_key = ? AND fingerprint = ?",
		values: [r.signer.groupId, r.signer.deviceId, r.signer.publicKey, r.signer.fingerprint],
	};
}
function captureFinalize(
	input: unknown,
	c: CoordinatorAuthLinkConfig | null,
): CoordinatorAuthLinkFinalizeInput | null {
	const i = capture(input, [
		"purpose",
		"coordinatorId",
		"attemptId",
		"groupId",
		"identityId",
		"deviceId",
		"fingerprint",
		"runtimeVerifierHash",
		"completionSecretHash",
		"signer",
	]);
	const s = captureSigner(i?.signer);
	if (!c || !i || !s || i.purpose !== AUTH_LINK_PURPOSE || i.coordinatorId !== c.coordinatorId)
		return null;
	if (
		![i.attemptId, i.groupId, i.identityId, i.deviceId].every(isAuthControllerId) ||
		![i.fingerprint, i.runtimeVerifierHash, i.completionSecretHash].every(isHash)
	)
		return null;
	return { ...i, signer: s } as unknown as CoordinatorAuthLinkFinalizeInput;
}
function finalizeMatches(row: Attempt, i: CoordinatorAuthLinkFinalizeInput): boolean {
	return (
		signerMatches(row, i.signer) &&
		row.identity_id === i.identityId &&
		row.runtime_verifier_hash === i.runtimeVerifierHash &&
		row.completion_secret_hash === i.completionSecretHash
	);
}
function finalizeStatements(
	i: CoordinatorAuthLinkFinalizeInput,
	c: CoordinatorAuthLinkConfig,
	now: number,
	linkId: string,
): AuthLinkStatement[] {
	const consume: AuthLinkStatement = {
		sql: `UPDATE coordinator_auth_link_attempts SET state = 'finalized', link_id = ?, finalized_at_ms = ? WHERE attempt_id = ? AND ${LIVE_CONFIG} AND state = 'confirmed' AND expires_at_ms > ? AND group_id = ? AND identity_id = ? AND device_id = ? AND fingerprint = ? AND public_key = ? AND runtime_verifier_hash = ? AND completion_secret_hash = ? AND ${AUTHORITY}`,
		values: [
			linkId,
			now,
			i.attemptId,
			...configValues(c),
			now,
			i.groupId,
			i.identityId,
			i.deviceId,
			i.fingerprint,
			i.signer.publicKey,
			i.runtimeVerifierHash,
			i.completionSecretHash,
		],
	};
	const link: AuthLinkStatement = {
		sql: `INSERT INTO coordinator_auth_account_links (coordinator_id, link_id, issuer, subject, identity_id, attempt_id, controller_attestation_id, auth_config_revision, created_at_ms) SELECT coordinator_id, link_id, issuer, account_subject, identity_id, attempt_id, controller_attestation_id, auth_config_revision, finalized_at_ms FROM coordinator_auth_link_attempts WHERE attempt_id = ? AND ${LIVE_CONFIG} AND link_id = ? AND state = 'finalized'`,
		values: [i.attemptId, ...configValues(c), linkId],
	};
	const audit: AuthLinkStatement = {
		sql: `INSERT INTO coordinator_auth_link_audit_log (coordinator_id, link_id, action, attempt_id, identity_id, group_id, device_id, fingerprint, controller_attestation_id, auth_config_revision, created_at_ms) SELECT t.coordinator_id, t.link_id, 'link_created', t.attempt_id, t.identity_id, t.group_id, t.device_id, t.fingerprint, t.controller_attestation_id, t.auth_config_revision, t.finalized_at_ms FROM coordinator_auth_link_attempts t JOIN coordinator_auth_account_links l ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id WHERE t.attempt_id = ? AND t.coordinator_id = ? AND t.issuer = ? AND t.auth_config_revision = ? AND ? = 1 AND t.link_id = ?`,
		values: [i.attemptId, ...configValues(c), linkId],
	};
	return [consume, link, audit];
}
const RECEIPT_SQL = `SELECT 1 FROM coordinator_auth_link_attempts t
 JOIN coordinator_auth_account_links l ON l.coordinator_id = t.coordinator_id AND l.link_id = t.link_id
 AND l.attempt_id = t.attempt_id AND l.identity_id = t.identity_id AND l.issuer = t.issuer AND l.subject = t.account_subject
 AND l.controller_attestation_id = t.controller_attestation_id AND l.auth_config_revision = t.auth_config_revision AND l.created_at_ms = t.finalized_at_ms
 JOIN coordinator_auth_link_audit_log a ON a.coordinator_id = t.coordinator_id AND a.link_id = t.link_id AND a.action = 'link_created'
 AND a.attempt_id = t.attempt_id AND a.identity_id = t.identity_id AND a.group_id = t.group_id AND a.device_id = t.device_id
 AND a.fingerprint = t.fingerprint AND a.controller_attestation_id = t.controller_attestation_id AND a.auth_config_revision = t.auth_config_revision AND a.created_at_ms = t.finalized_at_ms
 WHERE t.coordinator_id = ? AND t.attempt_id = ? AND t.link_id = ?`;
