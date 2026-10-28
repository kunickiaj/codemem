import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
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
	isBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest } from "./coordinator-browser-request.js";
import { readBrowserStartTransaction } from "./coordinator-browser-start-transaction.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import {
	commitOwnerEnrollment,
	OWNER_ACTIVE_LINK_SQL,
	ownerExcludedLegacyDecisionSql,
	readOwnerEnrollmentReceipt,
} from "./coordinator-owner-enrollment-commit.js";
import {
	type OwnerAuthorityAttempt as OwnerAttempt,
	ownerEnrollmentConfirmationHash,
	readGrantPins,
	validAttemptTime,
	verifyOwnerEnrollmentSignature,
	verifyPendingKeySignatureAndHashes,
} from "./coordinator-owner-enrollment-proof.js";
import {
	OWNER_ADMISSION_SCHEMA_READY_SQL,
	ownerAdmissionSessionGuard,
} from "./owner-browser-admission-authority.js";
import {
	isOwnerEnrollmentAdmissionKey,
	type OwnerEnrollmentAdmissionKey,
	type OwnerEnrollmentResolvedOwner,
	ownerEnrollmentOwnerCommitment,
	verifyOwnerEnrollmentAdmission,
	verifyOwnerEnrollmentAdmissionV2,
} from "./owner-enrollment-admission.js";
import {
	controllerOwnerLinkAuthority,
	readOwnerLinkAuthority,
} from "./owner-enrollment-link-authority.js";
import { matchesAdmissionOwner, validAdmissionOwnerHash } from "./owner-enrollment-owner-pin.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export interface OwnerEnrollmentStart {
	attemptId: string;
	deviceId: string;
	publicKey: string;
	loopbackRedirect: string;
	browserStartCode: string;
	signature: string;
}
/** Trusted internal composition only. Never deserialize resolvedOwner from public request JSON. */
export interface OwnerEnrollmentOwnerBoundStartOptions {
	admissionToken: string;
	resolvedOwner: OwnerEnrollmentResolvedOwner;
	/** Trusted browser composition only; never accepted from signed-start JSON. */
	sessionCookieHash?: string;
}
interface OwnerEnrollmentFinalize {
	attemptId: string;
	completionSecret: string;
	signature: string;
}
export type OwnerEnrollmentReceipt = {
	kind: "finalized" | "prior_commit";
	bindingId: string;
	identityId: string;
	groups: string[];
};
export type OwnerEnrollmentStartResult =
	| { kind: "rejected"; error: "owner_enrollment_unavailable" | "owner_enrollment_unknown" }
	| { kind: "started"; attemptId: string; expiresAtMs: number }
	| { kind: "browser_claimed"; authorizationUrl: string; setCookies: string[] }
	| { kind: "verified"; confirmation: OwnerEnrollmentConfirmation; csrf: string }
	| {
			kind: "confirmed";
			completionSecret: string;
			loopbackRedirect: string;
			confirmation: OwnerEnrollmentConfirmation;
	  }
	| OwnerEnrollmentReceipt;
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
	groups: readonly string[];
}
type StartPin = { coordinatorId: string; origin: string; issuer: string; revision: string };
interface OwnerEnrollmentCompositionBase {
	purpose: "owner_enroll";
	config: unknown;
	backend: AuthLinkBackend;
	csrfKey: BrowserCsrfKey;
	limiter: InMemoryRequestRateLimiter;
	oidcOptions: CoordinatorOidcOptions;
	clock?: () => number;
}
export type OwnerEnrollmentComposition = OwnerEnrollmentCompositionBase &
	(
		| { mode: "local_test"; admissionKey?: never }
		| { mode: "production"; admissionKey: OwnerEnrollmentAdmissionKey }
	);
type Context = {
	backend: AuthLinkBackend;
	c: CoordinatorAuthBrowserConfig;
	pin: StartPin;
	csrfKey: BrowserCsrfKey;
	scope: BrowserCsrfScope;
	limiter: InMemoryRequestRateLimiter;
	client: CoordinatorOidcClient;
	now: () => number;
	admissionKey?: OwnerEnrollmentAdmissionKey;
};
const unavailable: OwnerEnrollmentStartResult = Object.freeze({
	kind: "rejected",
	error: "owner_enrollment_unavailable",
});
const OWNER_START_CLIENT_LIMIT = 20;
const OWNER_MAX_ACTIVE_PER_COORDINATOR = 1000;
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
function captureResolvedOwner(value: unknown): OwnerEnrollmentResolvedOwner {
	return Object.freeze({
		coordinatorId: id(own(value, "coordinatorId")),
		issuer: text(own(value, "issuer"), 4096),
		subject: text(own(value, "subject"), 255),
		identityId: id(own(value, "identityId")),
		linkId: id(own(value, "linkId")),
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

/** Opt-in server composition. Production requires exact-start admission; local fixtures require custom fetch.
 * Native SQLite atomic batch semantics and schema constraints are required; errors
 * report unknown, never a claim that an attempted commit made no changes.
 */
function captureComposition(input: OwnerEnrollmentComposition) {
	const mode = own(input, "mode");
	if (
		own(input, "purpose") !== "owner_enroll" ||
		!["local_test", "production"].includes(mode as string)
	)
		throw new Error();
	const settings = captureCoordinatorBrowserAuthConfig(own(input, "config"));
	if (settings.kind !== "enabled") throw new Error();
	const oidcOptions = captureOwnerOidcOptions(mode, own(input, "oidcOptions"));
	const admissionKey = mode === "production" ? own(input, "admissionKey") : undefined;
	if (mode === "production" && !isOwnerEnrollmentAdmissionKey(admissionKey)) throw new Error();
	const csrfKey = own(input, "csrfKey");
	const limiter = own(input, "limiter") as InMemoryRequestRateLimiter;
	if (!isBrowserCsrfKey(csrfKey) || typeof limiter?.check !== "function") throw new Error();
	const backend = own(input, "backend") as AuthLinkBackend;
	if (
		!backend ||
		![backend.first, backend.run, backend.batch].every((f) => typeof f === "function")
	)
		throw new Error();
	return {
		mode,
		settings,
		backend,
		csrfKey,
		limiter,
		oidcOptions,
		admissionKey: admissionKey as OwnerEnrollmentAdmissionKey | undefined,
	};
}

function captureOwnerOidcOptions(mode: unknown, value: unknown): CoordinatorOidcOptions {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
	const captured: Record<string, unknown> = {};
	for (const name of ["fetch", "timeoutSeconds"]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (descriptor && !Object.hasOwn(descriptor, "value")) throw new Error();
		captured[name] = descriptor?.value;
	}
	const { fetch, timeoutSeconds } = captured;
	if (fetch !== undefined && typeof fetch !== "function") throw new Error();
	if (mode === "local_test" && typeof fetch !== "function") throw new Error();
	if (
		timeoutSeconds !== undefined &&
		(typeof timeoutSeconds !== "number" ||
			!Number.isFinite(timeoutSeconds) ||
			timeoutSeconds < 1 ||
			timeoutSeconds > 30)
	)
		throw new Error();
	return {
		fetch: fetch as CoordinatorOidcOptions["fetch"],
		timeoutSeconds: timeoutSeconds as number | undefined,
	};
}

export async function createCoordinatorOwnerEnrollment(input: OwnerEnrollmentComposition) {
	try {
		const { mode, settings, backend, csrfKey, limiter, oidcOptions, admissionKey } =
			captureComposition(input);
		const client = await composeOidcClient(mode, settings.oidc, oidcOptions);
		const c = settings.store;
		const clock = input.clock ?? Date.now;
		const context: Context = {
			backend,
			c,
			client,
			admissionKey,
			now: () => authLinkNow(clock),
			pin: Object.freeze({
				coordinatorId: c.coordinatorId,
				origin: settings.publicOrigin,
				issuer: c.issuer,
				revision: c.revision,
			}),
			scope: Object.freeze({ publicOrigin: settings.publicOrigin, store: c }),
			csrfKey,
			limiter,
		};
		return {
			ok: true as const,
			enrollment: Object.freeze({
				// clientKey must come from the trusted transport, never the signed request body.
				start: (value: OwnerEnrollmentStart, clientKey: string, admissionToken?: string) =>
					boundary(() =>
						start(context, value, clientKey, { kind: "operator", token: admissionToken }),
					),
				// Unmounted until a separately reviewed authenticated browser issuer exists.
				startOwnerBound: (
					value: OwnerEnrollmentStart,
					clientKey: string,
					options: OwnerEnrollmentOwnerBoundStartOptions,
				) => boundary(() => start(context, value, clientKey, { kind: "owner", options })),
				claimBrowser: (request: Request, clientKey: string) =>
					boundary(() => claimBrowser(context, request, clientKey)),
				verifyCallback: (request: Request) => boundary(() => verifyCallback(context, request)),
				confirm: (request: Request, clientKey: string, confirmationCommitment: string) =>
					boundary(() => confirm(context, request, clientKey, confirmationCommitment)),
				finalize: (value: OwnerEnrollmentFinalize) => boundary(() => finalize(context, value)),
			}),
		};
	} catch {
		return { ok: false as const };
	}
}

async function composeOidcClient(
	mode: unknown,
	config: Parameters<typeof createCoordinatorOidcClient>[0],
	options: CoordinatorOidcOptions,
): Promise<CoordinatorOidcClient> {
	if (mode === "production") return deferredOidcClient(config, options);
	const result = await createCoordinatorOidcClient(config, options);
	if (!result.ok) throw new Error("owner_enrollment_oidc_unavailable");
	return result.client;
}

/** Discovery is deferred until an eligible browser claim or consumed callback. */
function deferredOidcClient(
	config: Parameters<typeof createCoordinatorOidcClient>[0],
	options: CoordinatorOidcOptions,
): CoordinatorOidcClient {
	let settled: CoordinatorOidcClient | undefined;
	async function getClient() {
		if (settled) return settled;
		const result = await createCoordinatorOidcClient(config, options);
		if (!result.ok) throw new Error("owner_enrollment_oidc_unavailable");
		settled ??= result.client;
		return settled;
	}
	return {
		createAuthorizationRequest: async () => (await getClient()).createAuthorizationRequest(),
		verifyCallback: async (input, callbackOptions) =>
			(await getClient()).verifyCallback(input, callbackOptions),
	};
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
function ownerAttemptSql(state: "browser_claimed" | "oidc_verified"): string {
	return `a.coordinator_id = ? AND a.attempt_id = ? AND a.purpose = 'owner_enroll'
 AND a.state = '${state}' AND a.origin = ? AND a.issuer = ? AND a.auth_config_revision = ?
 AND a.browser_transaction_hash = ? AND a.browser_binder_hash = ?
 AND a.device_id = ? AND a.public_key = ? AND a.key_id = ? AND a.fingerprint = ?
 AND a.browser_start_hash = ? AND a.loopback_redirect = ? AND a.created_at_ms = ? AND a.expires_at_ms = ?
 AND a.admission_owner_hash IS ?
 AND ${OWNER_ADMISSION_SCHEMA_READY_SQL}
 AND a.created_at_ms <= ? AND a.expires_at_ms > ?`;
}
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
		a.admission_owner_hash,
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
 AND EXISTS (SELECT 1 FROM coordinator_owner_enrollment_attempts a WHERE ${ownerAttemptSql("browser_claimed")})`,
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
	controller_attestation_id: string | null;
	owner_qualification_id: string | null;
	auth_config_revision: string;
	created_at_ms: number;
	authority_kind: string;
	device_claim_id: string | null;
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
	const candidate = await context.backend.first<OwnerAccountLink>({
		sql: `SELECT l.*,NULL AS owner_qualification_id FROM coordinator_auth_account_links l WHERE l.coordinator_id = ? AND l.issuer = ? AND l.subject = ? AND l.revoked_at_ms IS NULL`,
		values: [context.c.coordinatorId, account.issuer, account.subject],
	});
	if (!candidate) return null;
	const resolved = await callbackLinkAuthority(context, consumed.row, candidate);
	if (!resolved) return null;
	const { link, authority } = resolved;
	if (
		!(await matchesAdmissionOwner({
			...consumed.row,
			issuer: account.issuer,
			account_subject: account.subject,
			identity_id: link.identity_id,
			link_id: link.link_id,
		}))
	)
		return null;
	const grants = await context.backend.first<{ rows: string }>({
		sql: `SELECT (${CALLBACK_GRANTS_SQL}) AS rows FROM coordinator_owner_enrollment_attempts a
 WHERE ${ownerAttemptSql("browser_claimed")}`,
		values: [link.identity_id, ...callbackAttemptValues(context, consumed.row, context.now())],
	});
	if (!grants || !readGrantPins(grants.rows)) return null;
	const time = context.now();
	const wrote = await context.backend.run(
		verifiedStatement(context, consumed, account, link, grants.rows, time, authority),
	);
	if (wrote !== 1) return null;
	const row = await readAttempt(context, consumed.row.attempt_id);
	// A missing or changed post-write read is unknown, not evidence the write failed.
	if (
		row?.state !== "oidc_verified" ||
		row.admission_owner_hash !== consumed.row.admission_owner_hash ||
		row.link_id !== link.link_id ||
		(row.owner_qualification_id ?? null) !== link.owner_qualification_id ||
		row.link_controller_attestation_id !== link.controller_attestation_id ||
		row.account_subject !== account.subject ||
		row.grant_revisions_json !== grants.rows ||
		row.browser_transaction_hash !== consumed.txn.browser_transaction_hash ||
		row.browser_binder_hash !== consumed.txn.binder_hash
	)
		throw new Error();
	return row;
}
async function callbackLinkAuthority(
	context: Context,
	attempt: OwnerAttempt,
	link: OwnerAccountLink,
) {
	const scope = {
		sql: "l.coordinator_id=? AND l.link_id=?",
		values: [context.c.coordinatorId, link.link_id],
	};
	if (
		link.authority_kind === "controller_attestation" &&
		isAuthControllerId(link.controller_attestation_id) &&
		link.device_claim_id === null
	)
		return { authority: controllerOwnerLinkAuthority(attempt, scope), link };
	if (
		link.authority_kind !== "device_claim" ||
		link.controller_attestation_id !== null ||
		!isAuthControllerId(link.device_claim_id)
	)
		return null;
	const authority = await readOwnerLinkAuthority(context.backend, context.now(), scope);
	const qualified = await context.backend.first<{ owner_qualification_id: string | null }>({
		sql: `${authority.with}SELECT ${authority.qualification} AS owner_qualification_id
 FROM owner_scope_links l WHERE l.coordinator_id=? AND l.link_id=?
 AND l.revoked_at_ms IS NULL AND ${authority.link}`,
		values: [...authority.values, context.c.coordinatorId, link.link_id],
	});
	if (!qualified?.owner_qualification_id) return null;
	return { authority, link: { ...link, owner_qualification_id: qualified.owner_qualification_id } };
}
function verifiedStatement(
	context: Context,
	consumed: ConsumedOwnerBrowser,
	account: { issuer: string; subject: string },
	link: OwnerAccountLink,
	grants: string,
	time: number,
	authority: Awaited<ReturnType<typeof readOwnerLinkAuthority>>,
): AuthLinkStatement {
	// Keep consumed-browser proof and link provenance in separate native D1 depth trees.
	return {
		sql: `${authority.with ? `${authority.with},` : "WITH"} owner_callback_attempts AS MATERIALIZED (
 SELECT a.coordinator_id,a.attempt_id FROM coordinator_owner_enrollment_attempts a
 WHERE ${ownerAttemptSql("browser_claimed")}
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b WHERE ${CALLBACK_TXN_SQL}
 AND b.state = 'consumed' AND b.claim_token = ? AND b.nonce IS NULL AND b.pkce_verifier IS NULL)),
 owner_callback_links AS MATERIALIZED (
 SELECT l.*,${authority.qualification} AS owner_qualification_id FROM owner_scope_links l
 WHERE ${authority.link})
 UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'oidc_verified',
 account_subject = ?,identity_id = ?,link_id = ?,link_attempt_id = ?,link_controller_attestation_id = ?,
 ${authority.hasPin ? "owner_qualification_id = ?," : ""}link_auth_config_revision = ?,grant_revisions_json = ?
 WHERE a.coordinator_id=? AND a.attempt_id=?
 AND EXISTS (SELECT 1 FROM owner_callback_attempts p WHERE p.coordinator_id=a.coordinator_id AND p.attempt_id=a.attempt_id)
 AND EXISTS (SELECT 1 FROM owner_callback_links l WHERE l.coordinator_id = a.coordinator_id
 AND l.link_id = ? AND l.issuer = a.issuer AND l.subject = ? AND l.identity_id = ? AND l.attempt_id = ?
 AND l.controller_attestation_id IS ? AND l.owner_qualification_id IS ? AND l.auth_config_revision = ? AND l.created_at_ms = ? AND l.revoked_at_ms IS NULL)
 AND (${CALLBACK_GRANTS_SQL}) = ?
 AND ${NO_COLLISION_SQL}`,
		values: [
			...authority.values,
			...callbackAttemptValues(context, consumed.row, time),
			...callbackTxnValues(context, consumed.txn, time),
			consumed.claimToken,
			account.subject,
			link.identity_id,
			link.link_id,
			link.attempt_id,
			link.controller_attestation_id,
			...(authority.hasPin ? [link.owner_qualification_id] : []),
			link.auth_config_revision,
			grants,
			consumed.row.coordinator_id,
			consumed.row.attempt_id,
			link.link_id,
			account.subject,
			link.identity_id,
			link.attempt_id,
			link.controller_attestation_id,
			link.owner_qualification_id,
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
	if (!(await matchesAdmissionOwner(row))) throw new Error();
	const grants = readGrantPins(row.grant_revisions_json);
	if (!grants) throw new Error();
	// Display commitment; confirm() persists it with the completion-secret hash.
	const confirmationHash = await ownerEnrollmentConfirmationHash(row);
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
		groups: Object.freeze(grants.map((grant) => grant.groupId)),
	});
}

// Both the preflight read and winning update require the consumed transaction,
// exact linked account provenance, and the same active grant snapshot shown to the user.
const CONFIRM_AUTHORITY_SQL = `${OWNER_ACTIVE_LINK_SQL}
 AND (${CALLBACK_GRANTS_SQL}) = a.grant_revisions_json
 AND NOT EXISTS (SELECT 1 FROM json_each(a.grant_revisions_json) p WHERE ${ownerExcludedLegacyDecisionSql("json_extract(p.value,'$.groupId')")})
 AND EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions b
 WHERE b.coordinator_id = a.coordinator_id AND b.attempt_id = a.attempt_id AND b.purpose = 'owner_enroll'
 AND b.browser_transaction_hash = a.browser_transaction_hash AND b.binder_hash = a.browser_binder_hash
 AND b.issuer = a.issuer AND b.auth_config_revision = a.auth_config_revision AND b.redirect_uri = ?
 AND b.state = 'consumed' AND b.claim_token IS NOT NULL AND b.nonce IS NULL AND b.pkce_verifier IS NULL
 AND b.created_at_ms >= a.created_at_ms AND b.created_at_ms <= ?
 AND b.expires_at_ms = a.expires_at_ms)`;
function confirmAuthorityValues(context: Context, row: OwnerAttempt, time: number) {
	return [row.coordinator_id, row.attempt_id, row.identity_id, context.c.redirectUri, time];
}
function confirmAuthorityCte(authority: Awaited<ReturnType<typeof readOwnerLinkAuthority>>) {
	// JOIN/UPDATE FROM consumes this stage without nesting its proof under attempt pins.
	return `${authority.with ? `${authority.with},` : "WITH"} owner_confirm_authority AS MATERIALIZED (
 SELECT a.coordinator_id,a.attempt_id FROM coordinator_owner_enrollment_attempts a
 WHERE a.coordinator_id=? AND a.attempt_id=?
 AND ${CONFIRM_AUTHORITY_SQL.replace(OWNER_ACTIVE_LINK_SQL, authority.active)}) `;
}
const CONFIRM_AUTHORITY_MATCH_SQL = `p.coordinator_id=a.coordinator_id AND p.attempt_id=a.attempt_id`;
async function confirmationLinkAuthority(context: Context, row: OwnerAttempt, time: number) {
	const scope = {
		sql: "l.coordinator_id=? AND l.link_id=?",
		values: [row.coordinator_id, row.link_id],
	};
	const hasQualificationPin = Object.hasOwn(row, "owner_qualification_id");
	if (isAuthControllerId(row.link_controller_attestation_id)) {
		if (hasQualificationPin && row.owner_qualification_id !== null) throw new Error();
		const authority = controllerOwnerLinkAuthority(row, scope);
		if (hasQualificationPin) return authority;
		// A legacy snapshot cannot skip qualification pins added before either SQL executes.
		return {
			...authority,
			active: `(${authority.active} AND NOT EXISTS (SELECT 1 FROM pragma_table_info('coordinator_owner_enrollment_attempts') WHERE name='owner_qualification_id'))`,
		};
	}
	if (
		row.link_controller_attestation_id !== null ||
		!hasQualificationPin ||
		typeof row.owner_qualification_id !== "string"
	)
		throw new Error();
	const authority = await readOwnerLinkAuthority(context.backend, time, scope);
	if (!authority.hasPin) throw new Error();
	return authority;
}
async function readConfirmableAttempt(
	context: Context,
	attemptId: string,
	binderHash: string,
): Promise<OwnerAttempt | null> {
	const row = await context.backend.first<OwnerAttempt>({
		sql: `SELECT * FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ?
 AND attempt_id = ? AND purpose = 'owner_enroll' AND state = 'oidc_verified' AND browser_binder_hash = ?
 AND ${OWNER_ADMISSION_SCHEMA_READY_SQL}`,
		values: [context.c.coordinatorId, attemptId, binderHash],
	});
	const time = context.now();
	if (!live(context, row, time) || !row.browser_transaction_hash || !row.loopback_redirect)
		return null;
	if (!parseCoordinatorAuthLoopback(row.loopback_redirect).ok) return null;
	const authority = await confirmationLinkAuthority(context, row, time);
	const current = await context.backend.first({
		sql: `${confirmAuthorityCte(authority)}SELECT 1 FROM coordinator_owner_enrollment_attempts a
 JOIN owner_confirm_authority p ON ${CONFIRM_AUTHORITY_MATCH_SQL} WHERE
  ${ownerAttemptSql("oidc_verified")}`,
		values: [
			...authority.values,
			...confirmAuthorityValues(context, row, time),
			...callbackAttemptValues(context, row, time),
		],
	});
	return current ? row : null;
}
async function confirm(
	context: Context,
	request: Request,
	clientKey: string,
	confirmationCommitment: string,
): Promise<OwnerEnrollmentStartResult> {
	const snapshot = snapshotBrowserRequest(request);
	const checked = await guardBrowserForm({
		request,
		clientKey,
		action: "transaction_attempt",
		scope: context.scope,
		csrfKey: context.csrfKey,
		limiter: context.limiter,
	});
	if (!checked.ok || checked.action !== "transaction_attempt") return unavailable;
	const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
	if (cookie.kind !== "present" || cookie.cookieHash !== checked.cookieHash) return unavailable;
	const row = await readConfirmableAttempt(context, checked.attemptId, cookie.cookieHash);
	if (!row?.loopback_redirect) return unavailable;
	const confirmation = await confirmationView(row);
	if (confirmationCommitment !== confirmation.confirmationHash) return unavailable;
	const completionSecret = mintCompletionSecret();
	const completionHash = await proofHash(completionSecret);
	const time = context.now();
	const wrote = await context.backend.run(
		await confirmStatement(context, row, {
			confirmationHash: confirmation.confirmationHash,
			completionHash,
			time,
		}),
	);
	if (wrote !== 1) return unavailable;
	return {
		kind: "confirmed",
		completionSecret,
		loopbackRedirect: row.loopback_redirect,
		confirmation,
	};
}
function mintCompletionSecret(): string {
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
async function confirmStatement(
	context: Context,
	a: OwnerAttempt,
	p: { confirmationHash: string; completionHash: string; time: number },
): Promise<AuthLinkStatement> {
	const authority = await confirmationLinkAuthority(context, a, p.time);
	return {
		sql: `${confirmAuthorityCte(authority)}UPDATE coordinator_owner_enrollment_attempts AS a SET state = 'confirmed',
 confirmation_hash = ?,completion_secret_hash = ? FROM owner_confirm_authority p WHERE
  ${ownerAttemptSql("oidc_verified")}
 AND a.account_subject = ? AND a.identity_id = ? AND a.link_id = ? AND a.link_attempt_id = ?
 AND a.link_controller_attestation_id IS ? ${authority.hasPin ? "AND a.owner_qualification_id IS ?" : ""} AND a.link_auth_config_revision = ? AND a.grant_revisions_json = ?
 AND a.confirmation_hash IS NULL AND a.completion_secret_hash IS NULL
 AND ${CONFIRM_AUTHORITY_MATCH_SQL} AND ${NO_COLLISION_SQL}`,
		values: [
			...authority.values,
			...confirmAuthorityValues(context, a, p.time),
			p.confirmationHash,
			p.completionHash,
			...callbackAttemptValues(context, a, p.time),
			a.account_subject,
			a.identity_id,
			a.link_id,
			a.link_attempt_id,
			a.link_controller_attestation_id,
			...(authority.hasPin ? [a.owner_qualification_id ?? null] : []),
			a.link_auth_config_revision,
			a.grant_revisions_json,
			a.device_id,
			a.key_id,
			a.device_id,
			a.key_id,
		],
	};
}
function captureFinalize(value: unknown): OwnerEnrollmentFinalize {
	return Object.freeze({
		attemptId: id(own(value, "attemptId")),
		completionSecret: text(own(value, "completionSecret"), 43),
		signature: text(own(value, "signature"), 86),
	});
}
function matchesFinalScope(context: Context, row: OwnerAttempt | null): row is OwnerAttempt {
	return (
		!!row &&
		row.purpose === "owner_enroll" &&
		row.coordinator_id === context.c.coordinatorId &&
		row.origin === context.pin.origin &&
		row.issuer === context.c.issuer &&
		validAdmissionOwnerHash(row.admission_owner_hash) &&
		// A committed receipt is historical evidence; only a new commit needs the live revision.
		(row.state === "finalized" || row.auth_config_revision === context.c.revision) &&
		!!row.confirmation_hash
	);
}
async function finalize(
	context: Context,
	value: OwnerEnrollmentFinalize,
): Promise<OwnerEnrollmentStartResult> {
	let i: OwnerEnrollmentFinalize;
	try {
		i = captureFinalize(value);
	} catch {
		return unavailable;
	}
	const row = await readAttempt(context, i.attemptId);
	if (!matchesFinalScope(context, row)) return unavailable;
	const proof = await verifyPendingKeySignatureAndHashes(row, i.completionSecret, i.signature);
	if (!proof || proof.completionHash !== row.completion_secret_hash) return unavailable;
	if (row.state === "finalized") return priorCommit(context, row, proof);
	const time = context.now();
	if (!live(context, row, time) || row.state !== "confirmed") return unavailable;
	if ((await confirmationView(row)).confirmationHash !== row.confirmation_hash) return unavailable;
	const committed = await commitOwnerEnrollment({
		backend: context.backend,
		row,
		revision: context.c.revision,
		now: time,
		completionSecret: i.completionSecret,
		signature: i.signature,
	});
	return readFinalOutcome(context, i, { committed });
}
async function readFinalOutcome(
	context: Context,
	i: OwnerEnrollmentFinalize,
	options: { committed: boolean },
): Promise<OwnerEnrollmentStartResult> {
	const fresh = await readAttempt(context, i.attemptId);
	// A failed/missing post-commit read never proves rollback or successful completion.
	if (!fresh) throw new Error();
	if (!matchesFinalScope(context, fresh) || fresh.state !== "finalized") {
		if (options.committed) throw new Error();
		return unavailable;
	}
	const proof = await verifyPendingKeySignatureAndHashes(fresh, i.completionSecret, i.signature);
	if (!proof || !(await matchesReceipt(context, fresh, proof))) throw new Error();
	if (!options.committed) return receipt(fresh, "prior_commit");
	return receipt(fresh, "finalized");
}
type FinalProof = { completionHash: string; keyProofHash: string };
async function matchesReceipt(context: Context, row: OwnerAttempt, proof: FinalProof) {
	return (
		row.completion_secret_hash === proof.completionHash &&
		row.final_key_proof_hash === proof.keyProofHash &&
		(await readOwnerEnrollmentReceipt(context.backend, row))
	);
}
async function priorCommit(
	context: Context,
	row: OwnerAttempt,
	proof: FinalProof,
): Promise<OwnerEnrollmentStartResult> {
	if (!(await matchesReceipt(context, row, proof))) return unavailable;
	return receipt(row, "prior_commit");
}
function receipt(row: OwnerAttempt, kind: "finalized" | "prior_commit"): OwnerEnrollmentReceipt {
	const grants = readGrantPins(row.grant_revisions_json);
	if (!grants || !row.binding_id || !isAuthControllerId(row.identity_id)) throw new Error();
	return {
		kind,
		bindingId: row.binding_id,
		identityId: row.identity_id,
		groups: grants.map((grant) => grant.groupId),
	};
}
const NO_COLLISION_SQL = `NOT EXISTS (SELECT 1 FROM coordinator_device_ownership_bindings WHERE device_id = ? OR key_id = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_device_revocations WHERE (subject_kind = 'device_id' AND subject_value = ?)
 OR (subject_kind = 'ed25519_key' AND subject_value = ?))`;
async function start(
	context: Context,
	value: OwnerEnrollmentStart,
	clientKey: string,
	admissionInput:
		| { kind: "operator"; token?: string }
		| { kind: "owner"; options: OwnerEnrollmentOwnerBoundStartOptions },
): Promise<OwnerEnrollmentStartResult> {
	// Capture both the signed start and server-resolved owner before any async work.
	const captured = captureStartInputs(value, admissionInput);
	if (!isAuthControllerId(clientKey) || clientKey.length > 128) return unavailable;
	const admission = context.limiter.check(
		JSON.stringify(["owner-enrollment-start", context.c.coordinatorId, clientKey]),
		OWNER_START_CLIENT_LIMIT,
	);
	if (own(admission, "allowed") !== true) return unavailable;
	if (!captured) return unavailable;
	const { i } = captured;
	let browserStartHash: string;
	try {
		browserStartHash = await proofHash(i.browserStartCode);
	} catch {
		return unavailable;
	}
	const verifiedAdmission = await verifyStartAdmission(context, captured);
	if (!verifiedAdmission) return unavailable;
	const { admissionOwnerHash } = verifiedAdmission;
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
	const statement = startStatement(context, i, {
		keyId,
		fingerprint,
		browserStartHash,
		time,
		admissionOwnerHash,
	});
	if (captured.owner && captured.sessionCookieHash !== undefined) {
		const guard = await ownerAdmissionSessionGuard({
			backend: context.backend,
			config: context.c,
			sessionCookieHash: captured.sessionCookieHash,
			owner: captured.owner,
			deviceId: i.deviceId,
			fingerprint,
			time,
		});
		// Keep connection provenance out of the INSERT's expression tree (D1 depth 100).
		// Materialization is inside this same winning statement, not an earlier read.
		statement.sql = `WITH owner_admission_authority AS MATERIALIZED (${guard.sql})
 ${statement.sql} AND EXISTS (SELECT 1 FROM owner_admission_authority)`;
		statement.values.unshift(...guard.values);
	}
	const wrote = await context.backend.run(statement);
	if (wrote !== 1) return unavailable;
	return { kind: "started", attemptId: i.attemptId, expiresAtMs: time + 600000 };
}
function captureStartInputs(value: OwnerEnrollmentStart, admission: Parameters<typeof start>[3]) {
	try {
		const i = captureStart(value);
		if (admission.kind === "operator") return { i, token: admission.token, owner: null };
		return {
			i,
			token: own(admission.options, "admissionToken"),
			owner: captureResolvedOwner(own(admission.options, "resolvedOwner")),
			sessionCookieHash: captureSessionCookieHash(admission.options),
		};
	} catch {
		return null;
	}
}
function captureSessionCookieHash(
	options: OwnerEnrollmentOwnerBoundStartOptions,
): string | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(options, "sessionCookieHash");
	if (!descriptor) return undefined;
	if (
		!Object.hasOwn(descriptor, "value") ||
		typeof descriptor.value !== "string" ||
		!/^[a-f0-9]{64}$/.test(descriptor.value)
	)
		throw new Error();
	return descriptor.value;
}
async function verifyStartAdmission(
	context: Context,
	captured: NonNullable<ReturnType<typeof captureStartInputs>>,
) {
	const { i, token, owner } = captured;
	if (owner) {
		if (
			!context.admissionKey ||
			!(await verifyOwnerEnrollmentAdmissionV2(context.admissionKey, token, context.pin, i, {
				resolvedOwner: owner,
				nowMs: context.now(),
			}))
		)
			return null;
		return { admissionOwnerHash: await ownerEnrollmentOwnerCommitment(owner) };
	}
	if (
		context.admissionKey &&
		!(await verifyOwnerEnrollmentAdmission(
			context.admissionKey,
			token,
			context.pin,
			i,
			context.now(),
		))
	)
		return null;
	return { admissionOwnerHash: null };
}
function startStatement(
	context: Context,
	i: OwnerEnrollmentStart,
	p: {
		keyId: string;
		fingerprint: string;
		browserStartHash: string;
		time: number;
		admissionOwnerHash: string | null;
	},
): AuthLinkStatement {
	const { c, pin } = context;
	// Signed starts have no issued-at: retain every attempt ID as a replay tombstone.
	// Expiry frees active slots only; no purge is supported, and storage fails closed.
	return {
		sql: `INSERT INTO coordinator_owner_enrollment_attempts
 (coordinator_id,attempt_id,purpose,origin,device_id,public_key,key_id,fingerprint,issuer,auth_config_revision,
 loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms,admission_owner_hash)
 SELECT ?,?,'owner_enroll',?,?,?,?,?,?,?,?,?,'pending',?,?,?
  WHERE ${OWNER_ADMISSION_SCHEMA_READY_SQL} AND ${NO_COLLISION_SQL}
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_link_attempts WHERE coordinator_id = ? AND attempt_id = ?)
 AND NOT EXISTS (SELECT 1 FROM coordinator_auth_browser_transactions WHERE coordinator_id = ?
 AND attempt_id = ? AND purpose <> 'signin')
 AND (SELECT count(*) FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND device_id = ?
 AND state IN ('pending','browser_claimed','oidc_verified','confirmed') AND expires_at_ms > ?) < ?
 AND (SELECT count(*) FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND device_id = ? AND created_at_ms > ?) < ?
 AND (SELECT count(*) FROM (SELECT 1 FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ?
 AND state IN ('pending','browser_claimed','oidc_verified','confirmed') AND expires_at_ms > ? LIMIT ?)) < ?
 AND (SELECT count(*) FROM (SELECT 1 FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ?
 AND state <> 'finalized' LIMIT ?)) < ?`,
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
			p.admissionOwnerHash,
			i.deviceId,
			p.keyId,
			i.deviceId,
			p.keyId,
			c.coordinatorId,
			i.attemptId,
			c.coordinatorId,
			i.attemptId,
			c.coordinatorId,
			i.deviceId,
			p.time,
			AUTH_LINK_MAX_ACTIVE_PER_DEVICE,
			c.coordinatorId,
			i.deviceId,
			p.time - AUTH_LINK_CREATE_WINDOW_MS,
			AUTH_LINK_MAX_CREATES_PER_DEVICE_WINDOW,
			c.coordinatorId,
			p.time,
			OWNER_MAX_ACTIVE_PER_COORDINATOR,
			OWNER_MAX_ACTIVE_PER_COORDINATOR,
			c.coordinatorId,
			AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
			AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
		],
	};
}
async function readAttempt(context: Context, attemptId: string): Promise<OwnerAttempt | null> {
	return context.backend.first<OwnerAttempt>({
		sql: `SELECT * FROM coordinator_owner_enrollment_attempts WHERE coordinator_id = ? AND attempt_id = ?
 AND ${OWNER_ADMISSION_SCHEMA_READY_SQL}`,
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
		validAdmissionOwnerHash(row.admission_owner_hash) &&
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
	const transaction = await readBrowserStartTransaction(
		snapshot.cookie,
		new CoordinatorAuthBrowserTransactions(context.backend, context.now),
		context.c,
	);
	if (transaction === "active" || transaction === "invalid") return unavailable;
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
 AND admission_owner_hash IS ?
 AND ${OWNER_ADMISSION_SCHEMA_READY_SQL}
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
		row.admission_owner_hash,
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
