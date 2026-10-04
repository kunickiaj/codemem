import type { CoordinatorAuthAccountProfileStore } from "./coordinator-auth-account-profile-contract.js";
import type {
	CoordinatorAuthBrowserTransactionConsumeResult,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import { renderAuthBrowserNotice } from "./coordinator-auth-browser-view.js";
import type { CoordinatorAuthSessionStore } from "./coordinator-auth-session-contract.js";
import {
	type CoordinatorBrowserAuthConfigField,
	type CoordinatorBrowserAuthSettings,
	captureCoordinatorBrowserAuthConfig,
} from "./coordinator-browser-auth-config.js";
import {
	type BrowserCookieReadResult,
	type BrowserCookieSecret,
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";

type CallbackStore = Pick<CoordinatorAuthBrowserTransactionStore, "consumeAuthBrowserTransaction"> &
	Pick<CoordinatorAuthSessionStore, "readAuthSession" | "signInWithConsumedBrowserTransaction"> &
	Pick<CoordinatorAuthAccountProfileStore, "recordAuthAccountProfile">;
type Settings = Extract<CoordinatorBrowserAuthSettings, { kind: "enabled" }>;
type Consumed = Extract<CoordinatorAuthBrowserTransactionConsumeResult, { kind: "consumed" }>;
type TransactionCookie = Extract<BrowserCookieReadResult, { kind: "present" }>;
type Verification = Awaited<ReturnType<CoordinatorOidcClient["verifyCallback"]>>;
export type CoordinatorBrowserAuthLinkCompletionInput = Readonly<{
	attemptId: string;
	browserTransactionHash: string;
	transactionCookie: BrowserCookieSecret;
	transactionCookieHash: string;
	verification: Readonly<Verification>;
}>;
export interface CoordinatorBrowserAuthCallbackInput {
	config: unknown;
	store: CallbackStore;
	completeLink: (input: CoordinatorBrowserAuthLinkCompletionInput) => Promise<Response>;
	oidcOptions?: CoordinatorOidcOptions;
}
export type CoordinatorBrowserAuthCallbackOutcome =
	| "signed_in"
	| "signed_in_profile_not_recorded"
	| "session_live"
	| "link_dispatched"
	| "method_not_allowed"
	| "not_found"
	| "callback_invalid"
	| "state_invalid"
	| "cookie_invalid"
	| "cookie_missing"
	| "transaction_unavailable"
	| "verification_failed"
	| "signin_rejected"
	| "link_continuation_failed"
	| "internal_error";
export type CoordinatorBrowserAuthCallbackResponse = Readonly<{
	response: Response;
	outcome: CoordinatorBrowserAuthCallbackOutcome;
}>;
export interface CoordinatorBrowserAuthCallbackHandlers {
	callback(request: Request): Promise<CoordinatorBrowserAuthCallbackResponse>;
}
export type CoordinatorBrowserAuthCallbackResult =
	| Readonly<{ ok: true; handlers: Readonly<CoordinatorBrowserAuthCallbackHandlers> }>
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
function captureStore(receiver: unknown): CallbackStore {
	const consume = dataMethod(
		receiver,
		"consumeAuthBrowserTransaction",
	) as CallbackStore["consumeAuthBrowserTransaction"];
	const read = dataMethod(receiver, "readAuthSession") as CallbackStore["readAuthSession"];
	const signin = dataMethod(
		receiver,
		"signInWithConsumedBrowserTransaction",
	) as CallbackStore["signInWithConsumedBrowserTransaction"];
	const profile = dataMethod(
		receiver,
		"recordAuthAccountProfile",
	) as CallbackStore["recordAuthAccountProfile"];
	return Object.freeze({
		consumeAuthBrowserTransaction: (...args) => Reflect.apply(consume, receiver, args),
		readAuthSession: (...args) => Reflect.apply(read, receiver, args),
		signInWithConsumedBrowserTransaction: (...args) => Reflect.apply(signin, receiver, args),
		recordAuthAccountProfile: (...args) => Reflect.apply(profile, receiver, args),
	});
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
function nativeGetter(prototype: object, name: string): ((this: Request) => unknown) | undefined {
	let cursor: object | null = prototype;
	while (cursor !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(cursor, name);
		if (descriptor) return descriptor.get;
		cursor = Object.getPrototypeOf(cursor);
	}
	return undefined;
}
const requestGetters = Object.freeze({
	method: nativeGetter(Request.prototype, "method"),
	url: nativeGetter(Request.prototype, "url"),
	headers: nativeGetter(Request.prototype, "headers"),
});
const headersGet = Headers.prototype.get;
const responseStatus = nativeGetter(Response.prototype, "status");
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
	publicOrigin: string;
	callbackURI: string;
	client: CoordinatorOidcClient;
	store: CallbackStore;
	completeLink: CoordinatorBrowserAuthCallbackInput["completeLink"];
}>;

function result(
	response: Response,
	outcome: CoordinatorBrowserAuthCallbackOutcome,
): CoordinatorBrowserAuthCallbackResponse {
	return Object.freeze({ response, outcome });
}
function clearTransaction(headers: Headers): void {
	headers.append("Set-Cookie", clearBrowserCookie("transaction"));
}
async function notice(
	status: number,
	outcome: CoordinatorBrowserAuthCallbackOutcome,
	options: { clearTransaction?: boolean; allow?: string } = {},
): Promise<CoordinatorBrowserAuthCallbackResponse> {
	try {
		const page = await renderAuthBrowserNotice("auth_unavailable");
		const headers = new Headers(page.headers);
		if (options.allow) headers.set("Allow", options.allow);
		if (options.clearTransaction) clearTransaction(headers);
		return result(new Response(page.body, { status, headers }), outcome);
	} catch {
		const headers = new Headers({
			"Content-Type": "text/plain;charset=utf-8",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		});
		if (options.allow) headers.set("Allow", options.allow);
		if (options.clearTransaction) clearTransaction(headers);
		return result(
			new Response(
				"Sign-in or linking unavailable. Return to the flow you started and try again.",
				{ status: 503, headers },
			),
			"internal_error",
		);
	}
}
function accountResponse(context: Context, sessionCookie?: string): Response {
	const headers = new Headers({
		Location: new URL("/auth/account", context.publicOrigin).href,
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	if (sessionCookie) headers.append("Set-Cookie", sessionCookie);
	clearTransaction(headers);
	return new Response(null, { status: 303, headers });
}
function callbackState(
	context: Context,
	snapshot: Snapshot,
): { state: string } | { error: "callback_invalid" | "not_found" | "state_invalid" } {
	if (snapshot.url.length > 8192 || snapshot.url.includes("#"))
		return { error: "callback_invalid" };
	let url: URL;
	try {
		url = new URL(snapshot.url);
	} catch {
		return { error: "callback_invalid" };
	}
	const redirect = new URL(context.callbackURI);
	if (url.origin !== redirect.origin || url.pathname !== redirect.pathname)
		return { error: "not_found" };
	const states = url.searchParams.getAll("state");
	const state = states[0];
	if (
		states.length !== 1 ||
		typeof state !== "string" ||
		state.length < 43 ||
		state.length > 128 ||
		!/^[A-Za-z0-9._~-]+$/.test(state)
	)
		return { error: "state_invalid" };
	return { state };
}
async function hashState(state: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function verify(
	context: Context,
	snapshot: Snapshot,
	state: string,
	consumed: Consumed,
): Promise<Readonly<Verification>> {
	try {
		const verified = await context.client.verifyCallback({
			callbackUrl: snapshot.url,
			material: { state, nonce: consumed.nonce, pkceVerifier: consumed.pkceVerifier },
		});
		if (!verified.ok) return Object.freeze({ ok: false, error: verified.error });
		if (verified.account.issuer !== context.storeConfig.issuer) throw new Error();
		return Object.freeze({
			ok: true,
			account: Object.freeze({ ...verified.account }),
			profile: Object.freeze({ ...verified.profile }),
		});
	} catch {
		return Object.freeze({ ok: false, error: "oidc_verification_failed" });
	}
}
async function dispatchLink(
	context: Context,
	consumed: Extract<Consumed, { purpose: "link" }>,
	cookie: TransactionCookie,
	verification: Readonly<Verification>,
): Promise<CoordinatorBrowserAuthCallbackResponse> {
	try {
		const response = await context.completeLink(
			Object.freeze({
				attemptId: consumed.attemptId,
				browserTransactionHash: consumed.browserTransactionHash,
				transactionCookie: cookie.secret,
				transactionCookieHash: cookie.cookieHash,
				verification,
			}),
		);
		// Use the native brand check, not an overridable status property or instanceof.
		if (!responseStatus || typeof Reflect.apply(responseStatus, response, []) !== "number")
			throw new Error();
		return result(response, "link_dispatched");
	} catch {
		return notice(503, "link_continuation_failed");
	}
}
async function recordProfile(
	context: Context,
	credentialHash: string,
	verification: Extract<Verification, { ok: true }>,
	response: Response,
): Promise<CoordinatorBrowserAuthCallbackResponse> {
	try {
		const recorded = await context.store.recordAuthAccountProfile(
			{ credentialHash, profile: verification.profile },
			context.storeConfig,
		);
		if (recorded.kind === "recorded") return result(response, "signed_in");
	} catch {
		// Display metadata failure must not discard a durably issued session response.
	}
	return result(response, "signed_in_profile_not_recorded");
}
async function signIn(
	context: Context,
	snapshot: Snapshot,
	consumed: Consumed,
	verification: Readonly<Verification>,
): Promise<CoordinatorBrowserAuthCallbackResponse> {
	if (!verification.ok) return notice(403, "verification_failed", { clearTransaction: true });
	const existing = await readBrowserCookie(snapshot.cookie, "session");
	if (existing.kind === "invalid") throw new Error();
	if (
		existing.kind === "present" &&
		(await context.store.readAuthSession(existing.cookieHash, context.storeConfig))
	)
		return result(accountResponse(context), "session_live");
	const issued = await issueBrowserCookie("session");
	const response = accountResponse(context, issued.setCookie);
	// Prebuild cookies locally; release the session bearer only after guarded persistence.
	const persisted = await context.store.signInWithConsumedBrowserTransaction(
		{
			browserTransactionHash: consumed.browserTransactionHash,
			account: verification.account,
			credentialHash: issued.cookieHash,
		},
		context.storeConfig,
	);
	if (persisted.kind !== "issued")
		return notice(403, "signin_rejected", { clearTransaction: true });
	return recordProfile(context, issued.cookieHash, verification, response);
}
async function callback(
	context: Context,
	request: Request,
): Promise<CoordinatorBrowserAuthCallbackResponse> {
	let clearSigninTransaction = false;
	try {
		const snapshot = snapshotRequest(request);
		if (snapshot.method !== "GET") return await notice(405, "method_not_allowed", { allow: "GET" });
		const parsed = callbackState(context, snapshot);
		if ("error" in parsed)
			return await notice(parsed.error === "not_found" ? 404 : 400, parsed.error);
		const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
		if (cookie.kind === "invalid") return await notice(400, "cookie_invalid");
		if (cookie.kind === "absent") return await notice(403, "cookie_missing");
		const stateHash = await hashState(parsed.state);
		// Atomic consumption burns matching material before any provider verification.
		const consumed = await context.store.consumeAuthBrowserTransaction(
			{ stateHash, binderHash: cookie.cookieHash },
			context.storeConfig,
		);
		if (consumed.kind !== "consumed") return await notice(403, "transaction_unavailable");
		clearSigninTransaction = consumed.purpose === "signin";
		const verification = await verify(context, snapshot, parsed.state, consumed);
		if (consumed.purpose === "link")
			return await dispatchLink(context, consumed, cookie, verification);
		if (consumed.purpose !== "signin") throw new Error();
		return await signIn(context, snapshot, consumed, verification);
	} catch {
		// A consume throw is ambiguous: never claim rollback or clear an unknown purpose.
		return notice(503, "internal_error", { clearTransaction: clearSigninTransaction });
	}
}

/** Unmounted callback only. Linking lifecycle and route registration belong to callers. */
export async function createCoordinatorBrowserAuthCallback(
	input: CoordinatorBrowserAuthCallbackInput,
): Promise<CoordinatorBrowserAuthCallbackResult> {
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
		const completeLink = ownData(input, "completeLink");
		if (typeof completeLink !== "function") throw new Error();
		const store = captureStore(ownData(input, "store"));
		const options = captureOidcOptions(input);
		const oidc = await createCoordinatorOidcClient(settings.oidc, options);
		if (!oidc.ok) return Object.freeze({ ok: false, error: oidc.error });
		const context: Context = Object.freeze({
			storeConfig: settings.store,
			publicOrigin: settings.publicOrigin,
			callbackURI: settings.store.redirectUri,
			client: oidc.client,
			store,
			completeLink: completeLink as CoordinatorBrowserAuthCallbackInput["completeLink"],
		});
		return Object.freeze({
			ok: true,
			handlers: Object.freeze({ callback: (request: Request) => callback(context, request) }),
		});
	} catch {
		return Object.freeze({ ok: false, error: "invalid_input" });
	}
}
