import type { CoordinatorAuthBrowserTransactionStore } from "./coordinator-auth-browser-transaction-contract.js";
import {
	type CoordinatorAuthBrowserPage,
	renderAuthBrowserNotice,
	renderAuthLinkStartPage,
	renderAuthSigninContinuePage,
} from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	decodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
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
import { snapshotBrowserRequest } from "./coordinator-browser-request.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

type LinkStartStore = Pick<CoordinatorAuthBrowserTransactionStore, "startAuthBrowserTransaction">;
type Settings = Extract<CoordinatorBrowserAuthSettings, { kind: "enabled" }>;
export interface CoordinatorBrowserLinkStartInput {
	config: unknown;
	csrfKey: BrowserCsrfKey;
	store: LinkStartStore;
	limiter: InMemoryRequestRateLimiter;
	oidcOptions?: CoordinatorOidcOptions;
}
export type CoordinatorBrowserLinkStartOutcome =
	| "link_start_page"
	| "link_started"
	| "link_in_progress"
	| "method_not_allowed"
	| "not_found"
	| "form_invalid"
	| "cookie_invalid"
	| "origin_rejected"
	| "rate_limited"
	| "unsupported_media_type"
	| "body_too_large"
	| "cookie_missing"
	| "csrf_invalid"
	| "attempt_unavailable"
	| "start_conflict"
	| "start_limited"
	| "provider_request_failed"
	| "internal_error";
export type CoordinatorBrowserLinkStartResponse = Readonly<{
	response: Response;
	outcome: CoordinatorBrowserLinkStartOutcome;
}>;
export interface CoordinatorBrowserLinkStartHandlers {
	linkStartPage(request: Request): Promise<CoordinatorBrowserLinkStartResponse>;
	linkStart(request: Request, clientKey: string): Promise<CoordinatorBrowserLinkStartResponse>;
}
export type CoordinatorBrowserLinkStartResult =
	| Readonly<{ ok: true; handlers: Readonly<CoordinatorBrowserLinkStartHandlers> }>
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
type Context = Readonly<{
	storeConfig: Settings["store"];
	scope: BrowserCsrfScope;
	csrfKey: BrowserCsrfKey;
	store: LinkStartStore;
	limiter: InMemoryRequestRateLimiter;
	client: CoordinatorOidcClient;
	startUrl: string;
}>;
type Snapshot = ReturnType<typeof snapshotBrowserRequest>;
type LinkGuard = Extract<BrowserFormGuardResult, { ok: true; action: "link_start" }>;
const requestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get;
const headersGet = Headers.prototype.get;
const MAX_START_URL_LENGTH = 8192;

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
function result(
	response: Response,
	outcome: CoordinatorBrowserLinkStartOutcome,
): CoordinatorBrowserLinkStartResponse {
	return Object.freeze({ response, outcome });
}
function pageResponse(
	page: CoordinatorAuthBrowserPage,
	status = 200,
	extra?: Record<string, string>,
): Response {
	const headers = new Headers(page.headers);
	if (extra)
		new Headers(extra).forEach((value, name) => {
			headers.set(name, value);
		});
	return new Response(page.body, { status, headers });
}
async function notice(
	status: number,
	outcome: CoordinatorBrowserLinkStartOutcome,
	extra?: Record<string, string>,
): Promise<CoordinatorBrowserLinkStartResponse> {
	try {
		return result(
			pageResponse(await renderAuthBrowserNotice("unavailable"), status, extra),
			outcome,
		);
	} catch {
		return result(
			new Response("Account linking unavailable. Return to your terminal and try again.", {
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
}
function parseStartQuery(context: Context, text: string) {
	const url = new URL(text);
	if (
		text.includes("#") ||
		url.href !== text ||
		`${url.origin}${url.pathname}` !== context.startUrl ||
		url.username ||
		url.password
	)
		return null;
	const entries = [...url.searchParams];
	if (
		entries.length !== 2 ||
		url.searchParams.getAll("attempt_id").length !== 1 ||
		url.searchParams.getAll("start_code").length !== 1
	)
		return null;
	const attemptId = url.searchParams.get("attempt_id");
	const startCode = url.searchParams.get("start_code");
	if (
		!isAuthControllerId(attemptId) ||
		typeof startCode !== "string" ||
		!decodeCoordinatorAuthProof32(startCode)
	)
		return null;
	return Object.freeze({ attemptId, startCode });
}
async function linkStartPage(
	context: Context,
	request: Request,
): Promise<CoordinatorBrowserLinkStartResponse> {
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "GET") return await notice(405, "method_not_allowed", { Allow: "GET" });
		if (snapshot.url.length > MAX_START_URL_LENGTH) return await notice(400, "form_invalid");
		const url = new URL(snapshot.url);
		if (`${url.origin}${url.pathname}` !== context.startUrl || url.username || url.password)
			return await notice(404, "not_found");
		const query = parseStartQuery(context, snapshot.url);
		if (!query) return await notice(400, "form_invalid");
		const transaction = await readBrowserCookie(snapshot.cookie, "transaction");
		if (transaction.kind === "invalid") return await notice(400, "cookie_invalid");
		if (transaction.kind === "present") return await notice(409, "link_in_progress");
		const existing = await readBrowserCookie(snapshot.cookie, "start");
		if (existing.kind === "invalid") return await notice(400, "cookie_invalid");
		const cookie = existing.kind === "present" ? existing : await issueBrowserCookie("start");
		const csrfToken = await issueBrowserCsrfToken(
			context.csrfKey,
			cookie.secret,
			"start",
			context.scope,
		);
		const response = pageResponse(await renderAuthLinkStartPage({ ...query, csrfToken }));
		if ("setCookie" in cookie) response.headers.append("Set-Cookie", cookie.setCookie);
		return result(response, "link_start_page");
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
	guard: LinkGuard,
): Promise<CoordinatorBrowserLinkStartResponse> {
	const start = await readBrowserCookie(snapshot.cookie, "start");
	if (start.kind !== "present" || start.cookieHash !== guard.cookieHash)
		return notice(503, "internal_error");
	const bytes = decodeCoordinatorAuthProof32(guard.startCode);
	if (!bytes) return notice(400, "form_invalid");
	const browserStartHash = await hashCoordinatorAuthProofBytes32(bytes);
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
	// Release promotion only after both private-proof and unique-binder SQL guards commit.
	const admitted = await context.store.startAuthBrowserTransaction(
		{
			purpose: "link",
			attemptId: guard.attemptId,
			browserStartHash,
			stateHash,
			binderHash: guard.cookieHash,
			nonce: authorization.material.nonce,
			pkceVerifier: authorization.material.pkceVerifier,
		},
		context.storeConfig,
	);
	if (admitted.kind === "started") return result(response, "link_started");
	if (admitted.kind === "rejected") {
		if (admitted.error === "attempt_unavailable" || admitted.error === "attempt_expired")
			return notice(409, "attempt_unavailable");
		if (admitted.error === "transaction_conflict") return notice(409, "start_conflict");
		if (admitted.error === "transaction_limited" || admitted.error === "clock_retention_blocked")
			return notice(503, "start_limited");
	}
	return notice(503, "internal_error");
}
async function linkStart(
	context: Context,
	request: Request,
	clientKey: string,
): Promise<CoordinatorBrowserLinkStartResponse> {
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "POST")
			return await notice(405, "method_not_allowed", { Allow: "POST" });
		if (snapshot.url.length > MAX_START_URL_LENGTH) return await notice(400, "form_invalid");
		const headers = requestHeaders?.call(request) as Headers;
		if (
			new URL(snapshot.url).origin !== context.scope.publicOrigin ||
			headersGet.call(headers, "origin") !== context.scope.publicOrigin
		)
			return await notice(403, "origin_rejected");
		if (snapshot.url !== context.startUrl) return await notice(404, "not_found");
		// Capture the guard's native fields in the same synchronous tick.
		const pendingGuard = guardBrowserForm({
			request,
			scope: context.scope,
			csrfKey: context.csrfKey,
			action: "link_start",
			limiter: context.limiter,
			clientKey,
		});
		const guard = await pendingGuard;
		const priority = guardPriority(guard);
		if (priority) return await priority;
		const transaction = await readBrowserCookie(snapshot.cookie, "transaction");
		if (transaction.kind === "invalid") return await notice(400, "cookie_invalid");
		if (transaction.kind === "present") return await notice(409, "link_in_progress");
		if (!guard.ok) return await guardFailure(guard);
		if (guard.action !== "link_start") return await notice(503, "internal_error");
		return await admitStart(context, snapshot, guard);
	} catch {
		return await notice(503, "internal_error");
	}
}
function captureOidcOptions(input: unknown): CoordinatorOidcOptions | undefined {
	const supplied = ownData(input, "oidcOptions");
	if (supplied === undefined) return undefined;
	return Object.freeze({
		fetch: ownData(supplied, "fetch") as CoordinatorOidcOptions["fetch"],
		timeoutSeconds: ownData(supplied, "timeoutSeconds") as CoordinatorOidcOptions["timeoutSeconds"],
	});
}
/** Unmounted private-code entry only; sessions, completion and cleanup are independent.
 * A future gateway must redact the handoff query, Referer and form body from logs.
 */
export async function createCoordinatorBrowserLinkStart(
	input: CoordinatorBrowserLinkStartInput,
): Promise<CoordinatorBrowserLinkStartResult> {
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
		) as LinkStartStore["startAuthBrowserTransaction"];
		const store = Object.freeze({ startAuthBrowserTransaction: start.bind(receiver) });
		const limiter = ownData(input, "limiter") as InMemoryRequestRateLimiter;
		dataMethod(limiter, "check");
		const oidcOptions = captureOidcOptions(input);
		const scope = Object.freeze({ publicOrigin: settings.publicOrigin, store: settings.store });
		const startUrl = new URL("/auth/link/start", settings.publicOrigin).href;
		const oidc = await createCoordinatorOidcClient(settings.oidc, oidcOptions);
		if (!oidc.ok) return Object.freeze({ ok: false, error: oidc.error });
		const context: Context = Object.freeze({
			storeConfig: settings.store,
			scope,
			csrfKey,
			store,
			limiter,
			client: oidc.client,
			startUrl,
		});
		return Object.freeze({
			ok: true,
			handlers: Object.freeze({
				linkStartPage: (request: Request) => linkStartPage(context, request),
				linkStart: (request: Request, clientKey: string) => linkStart(context, request, clientKey),
			}),
		});
	} catch {
		return Object.freeze({ ok: false, error: "invalid_input" });
	}
}
