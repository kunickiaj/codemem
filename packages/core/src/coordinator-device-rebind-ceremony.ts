import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	AUTH_LINK_CREATE_WINDOW_MS,
	AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
} from "./coordinator-auth-link-contract.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import {
	clearBrowserCookie,
	readBrowserCookie,
	reissueStartCookieAsTransaction,
} from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	type BrowserCsrfScope,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest } from "./coordinator-browser-request.js";
import { readBrowserStartTransaction } from "./coordinator-browser-start-transaction.js";
import {
	commitDeviceRebind,
	DEVICE_REBIND_DAILY_LIMIT,
	type DeviceRebindReceipt,
	readDeviceRebindReceipt,
} from "./coordinator-device-rebind-commit.js";
import {
	type DeviceRebindAttempt,
	deviceRebindConfirmationHash,
	verifyDeviceRebindCompletion,
} from "./coordinator-device-rebind-proof.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import type { CoordinatorOidcClient } from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

/** The signed device request's verified enrollment; the route authenticates it. */
export interface DeviceRebindSigner {
	groupId: string;
	deviceId: string;
	publicKey: string;
	fingerprint: string;
}

export interface DeviceRebindStart {
	attemptId: string;
	signer: DeviceRebindSigner;
	/** The device's current Identity (its local actor), checked against its enrollments. */
	currentIdentityId: string;
	loopbackRedirect: string;
	/** SHA-256 hex of the browser start code; the device keeps the code itself. */
	browserStartHash: string;
	/** SHA-256 hex of the device's local review; any local change aborts the switch. */
	reviewDigest: string;
}

/** Why a step refused; the Viewer turns these into the next action for the person. */
export type DeviceRebindRefusal =
	| "unavailable"
	| "current_identity_linked"
	| "device_already_bound"
	| "account_not_linked"
	| "already_this_identity"
	| "daily_limit"
	| "retry";

export interface DeviceRebindConfirmation {
	attemptId: string;
	deviceId: string;
	fingerprint: string;
	issuer: string;
	subject: string;
	currentIdentityId: string;
	targetIdentityId: string;
	/** Groups where the device stays enrolled but the target Identity has no access yet. */
	groupsWithoutAccess: readonly string[];
	confirmationHash: string;
}

export type DeviceRebindResult =
	| { kind: "refused"; reason: DeviceRebindRefusal }
	| { kind: "unknown" }
	| { kind: "started"; attemptId: string; expiresAtMs: number }
	| { kind: "browser_claimed"; authorizationUrl: string; setCookies: string[] }
	| { kind: "verified"; confirmation: DeviceRebindConfirmation; csrf: string }
	| { kind: "confirmed"; completionSecret: string; loopbackRedirect: string }
	| { kind: "finalized" | "prior_commit"; receipt: DeviceRebindReceipt }
	| {
			kind: "status";
			state: string;
			expiresAtMs: number;
			/** Shown once the person confirmed; the device signs it at finalize. */
			targetIdentityId: string | null;
			receipt: DeviceRebindReceipt | null;
	  };

/** What the signed device steps need: no OIDC client or browser CSRF key. */
export interface DeviceRebindDeviceDependencies {
	backend: AuthLinkBackend;
	/** Store settings of the enabled browser-auth configuration. */
	config: CoordinatorAuthBrowserConfig;
	publicOrigin: string;
	limiter: InMemoryRequestRateLimiter;
	now(): number;
}

export interface DeviceRebindDependencies extends DeviceRebindDeviceDependencies {
	csrfKey: BrowserCsrfKey;
	client: Pick<CoordinatorOidcClient, "createAuthorizationRequest" | "verifyCallback">;
}

const ATTEMPT = "coordinator_device_rebind_attempts";
const TTL_MS = 600_000;
const START_CLIENT_LIMIT = 20;
const refused = (reason: DeviceRebindRefusal): DeviceRebindResult => ({ kind: "refused", reason });

async function sha256Hex(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function proofHash(value: string): Promise<string | null> {
	const bytes = decodeCoordinatorAuthProof32(value);
	return bytes ? hashCoordinatorAuthProofBytes32(bytes) : null;
}

function mintCompletionSecret(): string {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}

// Live conditions shared by every step; each winning statement repeats them.
const UNBOUND_SQL = `NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings b
 WHERE b.device_id = a.device_id OR b.key_id = a.key_id)`;
const UNREVOKED_SQL = `NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
 WHERE (r.subject_kind = 'device_id' AND r.subject_value = a.device_id)
 OR (r.subject_kind = 'ed25519_key' AND r.subject_value = a.key_id))`;
const CURRENT_UNLINKED_SQL = `NOT EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = a.coordinator_id AND l.identity_id = a.current_identity_id
 AND l.revoked_at_ms IS NULL)`;
const TARGET_LINK_SQL = `EXISTS (SELECT 1 FROM coordinator_auth_account_links l
 WHERE l.coordinator_id = a.coordinator_id AND l.link_id = a.link_id
 AND l.identity_id = a.target_identity_id AND l.issuer = a.issuer AND l.subject = a.account_subject
 AND l.authority_kind = a.link_authority_kind AND l.revoked_at_ms IS NULL)`;
const LIVE_SQL = `a.coordinator_id = ? AND a.attempt_id = ? AND a.origin = ? AND a.issuer = ?
 AND a.auth_config_revision = ? AND a.created_at_ms <= ? AND a.expires_at_ms > ?
 AND ${UNBOUND_SQL} AND ${UNREVOKED_SQL} AND ${CURRENT_UNLINKED_SQL}`;
// Every enrollment of the device names no Identity or the current one.
const ENROLLMENTS_CURRENT_SQL = `NOT EXISTS (SELECT 1 FROM enrolled_devices e WHERE e.device_id = a.device_id
 AND e.identity_id IS NOT NULL AND e.identity_id <> a.current_identity_id)`;
// The current Identity is one an enrollment names, or the device's default local Identity.
const CURRENT_IS_DEVICES_SQL = `(a.current_identity_id = 'local:' || a.device_id
 OR EXISTS (SELECT 1 FROM enrolled_devices e WHERE e.device_id = a.device_id
 AND e.identity_id = a.current_identity_id))`;
const groupsWithoutAccessSql = (
	target: string,
) => `SELECT coalesce(json_group_array(group_id), '[]') FROM (
 SELECT DISTINCT e.group_id FROM enrolled_devices e WHERE e.device_id = a.device_id
 AND NOT EXISTS (SELECT 1 FROM coordinator_identity_group_grants r WHERE r.coordinator_id = a.coordinator_id
 AND r.identity_id = ${target} AND r.group_id = e.group_id AND r.status = 'active' AND r.revoked_at IS NULL)
 ORDER BY e.group_id)`;
const GROUPS_WITHOUT_ACCESS_SQL = groupsWithoutAccessSql("?");
// The Team effects and enrollments shown in the browser are still the live ones.
const EFFECTS_CURRENT_SQL = `json((${groupsWithoutAccessSql("a.target_identity_id")}))
 = json_extract(a.team_effects_json, '$.groupsWithoutAccess')
 AND (SELECT count(*) FROM enrolled_devices e WHERE e.device_id = a.device_id) = a.enrollment_count`;

interface Ctx<D extends DeviceRebindDeviceDependencies = DeviceRebindDependencies> {
	deps: D;
	c: CoordinatorAuthBrowserConfig;
	scope: BrowserCsrfScope;
}
/** Device steps and their helpers run with either dependency set. */
type DeviceCtx = Ctx<DeviceRebindDeviceDependencies>;

function live(ctx: DeviceCtx, time: number, attemptId: string) {
	const { c, deps } = ctx;
	return [c.coordinatorId, attemptId, deps.publicOrigin, c.issuer, c.revision, time, time];
}

function readAttempt(ctx: DeviceCtx, attemptId: string) {
	return ctx.deps.backend.first<DeviceRebindAttempt>({
		sql: `SELECT * FROM ${ATTEMPT} WHERE coordinator_id = ? AND attempt_id = ?`,
		values: [ctx.c.coordinatorId, attemptId],
	});
}

/** Unexpected errors report an unknown outcome, never a failure. */
function boundary<C extends DeviceCtx, A extends unknown[]>(
	ctx: C,
	step: (ctx: C, ...args: A) => Promise<DeviceRebindResult | null>,
) {
	return async (...args: A): Promise<DeviceRebindResult | null> => {
		try {
			return await step(ctx, ...args);
		} catch {
			return { kind: "unknown" };
		}
	};
}

/**
 * The browser and device ceremony for ADR 0005 Section 8 rebinding. Every
 * step re-checks live authority in its winning statement; pre-reads only pick
 * the refusal reason shown to the person.
 */
export function createDeviceRebindCeremony(deps: DeviceRebindDependencies) {
	const ctx = context(deps);
	return Object.freeze({
		...deviceSteps(ctx),
		claimBrowser: boundary(ctx, claimBrowser),
		verifyCallback: boundary(ctx, verifyCallback),
		confirm: boundary(ctx, confirm),
	});
}

/** The steps a signed device request drives: start, status, and finalize. */
export function createDeviceRebindDeviceSteps(deps: DeviceRebindDeviceDependencies) {
	return Object.freeze(deviceSteps(context(deps)));
}

function context<D extends DeviceRebindDeviceDependencies>(deps: D): Ctx<D> {
	const c = deps.config;
	return { deps, c, scope: Object.freeze({ publicOrigin: deps.publicOrigin, store: c }) };
}

function deviceSteps(ctx: DeviceCtx) {
	return {
		start: boundary(ctx, start),
		finalize: boundary(ctx, finalize),
		status: boundary(ctx, status),
	};
}

async function startRefusal(
	ctx: DeviceCtx,
	input: DeviceRebindStart,
	keyId: string,
): Promise<DeviceRebindRefusal | null> {
	const facts = await ctx.deps.backend.first<{ bound: number; linked: number; enrolled: number }>({
		sql: `SELECT
 EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings WHERE device_id = ? OR key_id = ?) AS bound,
 EXISTS (SELECT 1 FROM coordinator_auth_account_links WHERE coordinator_id = ? AND identity_id = ?
  AND revoked_at_ms IS NULL) AS linked,
 EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
  WHERE e.group_id = ? AND e.device_id = ? AND e.public_key = ? AND e.fingerprint = ? AND e.enabled = 1
  AND g.archived_at IS NULL) AS enrolled`,
		values: [
			input.signer.deviceId,
			keyId,
			ctx.c.coordinatorId,
			input.currentIdentityId,
			input.signer.groupId,
			input.signer.deviceId,
			input.signer.publicKey,
			input.signer.fingerprint,
		],
	});
	if (facts?.enrolled !== 1) return "unavailable";
	if (facts.bound === 1) return "device_already_bound";
	if (facts.linked === 1) return "current_identity_linked";
	return null;
}

async function start(ctx: DeviceCtx, input: DeviceRebindStart, clientKey: string) {
	const limit = ctx.deps.limiter.check(
		JSON.stringify(["device-rebind-start", ctx.c.coordinatorId, clientKey]),
		START_CLIENT_LIMIT,
	);
	if (!limit.allowed) return refused("retry");
	if (
		!isAuthControllerId(input.attemptId) ||
		!isAuthControllerId(input.currentIdentityId) ||
		!/^[0-9a-f]{64}$/.test(input.reviewDigest) ||
		!/^[0-9a-f]{64}$/.test(input.browserStartHash) ||
		!parseCoordinatorAuthLoopback(input.loopbackRedirect).ok
	)
		return refused("unavailable");
	const startHash = input.browserStartHash;
	const keyId = await ed25519KeyId(input.signer.publicKey);
	if (!keyId) return refused("unavailable");
	const reason = await startRefusal(ctx, input, keyId);
	if (reason) return refused(reason);
	const time = ctx.deps.now();
	const s = input.signer;
	const wrote = await ctx.deps.backend.run({
		sql: `INSERT INTO ${ATTEMPT} (coordinator_id, attempt_id, origin, device_id, public_key, key_id,
 fingerprint, current_identity_id, issuer, auth_config_revision, loopback_redirect, browser_start_hash,
 review_digest, state, created_at_ms, expires_at_ms)
 SELECT a.* FROM (SELECT ? AS coordinator_id, ? AS attempt_id, ? AS origin, ? AS device_id,
 ? AS public_key, ? AS key_id, ? AS fingerprint, ? AS current_identity_id, ? AS issuer,
 ? AS auth_config_revision, ? AS loopback_redirect, ? AS browser_start_hash, ? AS review_digest,
 'pending' AS state, ? AS created_at_ms, ? AS expires_at_ms) a
 WHERE EXISTS (SELECT 1 FROM enrolled_devices e JOIN groups g ON g.group_id = e.group_id
  WHERE e.group_id = ? AND e.device_id = a.device_id AND e.public_key = a.public_key
  AND e.fingerprint = a.fingerprint AND e.enabled = 1 AND g.archived_at IS NULL)
 AND ${ENROLLMENTS_CURRENT_SQL} AND ${CURRENT_IS_DEVICES_SQL}
 AND ${UNBOUND_SQL} AND ${UNREVOKED_SQL} AND ${CURRENT_UNLINKED_SQL}
 AND NOT EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts o
  WHERE o.coordinator_id = a.coordinator_id AND o.attempt_id = a.attempt_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts o
  WHERE o.coordinator_id = a.coordinator_id AND o.attempt_id = a.attempt_id)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions o
  WHERE o.coordinator_id = a.coordinator_id AND o.attempt_id = a.attempt_id)
 AND (SELECT count(*) FROM ${ATTEMPT} o WHERE o.coordinator_id = a.coordinator_id AND o.device_id = a.device_id
  AND o.state IN ('pending', 'browser_claimed', 'oidc_verified', 'confirmed') AND o.expires_at_ms > ?) < ?
 AND (SELECT count(*) FROM ${ATTEMPT} o WHERE o.coordinator_id = a.coordinator_id AND o.device_id = a.device_id
  AND o.created_at_ms > ?) < ?`,
		values: [
			ctx.c.coordinatorId,
			input.attemptId,
			ctx.deps.publicOrigin,
			s.deviceId,
			s.publicKey,
			keyId,
			s.fingerprint,
			input.currentIdentityId,
			ctx.c.issuer,
			ctx.c.revision,
			input.loopbackRedirect,
			startHash,
			input.reviewDigest,
			time,
			time + TTL_MS,
			s.groupId,
			time,
			AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
			time - AUTH_LINK_CREATE_WINDOW_MS,
			AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
		],
	});
	if (wrote !== 1) return refused("unavailable");
	return { kind: "started" as const, attemptId: input.attemptId, expiresAtMs: time + TTL_MS };
}

async function claimBrowser(ctx: Ctx, request: Request, clientKey: string) {
	const snapshot = snapshotBrowserRequest(request);
	const transaction = await readBrowserStartTransaction(
		snapshot.cookie,
		new CoordinatorAuthBrowserTransactions(ctx.deps.backend, ctx.deps.now),
		ctx.c,
	);
	if (transaction === "active" || transaction === "invalid") return refused("unavailable");
	const checked = await guardBrowserForm({
		request,
		clientKey,
		action: "link_start",
		scope: ctx.scope,
		csrfKey: ctx.deps.csrfKey,
		limiter: ctx.deps.limiter,
	});
	if (!checked.ok || checked.action !== "link_start") return refused("unavailable");
	const cookie = await readBrowserCookie(snapshot.cookie, "start");
	if (cookie.kind !== "present" || cookie.cookieHash !== checked.cookieHash)
		return refused("unavailable");
	const row = await readAttempt(ctx, checked.attemptId);
	if (
		row?.state !== "pending" ||
		row.expires_at_ms <= ctx.deps.now() ||
		row.browser_start_hash !== (await proofHash(checked.startCode))
	)
		return refused("unavailable");
	const authorization = await ctx.deps.client.createAuthorizationRequest();
	const url = new URL(authorization.authorizationUrl);
	url.searchParams.set("prompt", "select_account");
	const time = ctx.deps.now();
	const transactionHash = await hashCoordinatorAuthProofBytes32(
		globalThis.crypto.getRandomValues(new Uint8Array(32)),
	);
	const stateHash = await sha256Hex(authorization.material.state);
	await ctx.deps.backend.batch(
		claimStatements(ctx, row, authorization.material, {
			time,
			transactionHash,
			stateHash,
			binderHash: checked.cookieHash,
		}),
	);
	const claimed = await readAttempt(ctx, row.attempt_id);
	if (claimed?.state !== "browser_claimed" || claimed.browser_transaction_hash !== transactionHash)
		throw new Error("device_rebind_claim_unconfirmed");
	return {
		kind: "browser_claimed" as const,
		authorizationUrl: url.href,
		setCookies: [reissueStartCookieAsTransaction(cookie.secret), clearBrowserCookie("start")],
	};
}

/** Browser transaction insert and attempt claim; each asserts it changed exactly one row. */
function claimStatements(
	ctx: Ctx,
	row: DeviceRebindAttempt,
	material: { nonce: string; pkceVerifier: string },
	p: { time: number; transactionHash: string; stateHash: string; binderHash: string },
): AuthLinkStatement[] {
	const pending = `${LIVE_SQL} AND a.state = 'pending' AND a.browser_start_hash = ?
 AND a.browser_transaction_hash IS NULL AND a.browser_binder_hash IS NULL`;
	const pendingValues = [...live(ctx, p.time, row.attempt_id), row.browser_start_hash];
	// A standalone INSERT fails the batch when the previous write changed nothing.
	const assertOne = {
		sql: "INSERT INTO coordinator_auth_browser_transactions (purpose) SELECT 'owner_enroll' WHERE changes() <> 1",
		values: [],
	};
	return [
		{
			sql: `INSERT INTO coordinator_auth_browser_transactions (coordinator_id, browser_transaction_hash,
 purpose, attempt_id, state_hash, binder_hash, issuer, auth_config_revision, redirect_uri, state, nonce,
 pkce_verifier, created_at_ms, expires_at_ms)
 SELECT a.coordinator_id, ?, 'owner_enroll', a.attempt_id, ?, ?, a.issuer, a.auth_config_revision, ?,
 'pending', ?, ?, ?, a.expires_at_ms FROM ${ATTEMPT} a WHERE ${pending}`,
			values: [
				p.transactionHash,
				p.stateHash,
				p.binderHash,
				ctx.c.redirectUri,
				material.nonce,
				material.pkceVerifier,
				p.time,
				...pendingValues,
			],
		},
		assertOne,
		{
			sql: `UPDATE ${ATTEMPT} AS a SET state = 'browser_claimed', browser_transaction_hash = ?,
 browser_binder_hash = ? WHERE ${pending}`,
			values: [p.transactionHash, p.binderHash, ...pendingValues],
		},
		assertOne,
	];
}

/** The single OIDC state of a well-formed callback to the configured URL, checked before any burn. */
function callbackState(
	ctx: Ctx,
	snapshot: ReturnType<typeof snapshotBrowserRequest>,
): string | null {
	if (snapshot.method !== "GET" || snapshot.url.length > 8192 || snapshot.url.includes("#"))
		return null;
	const url = new URL(snapshot.url);
	const redirect = new URL(ctx.c.redirectUri);
	if (
		url.origin !== redirect.origin ||
		url.pathname !== redirect.pathname ||
		url.username ||
		url.password
	)
		return null;
	const states = url.searchParams.getAll("state");
	if (states.length !== 1 || !/^[A-Za-z0-9._~-]{43,128}$/.test(states[0] ?? "")) return null;
	return states[0] ?? null;
}

/**
 * Returns null when the callback belongs to another ceremony; the shared OIDC
 * callback then offers it to the next handler. Only this step may fall
 * through: rebind start and confirm forms have their own URLs.
 */
async function verifyCallback(ctx: Ctx, request: Request) {
	const snapshot = snapshotBrowserRequest(request);
	const state = callbackState(ctx, snapshot);
	if (!state) return null;
	const states = [state];
	const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
	if (cookie.kind !== "present") return null;
	const time = ctx.deps.now();
	const txn = await ctx.deps.backend.first<{
		browser_transaction_hash: string;
		attempt_id: string;
		nonce: string;
		pkce_verifier: string;
	}>({
		sql: `SELECT b.* FROM coordinator_auth_browser_transactions b JOIN ${ATTEMPT} a
 ON a.coordinator_id = b.coordinator_id AND a.attempt_id = b.attempt_id
 AND a.browser_transaction_hash = b.browser_transaction_hash AND a.browser_binder_hash = b.binder_hash
 WHERE b.coordinator_id = ? AND b.purpose = 'owner_enroll' AND b.state_hash = ? AND b.binder_hash = ?
 AND b.state = 'pending' AND b.issuer = ? AND b.auth_config_revision = ? AND b.redirect_uri = ?
 AND b.created_at_ms <= ? AND b.expires_at_ms > ? AND a.state = 'browser_claimed'`,
		values: [
			ctx.c.coordinatorId,
			await sha256Hex(states[0] as string),
			cookie.cookieHash,
			ctx.c.issuer,
			ctx.c.revision,
			ctx.c.redirectUri,
			time,
			time,
		],
	});
	if (!txn) return null;
	// Burn the transaction before provider verification, as every other ceremony does.
	const claimToken = globalThis.crypto.randomUUID();
	const burned = await ctx.deps.backend.run({
		sql: `UPDATE coordinator_auth_browser_transactions SET state = 'consumed', consumed_at_ms = ?,
 claim_token = ?, nonce = NULL, pkce_verifier = NULL
 WHERE coordinator_id = ? AND browser_transaction_hash = ? AND state = 'pending'`,
		values: [time, claimToken, ctx.c.coordinatorId, txn.browser_transaction_hash],
	});
	if (burned !== 1) return refused("unavailable");
	const verified = await ctx.deps.client.verifyCallback(
		{
			callbackUrl: snapshot.url,
			material: { state: states[0] as string, nonce: txn.nonce, pkceVerifier: txn.pkce_verifier },
		},
		{ fetchUserInfo: false },
	);
	if (!verified.ok || verified.account.issuer !== ctx.c.issuer) return refused("unavailable");
	const outcome = await persistVerified(ctx, txn.attempt_id, verified.account, claimToken);
	if (outcome.kind !== "verified") return outcome;
	const csrf = await issueBrowserCsrfToken(
		ctx.deps.csrfKey,
		cookie.secret,
		"transaction",
		ctx.scope,
	);
	return { kind: "verified" as const, confirmation: outcome.confirmation, csrf };
}

async function persistVerified(
	ctx: Ctx,
	attemptId: string,
	account: { issuer: string; subject: string },
	claimToken: string,
): Promise<DeviceRebindResult> {
	const row = await readAttempt(ctx, attemptId);
	const link = await ctx.deps.backend.first<{
		link_id: string;
		identity_id: string;
		authority_kind: "controller_attestation" | "device_claim";
	}>({
		sql: `SELECT link_id, identity_id, authority_kind FROM coordinator_auth_account_links
 WHERE coordinator_id = ? AND issuer = ? AND subject = ? AND revoked_at_ms IS NULL`,
		values: [ctx.c.coordinatorId, account.issuer, account.subject],
	});
	if (!row) return refused("unavailable");
	if (!link) return refused("account_not_linked");
	if (link.identity_id === row.current_identity_id) return refused("already_this_identity");
	const time = ctx.deps.now();
	const wrote = await ctx.deps.backend.run({
		sql: `UPDATE ${ATTEMPT} AS a SET state = 'oidc_verified', account_subject = ?, target_identity_id = ?,
 link_id = ?, link_authority_kind = ?,
 enrollment_count = (SELECT count(*) FROM enrolled_devices e WHERE e.device_id = a.device_id),
 team_effects_json = json_object('groupsWithoutAccess', json((${GROUPS_WITHOUT_ACCESS_SQL})))
 WHERE ${LIVE_SQL} AND a.state = 'browser_claimed' AND ${ENROLLMENTS_CURRENT_SQL}
 AND (SELECT count(*) FROM enrolled_devices e WHERE e.device_id = a.device_id) BETWEEN 1 AND 50
 AND EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id = a.coordinator_id
  AND l.link_id = ? AND l.identity_id = ? AND l.issuer = a.issuer AND l.subject = ? AND l.revoked_at_ms IS NULL)
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE b.coordinator_id = a.coordinator_id
  AND b.browser_transaction_hash = a.browser_transaction_hash AND b.state = 'consumed' AND b.claim_token = ?)`,
		values: [
			account.subject,
			link.identity_id,
			link.link_id,
			link.authority_kind,
			link.identity_id,
			...live(ctx, time, attemptId),
			link.link_id,
			link.identity_id,
			account.subject,
			claimToken,
		],
	});
	if (wrote !== 1) return refused(await currentRefusal(ctx, row));
	const verified = await readAttempt(ctx, attemptId);
	if (verified?.state !== "oidc_verified" || verified.link_id !== link.link_id)
		throw new Error("device_rebind_verify_unconfirmed");
	return { kind: "verified", confirmation: await confirmationView(verified), csrf: "" };
}

/** Explains why a guarded write matched nothing; never authorizes anything. */
async function currentRefusal(
	ctx: DeviceCtx,
	row: DeviceRebindAttempt,
): Promise<DeviceRebindRefusal> {
	const facts = await ctx.deps.backend.first<{ bound: number; linked: number }>({
		sql: `SELECT
 EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings WHERE device_id = ? OR key_id = ?) AS bound,
 EXISTS (SELECT 1 FROM coordinator_auth_account_links WHERE coordinator_id = ? AND identity_id = ?
  AND revoked_at_ms IS NULL) AS linked`,
		values: [row.device_id, row.key_id, ctx.c.coordinatorId, row.current_identity_id],
	});
	if (facts?.bound === 1) return "device_already_bound";
	if (facts?.linked === 1) return "current_identity_linked";
	return "unavailable";
}

async function confirmationView(row: DeviceRebindAttempt): Promise<DeviceRebindConfirmation> {
	const effects = JSON.parse(row.team_effects_json ?? "null") as {
		groupsWithoutAccess?: unknown;
	};
	const groups = Array.isArray(effects?.groupsWithoutAccess) ? effects.groupsWithoutAccess : null;
	if (!groups?.every((group) => typeof group === "string") || !row.account_subject)
		throw new Error("device_rebind_confirmation_invalid");
	return Object.freeze({
		attemptId: row.attempt_id,
		deviceId: row.device_id,
		fingerprint: row.fingerprint,
		issuer: row.issuer,
		subject: row.account_subject,
		currentIdentityId: row.current_identity_id,
		targetIdentityId: row.target_identity_id as string,
		groupsWithoutAccess: Object.freeze([...groups]),
		// confirm(ctx, ) persists this exact commitment with the completion-secret hash.
		confirmationHash: await deviceRebindConfirmationHash(row),
	});
}

async function confirm(ctx: Ctx, request: Request, clientKey: string, commitment: string) {
	const snapshot = snapshotBrowserRequest(request);
	const checked = await guardBrowserForm({
		request,
		clientKey,
		action: "transaction_attempt",
		scope: ctx.scope,
		csrfKey: ctx.deps.csrfKey,
		limiter: ctx.deps.limiter,
	});
	if (!checked.ok || checked.action !== "transaction_attempt") return refused("unavailable");
	const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
	if (cookie.kind !== "present" || cookie.cookieHash !== checked.cookieHash)
		return refused("unavailable");
	const row = await readAttempt(ctx, checked.attemptId);
	if (row?.state !== "oidc_verified" || row.browser_binder_hash !== cookie.cookieHash)
		return refused("unavailable");
	const view = await confirmationView(row);
	if (commitment !== view.confirmationHash || !row.loopback_redirect) return refused("unavailable");
	const completionSecret = mintCompletionSecret();
	const time = ctx.deps.now();
	const wrote = await ctx.deps.backend.run({
		sql: `UPDATE ${ATTEMPT} AS a SET state = 'confirmed', confirmation_hash = ?, completion_secret_hash = ?
 WHERE ${LIVE_SQL} AND a.state = 'oidc_verified' AND a.browser_binder_hash = ?
 AND a.account_subject = ? AND a.target_identity_id = ? AND a.link_id = ? AND a.team_effects_json = ?
 AND a.enrollment_count = ? AND ${TARGET_LINK_SQL} AND ${ENROLLMENTS_CURRENT_SQL}
 AND ${EFFECTS_CURRENT_SQL}
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE b.coordinator_id = a.coordinator_id
  AND b.browser_transaction_hash = a.browser_transaction_hash AND b.state = 'consumed')`,
		values: [
			view.confirmationHash,
			await proofHash(completionSecret),
			...live(ctx, time, row.attempt_id),
			cookie.cookieHash,
			row.account_subject,
			row.target_identity_id,
			row.link_id,
			row.team_effects_json,
			row.enrollment_count,
		],
	});
	if (wrote !== 1) return refused(await currentRefusal(ctx, row));
	return {
		kind: "confirmed" as const,
		completionSecret,
		loopbackRedirect: row.loopback_redirect,
	};
}

async function finalize(
	ctx: DeviceCtx,
	input: {
		attemptId: string;
		signer: DeviceRebindSigner;
		completionSecret: string;
		signature: string;
	},
): Promise<DeviceRebindResult> {
	const row = await readAttempt(ctx, input.attemptId);
	if (!row || !sameDevice(row, input.signer)) return refused("unavailable");
	const result = await commitDeviceRebind({
		backend: ctx.deps.backend,
		coordinatorId: ctx.c.coordinatorId,
		attemptId: input.attemptId,
		revision: ctx.c.revision,
		now: ctx.deps.now(),
		completionSecret: input.completionSecret,
		signature: input.signature,
	});
	if (result.kind === "committed") return { kind: "finalized", receipt: result.receipt };
	if (result.kind === "prior_commit") return { kind: "prior_commit", receipt: result.receipt };
	return refused(await finalizeRefusal(ctx, input, row));
}

/**
 * A refused commit is retryable only when its proofs are valid, the attempt is
 * still confirmed, and the target has not reached its daily limit: then a
 * concurrent enrollment change elsewhere made the pinned scan refuse.
 */
async function finalizeRefusal(
	ctx: DeviceCtx,
	input: { attemptId: string; completionSecret: string; signature: string },
	row: DeviceRebindAttempt,
): Promise<DeviceRebindRefusal> {
	const after = await readAttempt(ctx, input.attemptId);
	const now = ctx.deps.now();
	if (after?.state !== "confirmed" || after.expires_at_ms <= now) return currentRefusal(ctx, row);
	const proof = await verifyDeviceRebindCompletion(after, {
		revision: ctx.c.revision,
		now,
		completionSecret: input.completionSecret,
		signature: input.signature,
	});
	if (!proof) return "unavailable";
	const recent = await ctx.deps.backend.first<{ n: number }>({
		sql: `SELECT count(*) AS n FROM coordinator_device_rebind_audit_log
 WHERE coordinator_id = ? AND target_identity_id = ? AND created_at_ms > ?`,
		values: [ctx.c.coordinatorId, after.target_identity_id, now - 86_400_000],
	});
	if ((recent?.n ?? 0) >= DEVICE_REBIND_DAILY_LIMIT) return "daily_limit";
	const reason = await currentRefusal(ctx, row);
	if (reason !== "unavailable") return reason;
	return pinnedFactsHold(ctx, after);
}

/** The attempt pins its link and enrollments; once those change, retrying cannot succeed. */
async function pinnedFactsHold(
	ctx: DeviceCtx,
	a: DeviceRebindAttempt,
): Promise<DeviceRebindRefusal> {
	const facts = await ctx.deps.backend.first<{ linked: number; enrollments: number }>({
		sql: `SELECT ${TARGET_LINK_SQL} AS linked,
 ((SELECT count(*) FROM enrolled_devices e WHERE e.device_id = a.device_id) = a.enrollment_count
 AND ${ENROLLMENTS_CURRENT_SQL}) AS enrollments
 FROM ${ATTEMPT} a WHERE a.coordinator_id = ? AND a.attempt_id = ?`,
		values: [ctx.c.coordinatorId, a.attempt_id],
	});
	if (facts?.linked !== 1) return "account_not_linked";
	if (facts.enrollments !== 1) return "unavailable";
	return "retry";
}

/** Signed read by the attempt's own device; resolves unknown outcomes without writing. */
async function status(ctx: DeviceCtx, input: { attemptId: string; signer: DeviceRebindSigner }) {
	const row = await readAttempt(ctx, input.attemptId);
	if (!row || !sameDevice(row, input.signer)) return refused("unavailable");
	return {
		kind: "status" as const,
		state: row.state,
		expiresAtMs: row.expires_at_ms,
		targetIdentityId: ["confirmed", "finalized"].includes(row.state)
			? row.target_identity_id
			: null,
		receipt:
			row.state === "finalized"
				? await readDeviceRebindReceipt(ctx.deps.backend, ctx.c.coordinatorId, row.attempt_id)
				: null,
	};
}

function sameDevice(row: DeviceRebindAttempt, signer: DeviceRebindSigner): boolean {
	return (
		row.device_id === signer.deviceId &&
		row.public_key === signer.publicKey &&
		row.fingerprint === signer.fingerprint
	);
}
