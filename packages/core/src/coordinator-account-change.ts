import { CONNECTION_REQUESTER_IDENTITY_SQL } from "./coordinator-account-connection-link.js";
import {
	connectionAdmissionSql,
	hasConnectionSessionSchema,
} from "./coordinator-account-connection-session.js";
import {
	CONNECTION_ALLOCATE_ORDER_SQL,
	CONNECTION_ARCHIVED_CURRENT_MATCH_SQL,
	CONNECTION_ASSERT_ONE_WRITE_SQL,
	CONNECTION_BIRTH_COLUMNS,
	CONNECTION_NOT_REVOKED_SQL,
} from "./coordinator-account-connection-storage.js";
import { ACCOUNT_UNLINK_TABLE } from "./coordinator-account-unlink-schema.js";
import { captureAuthAccountProfile } from "./coordinator-auth-account-profile.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL,
	AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import {
	AUTH_LINK_CONTROLLER_SOURCE_SQL,
	type AuthLinkBackend,
	type AuthLinkStatement,
	authLinkControllerSourceValues,
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
import {
	authClaimGenesisSql,
	authDeviceClaimProvenanceSql,
} from "./coordinator-auth-link-provenance.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";

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
const admission = `, change_admitted AS (SELECT p.* FROM claim_input p WHERE ${connectionAdmissionSql("p")})`;
function browserPin(value: unknown) {
	const i = capture(value, ["attemptId", "stateHash", "binderHash"]);
	if (!i || !isAuthControllerId(i.attemptId) || !isHash(i.stateHash) || !isHash(i.binderHash))
		return null;
	return { attemptId: i.attemptId, stateHash: i.stateHash, binderHash: i.binderHash };
}
const browserMatch = "a.attempt_id = ? AND a.state_hash = ? AND a.binder_hash = ?";
const scrub =
	"nonce = NULL,pkce_verifier = NULL,display_name = NULL,email = NULL,email_verified = NULL,picture_url = NULL";

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
	private async authority(
		c: CoordinatorAuthLinkConfig,
		s: CoordinatorAuthLinkSigner,
		target: { identity_id: string; target_link_id: string },
		now: number,
	) {
		const captured = await captureDeviceClaimEligibility(
			this.backend,
			{ identityId: target.identity_id, signer: s },
			c,
			now,
		);
		if (!captured) return null;
		// Independent proof facts keep native D1's expression depth below 100.
		const facts = `,
 device_births AS MATERIALIZED (SELECT l.coordinator_id,l.link_id FROM coordinator_auth_account_links l JOIN claim_input p ON p.coordinator_id=l.coordinator_id AND p.identity_id=l.identity_id WHERE ${authDeviceClaimProvenanceSql({ link: "l", connections: captured.connectionSession })}),
 original_claims AS MATERIALIZED (SELECT d.* FROM coordinator_auth_device_claims d JOIN claim_input p ON p.coordinator_id=d.coordinator_id AND p.identity_id=d.identity_id WHERE ${captured.connectionSession ? authClaimGenesisSql("d") : "1 = 1"}),
 controller_births AS MATERIALIZED (SELECT l.coordinator_id,l.link_id FROM coordinator_auth_account_links l
 JOIN coordinator_auth_link_attempts b ON b.coordinator_id=l.coordinator_id AND b.link_id=l.link_id AND b.attempt_id=l.attempt_id
 JOIN coordinator_auth_link_audit_log ca ON ca.coordinator_id=l.coordinator_id AND ca.link_id=l.link_id AND ca.action='link_created'
 JOIN coordinator_auth_controller_attestations origin ON origin.coordinator_id=l.coordinator_id AND origin.attestation_id=l.controller_attestation_id
 WHERE (l.authority_kind='controller_attestation' AND l.device_claim_id IS NULL AND b.authority_kind=l.authority_kind AND b.controller_attestation_id=l.controller_attestation_id)
 AND (ca.attempt_id=b.attempt_id AND ca.identity_id=l.identity_id AND ca.controller_attestation_id=l.controller_attestation_id AND ca.authority_kind=l.authority_kind AND ca.auth_config_revision=l.auth_config_revision AND ca.group_id=b.group_id AND ca.device_id=b.device_id AND ca.fingerprint=b.fingerprint AND ca.created_at_ms=l.created_at_ms AND b.finalized_at_ms=l.created_at_ms)
 AND (origin.group_id=b.group_id AND origin.device_id=b.device_id AND origin.public_key=b.public_key AND origin.fingerprint=b.fingerprint AND origin.identity_id=b.identity_id AND origin.review_receipt_id=b.controller_review_receipt_id AND origin.revision=b.controller_revision)
 ${captured.connectionSession ? "AND (b.prior_link_id IS NULL OR EXISTS (SELECT 1 FROM coordinator_auth_account_connection_history h WHERE h.coordinator_id=b.coordinator_id AND h.identity_id=b.identity_id AND h.link_id=b.prior_link_id AND h.successor_link_id=b.link_id))" : ""})`;
		return sql(
			`${AUTH_DEVICE_CLAIM_INPUT_SQL}, current_controller AS MATERIALIZED (SELECT a.* ${AUTH_LINK_CONTROLLER_SOURCE_SQL})${facts},
 requester_ok AS MATERIALIZED (SELECT p.* FROM claim_input p WHERE (${AUTH_DEVICE_CLAIM_CURRENT_SUBJECT_COMPATIBLE_SQL}) AND (${CONNECTION_REQUESTER_IDENTITY_SQL}) AND ((${AUTH_DEVICE_CLAIM_REQUESTER_ATTESTATION_COMPATIBLE_SQL}) OR EXISTS (SELECT 1 FROM current_controller cc WHERE cc.identity_id=p.identity_id)) AND (${AUTH_DEVICE_CLAIM_REQUESTER_INVITE_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_REQUESTER_LINK_COMPATIBLE_SQL}) AND (${AUTH_DEVICE_CLAIM_LEGACY_COMPATIBLE_SQL})), change_authority AS MATERIALIZED (
 SELECT l.*,e.identity_id AS enrollment_identity_id FROM requester_ok p
 JOIN ${current} l ON l.coordinator_id = p.coordinator_id AND l.link_id = ? AND l.identity_id = p.identity_id AND l.issuer = p.issuer
 JOIN enrolled_devices e ON e.group_id = p.group_id AND e.device_id = p.device_id AND e.public_key = p.public_key AND e.fingerprint = p.fingerprint
 JOIN groups g ON g.group_id = e.group_id
 JOIN coordinator_auth_link_attempts b ON b.coordinator_id = l.coordinator_id AND b.link_id = l.link_id AND b.attempt_id = l.attempt_id
 LEFT JOIN controller_births cb ON cb.coordinator_id=l.coordinator_id AND cb.link_id=l.link_id
 LEFT JOIN device_births db ON db.coordinator_id=l.coordinator_id AND db.link_id=l.link_id
 LEFT JOIN current_controller cc ON cc.identity_id=l.identity_id
 LEFT JOIN original_claims d ON d.coordinator_id=l.coordinator_id AND ${captured.connectionSession ? "d.identity_id=l.identity_id" : "d.claim_id=l.device_claim_id"} AND d.group_id=p.group_id AND d.device_id=p.device_id AND d.public_key=p.public_key AND d.fingerprint=p.fingerprint AND d.key_id=p.key_id
 WHERE (e.enabled = 1 AND g.archived_at IS NULL AND (e.identity_id IS NULL OR e.identity_id = l.identity_id))
 AND (b.identity_id = l.identity_id AND b.issuer = l.issuer AND b.account_subject = l.subject AND b.auth_config_revision = l.auth_config_revision AND b.state IN ('finalized','session_redeemed'))
 AND (${CONNECTION_NOT_REVOKED_SQL})
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r WHERE (r.subject_kind = 'device_id' AND r.subject_value = p.device_id) OR (r.subject_kind = 'ed25519_key' AND r.subject_value = p.key_id))
 AND (cb.link_id IS NOT NULL OR db.link_id IS NOT NULL) AND (cc.attestation_id IS NOT NULL OR d.claim_id IS NOT NULL))`,
			[...captured.values, ...authLinkControllerSourceValues(c, s), target.target_link_id],
		);
	}
	// Expected Identity is checked after deriving authority, never used to grant it.
	private deriveTarget(c: CoordinatorAuthLinkConfig, i: Pick<Signed, "signer">, key: string) {
		return this.first<{ identity_id: string; target_link_id: string }>(
			sql(
				`SELECT l.identity_id,l.link_id AS target_link_id FROM ${current} l
 LEFT JOIN coordinator_auth_device_claims d ON d.coordinator_id = l.coordinator_id AND d.identity_id = l.identity_id
 LEFT JOIN coordinator_auth_controller_attestations a ON a.coordinator_id = l.coordinator_id AND a.identity_id = l.identity_id
 WHERE l.coordinator_id = ? AND ((d.device_id = ? AND d.key_id = ?) OR
 (a.group_id = ? AND a.device_id = ? AND a.public_key = ? AND a.fingerprint = ? AND a.revoked_at IS NULL))`,
				[c.coordinatorId, i.signer.deviceId, key, ...signerValues(i.signer)],
			),
		);
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
		const target = await this.deriveTarget(c, { signer }, key);
		if (!target || target.identity_id !== i.expectedIdentityId) return unavailable;
		const authority = await this.authority(c, signer, target, authLinkNow(this.clock));
		if (!authority) return unavailable;
		const allowed = !!(await this.first(
			sql(`${authority.sql} SELECT 1 FROM change_authority`, authority.values),
		));
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
		const target = await this.deriveTarget(c, { signer }, key);
		if (
			!target ||
			target.identity_id !== i.expectedIdentityId ||
			target.target_link_id !== i.expectedLinkId
		)
			return null;
		const now = authLinkNow(this.clock);
		const authority = await this.authority(c, signer, target, now);
		if (!authority) return null;
		await this.atomic([
			sql(
				`${authority.sql} INSERT INTO ${ACCOUNT_UNLINK_TABLE} (coordinator_id,attempt_id,target_link_id,identity_id,issuer,target_subject,group_id,device_id,public_key,fingerprint,enrollment_identity_id,auth_config_revision,request_hash,state,created_at_ms)
 SELECT coordinator_id,?,link_id,identity_id,issuer,subject,?,?,?,?,enrollment_identity_id,?,?,'committing',? FROM change_authority`,
				[...authority.values, i.attemptId, ...signerValues(signer), c.revision, i.requestHash, now],
			),
			assertOne,
			...disconnectEffects(c.coordinatorId, i.attemptId, now, { connections: true, device: true }),
			sql(
				`UPDATE ${ACCOUNT_UNLINK_TABLE} SET state='completed',completed_at_ms=? WHERE coordinator_id=? AND attempt_id=? AND state='committing'`,
				[now, c.coordinatorId, i.attemptId],
			),
			assertOne,
		]);
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
		const target = await this.deriveTarget(c, i, key);
		if (!target || target.identity_id !== i.expectedIdentityId) return false;
		const authority = await this.authority(c, i.signer, target, now);
		if (!authority) return false;
		return (
			(await this.atomic([
				sql(
					`${authority.sql}${admission} INSERT INTO ${table}
 (coordinator_id,attempt_id,intent,target_link_id,identity_id,issuer,target_subject,group_id,device_id,public_key,fingerprint,key_id,enrollment_identity_id,auth_config_revision,runtime_verifier_hash,browser_start_hash,loopback_redirect,state,created_at_ms,expires_at_ms)
 SELECT coordinator_id,?,?,link_id,identity_id,issuer,subject,?,?,?,?,?,enrollment_identity_id,?,?,?,?,'pending',?,? FROM change_authority WHERE EXISTS (SELECT 1 FROM change_admitted)`,
					[
						...authority.values,
						i.attemptId,
						extra.intent,
						...signerValues(i.signer),
						key,
						c.revision,
						i.runtimeVerifierHash,
						extra.browserStartHash,
						extra.loopbackRedirect as string,
						now,
						now + 600000,
					],
				),
				assertOne,
			])) || !!(await retry())
		);
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
		return this.atomic([
			sql(
				`${authority.sql} UPDATE ${table} AS a SET state = CASE intent WHEN 'refresh' THEN 'confirmed' ELSE 'verified' END,verified_at_ms = ?,
 confirmed_at_ms = CASE intent WHEN 'refresh' THEN ? END,completion_secret_hash = CASE intent WHEN 'refresh' THEN ? END,
 display_name = ?,email = ?,email_verified = ?,picture_url = ? WHERE ${configured} AND a.attempt_id = ? AND a.state_hash = ? AND a.binder_hash = ? AND a.target_subject = ? AND a.state = 'consumed' AND a.expires_at_ms > ?
 AND EXISTS (SELECT 1 FROM change_authority l WHERE l.coordinator_id = a.coordinator_id AND l.link_id = a.target_link_id AND l.identity_id = a.identity_id AND l.subject = a.target_subject AND l.issuer = a.issuer AND l.enrollment_identity_id IS a.enrollment_identity_id)`,
				[
					...authority.values,
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
		if (!authority) return false;
		// This request still owns the raw secret; never recover from status alone.
		return !!(await this.first(
			sql(
				`${authority.sql} SELECT 1 FROM ${table} a WHERE ${configured} AND ${browserMatch}
 AND a.intent='disconnect' AND a.state='confirmed' AND a.completion_secret_hash=? AND a.expires_at_ms>?
 AND EXISTS (SELECT 1 FROM change_authority l WHERE l.coordinator_id=a.coordinator_id AND l.link_id=a.target_link_id
 AND l.identity_id=a.identity_id AND l.subject=a.target_subject AND l.issuer=a.issuer AND l.enrollment_identity_id IS a.enrollment_identity_id)`,
				[
					...authority.values,
					...configValues(c),
					pins.attemptId,
					pins.stateHash,
					pins.binderHash,
					completionSecretHash,
					now,
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
		const won = sql(
			`${authority.sql} UPDATE ${table} AS a SET state = 'committing' WHERE ${match} AND a.state = 'confirmed' AND a.expires_at_ms > ?
 AND EXISTS (SELECT 1 FROM change_authority ca WHERE ca.link_id = a.target_link_id AND ca.subject = a.target_subject AND ca.enrollment_identity_id IS a.enrollment_identity_id)`,
			[...authority.values, ...pins, now],
		);
		const effects =
			a.intent === "disconnect"
				? disconnectEffects(c.coordinatorId, i.attemptId, now, {
						connections: await hasConnectionSessionSchema(this.backend),
					})
				: refreshEffects(c.coordinatorId, i.attemptId);
		if (
			!(await this.atomic([
				won,
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
		if (
			!authority ||
			!(await this.first(
				sql(`${authority.sql} SELECT 1 FROM change_authority WHERE enrollment_identity_id IS ?`, [
					...authority.values,
					a.enrollment_identity_id,
				]),
			))
		)
			return null;
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
