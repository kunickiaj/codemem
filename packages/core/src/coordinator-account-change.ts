import {
	prepareAccountChangeAuthority,
	prepareAccountChangeAuthorityFor,
	readAccountChangeBase,
} from "./coordinator-account-change-authority.js";
import type {
	AccountChangeGrant,
	AccountChangeTarget,
} from "./coordinator-account-change-decision.js";
import {
	connectionAdmissionSql,
	hasConnectionSessionSchema,
} from "./coordinator-account-connection-session.js";
import {
	CONNECTION_ALLOCATE_ORDER_SQL,
	CONNECTION_ARCHIVED_CURRENT_MATCH_SQL,
	CONNECTION_ASSERT_ONE_WRITE_SQL,
	CONNECTION_BIRTH_COLUMNS,
} from "./coordinator-account-connection-storage.js";
import { ACCOUNT_UNLINK_TABLE } from "./coordinator-account-unlink-schema.js";
import { captureAuthAccountProfile } from "./coordinator-auth-account-profile.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	type AuthLinkBackend,
	type AuthLinkStatement,
	authLinkNow,
} from "./coordinator-auth-link.js";
import {
	AUTH_LINK_EXPIRE_BATCH_MAX,
	type CoordinatorAuthLinkConfig,
	type CoordinatorAuthLinkSigner,
} from "./coordinator-auth-link-contract.js";
import {
	capture,
	captureAuthLinkConfig,
	captureAuthLinkSigner,
	isHash,
} from "./coordinator-auth-link-input.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { sqlIs } from "./coordinator-sql-compare.js";

const table = "coordinator_account_change_attempts";
const history = "coordinator_auth_account_connection_history";
const orders = "coordinator_auth_account_connection_orders";
const current = "coordinator_auth_account_links";
const sql = (query: string, values: AuthLinkStatement["values"] = []): AuthLinkStatement => ({
	sql: query,
	values,
});
const assertOne = sql(CONNECTION_ASSERT_ONE_WRITE_SQL);
type Intent = "refresh" | "disconnect";
interface ChangeRow {
	attempt_id: string;
	target_link_id: string;
	identity_id: string;
	issuer: string;
	target_subject: string;
	intent: Intent;
	state: string;
	auth_config_revision: string;
	enrollment_identity_id: string | null;
	group_id: string;
	device_id: string;
	public_key: string;
	fingerprint: string;
	runtime_verifier_hash: string;
	completion_secret_hash: string | null;
	completed_at_ms: number;
	nonce: string;
	pkce_verifier: string;
	expires_at_ms: number;
	loopback_redirect: string;
	display_name: string | null;
	email: string | null;
	email_verified: number | null;
	picture_url: string | null;
}
export interface AccountChangeOutcome {
	intent: Intent;
	targetLinkId: string;
	completedAtMs: number;
}
interface Signed {
	attemptId: string;
	signer: CoordinatorAuthLinkSigner;
	runtimeVerifierHash: string;
	expectedIdentityId: string;
}
function signed(value: unknown): Signed | null {
	const i = capture(value, ["attemptId", "signer", "runtimeVerifierHash", "expectedIdentityId"]);
	const signer = captureAuthLinkSigner(i?.signer);
	if (
		!i ||
		!signer ||
		!isAuthControllerId(i.attemptId) ||
		!isHash(i.runtimeVerifierHash) ||
		!isAuthControllerId(i.expectedIdentityId)
	)
		return null;
	return {
		attemptId: i.attemptId,
		signer,
		runtimeVerifierHash: i.runtimeVerifierHash,
		expectedIdentityId: i.expectedIdentityId,
	};
}
function signerValues(s: CoordinatorAuthLinkSigner): string[] {
	return [s.groupId, s.deviceId, s.publicKey, s.fingerprint];
}
const signedMatch =
	"a.group_id = ? AND a.device_id = ? AND a.public_key = ? AND a.fingerprint = ? AND a.runtime_verifier_hash = ? AND a.identity_id = ?";
const signedValues = (i: Signed) => [
	...signerValues(i.signer),
	i.runtimeVerifierHash,
	i.expectedIdentityId,
];
const configured = "a.coordinator_id = ? AND a.issuer = ? AND a.auth_config_revision = ? AND ? = 1";
const configValues = (c: CoordinatorAuthLinkConfig) => [
	c.coordinatorId,
	c.issuer,
	c.revision,
	Number(c.enabled),
];
const outcome = (a: ChangeRow): AccountChangeOutcome => ({
	intent: a.intent,
	targetLinkId: a.target_link_id,
	completedAtMs: a.completed_at_ms,
});
function unlinkInput(value: unknown) {
	const i = capture(value, [
		"attemptId",
		"signer",
		"expectedIdentityId",
		"expectedLinkId",
		"requestHash",
	]);
	const signer = captureAuthLinkSigner(i?.signer);
	if (
		!i ||
		!signer ||
		!isAuthControllerId(i.attemptId) ||
		!isAuthControllerId(i.expectedIdentityId) ||
		!isAuthControllerId(i.expectedLinkId) ||
		!isHash(i.requestHash)
	)
		return null;
	return {
		attemptId: i.attemptId,
		signer,
		expectedIdentityId: i.expectedIdentityId,
		expectedLinkId: i.expectedLinkId,
		requestHash: i.requestHash,
	};
}

// LINK and CHANGE share admission budgets; terminal receipts still count toward
// hourly/retention creation limits, but not toward concurrent live attempts.
// Retained failures also consume the existing coordinator unfinished budget.
// Admission is a budget, not authority, so it stays in the INSERT and counts live rows.
const admissionInput =
	"(SELECT ? AS coordinator_id, ? AS group_id, ? AS device_id, ? AS identity_id, ? AS now_ms)";
const admissionValues = (
	c: CoordinatorAuthLinkConfig,
	s: CoordinatorAuthLinkSigner,
	target: AccountChangeTarget,
	now: number,
) => [c.coordinatorId, s.groupId, s.deviceId, target.identity_id, now];
function browserPin(value: unknown) {
	const i = capture(value, ["attemptId", "stateHash", "binderHash"]);
	if (!i || !isAuthControllerId(i.attemptId) || !isHash(i.stateHash) || !isHash(i.binderHash))
		return null;
	return { attemptId: i.attemptId, stateHash: i.stateHash, binderHash: i.binderHash };
}
const browserMatch = "a.attempt_id = ? AND a.state_hash = ? AND a.binder_hash = ?";
const scrub =
	"nonce = NULL,pkce_verifier = NULL,display_name = NULL,email = NULL,email_verified = NULL,picture_url = NULL";

/** Alias a: the attempt row still names the granted link, Identity and enrollment Identity. */
const grantedRowSql =
	"a.coordinator_id = ? AND a.target_link_id = ? AND a.identity_id = ? AND a.target_subject = ? AND a.issuer = ? AND a.enrollment_identity_id IS ?";
const grantedRowValues = (g: AccountChangeGrant) => [
	g.coordinatorId,
	g.linkId,
	g.identityId,
	g.subject,
	g.issuer,
	g.enrollmentIdentityId,
];

/** Private persistence boundary only. Signed inputs must come from the
 * signature verifier; verified callbacks must come from the maintained OIDC
 * adapter after state/binder consumption. These methods do not verify signatures,
 * Google tokens, browser cookies or CSRF, and must never be mounted as JSON APIs.
 */

export class AccountChangeOperations {
	constructor(
		private readonly backend: AuthLinkBackend,
		private readonly clock: () => number = Date.now,
	) {}
	private first<T>(statement: AuthLinkStatement) {
		return this.backend.first<T>(statement);
	}
	private async atomic(statements: AuthLinkStatement[]): Promise<boolean> {
		try {
			await this.backend.batch(statements);
			return true;
		} catch {
			return false;
		}
	}
	private row(c: CoordinatorAuthLinkConfig, id: string) {
		return this.first<ChangeRow>(
			sql(`SELECT * FROM ${table} WHERE coordinator_id = ? AND attempt_id = ?`, [
				c.coordinatorId,
				id,
			]),
		);
	}
	// The grant is void unless its guards run first in the batch that writes.
	private authority(
		c: CoordinatorAuthLinkConfig,
		s: CoordinatorAuthLinkSigner,
		target: AccountChangeTarget,
		now: number,
	) {
		return prepareAccountChangeAuthorityFor(this.backend, c, s, target, now);
	}
	/** Derives the target from this signer's own proofs, then decides on it. */
	private async derivedAuthority(
		c: CoordinatorAuthLinkConfig,
		s: CoordinatorAuthLinkSigner,
		keyId: string,
		accept: (target: AccountChangeTarget) => boolean,
		now: number,
	) {
		const base = await readAccountChangeBase(this.backend, c, s, { deriveTarget: { keyId } });
		const { target } = base;
		if (!target || !accept(target)) return null;
		const authority = await prepareAccountChangeAuthority(this.backend, base, c, s, target, now);
		return authority ? { target, ...authority } : null;
	}
	private retryCreate(
		c: CoordinatorAuthLinkConfig,
		i: Signed,
		extra: Record<string, unknown>,
		now: number,
	) {
		return this.first(
			sql(
				`SELECT 1 FROM ${table} a WHERE ${configured} AND a.attempt_id = ? AND ${signedMatch} AND a.intent = ? AND a.browser_start_hash = ? AND a.loopback_redirect = ? AND a.state NOT IN ('cancelled','failed','expired') AND (a.state = 'completed' OR a.expires_at_ms > ?)`,
				[
					...configValues(c),
					i.attemptId,
					...signedValues(i),
					extra.intent as string,
					extra.browserStartHash as string,
					extra.loopbackRedirect as string,
					now,
				],
			),
		);
	}
	/** Descriptive device actions only; create/finalize always recheck current authority. */
	async readCapabilities(
		value: unknown,
		config: unknown,
	): Promise<{ refresh: boolean; disconnect: boolean; unlinkTarget?: string }> {
		const c = captureAuthLinkConfig(config);
		const i = capture(value, ["signer", "expectedIdentityId"]);
		const signer = captureAuthLinkSigner(i?.signer);
		const unavailable = { refresh: false, disconnect: false };
		if (!c?.enabled || !i || !signer || !isAuthControllerId(i.expectedIdentityId))
			return unavailable;
		const key = await ed25519KeyIdForRevocation(signer.publicKey);
		if (!key) return unavailable;
		const authority = await this.derivedAuthority(
			c,
			signer,
			key,
			(target) => target.identity_id === i.expectedIdentityId,
			authLinkNow(this.clock),
		);
		if (!authority) return unavailable;
		const { target } = authority;
		// Descriptive only, so nothing re-runs the reads.
		const allowed = authority.grant !== null;
		return {
			refresh: allowed,
			disconnect: allowed,
			...(allowed ? { unlinkTarget: target.target_link_id } : {}),
		};
	}
	/** Device-signed unlink only. The winning INSERT rechecks live authority and the exact target. */
	async unlink(value: unknown, config: unknown): Promise<AccountChangeOutcome | null> {
		const c = captureAuthLinkConfig(config);
		const i = unlinkInput(value);
		if (!c?.enabled || !i) return null;
		const { signer } = i;
		const pins = [
			c.coordinatorId,
			i.attemptId,
			i.expectedLinkId,
			i.expectedIdentityId,
			c.issuer,
			...signerValues(signer),
			c.revision,
			i.requestHash,
		];
		const retry = () =>
			this.first<{ targetLinkId: string; completedAtMs: number }>(
				sql(
					`SELECT target_link_id AS targetLinkId,completed_at_ms AS completedAtMs FROM ${ACCOUNT_UNLINK_TABLE} WHERE coordinator_id=? AND attempt_id=? AND target_link_id=? AND identity_id=? AND issuer=? AND group_id=? AND device_id=? AND public_key=? AND fingerprint=? AND auth_config_revision=? AND request_hash=? AND state='completed'`,
					pins,
				),
			);
		const prior = await retry();
		if (prior) return { intent: "disconnect", ...prior };
		const key = await ed25519KeyIdForRevocation(signer.publicKey);
		if (!key) return null;
		const now = authLinkNow(this.clock);
		const authority = await this.derivedAuthority(
			c,
			signer,
			key,
			(target) =>
				target.identity_id === i.expectedIdentityId && target.target_link_id === i.expectedLinkId,
			now,
		);
		if (!authority) return null;
		const { grant } = authority;
		if (grant) await this.atomic([...authority.guards, ...unlinkWrites(c, i, grant, now)]);
		const completed = await retry();
		return completed ? { intent: "disconnect", ...completed } : null;
	}
	async create(value: unknown, config: unknown): Promise<boolean> {
		const c = captureAuthLinkConfig(config),
			i = signed(value);
		const extra = capture(value, ["intent", "browserStartHash", "loopbackRedirect"]);
		if (
			!c?.enabled ||
			!i ||
			!extra ||
			!isHash(extra.browserStartHash) ||
			!parseCoordinatorAuthLoopback(extra.loopbackRedirect).ok ||
			(extra.intent !== "refresh" && extra.intent !== "disconnect")
		)
			return false;
		const now = authLinkNow(this.clock);
		const retry = () => this.retryCreate(c, i, extra, now);
		if (await this.row(c, i.attemptId)) return !!(await retry());
		const key = await ed25519KeyIdForRevocation(i.signer.publicKey);
		if (!key) return false;
		const authority = await this.derivedAuthority(
			c,
			i.signer,
			key,
			(target) => target.identity_id === i.expectedIdentityId,
			now,
		);
		if (!authority) return false;
		const { grant, target } = authority;
		const created =
			!!grant &&
			(await this.atomic([
				...authority.guards,
				createWrite({
					c,
					i,
					intent: extra.intent,
					key,
					grant,
					target,
					now,
					browserStartHash: extra.browserStartHash,
					loopbackRedirect: extra.loopbackRedirect as string,
				}),
				assertOne,
			]));
		return created || !!(await retry());
	}
	async claimBrowser(value: unknown, config: unknown): Promise<boolean> {
		const c = captureAuthLinkConfig(config),
			i = capture(value, [
				"attemptId",
				"browserStartHash",
				"stateHash",
				"binderHash",
				"nonce",
				"pkceVerifier",
			]);
		if (
			!c?.enabled ||
			!i ||
			!isAuthControllerId(i.attemptId) ||
			![i.browserStartHash, i.stateHash, i.binderHash].every(isHash) ||
			![i.nonce, i.pkceVerifier].every(
				(v) => typeof v === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(v),
			)
		)
			return false;
		const now = authLinkNow(this.clock);
		return this.atomic([
			sql(
				`INSERT INTO ${orders} (coordinator_id,last_order) SELECT ?,0 WHERE NOT EXISTS (SELECT 1 FROM ${orders} WHERE coordinator_id = ?)`,
				[c.coordinatorId, c.coordinatorId],
			),
			sql(CONNECTION_ALLOCATE_ORDER_SQL, [c.coordinatorId]),
			assertOne,
			sql(
				`UPDATE ${table} AS a SET state = 'browser_pending',state_hash = ?,binder_hash = ?,nonce = ?,pkce_verifier = ?,browser_order = (SELECT last_order FROM ${orders} WHERE coordinator_id = a.coordinator_id)
 WHERE ${configured} AND a.attempt_id = ? AND a.browser_start_hash = ? AND a.state = 'pending' AND a.expires_at_ms > ?`,
				[
					i.stateHash as string,
					i.binderHash as string,
					i.nonce as string,
					i.pkceVerifier as string,
					...configValues(c),
					i.attemptId,
					i.browserStartHash as string,
					now,
				],
			),
			assertOne,
		]);
	}
	/** Lookup AND one-use consumption are one private operation; returned secrets
	 * may be used only by the OIDC exchange, never returned by a public status API. */
	async consumeCallback(value: unknown, config: unknown) {
		const c = captureAuthLinkConfig(config),
			i = capture(value, ["stateHash", "binderHash"]);
		if (!c?.enabled || !i || !isHash(i.stateHash) || !isHash(i.binderHash)) return null;
		const now = authLinkNow(this.clock);
		const a = await this.first<ChangeRow>(
			sql(
				`SELECT * FROM ${table} a WHERE ${configured} AND a.state_hash = ? AND a.binder_hash = ? AND a.state = 'browser_pending' AND a.expires_at_ms > ?`,
				[...configValues(c), i.stateHash, i.binderHash, now],
			),
		);
		if (!a) return null;
		const won = await this.atomic([
			sql(
				`UPDATE ${table} AS a SET state = 'consumed',nonce = NULL,pkce_verifier = NULL,consumed_at_ms = ? WHERE ${configured} AND a.attempt_id = ? AND a.state_hash = ? AND a.binder_hash = ? AND a.state = 'browser_pending' AND a.expires_at_ms > ?`,
				[now, ...configValues(c), a.attempt_id, i.stateHash, i.binderHash, now],
			),
			assertOne,
		]);
		return won ? { attemptId: a.attempt_id, nonce: a.nonce, pkceVerifier: a.pkce_verifier } : null;
	}
	private async callbackAuthority(c: CoordinatorAuthLinkConfig, attemptId: string, now: number) {
		const a = await this.row(c, attemptId);
		if (!a) return null;
		return this.authority(
			c,
			{
				groupId: a.group_id,
				deviceId: a.device_id,
				publicKey: a.public_key,
				fingerprint: a.fingerprint,
			},
			a,
			now,
		);
	}
	/** Trusted adapter output, not HTTP account JSON. No autoConfirm caller flag. */
	async recordVerifiedCallback(value: unknown, config: unknown): Promise<boolean> {
		const c = captureAuthLinkConfig(config),
			i = capture(value, [
				"attemptId",
				"stateHash",
				"binderHash",
				"issuer",
				"subject",
				"profile",
				"completionSecretHash",
			]);
		const profile = captureAuthAccountProfile(i?.profile);
		if (
			!c?.enabled ||
			!i ||
			!profile ||
			!isAuthControllerId(i.attemptId) ||
			![i.stateHash, i.binderHash, i.completionSecretHash].every(isHash) ||
			i.issuer !== c.issuer ||
			typeof i.subject !== "string"
		)
			return false;
		const now = authLinkNow(this.clock);
		const authority = await this.callbackAuthority(c, i.attemptId, now);
		if (!authority) return false;
		const { grant } = authority;
		if (!grant) return false;
		return this.atomic([
			...authority.guards,
			sql(
				`UPDATE ${table} AS a SET state = CASE intent WHEN 'refresh' THEN 'confirmed' ELSE 'verified' END,verified_at_ms = ?,
 confirmed_at_ms = CASE intent WHEN 'refresh' THEN ? END,completion_secret_hash = CASE intent WHEN 'refresh' THEN ? END,
 display_name = ?,email = ?,email_verified = ?,picture_url = ? WHERE ${configured} AND a.attempt_id = ? AND a.state_hash = ? AND a.binder_hash = ? AND a.target_subject = ? AND a.state = 'consumed' AND a.expires_at_ms > ?
 AND ${grantedRowSql}`,
				[
					now,
					now,
					i.completionSecretHash as string,
					profile.displayName ?? null,
					profile.email ?? null,
					profile.emailVerified === undefined ? null : Number(profile.emailVerified),
					profile.pictureUrl ?? null,
					...configValues(c),
					i.attemptId,
					i.stateHash as string,
					i.binderHash as string,
					i.subject,
					now,
					...grantedRowValues(grant),
				],
			),
			assertOne,
		]);
	}
	/** The browser handler validates the fresh binder and CSRF before this call. */
	async confirmDisconnect(value: unknown, config: unknown): Promise<boolean> {
		const c = captureAuthLinkConfig(config),
			i = browserPin(value),
			proof = capture(value, ["completionSecretHash"]);
		if (!c?.enabled || !i || !proof || !isHash(proof.completionSecretHash)) return false;
		const now = authLinkNow(this.clock);
		const won = await this.atomic([
			sql(
				`UPDATE ${table} AS a SET state = 'confirmed',confirmed_at_ms = ?,completion_secret_hash = ? WHERE ${configured} AND a.attempt_id = ? AND a.state_hash = ? AND a.binder_hash = ? AND a.intent = 'disconnect' AND a.state = 'verified' AND a.expires_at_ms > ?`,
				[
					now,
					proof.completionSecretHash,
					...configValues(c),
					i.attemptId,
					i.stateHash as string,
					i.binderHash as string,
					now,
				],
			),
			assertOne,
		]);
		if (won) return true;
		return this.readConfirmedDisconnect(i, proof.completionSecretHash, c);
	}
	private async readConfirmedDisconnect(
		pins: NonNullable<ReturnType<typeof browserPin>>,
		completionSecretHash: string,
		c: CoordinatorAuthLinkConfig,
	): Promise<boolean> {
		const now = authLinkNow(this.clock);
		const authority = await this.callbackAuthority(c, pins.attemptId, now);
		const grant = authority?.grant;
		if (!grant) return false;
		// This request still owns the raw secret; never recover from status alone.
		// A read only, so nothing re-runs the authority reads.
		return !!(await this.first(
			sql(
				`SELECT 1 FROM ${table} a WHERE ${configured} AND ${browserMatch}
 AND a.intent='disconnect' AND a.state='confirmed' AND a.completion_secret_hash=? AND a.expires_at_ms>?
 AND ${grantedRowSql}`,
				[
					...configValues(c),
					pins.attemptId,
					pins.stateHash,
					pins.binderHash,
					completionSecretHash,
					now,
					...grantedRowValues(grant),
				],
			),
		));
	}
	async finalize(value: unknown, config: unknown): Promise<AccountChangeOutcome | null> {
		const c = captureAuthLinkConfig(config),
			i = signed(value),
			proof = capture(value, ["completionSecretHash"]);
		if (!c?.enabled || !i || !proof || !isHash(proof.completionSecretHash)) return null;
		const a = await this.row(c, i.attemptId);
		if (!a) return null;
		const pins = [...configValues(c), i.attemptId, ...signedValues(i), proof.completionSecretHash];
		const match = `${configured} AND a.attempt_id = ? AND ${signedMatch} AND a.completion_secret_hash = ?`;
		// Retained exact-proof retries have no effects, including after target deletion.
		const retry = await this.first<ChangeRow>(
			sql(`SELECT * FROM ${table} a WHERE ${match} AND a.state = 'completed'`, pins),
		);
		if (retry) return outcome(retry);
		const now = authLinkNow(this.clock),
			authority = await this.authority(c, i.signer, a, now);
		if (!authority) return null;
		const { grant } = authority;
		const effects =
			a.intent === "disconnect"
				? disconnectEffects(c.coordinatorId, i.attemptId, now, {
						connections: await hasConnectionSessionSchema(this.backend),
					})
				: refreshEffects(c.coordinatorId, i.attemptId);
		// A denied grant takes the same path as the old statement that matched no row.
		if (
			!grant ||
			!(await this.atomic([
				...authority.guards,
				sql(
					`UPDATE ${table} AS a SET state = 'committing' WHERE ${match} AND a.state = 'confirmed' AND a.expires_at_ms > ?
 AND a.target_link_id = ? AND a.target_subject = ? AND a.enrollment_identity_id IS ?`,
					[...pins, now, grant.linkId, grant.subject, grant.enrollmentIdentityId],
				),
				assertOne,
				...effects,
				sql(
					`UPDATE ${table} SET state = 'completed',completed_at_ms = ?,display_name = NULL,email = NULL,email_verified = NULL,picture_url = NULL WHERE coordinator_id = ? AND attempt_id = ? AND state = 'committing'`,
					[now, c.coordinatorId, i.attemptId],
				),
				assertOne,
			]))
		) {
			const completed = await this.first<ChangeRow>(
				sql(`SELECT * FROM ${table} a WHERE ${match} AND a.state = 'completed'`, pins),
			);
			return completed ? outcome(completed) : null;
		}
		return { intent: a.intent, targetLinkId: a.target_link_id, completedAtMs: now };
	}
	async cancel(value: unknown, config: unknown): Promise<boolean> {
		const c = captureAuthLinkConfig(config),
			i = signed(value);
		if (!c?.enabled || !i) return false;
		return this.atomic([
			sql(
				`UPDATE ${table} AS a SET state = 'cancelled',failure_reason = 'device_cancelled',nonce = NULL,pkce_verifier = NULL,display_name = NULL,email = NULL,email_verified = NULL,picture_url = NULL WHERE ${configured} AND a.attempt_id = ? AND ${signedMatch} AND a.state NOT IN ('completed','committing','cancelled','failed','expired') AND a.expires_at_ms > ?`,
				[...configValues(c), i.attemptId, ...signedValues(i), authLinkNow(this.clock)],
			),
			assertOne,
		]);
	}
	/** Signed status is descriptive only; it never supplies management authority. */
	async readStatus(value: unknown, config: unknown) {
		const c = captureAuthLinkConfig(config),
			i = signed(value);
		if (!c?.enabled || !i) return null;
		const a = await this.first<ChangeRow>(
			sql(`SELECT * FROM ${table} a WHERE ${configured} AND a.attempt_id = ? AND ${signedMatch}`, [
				...configValues(c),
				i.attemptId,
				...signedValues(i),
			]),
		);
		if (!a) return null;
		const state =
			["pending", "browser_pending", "consumed", "verified", "confirmed"].includes(a.state) &&
			a.expires_at_ms <= authLinkNow(this.clock)
				? "expired"
				: a.state;
		return {
			attemptId: a.attempt_id,
			intent: a.intent,
			state,
			expiresAtMs: a.expires_at_ms,
			identityId: a.identity_id,
		};
	}
	/** Shared callback dispatch can probe exact state/binder without consuming it. */
	async hasPendingCallback(value: unknown, config: unknown): Promise<boolean> {
		const c = captureAuthLinkConfig(config),
			i = capture(value, ["stateHash", "binderHash"]);
		if (!c?.enabled || !i || !isHash(i.stateHash) || !isHash(i.binderHash)) return false;
		return !!(await this.first(
			sql(
				`SELECT 1 FROM ${table} a WHERE ${configured} AND a.state_hash = ? AND a.binder_hash = ? AND a.state = 'browser_pending' AND a.expires_at_ms > ?`,
				[...configValues(c), i.stateHash, i.binderHash, authLinkNow(this.clock)],
			),
		));
	}
	/** Prepare delivery for an exact consumed proof; the winning write rechecks authority. */
	async readCallbackView(value: unknown, config: unknown) {
		const c = captureAuthLinkConfig(config),
			i = browserPin(value);
		if (!c?.enabled || !i) return null;
		const a = await this.first<ChangeRow>(
			sql(
				`SELECT * FROM ${table} a WHERE ${configured} AND ${browserMatch} AND a.state = 'consumed' AND a.expires_at_ms > ?`,
				[...configValues(c), i.attemptId, i.stateHash, i.binderHash, authLinkNow(this.clock)],
			),
		);
		if (!a || !parseCoordinatorAuthLoopback(a.loopback_redirect).ok) return null;
		return { attemptId: a.attempt_id, intent: a.intent, loopbackRedirect: a.loopback_redirect };
	}
	/** Cookie-authenticated, CSRF-protected hosted confirmation only, not status JSON. */
	async readBrowserView(value: unknown, config: unknown) {
		const c = captureAuthLinkConfig(config),
			i = browserPin(value);
		if (!c?.enabled || !i) return null;
		const now = authLinkNow(this.clock);
		const a = await this.first<ChangeRow>(
			sql(
				`SELECT * FROM ${table} a WHERE ${configured} AND ${browserMatch} AND a.state IN ('verified','confirmed') AND a.expires_at_ms > ?`,
				[...configValues(c), i.attemptId, i.stateHash, i.binderHash, now],
			),
		);
		if (!a) return null;
		if (!parseCoordinatorAuthLoopback(a.loopback_redirect).ok) return null;
		const authority = await this.authority(
			c,
			{
				groupId: a.group_id,
				deviceId: a.device_id,
				publicKey: a.public_key,
				fingerprint: a.fingerprint,
			},
			a,
			now,
		);
		// A read only, so nothing re-runs the authority reads.
		const grant = authority?.grant;
		if (!grant || !sqlIs(grant.enrollmentIdentityId, a.enrollment_identity_id)) return null;
		const profile = captureAuthAccountProfile({
			displayName: a.display_name,
			email: a.email,
			emailVerified: a.email_verified === null ? undefined : Boolean(a.email_verified),
			pictureUrl: a.picture_url,
		});
		return {
			attemptId: a.attempt_id,
			intent: a.intent,
			state: a.state,
			loopbackRedirect: a.loopback_redirect,
			identityId: a.identity_id,
			expiresAtMs: a.expires_at_ms,
			profile,
		};
	}
	/** Private cookie binding lookup; never returns account or redirect data. */
	async readBrowserBinding(value: unknown, config: unknown): Promise<{ stateHash: string } | null> {
		const c = captureAuthLinkConfig(config),
			i = capture(value, ["attemptId", "binderHash"]);
		if (!c?.enabled || !i || !isAuthControllerId(i.attemptId) || !isHash(i.binderHash)) return null;
		return this.first(
			sql(
				`SELECT state_hash AS stateHash FROM ${table} a WHERE ${configured} AND a.attempt_id = ? AND a.binder_hash = ? AND a.state IN ('verified','confirmed') AND a.expires_at_ms > ?`,
				[...configValues(c), i.attemptId, i.binderHash, authLinkNow(this.clock)],
			),
		);
	}
	/** Private start-code lookup; no account, profile or redirect data before proof. */
	async readStart(value: unknown, config: unknown) {
		const c = captureAuthLinkConfig(config),
			i = capture(value, ["attemptId", "browserStartHash"]);
		if (!c?.enabled || !i || !isAuthControllerId(i.attemptId) || !isHash(i.browserStartHash))
			return null;
		return this.first<{ intent: Intent; expiresAtMs: number }>(
			sql(
				`SELECT intent,expires_at_ms AS expiresAtMs FROM ${table} a WHERE ${configured} AND a.attempt_id = ? AND a.browser_start_hash = ? AND a.state = 'pending' AND a.expires_at_ms > ?`,
				[...configValues(c), i.attemptId, i.browserStartHash, authLinkNow(this.clock)],
			),
		);
	}
	/** Cookie-binder activity probe for the shared configured browser handler. */
	async readManagementActivity(value: unknown, config: unknown) {
		const c = captureAuthLinkConfig(config),
			i = capture(value, ["binderHash"]);
		if (!c?.enabled || !i || !isHash(i.binderHash))
			return { kind: "rejected" as const, error: "auth_config_changed" as const };
		const a = await this.first<ChangeRow>(
			sql(`SELECT * FROM ${table} WHERE coordinator_id = ? AND binder_hash = ?`, [
				c.coordinatorId,
				i.binderHash,
			]),
		);
		if (!a) return { kind: "inactive" as const };
		if (a.issuer !== c.issuer || a.auth_config_revision !== c.revision)
			return { kind: "rejected" as const, error: "auth_config_changed" as const };
		if (
			["completed", "cancelled", "failed", "expired"].includes(a.state) ||
			a.expires_at_ms <= authLinkNow(this.clock)
		)
			return { kind: "inactive" as const };
		return { kind: "active" as const };
	}
	/** Only the exact consumed exchange may report provider failure. */
	async failConsumed(value: unknown, config: unknown): Promise<boolean> {
		const c = captureAuthLinkConfig(config),
			i = browserPin(value);
		if (!c?.enabled || !i) return false;
		return this.atomic([
			sql(
				`UPDATE ${table} AS a SET state = 'failed',failure_reason = 'provider_failure',${scrub} WHERE ${configured} AND ${browserMatch} AND a.state = 'consumed' AND a.expires_at_ms > ?`,
				[...configValues(c), i.attemptId, i.stateHash, i.binderHash, authLinkNow(this.clock)],
			),
			assertOne,
		]);
	}
	/** Coordinator-local maintenance; config rotation/disable must not retain staging. */
	async maintainExpired(
		coordinatorId: unknown,
		limit: unknown = AUTH_LINK_EXPIRE_BATCH_MAX,
	): Promise<number> {
		if (
			!isAuthControllerId(coordinatorId) ||
			typeof limit !== "number" ||
			!Number.isInteger(limit) ||
			limit < 1 ||
			limit > AUTH_LINK_EXPIRE_BATCH_MAX
		)
			return 0;
		const now = authLinkNow(this.clock);
		return this.backend.run(
			sql(
				`UPDATE ${table} SET state = 'expired',failure_reason = 'expired',${scrub} WHERE coordinator_id = ? AND state IN ('pending','browser_pending','consumed','verified','confirmed') AND expires_at_ms <= ? AND attempt_id IN (SELECT attempt_id FROM ${table} WHERE coordinator_id = ? AND state IN ('pending','browser_pending','consumed','verified','confirmed') AND expires_at_ms <= ? ORDER BY expires_at_ms,attempt_id LIMIT ?)`,
				[coordinatorId, now, coordinatorId, now, limit],
			),
		);
	}
}

/** The device unlink receipt, its disconnect effects and its completion, after the guards. */
function unlinkWrites(
	c: CoordinatorAuthLinkConfig,
	i: NonNullable<ReturnType<typeof unlinkInput>>,
	grant: AccountChangeGrant,
	now: number,
): AuthLinkStatement[] {
	return [
		sql(
			`INSERT INTO ${ACCOUNT_UNLINK_TABLE} (coordinator_id,attempt_id,target_link_id,identity_id,issuer,target_subject,group_id,device_id,public_key,fingerprint,enrollment_identity_id,auth_config_revision,request_hash,state,created_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'committing',?)`,
			[
				grant.coordinatorId,
				i.attemptId,
				grant.linkId,
				grant.identityId,
				grant.issuer,
				grant.subject,
				...signerValues(i.signer),
				grant.enrollmentIdentityId,
				c.revision,
				i.requestHash,
				now,
			],
		),
		assertOne,
		...disconnectEffects(c.coordinatorId, i.attemptId, now, { connections: true, device: true }),
		sql(
			`UPDATE ${ACCOUNT_UNLINK_TABLE} SET state='completed',completed_at_ms=? WHERE coordinator_id=? AND attempt_id=? AND state='committing'`,
			[now, c.coordinatorId, i.attemptId],
		),
		assertOne,
	];
}

/** The pending change attempt for the granted link, when the shared budgets admit it. */
function createWrite(w: {
	c: CoordinatorAuthLinkConfig;
	i: Signed;
	intent: Intent;
	key: string;
	grant: AccountChangeGrant;
	target: AccountChangeTarget;
	now: number;
	browserStartHash: string;
	loopbackRedirect: string;
}): AuthLinkStatement {
	const { c, i, grant, now } = w;
	return sql(
		`INSERT INTO ${table}
 (coordinator_id,attempt_id,intent,target_link_id,identity_id,issuer,target_subject,group_id,device_id,public_key,fingerprint,key_id,enrollment_identity_id,auth_config_revision,runtime_verifier_hash,browser_start_hash,loopback_redirect,state,created_at_ms,expires_at_ms)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,? FROM ${admissionInput} p WHERE ${connectionAdmissionSql("p")}`,
		[
			grant.coordinatorId,
			i.attemptId,
			w.intent,
			grant.linkId,
			grant.identityId,
			grant.issuer,
			grant.subject,
			...signerValues(i.signer),
			w.key,
			grant.enrollmentIdentityId,
			c.revision,
			i.runtimeVerifierHash,
			w.browserStartHash,
			w.loopbackRedirect,
			now,
			now + 600000,
			...admissionValues(c, i.signer, w.target, now),
		],
	);
}

function disconnectEffects(
	coordinator: string,
	attempt: string,
	now: number,
	options: { connections: boolean; device?: boolean },
): AuthLinkStatement[] {
	const table = options.device ? ACCOUNT_UNLINK_TABLE : "coordinator_account_change_attempts";
	const intent = options.device ? "" : " AND a.intent = 'disconnect'";
	const columns = options.connections
		? [...CONNECTION_BIRTH_COLUMNS, "signin_floor"]
		: CONNECTION_BIRTH_COLUMNS;
	const exactBirth = `${CONNECTION_ARCHIVED_CURRENT_MATCH_SQL}${options.connections ? " AND h.signin_floor IS c.signin_floor" : ""}`;
	return [
		sql(
			`INSERT INTO ${history} (${columns.join(",")},original_rowid,ended_at_ms,end_attempt_id)
 SELECT ${columns.map((c) => `l.${c}`).join(",")},l.rowid,?,a.attempt_id FROM ${current} l JOIN ${table} a ON a.coordinator_id = l.coordinator_id AND a.target_link_id = l.link_id WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.state = 'committing'${intent}`,
			[now, coordinator, attempt],
		),
		assertOne,
		sql(
			`DELETE FROM ${current} AS c WHERE EXISTS (SELECT 1 FROM ${history} h WHERE h.coordinator_id = ? AND h.end_attempt_id = ? AND ${exactBirth})`,
			[coordinator, attempt],
		),
		assertOne,
		sql(
			`UPDATE coordinator_auth_sessions SET revoked_at_ms = ? WHERE coordinator_id = ? AND link_id = (SELECT target_link_id FROM ${table} WHERE coordinator_id = ? AND attempt_id = ?) AND revoked_at_ms IS NULL`,
			[now, coordinator, coordinator, attempt],
		),
		sql(
			`INSERT INTO ${orders} (coordinator_id,last_order) SELECT NULL,0 WHERE EXISTS (
 SELECT 1 FROM coordinator_auth_sessions s JOIN ${table} a ON a.coordinator_id = s.coordinator_id AND a.target_link_id = s.link_id
 WHERE a.coordinator_id = ? AND a.attempt_id = ? AND s.revoked_at_ms IS NULL)`,
			[coordinator, attempt],
		),
		...["coordinator_auth_account_profiles", "coordinator_auth_link_profiles"].map((name) =>
			sql(
				`DELETE FROM ${name} WHERE coordinator_id = ? AND link_id = (SELECT target_link_id FROM ${table} WHERE coordinator_id = ? AND attempt_id = ?)`,
				[coordinator, coordinator, attempt],
			),
		),
		sql(
			`INSERT INTO ${orders} (coordinator_id,last_order) SELECT NULL,0 WHERE EXISTS (
 SELECT 1 FROM ${table} a WHERE a.coordinator_id = ? AND a.attempt_id = ? AND (
 EXISTS (SELECT 1 FROM coordinator_auth_account_profiles p WHERE p.coordinator_id = a.coordinator_id AND p.link_id = a.target_link_id)
 OR EXISTS (SELECT 1 FROM coordinator_auth_link_profiles p WHERE p.coordinator_id = a.coordinator_id AND p.link_id = a.target_link_id)))`,
			[coordinator, attempt],
		),
	];
}
function refreshEffects(coordinator: string, attempt: string): AuthLinkStatement[] {
	// Keep original birth metadata byte-for-byte; new provenance names the
	// management receipt. Never invent a session receipt or a fake birth attempt.
	return [
		sql(
			`INSERT INTO coordinator_auth_link_profiles
 (coordinator_id,attempt_id,issuer,subject,auth_config_revision,browser_transaction_hash,link_id,verified_at_ms,display_name,email,email_verified,picture_url,source_change_attempt_id,source_order)
 SELECT l.coordinator_id,l.attempt_id,l.issuer,l.subject,l.auth_config_revision,b.browser_transaction_hash,l.link_id,b.oidc_verified_at_ms,a.display_name,a.email,a.email_verified,a.picture_url,a.attempt_id,a.browser_order
 FROM ${table} a JOIN ${current} l ON l.coordinator_id = a.coordinator_id AND l.link_id = a.target_link_id
 JOIN coordinator_auth_link_attempts b ON b.coordinator_id = l.coordinator_id AND b.attempt_id = l.attempt_id AND b.link_id = l.link_id
 WHERE a.coordinator_id = ? AND a.attempt_id = ? AND a.state = 'committing' AND a.intent = 'refresh'
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_account_profiles p WHERE p.coordinator_id = l.coordinator_id AND p.link_id = l.link_id AND p.source_order >= a.browser_order)
 ON CONFLICT(coordinator_id,link_id) DO UPDATE SET display_name = excluded.display_name,email = excluded.email,email_verified = excluded.email_verified,picture_url = excluded.picture_url,
 source_change_attempt_id = excluded.source_change_attempt_id,source_order = excluded.source_order
 WHERE coalesce(coordinator_auth_link_profiles.source_order,0) < excluded.source_order`,
			[coordinator, attempt],
		),
		sql(
			`INSERT INTO ${orders} (coordinator_id,last_order) SELECT NULL,0 WHERE changes() <> 1 AND NOT EXISTS (
 SELECT 1 FROM ${table} a WHERE a.coordinator_id = ? AND a.attempt_id = ? AND (
 EXISTS (SELECT 1 FROM coordinator_auth_link_profiles p WHERE p.coordinator_id = a.coordinator_id AND p.link_id = a.target_link_id AND p.source_order >= a.browser_order)
 OR EXISTS (SELECT 1 FROM coordinator_auth_account_profiles p WHERE p.coordinator_id = a.coordinator_id AND p.link_id = a.target_link_id AND p.source_order >= a.browser_order)))`,
			[coordinator, attempt],
		),
	];
}
