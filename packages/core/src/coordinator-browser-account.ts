import type { CoordinatorAuthAccountProfileStore } from "./coordinator-auth-account-profile-contract.js";
import {
	AUTH_BROWSER_FORM_ACTIONS,
	type CoordinatorAuthBrowserPage,
	renderAuthBrowserNotice,
	renderCurrentAccountPage,
} from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorAuthSessionStore } from "./coordinator-auth-session-contract.js";
import {
	type CoordinatorBrowserAuthConfigField,
	type CoordinatorBrowserAuthSettings,
	captureCoordinatorBrowserAuthConfig,
} from "./coordinator-browser-auth-config.js";
import { clearBrowserCookie, readBrowserCookie } from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	type BrowserCsrfScope,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { type BrowserFormGuardResult, guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest as snapshotRequest } from "./coordinator-browser-request.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

type AccountStore = Pick<CoordinatorAuthAccountProfileStore, "readAuthSessionAccount"> &
	Pick<CoordinatorAuthSessionStore, "readAuthSession" | "signOutAuthSession">;
type StoreConfig = Extract<CoordinatorBrowserAuthSettings, { kind: "enabled" }>["store"];
export interface CoordinatorBrowserAccountInput {
	config: unknown;
	csrfKey: BrowserCsrfKey;
	store: AccountStore;
	limiter: InMemoryRequestRateLimiter;
}
export type CoordinatorBrowserAccountOutcome =
	| "account_page"
	| "signed_out"
	| "already_signed_out"
	| "method_not_allowed"
	| "not_found"
	| "cookie_invalid"
	| "origin_rejected"
	| "rate_limited"
	| "unsupported_media_type"
	| "body_too_large"
	| "form_invalid"
	| "csrf_invalid"
	| "signout_unconfirmed"
	| "internal_error";
export type CoordinatorBrowserAccountResponse = Readonly<{
	response: Response;
	outcome: CoordinatorBrowserAccountOutcome;
}>;
export interface CoordinatorBrowserAccountHandlers {
	account(request: Request): Promise<CoordinatorBrowserAccountResponse>;
	logout(request: Request, clientKey: string): Promise<CoordinatorBrowserAccountResponse>;
}
export type CoordinatorBrowserAccountResult =
	| Readonly<{ ok: true; handlers: Readonly<CoordinatorBrowserAccountHandlers> }>
	| Readonly<{
			ok: false;
			error: "browser_auth_config_invalid";
			field: CoordinatorBrowserAuthConfigField;
	  }>
	| Readonly<{ ok: false; error: "browser_auth_disabled" | "invalid_input" }>;

function object(value: unknown): asserts value is object {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
}
function plain(value: unknown): void {
	object(value);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error();
}
function ownData(value: unknown, name: string): unknown {
	object(value);
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error();
	return descriptor.value;
}
function dataMethod(value: unknown, name: string): unknown {
	object(value);
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
type Context = Readonly<{
	storeConfig: StoreConfig;
	publicOrigin: string;
	scope: BrowserCsrfScope;
	signoutScope: Readonly<{ coordinatorId: string }>;
	csrfKey: BrowserCsrfKey;
	store: AccountStore;
	limiter: InMemoryRequestRateLimiter;
}>;
function result(
	response: Response,
	outcome: CoordinatorBrowserAccountOutcome,
): CoordinatorBrowserAccountResponse {
	return Object.freeze({ response, outcome });
}
function pageResponse(
	page: CoordinatorAuthBrowserPage,
	status = 200,
	extra?: Record<string, string>,
) {
	const headers = new Headers(page.headers);
	headers.set("Cache-Control", "no-store");
	if (extra)
		new Headers(extra).forEach((value, name) => {
			headers.set(name, value);
		});
	return new Response(page.body, { status, headers });
}
function fallback(): CoordinatorBrowserAccountResponse {
	return result(
		new Response("Account unavailable. Try again.", {
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
	outcome: CoordinatorBrowserAccountOutcome,
	extra?: Record<string, string>,
): Promise<CoordinatorBrowserAccountResponse> {
	try {
		const kind = status === 200 ? "signed_out" : "auth_unavailable";
		return result(pageResponse(await renderAuthBrowserNotice(kind), status, extra), outcome);
	} catch {
		return fallback();
	}
}
function routeError(snapshot: ReturnType<typeof snapshotRequest>, url: string, method: string) {
	if (snapshot.method !== method) return notice(405, "method_not_allowed", { Allow: method });
	if (snapshot.url !== url) return notice(404, "not_found");
	return null;
}
function captureSession(value: unknown, context: Context): string {
	plain(value);
	const account = ownData(value, "account");
	plain(account);
	const issuer = ownData(account, "issuer");
	const identityId = ownData(value, "identityId");
	if (issuer !== context.storeConfig.issuer || !isAuthControllerId(identityId)) throw new Error();
	return identityId;
}
async function account(
	context: Context,
	request: Request,
): Promise<CoordinatorBrowserAccountResponse> {
	try {
		const snapshot = snapshotRequest(request);
		const routing = routeError(snapshot, `${context.publicOrigin}/auth/account`, "GET");
		if (routing) return await routing;
		const cookie = await readBrowserCookie(snapshot.cookie, "session");
		if (cookie.kind === "invalid") return await notice(200, "cookie_invalid");
		if (cookie.kind === "absent") return await notice(200, "signed_out");
		const current = await context.store.readAuthSessionAccount(
			cookie.cookieHash,
			context.storeConfig,
		);
		if (current === null) return await notice(200, "signed_out");
		plain(current);
		const identityId = captureSession(ownData(current, "session"), context);
		const profile = ownData(current, "profile");
		const csrfToken = await issueBrowserCsrfToken(
			context.csrfKey,
			cookie.secret,
			"session",
			context.scope,
		);
		return result(
			pageResponse(
				await renderCurrentAccountPage({
					profile,
					issuer: context.storeConfig.issuer,
					identity: { id: identityId },
					csrfToken,
				}),
			),
			"account_page",
		);
	} catch {
		return await notice(503, "internal_error");
	}
}
function guardFailure(guard: Extract<BrowserFormGuardResult, { ok: false }>) {
	switch (guard.error) {
		case "origin_rejected":
			return notice(403, guard.error);
		case "rate_limited":
			return notice(429, guard.error, { "Retry-After": String(guard.retryAfterS) });
		case "cookie_missing":
			return notice(200, "signed_out");
		case "unsupported_media_type":
			return notice(415, guard.error);
		case "body_too_large":
			return notice(413, guard.error);
		case "form_invalid":
			return notice(400, guard.error);
		case "cookie_invalid":
		case "csrf_invalid":
			return notice(403, guard.error);
		default:
			return notice(503, "internal_error");
	}
}
async function signOut(context: Context, hash: string): Promise<CoordinatorBrowserAccountResponse> {
	// Build before touching persistence. Failure must keep the credential available for retry.
	const response = pageResponse(await renderAuthBrowserNotice("signed_out"));
	response.headers.append("Set-Cookie", clearBrowserCookie("session"));
	const before = await context.store.readAuthSession(hash, context.storeConfig);
	// Current-config absence deliberately clears only the browser, without revoking old rows.
	if (before === null) return result(response, "already_signed_out");
	captureSession(before, context);
	const written = await context.store.signOutAuthSession(hash, context.signoutScope);
	plain(written);
	if (ownData(written, "kind") !== "signed_out") return notice(503, "internal_error");
	const after = await context.store.readAuthSession(hash, context.storeConfig);
	if (after === null) return result(response, "signed_out");
	captureSession(after, context);
	return notice(503, "signout_unconfirmed");
}
async function logout(
	context: Context,
	request: Request,
	clientKey: string,
): Promise<CoordinatorBrowserAccountResponse> {
	try {
		const snapshot = snapshotRequest(request);
		const routing = routeError(
			snapshot,
			`${context.publicOrigin}${AUTH_BROWSER_FORM_ACTIONS.signOut}`,
			"POST",
		);
		if (routing) return await routing;
		// No asynchronous boundary between our cookie snapshot and the guard's native snapshot.
		const pendingGuard = guardBrowserForm({
			request,
			scope: context.scope,
			csrfKey: context.csrfKey,
			action: "session_logout",
			limiter: context.limiter,
			clientKey,
		});
		const guard = await pendingGuard;
		if (!guard.ok) return await guardFailure(guard);
		if (guard.action !== "session_logout") return await notice(503, "internal_error");
		const cookie = await readBrowserCookie(snapshot.cookie, "session");
		if (cookie.kind !== "present" || cookie.cookieHash !== guard.cookieHash)
			return await notice(503, "internal_error");
		return await signOut(context, cookie.cookieHash);
	} catch {
		return await notice(503, "internal_error");
	}
}
function captureStore(receiver: unknown): AccountStore {
	const readAccount = dataMethod(
		receiver,
		"readAuthSessionAccount",
	) as AccountStore["readAuthSessionAccount"];
	const read = dataMethod(receiver, "readAuthSession") as AccountStore["readAuthSession"];
	const signout = dataMethod(receiver, "signOutAuthSession") as AccountStore["signOutAuthSession"];
	return Object.freeze({
		readAuthSessionAccount: readAccount.bind(receiver),
		readAuthSession: read.bind(receiver),
		signOutAuthSession: signout.bind(receiver),
	});
}
/** Unmounted local account/logout only. No provider client, profile writes or route registration. */
export async function createCoordinatorBrowserAccount(
	input: CoordinatorBrowserAccountInput,
): Promise<CoordinatorBrowserAccountResult> {
	try {
		const config = ownData(input, "config");
		const settings = captureCoordinatorBrowserAuthConfig(config);
		if (settings.kind === "disabled")
			return Object.freeze({ ok: false, error: "browser_auth_disabled" });
		if (settings.kind === "invalid")
			return Object.freeze({
				ok: false,
				error: "browser_auth_config_invalid",
				field: settings.field,
			});
		const csrfKey = ownData(input, "csrfKey") as BrowserCsrfKey;
		object(csrfKey);
		const store = captureStore(ownData(input, "store"));
		const limiter = ownData(input, "limiter") as InMemoryRequestRateLimiter;
		dataMethod(limiter, "check");
		const context: Context = Object.freeze({
			storeConfig: settings.store,
			publicOrigin: settings.publicOrigin,
			scope: Object.freeze({ publicOrigin: settings.publicOrigin, store: settings.store }),
			signoutScope: Object.freeze({ coordinatorId: settings.store.coordinatorId }),
			csrfKey,
			store,
			limiter,
		});
		return Object.freeze({
			ok: true,
			handlers: Object.freeze({
				account: (request: Request) => account(context, request),
				logout: (request: Request, clientKey: string) => logout(context, request, clientKey),
			}),
		});
	} catch {
		return Object.freeze({ ok: false, error: "invalid_input" });
	}
}
