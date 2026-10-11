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
import type { BrowserCsrfKey, BrowserCsrfScope } from "./coordinator-browser-csrf.js";
import { guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest } from "./coordinator-browser-request.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import {
	type OwnerAttempt,
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
	| { kind: "browser_claimed"; authorizationUrl: string; setCookies: string[] };
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
	client: Pick<CoordinatorOidcClient, "createAuthorizationRequest">;
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
			}),
		};
	} catch {
		return { ok: false as const };
	}
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
