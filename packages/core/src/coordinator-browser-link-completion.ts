import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import {
	AUTH_BROWSER_FORM_ACTIONS,
	type CoordinatorAuthBrowserPage,
	renderAuthBrowserNotice,
	renderAuthLinkCompletionPage,
} from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { CoordinatorAuthLinkStore } from "./coordinator-auth-link-contract.js";
import type { CoordinatorAuthSessionStore } from "./coordinator-auth-session-contract.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	type BrowserCsrfScope,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { type BrowserFormGuardResult, guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest } from "./coordinator-browser-request.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

type CompletionStore = Pick<
	CoordinatorAuthBrowserTransactionStore,
	"resolveAuthLinkBrowserTransaction"
> &
	Pick<CoordinatorAuthLinkStore, "getAuthLinkAttemptStatus"> &
	Pick<
		CoordinatorAuthSessionStore,
		| "readAuthSession"
		| "redeemAuthLinkSessionWithBrowserTransaction"
		| "preserveAuthLinkSessionCompletion"
	>;
export interface CoordinatorBrowserLinkCompletionInput {
	config?: CoordinatorAuthBrowserConfig;
	csrfKey: BrowserCsrfKey;
	store: CompletionStore;
	limiter: InMemoryRequestRateLimiter;
}
export type CoordinatorBrowserLinkCompletionOutcome =
	| "waiting"
	| "ready"
	| "session_preserved"
	| "session_issued"
	| "method_not_allowed"
	| "not_found"
	| "query_invalid"
	| "completion_rejected"
	| "origin_rejected"
	| "rate_limited"
	| "unsupported_media_type"
	| "body_too_large"
	| "form_invalid"
	| "cookie_invalid"
	| "csrf_invalid"
	| "internal_error";
export type CoordinatorBrowserLinkCompletionResponse = Readonly<{
	response: Response;
	outcome: CoordinatorBrowserLinkCompletionOutcome;
}>;
export interface CoordinatorBrowserLinkCompletionHandlers {
	page(request: Request): Promise<CoordinatorBrowserLinkCompletionResponse>;
	complete(request: Request, clientKey: string): Promise<CoordinatorBrowserLinkCompletionResponse>;
}
export type CoordinatorBrowserLinkCompletionResult =
	| Readonly<{ ok: false; error: "browser_auth_disabled" }>
	| Readonly<{ ok: true; handlers: Readonly<CoordinatorBrowserLinkCompletionHandlers> }>;
type Context = Readonly<{
	config: Readonly<CoordinatorAuthBrowserConfig>;
	publicOrigin: string;
	scope: BrowserCsrfScope;
	csrfKey: BrowserCsrfKey;
	store: CompletionStore;
	limiter: InMemoryRequestRateLimiter;
}>;

function result(response: Response, outcome: CoordinatorBrowserLinkCompletionOutcome) {
	return Object.freeze({ response, outcome });
}
function pageResponse(
	page: CoordinatorAuthBrowserPage,
	status = 200,
	extra?: Record<string, string>,
) {
	const headers = new Headers(page.headers);
	if (extra)
		new Headers(extra).forEach((value, name) => {
			headers.set(name, value);
		});
	return new Response(page.body, { status, headers });
}
async function notice(
	status: number,
	outcome: CoordinatorBrowserLinkCompletionOutcome,
	extra?: Record<string, string>,
): Promise<CoordinatorBrowserLinkCompletionResponse> {
	try {
		return result(
			pageResponse(await renderAuthBrowserNotice("auth_unavailable"), status, extra),
			outcome,
		);
	} catch {
		return result(
			new Response("Linking unavailable. Try again.", {
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
function pageAttempt(url: URL): string | null {
	const entries = [...url.searchParams];
	const entry = entries[0];
	if (entries.length !== 1 || !entry || entry[0] !== "attempt_id") return null;
	const attemptId = entry[1];
	if (!isAuthControllerId(attemptId)) return null;
	return attemptId;
}
async function boundStatus(context: Context, attemptId: string, binderHash: string) {
	const resolved = await context.store.resolveAuthLinkBrowserTransaction(
		{ attemptId, binderHash },
		context.config,
	);
	if (resolved === null) return null;
	const browserTransactionHash = resolved.browserTransactionHash;
	const status = await context.store.getAuthLinkAttemptStatus(
		attemptId,
		{ kind: "browser", browserTransactionHash },
		context.config,
	);
	if (status === null) return null;
	return { browserTransactionHash, state: status.state };
}
async function page(
	context: Context,
	request: Request,
): Promise<CoordinatorBrowserLinkCompletionResponse> {
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "GET") return await notice(405, "method_not_allowed", { Allow: "GET" });
		if (snapshot.url.length > 8192) return await notice(400, "query_invalid");
		const url = new URL(snapshot.url);
		if (
			snapshot.url.includes("#") ||
			`${url.origin}${url.pathname}` !==
				`${context.publicOrigin}${AUTH_BROWSER_FORM_ACTIONS.completeLink}` ||
			url.username ||
			url.password
		)
			return await notice(404, "not_found");
		const attemptId = pageAttempt(url);
		if (attemptId === null) return await notice(400, "query_invalid");
		const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
		if (cookie.kind !== "present") return await notice(403, "cookie_invalid");
		const status = await boundStatus(context, attemptId, cookie.cookieHash);
		if (status?.state === "confirmed")
			return result(
				pageResponse(await renderAuthLinkCompletionPage({ attemptId, state: "waiting" })),
				"waiting",
			);
		if (status?.state !== "finalized") return await notice(403, "completion_rejected");
		const csrfToken = await issueBrowserCsrfToken(
			context.csrfKey,
			cookie.secret,
			"transaction",
			context.scope,
		);
		return result(
			pageResponse(await renderAuthLinkCompletionPage({ attemptId, state: "ready", csrfToken })),
			"ready",
		);
	} catch {
		return await notice(503, "internal_error");
	}
}
function guardFailure(guard: Extract<BrowserFormGuardResult, { ok: false }>) {
	switch (guard.error) {
		case "origin_rejected":
		case "cookie_invalid":
		case "csrf_invalid":
			return notice(403, guard.error);
		case "cookie_missing":
			return notice(403, "cookie_invalid");
		case "client_unidentified":
			return notice(503, "internal_error");
		case "rate_limited":
			return notice(429, guard.error, { "Retry-After": String(guard.retryAfterS) });
		case "unsupported_media_type":
			return notice(415, guard.error);
		case "body_too_large":
			return notice(413, guard.error);
		case "form_invalid":
			return notice(400, guard.error);
		default:
			return notice(503, "internal_error");
	}
}
function accountRedirect(context: Context, setCookie?: string): Response {
	const headers = new Headers({
		Location: `${context.publicOrigin}/auth/account`,
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
	});
	if (setCookie) headers.append("Set-Cookie", setCookie);
	headers.append("Set-Cookie", clearBrowserCookie("transaction"));
	return new Response(null, { status: 303, headers });
}
async function finishSession(
	context: Context,
	cookieHeader: string | null,
	attemptId: string,
	binderHash: string,
	browserTransactionHash: string,
) {
	const session = await readBrowserCookie(cookieHeader, "session");
	if (session.kind === "invalid") return notice(403, "cookie_invalid");
	if (session.kind === "present") {
		const live = await context.store.readAuthSession(session.cookieHash, context.config);
		if (live !== null) {
			const response = accountRedirect(context);
			const preserved = await context.store.preserveAuthLinkSessionCompletion(
				{ attemptId, browserTransactionHash, binderHash, credentialHash: session.cookieHash },
				context.config,
			);
			if (preserved.kind !== "preserved") return notice(403, "completion_rejected");
			return result(response, "session_preserved");
		}
	}
	const issued = await issueBrowserCookie("session");
	// Construct all bearer-bearing output before the atomic write; release only its issued result.
	const response = accountRedirect(context, issued.setCookie);
	const redeemed = await context.store.redeemAuthLinkSessionWithBrowserTransaction(
		{ attemptId, browserTransactionHash, binderHash, credentialHash: issued.cookieHash },
		context.config,
	);
	if (redeemed.kind !== "issued") return notice(403, "completion_rejected");
	return result(response, "session_issued");
}
async function complete(
	context: Context,
	request: Request,
	clientKey: string,
): Promise<CoordinatorBrowserLinkCompletionResponse> {
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "POST")
			return await notice(405, "method_not_allowed", { Allow: "POST" });
		if (snapshot.url !== `${context.publicOrigin}${AUTH_BROWSER_FORM_ACTIONS.completeLink}`)
			return await notice(404, "not_found");
		// Invoke synchronously so the shared guard captures the same native headers before any await.
		const pendingGuard = guardBrowserForm({
			request,
			scope: context.scope,
			csrfKey: context.csrfKey,
			action: "transaction_attempt",
			limiter: context.limiter,
			clientKey,
		});
		const guard = await pendingGuard;
		if (!guard.ok) return await guardFailure(guard);
		if (guard.action !== "transaction_attempt") return await notice(503, "internal_error");
		const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
		if (cookie.kind !== "present" || cookie.cookieHash !== guard.cookieHash)
			return await notice(403, "cookie_invalid");
		const status = await boundStatus(context, guard.attemptId, guard.cookieHash);
		// Even preserving an existing session requires independent device-finalized proof.
		if (status?.state !== "finalized") return await notice(403, "completion_rejected");
		return await finishSession(
			context,
			snapshot.cookie,
			guard.attemptId,
			guard.cookieHash,
			status.browserTransactionHash,
		);
	} catch {
		return await notice(503, "internal_error");
	}
}

/** Trusted captured config/key/store only. Unmounted; wiring faults may throw to the composition root. */
export function createCoordinatorBrowserLinkCompletionHandlers(
	input: CoordinatorBrowserLinkCompletionInput,
): CoordinatorBrowserLinkCompletionResult {
	if (!input.config?.enabled) return Object.freeze({ ok: false, error: "browser_auth_disabled" });
	const config = Object.freeze({
		enabled: input.config.enabled,
		coordinatorId: input.config.coordinatorId,
		issuer: input.config.issuer,
		revision: input.config.revision,
		redirectUri: input.config.redirectUri,
	});
	const receiver = input.store;
	const store: CompletionStore = Object.freeze({
		resolveAuthLinkBrowserTransaction: receiver.resolveAuthLinkBrowserTransaction.bind(receiver),
		getAuthLinkAttemptStatus: receiver.getAuthLinkAttemptStatus.bind(receiver),
		readAuthSession: receiver.readAuthSession.bind(receiver),
		preserveAuthLinkSessionCompletion: receiver.preserveAuthLinkSessionCompletion.bind(receiver),
		redeemAuthLinkSessionWithBrowserTransaction:
			receiver.redeemAuthLinkSessionWithBrowserTransaction.bind(receiver),
	});
	const publicOrigin = new URL(config.redirectUri).origin;
	const context: Context = Object.freeze({
		config,
		publicOrigin,
		scope: Object.freeze({ publicOrigin, store: config }),
		csrfKey: input.csrfKey,
		store,
		limiter: input.limiter,
	});
	return Object.freeze({
		ok: true,
		handlers: Object.freeze({
			page: (request: Request) => page(context, request),
			complete: (request: Request, clientKey: string) => complete(context, request, clientKey),
		}),
	});
}
