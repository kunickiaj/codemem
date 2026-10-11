import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	type AuthLinkBackend,
	type AuthLinkStatement,
	authLinkNow,
} from "./coordinator-auth-link.js";
import {
	AUTH_LINK_CREATE_WINDOW_MS,
	AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
	AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
	AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
} from "./coordinator-auth-link-contract.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { captureCoordinatorBrowserAuthConfig } from "./coordinator-browser-auth-config.js";
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
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import { ownerExcludedLegacyDecisionSql } from "./coordinator-owner-enrollment-commit.js";
import {
	type OwnerAttempt,
	readGrantPins,
	validAttemptTime,
	verifyOwnerEnrollmentSignature,
} from "./coordinator-owner-enrollment-proof.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export interface OwnerEnrollmentStart {
	attemptId: string;
	deviceId: string;
	publicKey: string;
	loopbackRedirect: string;
	browserStartCode: string;
	signature: string;
}
export type OwnerEnrollmentStartResult =
	| { kind: "rejected"; error: "owner_enrollment_unavailable" | "owner_enrollment_unknown" }
	| { kind: "started"; attemptId: string; expiresAtMs: number }
	| { kind: "browser_claimed"; authorizationUrl: string; setCookies: string[] }
	| { kind: "verified"; confirmation: OwnerEnrollmentConfirmation; csrf: string };
interface OwnerEnrollmentConfirmation {
	attemptId: string;
	coordinatorId: string;
	origin: string;
	deviceId: string;
	publicKey: string;
	keyId: string;
	fingerprint: string;
	issuer: string;
	subject: string;
	identityId: string;
	linkId: string;
	revision: string;
	confirmationHash: string;
}
type StartPin = { coordinatorId: string; origin: string; issuer: string; revision: string };
interface OwnerEnrollmentComposition {
	purpose: "owner_enroll";
	mode: "local_test";
	config: unknown;
	backend: AuthLinkBackend;
	csrfKey: BrowserCsrfKey;
	limiter: InMemoryRequestRateLimiter;
	oidcOptions: CoordinatorOidcOptions;
	clock?: () => number;
}
type Context = {
	backend: AuthLinkBackend;
	c: CoordinatorAuthBrowserConfig;
	pin: StartPin;
	csrfKey: BrowserCsrfKey;
	scope: BrowserCsrfScope;
	limiter: InMemoryRequestRateLimiter;
	client: CoordinatorOidcClient;
	now: () => number;
};
const unavailable: OwnerEnrollmentStartResult = Object.freeze({
	kind: "rejected",
	error: "owner_enrollment_unavailable",
});
function own(value: unknown, name: string): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error();
	return descriptor.value;
}
function text(value: unknown, maximum: number): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > maximum ||
		/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	)
		throw new Error();
	return value;
}
function id(value: unknown): string {
	if (!isAuthControllerId(value)) throw new Error();
	return value;
}
function captureStart(value: unknown): OwnerEnrollmentStart {
	return Object.freeze({
		attemptId: id(own(value, "attemptId")),
		deviceId: id(own(value, "deviceId")),
		publicKey: text(own(value, "publicKey"), 4096),
		loopbackRedirect: text(own(value, "loopbackRedirect"), 4096),
		browserStartCode: text(own(value, "browserStartCode"), 43),
		signature: text(own(value, "signature"), 86),
	});
}
export async function ownerEnrollmentHash(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
async function proofHash(value: string): Promise<string> {
	const bytes = decodeCoordinatorAuthProof32(value);
	if (!bytes) throw new Error();
	return hashCoordinatorAuthProofBytes32(bytes);
}
/** Pending-key proof only; no account or ownership authority. */
export function ownerEnrollmentStartMessage(input: OwnerEnrollmentStart, config: StartPin): string {
	return JSON.stringify([
		"codemem-owner-enrollment-start-v1",
		"owner_enroll",
		config.coordinatorId,
		config.origin,
		config.issuer,
		config.revision,
		input.attemptId,
		input.deviceId,
		input.publicKey,
		input.loopbackRedirect,
		input.browserStartCode,
	]);
}
async function boundary(
	action: () => Promise<OwnerEnrollmentStartResult>,
): Promise<OwnerEnrollmentStartResult> {
	try {
		return await action();
	} catch {
		return { kind: "rejected", error: "owner_enrollment_unknown" };
	}
}

/** Private, unmounted local-test composition. Config and transport belong to the server.
 * Native SQLite atomic batch semantics and schema constraints are required; errors
 * report unknown, never a claim that an attempted commit made no changes.
 */
export async function createCoordinatorOwnerEnrollment(input: OwnerEnrollmentComposition) {
	try {
		if (own(input, "purpose") !== "owner_enroll" || own(input, "mode") !== "local_test")
			return { ok: false as const };
		const settings = captureCoordinatorBrowserAuthConfig(own(input, "config"));
		if (settings.kind !== "enabled") return { ok: false as const };
		const options = own(input, "oidcOptions") as CoordinatorOidcOptions;
		const fetch = own(options, "fetch");
		if (typeof fetch !== "function") return { ok: false as const };
		const backend = own(input, "backend") as AuthLinkBackend;
		if (
			!backend ||
			![backend.first, backend.run, backend.batch].every((f) => typeof f === "function")
		)
			return { ok: false as const };
		const oidc = await createCoordinatorOidcClient(settings.oidc, {
			fetch: fetch as NonNullable<CoordinatorOidcOptions["fetch"]>,
			timeoutSeconds: options.timeoutSeconds,
		});
		if (!oidc.ok) return { ok: false as const };
		const c = settings.store;
		const clock = input.clock ?? Date.now;
		const context: Context = {
			backend,
			c,
			client: oidc.client,
			now: () => authLinkNow(clock),
			pin: Object.freeze({
				coordinatorId: c.coordinatorId,
				origin: settings.publicOrigin,
				issuer: c.issuer,
				revision: c.revision,
			}),
			scope: Object.freeze({ publicOrigin: settings.publicOrigin, store: c }),
			csrfKey: own(input, "csrfKey") as BrowserCsrfKey,
			limiter: own(input, "limiter") as InMemoryRequestRateLimiter,
		};
		return {
			ok: true as const,
			enrollment: Object.freeze({
				start: (value: OwnerEnrollmentStart) => boundary(() => start(context, value)),
				claimBrowser: (request: Request, clientKey: string) =>
					boundary(() => claimBrowser(context, request, clientKey)),
				verifyCallback: (request: Request) => boundary(() => verifyCallback(context, request)),
			}),
		};
	} catch {
		return { ok: false as const };
	}
}

interface OwnerBrowserTransaction {
	browser_transaction_hash: string;
	attempt_id: string;
	state_hash: string;
	binder_hash: string;
	nonce: string;
	pkce_verifier: string;
	created_at_ms: number;
	expires_at_ms: number;
}
interface ConsumedOwnerBrowser {
	txn: OwnerBrowserTransaction;
	row: OwnerAttempt;
	claimToken: string;
}
async function verifyCallback(
	context: Context,
	request: Request,
): Promise<OwnerEnrollmentStartResult> {
	const snapshot = snapshotBrowserRequest(request);
	if (snapshot.method !== "GET" || snapshot.url.length > 8192 || snapshot.url.includes("#"))
		return unavailable;
	const url = new URL(snapshot.url);
	const redirect = new URL(context.c.redirectUri);
	const states = url.searchParams.getAll("state");
	if (
		url.origin !== redirect.origin ||
		url.pathname !== redirect.pathname ||
		url.username ||
		url.password ||
		states.length !== 1 ||
		!/^[A-Za-z0-9._~-]{43,128}$/.test(states[0] ?? "")
	)
		return unavailable;
	const state = states[0] as string;
	const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
	if (cookie.kind !== "present") return unavailable;
	const consumed = await consumeOwnerBrowser(context, state, cookie.cookieHash);
	if (!consumed) return unavailable;
	// Capture the original material before burning it; the maintained client verifies
	// ID-token signatures, issuer, nonce and PKCE. No browser session supplies identity.
	const verified = await context.client.verifyCallback(
		{
			callbackUrl: snapshot.url,
			material: { state, nonce: consumed.txn.nonce, pkceVerifier: consumed.txn.pkce_verifier },
		},
		{ fetchUserInfo: false },
	);
	if (!verified.ok || verified.account.issuer !== context.c.issuer) return unavailable;
	const row = await persistVerified(context, consumed, verified.account);
	if (!row) return unavailable;
	const confirmation = await confirmationView(row);
	const csrf = await issueBrowserCsrfToken(
		context.csrfKey,
		cookie.secret,
		"transaction",
		context.scope,
	);
	return { kind: "verified", confirmation, csrf };
}
const CALLBACK_ATTEMPT_SQL = `a.coordinator_id = ? AND a.attempt_id = ? AND a.purpose = 'owner_enroll'
 AND a.state = 'browser_claimed' AND a.origin = ? AND a.issuer = ? AND a.auth_config_revision = ?
 AND a.browser_transaction_hash = ? AND a.browser_binder_hash = ?
 AND a.device_id = ? AND a.public_key = ? AND a.key_id = ? AND a.fingerprint = ?
 AND a.browser_start_hash = ? AND a.loopback_redirect = ? AND a.created_at_ms = ? AND a.expires_at_ms = ?
 AND a.created_at_ms <= ? AND a.expires_at_ms > ?`;
function callbackAttemptValues(
	context: Context,
	a: OwnerAttempt,
	time: number,
): AuthLinkStatement["values"] {
	return [
		context.c.coordinatorId,
		a.attempt_id,
		context.pin.origin,
		context.c.issuer,
		context.c.revision,
		a.browser_transaction_hash,
		a.browser_binder_hash,
		a.device_id,
		a.public_key,
		a.key_id,
		a.fingerprint,
		a.browser_start_hash,
		a.loopback_redirect,
		a.created_at_ms,
		a.expires_at_ms,
		time,
		time,
	];
}
const CALLBACK_TXN_SQL = `b.coordinator_id = ? AND b.browser_transaction_hash = ? AND b.purpose = 'owner_enroll'
 AND b.attempt_id = ? AND b.state_hash = ? AND b.binder_hash = ? AND b.issuer = ?
 AND b.auth_config_revision = ? AND b.redirect_uri = ? AND b.created_at_ms = ? AND b.expires_at_ms = ?
 AND b.created_at_ms <= ? AND b.expires_at_ms > ?`;
function callbackTxnValues(
	context: Context,
	b: OwnerBrowserTransaction,
	time: number,
): AuthLinkStatement["values"] {
	return [
		context.c.coordinatorId,
		b.browser_transaction_hash,
		b.attempt_id,
		b.state_hash,
		b.binder_hash,
		context.c.issuer,
		context.c.revision,
		context.c.redirectUri,
		b.created_at_ms,
		b.expires_at_ms,
		time,
		time,
	];
}
async function consumeOwnerBrowser(
	context: Context,
	state: string,
	binderHash: string,
): Promise<ConsumedOwnerBrowser | null> {
	const time = context.now();
	const txn = await context.backend.first<OwnerBrowserTransaction>({
		sql: `SELECT * FROM coordinator_auth_browser_transactions WHERE coordinator_id = ?
 AND purpose = 'owner_enroll' AND state_hash = ? AND binder_hash = ? AND state = 'pending'
 AND issuer = ? AND auth_config_revision = ? AND redirect_uri = ? AND created_at_ms <= ? AND expires_at_ms > ?`,
		values: [
			context.c.coordinatorId,
			await ownerEnrollmentHash(state),
			binderHash,
			context.c.issuer,
			context.c.revision,
			context.c.redirectUri,
			time,
			time,
		],
	});
	if (!txn) return null;
	const row = await readAttempt(context, txn.attempt_id);
	if (
		!live(context, row, time) ||
		row.state !== "browser_claimed" ||
		row.browser_transaction_hash !== txn.browser_transaction_hash ||
		row.browser_binder_hash !== binderHash ||
		row.expires_at_ms !== txn.expires_at_ms ||
		txn.created_at_ms < row.created_at_ms
	)
		return null;
	const claimToken = globalThis.crypto.randomUUID();
	const burnTime = context.now();
	const wrote = await context.backend.run({
		sql: `UPDATE coordinator_auth_browser_transactions AS b SET state = 'consumed',claim_token = ?,
 consumed_at_ms = ?,nonce = NULL,pkce_verifier = NULL WHERE ${CALLBACK_TXN_SQL}
 AND b.state = 'pending' AND b.nonce = ? AND b.pkce_verifier = ?
 AND EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE ${CALLBACK_ATTEMPT_SQL})`,
		values: [
			claimToken,
			burnTime,
			...callbackTxnValues(context, txn, burnTime),
			txn.nonce,
			txn.pkce_verifier,
			...callbackAttemptValues(context, row, burnTime),
		],
	});
	return wrote === 1 ? { txn, row, claimToken } : null;
}
interface OwnerAccountLink {
	link_id: string;
	identity_id: string;
	attempt_id: string;
	controller_attestation_id: string;
	auth_config_revision: string;
	created_at_ms: number;
}
// Filter each Team before pinning; the winning update repeats this exact snapshot.
const CALLBACK_GRANTS_SQL = `SELECT json_group_array(json_object('groupId',groupId,'revision',revision)) FROM
 (SELECT r.group_id AS groupId,r.revision AS revision FROM coordinator_identity_group_grants r
 JOIN groups g ON g.group_id = r.group_id WHERE r.coordinator_id = a.coordinator_id AND r.identity_id = ?
 AND r.status = 'active' AND r.revoked_at IS NULL AND g.archived_at IS NULL
 AND NOT ${ownerExcludedLegacyDecisionSql("r.group_id")} ORDER BY r.group_id LIMIT 51)`;
async function persistVerified(
	context: Context,
	consumed: ConsumedOwnerBrowser,
	account: { issuer: string; subject: string },
): Promise<OwnerAttempt | null> {
	const link = await context.backend.first<OwnerAccountLink>({
		sql: `SELECT * FROM coordinator_auth_account_links WHERE coordinator_id = ? AND issuer = ? AND subject = ? AND revoked_at_ms IS NULL`,
		values: [context.c.coordinatorId, account.issuer, account.subject],
	});
	if (!link) return null;
	const grants = await context.backend.first<{ rows: string }>({
		sql: `SELECT (${CALLBACK_GRANTS_SQL}) AS rows FROM coordinator_owner_enrollment_attempts a
 WHERE ${CALLBACK_ATTEMPT_SQL}`,
		values: [link.identity_id, ...callbackAttemptValues(context, consumed.row, context.now())],
	});
	if (!grants || !readGrantPins(grants.rows)) return null;
	const time = context.now();
	const wrote = await context.backend.run(
		verifiedStatement(context, consumed, account, link, grants.rows, time),
	);
	if (wrote !== 1) return null;
	const row = await readAttempt(context, consumed.row.attempt_id);
	// A missing or changed post-write read is unknown, not evidence the write failed.
	if (
		row?.state !== "oidc_verified" ||
		row.link_id !== link.link_id ||
		row.account_subject !== account.subject ||
		row.grant_revisions_json !== grants.rows ||
		row.browser_transaction_hash !== consumed.txn.browser_transaction_hash ||
		row.browser_binder_hash !== consumed.txn.binder_hash
	)
		throw new Error();
	return row;
}
function verifiedStatement(
	context: Context,
	consumed: ConsumedOwnerBrowser,
	account: { issuer: string; subject: string },
	link: OwnerAccountLink,
	grants: string,
	time: number,
): AuthLinkStatement {
	return {
		sql: `UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'oidc_verified',
 account_subject = ?,identity_id = ?,link_id = ?,link_attempt_id = ?,link_controller_attestation_id = ?,
 link_auth_config_revision = ?,grant_revisions_json = ? WHERE ${CALLBACK_ATTEMPT_SQL}
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE ${CALLBACK_TXN_SQL}
 AND b.state = 'consumed' AND b.claim_token = ? AND b.nonce IS NULL AND b.pkce_verifier IS NULL)
 AND EXISTS (SELECT 1 FROM coordinator_auth_account_links l WHERE l.coordinator_id = a.coordinator_id
 AND l.link_id = ? AND l.issuer = a.issuer AND l.subject = ? AND l.identity_id = ? AND l.attempt_id = ?
 AND l.controller_attestation_id = ? AND l.auth_config_revision = ? AND l.created_at_ms = ? AND l.revoked_at_ms IS NULL)
 AND (${CALLBACK_GRANTS_SQL}) = ?
 AND ${NO_COLLISION_SQL}`,
		values: [
			account.subject,
			link.identity_id,
			link.link_id,
			link.attempt_id,
			link.controller_attestation_id,
			link.auth_config_revision,
			grants,
			...callbackAttemptValues(context, consumed.row, time),
			...callbackTxnValues(context, consumed.txn, time),
			consumed.claimToken,
			link.link_id,
			account.subject,
			link.identity_id,
			link.attempt_id,
			link.controller_attestation_id,
			link.auth_config_revision,
			link.created_at_ms,
			link.identity_id,
			grants,
			consumed.row.device_id,
			consumed.row.key_id,
			consumed.row.device_id,
			consumed.row.key_id,
		],
	};
}
async function confirmationView(row: OwnerAttempt): Promise<OwnerEnrollmentConfirmation> {
	if (!row.account_subject || !row.identity_id || !row.link_id) throw new Error();
	// Display commitment only: do not persist a confirmation or completion secret yet.
	const confirmationHash = await ownerEnrollmentHash(
		JSON.stringify([
			"owner_enroll",
			row.coordinator_id,
			row.attempt_id,
			row.origin,
			row.device_id,
			row.public_key,
			row.key_id,
			row.fingerprint,
			row.issuer,
			row.account_subject,
			row.identity_id,
			row.link_id,
			row.link_attempt_id,
			row.link_controller_attestation_id,
			row.link_auth_config_revision,
			row.auth_config_revision,
			row.browser_start_hash,
			row.browser_transaction_hash,
			row.browser_binder_hash,
			row.grant_revisions_json,
			row.created_at_ms,
			row.expires_at_ms,
		]),
	);
	return Object.freeze({
		attemptId: row.attempt_id,
		coordinatorId: row.coordinator_id,
		origin: row.origin,
		deviceId: row.device_id,
		publicKey: row.public_key,
		keyId: row.key_id,
		fingerprint: row.fingerprint,
		issuer: row.issuer,
		subject: row.account_subject,
		identityId: row.identity_id,
		linkId: row.link_id,
		revision: row.auth_config_revision,
		confirmationHash,
	});
}
const NO_COLLISION_SQL = `NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings WHERE device_id = ? OR key_id = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations WHERE (subject_kind = 'device_id' AND subject_value = ?)
 OR (subject_kind = 'ed25519_key' AND subject_value = ?))`;
async function start(
	context: Context,
	value: OwnerEnrollmentStart,
): Promise<OwnerEnrollmentStartResult> {
	let i: OwnerEnrollmentStart;
	let browserStartHash: string;
	try {
		i = captureStart(value);
		browserStartHash = await proofHash(i.browserStartCode);
	} catch {
		return unavailable;
	}
	if (!parseCoordinatorAuthLoopback(i.loopbackRedirect).ok) return unavailable;
	const keyId = await ed25519KeyId(i.publicKey);
	if (
		!keyId ||
		!(await verifyOwnerEnrollmentSignature(
			i.publicKey,
			ownerEnrollmentStartMessage(i, context.pin),
			i.signature,
		))
	)
		return unavailable;
	const fingerprint = await ownerEnrollmentHash(i.publicKey);
	const time = context.now();
	const wrote = await context.backend.run(
		startStatement(context, i, { keyId, fingerprint, browserStartHash, time }),
	);
	if (wrote !== 1) return unavailable;
	return { kind: "started", attemptId: i.attemptId, expiresAtMs: time + 600000 };
}
function startStatement(
	context: Context,
	i: OwnerEnrollmentStart,
	p: { keyId: string; fingerprint: string; browserStartHash: string; time: number },
): AuthLinkStatement {
	const { c, pin } = context;
	return {
		sql: `INSERT INTO coordinator_owner_enrollment_attempts
 (coordinator_id,attempt_id,purpose,origin,device_id,public_key,key_id,fingerprint,issuer,auth_config_revision,
 loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms)
 SELECT ?,?,'owner_enroll',?,?,?,?,?,?,?,?,?,'pending',?,?
 WHERE ${NO_COLLISION_SQL}
 AND (SELECT count(*) FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND device_id = ?
 AND state IN ('pending','browser_claimed','oidc_verified','confirmed') AND expires_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND device_id = ? AND created_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND state <> 'finalized') < ?`,
		values: [
			c.coordinatorId,
			i.attemptId,
			pin.origin,
			i.deviceId,
			i.publicKey,
			p.keyId,
			p.fingerprint,
			c.issuer,
			c.revision,
			i.loopbackRedirect,
			p.browserStartHash,
			p.time,
			p.time + 600000,
			i.deviceId,
			p.keyId,
			i.deviceId,
			p.keyId,
			c.coordinatorId,
			i.deviceId,
			p.time,
			AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
			c.coordinatorId,
			i.deviceId,
			p.time - AUTH_LINK_CREATE_WINDOW_MS,
			AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
			c.coordinatorId,
			AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
		],
	};
}
async function readAttempt(context: Context, attemptId: string): Promise<OwnerAttempt | null> {
	return context.backend.first<OwnerAttempt>({
		sql: "SELECT * FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND attempt_id = ?",
		values: [context.c.coordinatorId, attemptId],
	});
}
function live(context: Context, row: OwnerAttempt | null, time: number): row is OwnerAttempt {
	return (
		!!row &&
		row.coordinator_id === context.c.coordinatorId &&
		row.purpose === "owner_enroll" &&
		row.origin === context.pin.origin &&
		row.issuer === context.c.issuer &&
		row.auth_config_revision === context.c.revision &&
		validAttemptTime(row) &&
		row.created_at_ms <= time &&
		row.expires_at_ms > time
	);
}
async function claimBrowser(
	context: Context,
	request: Request,
	clientKey: string,
): Promise<OwnerEnrollmentStartResult> {
	const snapshot = snapshotBrowserRequest(request);
	const transaction = await readBrowserCookie(snapshot.cookie, "transaction");
	if (transaction.kind !== "absent") return unavailable;
	const checked = await guardBrowserForm({
		request,
		clientKey,
		action: "link_start",
		scope: context.scope,
		csrfKey: context.csrfKey,
		limiter: context.limiter,
	});
	if (!checked.ok || checked.action !== "link_start") return unavailable;
	const cookie = await readBrowserCookie(snapshot.cookie, "start");
	if (cookie.kind !== "present" || cookie.cookieHash !== checked.cookieHash) return unavailable;
	const row = await readAttempt(context, checked.attemptId);
	const startHash = await proofHash(checked.startCode);
	if (
		!live(context, row, context.now()) ||
		row.state !== "pending" ||
		row.browser_start_hash !== startHash
	)
		return unavailable;
	const authorization = await context.client.createAuthorizationRequest();
	const authorizationUrl = new URL(authorization.authorizationUrl);
	authorizationUrl.searchParams.set("prompt", "select_account");
	const time = context.now();
	if (!live(context, row, time)) return unavailable;
	const hash = await hashCoordinatorAuthProofBytes32(
		globalThis.crypto.getRandomValues(new Uint8Array(32)),
	);
	const stateHash = await ownerEnrollmentHash(authorization.material.state);
	const setCookies = [reissueStartCookieAsTransaction(cookie.secret), clearBrowserCookie("start")];
	await context.backend.batch(
		claimStatements(context, row, authorization, {
			time,
			hash,
			stateHash,
			binder: checked.cookieHash,
		}),
	);
	const claimed = await readAttempt(context, row.attempt_id);
	if (
		claimed?.state !== "browser_claimed" ||
		claimed.browser_transaction_hash !== hash ||
		claimed.browser_binder_hash !== checked.cookieHash
	) {
		throw new Error();
	}
	return { kind: "browser_claimed", authorizationUrl: authorizationUrl.href, setCookies };
}
// A standalone INSERT must fail even if the raced attempt was deleted. UPDATE-based
// assertions could affect zero rows and silently leave an orphan transaction.
function assertOneWrite(): AuthLinkStatement {
	return {
		sql: "INSERT INTO coordinator_auth_browser_transactions (purpose) SELECT 'owner_enroll' WHERE changes() <> 1",
		values: [],
	};
}
type ClaimPin = { time: number; hash: string; stateHash: string; binder: string };
function claimStatements(
	context: Context,
	row: OwnerAttempt,
	authorization: Awaited<ReturnType<CoordinatorOidcClient["createAuthorizationRequest"]>>,
	p: ClaimPin,
): AuthLinkStatement[] {
	return [
		insertBrowser(context, row, authorization, p),
		assertOneWrite(),
		updateAttempt(context, row, authorization, p),
		assertOneWrite(),
	];
}
const PENDING_SQL = `coordinator_id = ? AND attempt_id = ? AND purpose = 'owner_enroll' AND state = 'pending'
 AND origin = ? AND issuer = ? AND auth_config_revision = ? AND browser_start_hash = ?
 AND created_at_ms = ? AND expires_at_ms = ? AND created_at_ms <= ? AND expires_at_ms > ?
 AND browser_transaction_hash IS NULL AND browser_binder_hash IS NULL`;
function pendingValues(
	context: Context,
	row: OwnerAttempt,
	p: ClaimPin,
): (string | number | null)[] {
	return [
		context.c.coordinatorId,
		row.attempt_id,
		context.pin.origin,
		context.c.issuer,
		context.c.revision,
		row.browser_start_hash,
		row.created_at_ms,
		row.expires_at_ms,
		p.time,
		p.time,
	];
}
function insertBrowser(
	context: Context,
	row: OwnerAttempt,
	authorization: Awaited<ReturnType<CoordinatorOidcClient["createAuthorizationRequest"]>>,
	p: ClaimPin,
): AuthLinkStatement {
	return {
		sql: `INSERT INTO coordinator_auth_browser_transactions
 (coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,issuer,auth_config_revision,redirect_uri,
 state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
 SELECT coordinator_id,?,'owner_enroll',attempt_id,?,?,issuer,auth_config_revision,?,'pending',?,?,?,expires_at_ms
 FROM coordinator_owner_enrollment_attempts WHERE ${PENDING_SQL} AND ${NO_COLLISION_SQL}`,
		values: [
			p.hash,
			p.stateHash,
			p.binder,
			context.c.redirectUri,
			authorization.material.nonce,
			authorization.material.pkceVerifier,
			p.time,
			...pendingValues(context, row, p),
			row.device_id,
			row.key_id,
			row.device_id,
			row.key_id,
		],
	};
}
function updateAttempt(
	context: Context,
	row: OwnerAttempt,
	authorization: Awaited<ReturnType<CoordinatorOidcClient["createAuthorizationRequest"]>>,
	p: ClaimPin,
): AuthLinkStatement {
	return {
		sql: `UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'browser_claimed',browser_transaction_hash = ?,browser_binder_hash = ?
 WHERE ${PENDING_SQL} AND ${NO_COLLISION_SQL}
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE b.coordinator_id = a.coordinator_id
 AND b.attempt_id = a.attempt_id AND b.browser_transaction_hash = ? AND b.purpose = 'owner_enroll'
 AND b.binder_hash = ? AND b.state_hash = ? AND b.issuer = a.issuer AND b.auth_config_revision = a.auth_config_revision
 AND b.redirect_uri = ? AND b.state = 'pending' AND b.nonce = ? AND b.pkce_verifier = ?
 AND b.created_at_ms = ? AND b.expires_at_ms = a.expires_at_ms)`,
		values: [
			p.hash,
			p.binder,
			...pendingValues(context, row, p),
			row.device_id,
			row.key_id,
			row.device_id,
			row.key_id,
			p.hash,
			p.binder,
			p.stateHash,
			context.c.redirectUri,
			authorization.material.nonce,
			authorization.material.pkceVerifier,
			p.time,
		],
	};
}
