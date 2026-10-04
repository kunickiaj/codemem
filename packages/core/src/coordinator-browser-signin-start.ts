import type { CoordinatorAuthBrowserTransactionStore } from "./coordinator-auth-browser-transaction-contract.js";
import {
	type CoordinatorAuthBrowserPage,
	renderAuthBrowserNotice,
	renderAuthSigninContinuePage,
	renderAuthSigninPage,
} from "./coordinator-auth-browser-view.js";
import type { CoordinatorAuthSessionStore } from "./coordinator-auth-session-contract.js";
import {
	type CoordinatorBrowserAuthConfigField,
	type CoordinatorBrowserAuthSettings,
	captureCoordinatorBrowserAuthConfig,
} from "./coordinator-browser-auth-config.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
	reissueStartCookieAsTransaction,
} from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	type BrowserCsrfScope,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { type BrowserFormGuardResult, guardBrowserForm } from "./coordinator-browser-form-guard.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

type SigninStore = Pick<CoordinatorAuthBrowserTransactionStore, "startAuthBrowserTransaction"> &
	Pick<CoordinatorAuthSessionStore, "readAuthSession">;
type Settings = Extract<CoordinatorBrowserAuthSettings, { kind: "enabled" }>;
export interface CoordinatorBrowserSigninStartInput {
	config: unknown;
	csrfKey: BrowserCsrfKey;
	store: SigninStore;
	limiter: InMemoryRequestRateLimiter;
	oidcOptions?: CoordinatorOidcOptions;
}
export type CoordinatorBrowserSigninStartOutcome =
	| "signin_page"
	| "signin_started"
	| "session_live"
	| "signin_in_progress"
	| "method_not_allowed"
	| "not_found"
	| "cookie_invalid"
	| "origin_rejected"
	| "rate_limited"
	| "unsupported_media_type"
	| "body_too_large"
	| "form_invalid"
	| "cookie_missing"
	| "csrf_invalid"
	| "start_conflict"
	| "start_limited"
	| "provider_request_failed"
	| "internal_error";
export type CoordinatorBrowserSigninStartResponse = Readonly<{
	response: Response;
	outcome: CoordinatorBrowserSigninStartOutcome;
}>;
export interface CoordinatorBrowserSigninStartHandlers {
	signInPage(request: Request): Promise<CoordinatorBrowserSigninStartResponse>;
	signInStart(request: Request, clientKey: string): Promise<CoordinatorBrowserSigninStartResponse>;
}
export type CoordinatorBrowserSigninStartResult =
	| Readonly<{ ok: true; handlers: Readonly<CoordinatorBrowserSigninStartHandlers> }>
	| Readonly<{
			ok: false;
			error: "browser_auth_config_invalid";
			field: CoordinatorBrowserAuthConfigField;
	  }>
	| Readonly<{
			ok: false;
			error:
				| "browser_auth_disabled"
				| "invalid_input"
				| "oidc_discovery_failed"
				| "invalid_provider_configuration";
	  }>;

function ownData(value: unknown, name: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (descriptor && !Object.hasOwn(descriptor, "value")) throw new Error();
	return descriptor?.value;
}

function dataMethod(value: unknown, name: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
	const seen = new Set<object>();
	let cursor: object | null = value;
	while (cursor !== null) {
		if (seen.has(cursor)) throw new Error();
		seen.add(cursor);
		const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
		if (descriptor) {
			if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function")
				throw new Error();
			return descriptor.value;
		}
		cursor = Object.getPrototypeOf(cursor);
	}
	throw new Error();
}

function nativeRequestGetter(name: string): ((this: Request) => unknown) | undefined {
	let prototype: object | null = Request.prototype;
	while (prototype !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (descriptor) return descriptor.get;
		prototype = Object.getPrototypeOf(prototype);
	}
	return undefined;
}
const requestGetters = Object.freeze({
	method: nativeRequestGetter("method"),
	url: nativeRequestGetter("url"),
	headers: nativeRequestGetter("headers"),
});
const headersGet = Headers.prototype.get;
function snapshotRequest(request: Request) {
	const method = requestGetters.method?.call(request);
	const url = requestGetters.url?.call(request);
	const headers = requestGetters.headers?.call(request) as Headers;
	if (typeof method !== "string" || typeof url !== "string") throw new Error();
	return Object.freeze({ method, url, cookie: headersGet.call(headers, "cookie") });
}
type Snapshot = ReturnType<typeof snapshotRequest>;
type Context = Readonly<{
	storeConfig: Settings["store"];
	scope: BrowserCsrfScope;
	csrfKey: BrowserCsrfKey;
	store: SigninStore;
	limiter: InMemoryRequestRateLimiter;
	client: CoordinatorOidcClient;
	signinUrl: string;
	accountUrl: string;
}>;

function result(
	response: Response,
	outcome: CoordinatorBrowserSigninStartOutcome,
): CoordinatorBrowserSigninStartResponse {
	return Object.freeze({ response, outcome });
}
function pageResponse(
	page: CoordinatorAuthBrowserPage,
	status = 200,
	extra?: Record<string, string>,
): Response {
	const headers = new Headers(page.headers);
	headers.set("Cache-Control", "no-store");
	if (extra) {
		new Headers(extra).forEach((value, name) => {
			headers.set(name, value);
		});
	}
	return new Response(page.body, { status, headers });
}
function fallback(): CoordinatorBrowserSigninStartResponse {
	return result(
		new Response("Sign-in unavailable. Try again.", {
			status: 503,
			headers: {
				"Content-Type": "text/plain;charset=utf-8",
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			},
		}),
		"internal_error",
	);
}
async function notice(
	status: number,
	outcome: CoordinatorBrowserSigninStartOutcome,
	extra?: Record<string, string>,
): Promise<CoordinatorBrowserSigninStartResponse> {
	try {
		const inProgress = outcome === "signin_in_progress" || outcome === "start_conflict";
		const kind = inProgress ? "signin_in_progress" : "signin_unavailable";
		return result(pageResponse(await renderAuthBrowserNotice(kind), status, extra), outcome);
	} catch {
		return fallback();
	}
}
function accountRedirect(context: Context): CoordinatorBrowserSigninStartResponse {
	return result(
		new Response(null, {
			status: 303,
			headers: {
				Location: context.accountUrl,
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
			},
		}),
		"session_live",
	);
}
async function liveSession(context: Context, snapshot: Snapshot): Promise<boolean> {
	const session = await readBrowserCookie(snapshot.cookie, "session");
	if (session.kind === "invalid") throw new Error();
	if (session.kind === "absent") return false;
	return (await context.store.readAuthSession(session.cookieHash, context.storeConfig)) !== null;
}
function routeError(context: Context, snapshot: Snapshot, method: "GET" | "POST") {
	if (snapshot.method !== method) return notice(405, "method_not_allowed", { Allow: method });
	if (snapshot.url !== context.signinUrl) return notice(404, "not_found");
	return null;
}
async function signInPage(
	context: Context,
	request: Request,
): Promise<CoordinatorBrowserSigninStartResponse> {
	try {
		const snapshot = snapshotRequest(request);
		const routing = routeError(context, snapshot, "GET");
		if (routing) return await routing;
		const transaction = await readBrowserCookie(snapshot.cookie, "transaction");
		if (transaction.kind === "invalid") return await notice(400, "cookie_invalid");
		if (transaction.kind === "present") return await notice(409, "signin_in_progress");
		if (await liveSession(context, snapshot)) return accountRedirect(context);
		const existing = await readBrowserCookie(snapshot.cookie, "start");
		if (existing.kind === "invalid") return await notice(400, "cookie_invalid");
		const cookie = existing.kind === "present" ? existing : await issueBrowserCookie("start");
		const csrfToken = await issueBrowserCsrfToken(
			context.csrfKey,
			cookie.secret,
			"start",
			context.scope,
		);
		const response = pageResponse(await renderAuthSigninPage({ csrfToken }));
		if ("setCookie" in cookie) response.headers.append("Set-Cookie", cookie.setCookie);
		return result(response, "signin_page");
	} catch {
		return await notice(503, "internal_error");
	}
}

function guardPriority(guard: BrowserFormGuardResult) {
	if (guard.ok) return null;
	if (guard.error === "origin_rejected") return notice(403, "origin_rejected");
	if (guard.error === "rate_limited")
		return notice(429, "rate_limited", { "Retry-After": String(guard.retryAfterS) });
	if (guard.error === "client_unidentified" || guard.error === "invalid_input")
		return notice(503, "internal_error");
	return null;
}
function guardFailure(guard: Extract<BrowserFormGuardResult, { ok: false }>) {
	switch (guard.error) {
		case "unsupported_media_type":
			return notice(415, guard.error);
		case "body_too_large":
			return notice(413, guard.error);
		case "form_invalid":
			return notice(400, guard.error);
		case "cookie_invalid":
		case "cookie_missing":
		case "csrf_invalid":
			return notice(403, guard.error);
		default:
			return notice(503, "internal_error");
	}
}

async function admitStart(
	context: Context,
	snapshot: Snapshot,
	binderHash: string,
): Promise<CoordinatorBrowserSigninStartResponse> {
	const start = await readBrowserCookie(snapshot.cookie, "start");
	if (start.kind !== "present" || start.cookieHash !== binderHash)
		return notice(503, "internal_error");
	let authorization: Awaited<ReturnType<CoordinatorOidcClient["createAuthorizationRequest"]>>;
	try {
		authorization = await context.client.createAuthorizationRequest();
	} catch {
		return notice(503, "provider_request_failed");
	}
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(authorization.material.state),
	);
	const stateHash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const response = pageResponse(
		await renderAuthSigninContinuePage({ authorizationUrl: authorization.authorizationUrl }),
	);
	response.headers.append("Set-Cookie", reissueStartCookieAsTransaction(start.secret));
	response.headers.append("Set-Cookie", clearBrowserCookie("start"));
	// Prebuild locally; cookies leave only after durable unique-binder admission.
	const admitted = await context.store.startAuthBrowserTransaction(
		{
			purpose: "signin",
			stateHash,
			binderHash,
			nonce: authorization.material.nonce,
			pkceVerifier: authorization.material.pkceVerifier,
		},
		context.storeConfig,
	);
	if (admitted.kind === "started") return result(response, "signin_started");
	if (admitted.kind === "rejected") {
		if (admitted.error === "transaction_conflict") return notice(409, "start_conflict");
		if (admitted.error === "transaction_limited" || admitted.error === "clock_retention_blocked")
			return notice(503, "start_limited");
	}
	return notice(503, "internal_error");
}

async function signInStart(
	context: Context,
	request: Request,
	clientKey: string,
): Promise<CoordinatorBrowserSigninStartResponse> {
	try {
		const snapshot = snapshotRequest(request);
		const routing = routeError(context, snapshot, "POST");
		if (routing) return await routing;
		// Guard snapshots native request fields in this same synchronous tick.
		const pendingGuard = guardBrowserForm({
			request,
			scope: context.scope,
			csrfKey: context.csrfKey,
			action: "signin_start",
			limiter: context.limiter,
			clientKey,
		});
		const guard = await pendingGuard;
		const priority = guardPriority(guard);
		if (priority) return await priority;
		const transaction = await readBrowserCookie(snapshot.cookie, "transaction");
		if (transaction.kind === "invalid") return await notice(400, "cookie_invalid");
		if (transaction.kind === "present") return await notice(409, "signin_in_progress");
		if (!guard.ok) return await guardFailure(guard);
		if (guard.action !== "signin_start") return await notice(503, "internal_error");
		if (await liveSession(context, snapshot)) return accountRedirect(context);
		return await admitStart(context, snapshot, guard.cookieHash);
	} catch {
		return await notice(503, "internal_error");
	}
}

function captureOidcOptions(input: unknown): CoordinatorOidcOptions | undefined {
	const supplied = ownData(input, "oidcOptions");
	if (supplied === undefined) return undefined;
	const fetch = ownData(supplied, "fetch") as CoordinatorOidcOptions["fetch"];
	const timeoutSeconds = ownData(
		supplied,
		"timeoutSeconds",
	) as CoordinatorOidcOptions["timeoutSeconds"];
	return Object.freeze({ fetch, timeoutSeconds });
}

/** Unmounted start handlers only. No callback, cleanup, session rotation or route registration. */
export async function createCoordinatorBrowserSigninStart(
	input: CoordinatorBrowserSigninStartInput,
): Promise<CoordinatorBrowserSigninStartResult> {
	try {
		const settings = captureCoordinatorBrowserAuthConfig(ownData(input, "config"));
		if (settings.kind === "disabled")
			return Object.freeze({ ok: false, error: "browser_auth_disabled" });
		if (settings.kind === "invalid")
			return Object.freeze({
				ok: false,
				error: "browser_auth_config_invalid",
				field: settings.field,
			});
		const csrfKey = ownData(input, "csrfKey") as BrowserCsrfKey;
		const receiver = ownData(input, "store");
		const start = dataMethod(
			receiver,
			"startAuthBrowserTransaction",
		) as SigninStore["startAuthBrowserTransaction"];
		const read = dataMethod(receiver, "readAuthSession") as SigninStore["readAuthSession"];
		const store: SigninStore = Object.freeze({
			startAuthBrowserTransaction: start.bind(receiver),
			readAuthSession: read.bind(receiver),
		});
		const limiter = ownData(input, "limiter") as InMemoryRequestRateLimiter;
		dataMethod(limiter, "check");
		const oidcOptions = captureOidcOptions(input);
		const scope = Object.freeze({ publicOrigin: settings.publicOrigin, store: settings.store });
		const signinUrl = new URL("/auth/sign-in", settings.publicOrigin).href;
		const accountUrl = new URL("/auth/account", settings.publicOrigin).href;
		const oidc = await createCoordinatorOidcClient(settings.oidc, oidcOptions);
		if (!oidc.ok) return Object.freeze({ ok: false, error: oidc.error });
		const context: Context = Object.freeze({
			storeConfig: settings.store,
			scope,
			csrfKey,
			store,
			limiter,
			client: oidc.client,
			signinUrl,
			accountUrl,
		});
		return Object.freeze({
			ok: true,
			handlers: Object.freeze({
				signInPage: (request: Request) => signInPage(context, request),
				signInStart: (request: Request, clientKey: string) =>
					signInStart(context, request, clientKey),
			}),
		});
	} catch {
		return Object.freeze({ ok: false, error: "invalid_input" });
	}
}
