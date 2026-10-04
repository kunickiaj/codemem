import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import {
	AUTH_BROWSER_FORM_ACTIONS,
	type CoordinatorAuthBrowserPage,
	renderAuthBrowserNotice,
	renderAuthLinkCompletionHopPage,
	renderAuthLinkConfirmPage,
} from "./coordinator-auth-browser-view.js";
import type { CoordinatorAuthLinkStore } from "./coordinator-auth-link-contract.js";
import type { CoordinatorBrowserAuthLinkCompletionInput } from "./coordinator-browser-auth-callback.js";
import {
	BROWSER_COOKIE_NAMES,
	type BrowserCookieSecret,
	browserCookieValue,
	clearBrowserCookie,
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

type LinkStore = Pick<
	CoordinatorAuthBrowserTransactionStore,
	"resolveAuthLinkBrowserTransaction" | "retireAuthBrowserTransactions"
> &
	Pick<
		CoordinatorAuthLinkStore,
		| "recordAuthLinkOidcVerified"
		| "readAuthLinkCompletionDestination"
		| "confirmAuthLinkAttempt"
		| "failAuthLinkAttempt"
	>;
export interface CoordinatorBrowserLinkInput {
	config: CoordinatorAuthBrowserConfig;
	csrfKey: BrowserCsrfKey;
	store: LinkStore;
	limiter: InMemoryRequestRateLimiter;
}
export type CoordinatorBrowserLinkCallback = (
	input: CoordinatorBrowserAuthLinkCompletionInput,
) => Promise<Response>;
export type CoordinatorBrowserLinkOutcome =
	| "link_confirmation"
	| "link_confirmed"
	| "link_cancelled"
	| "method_not_allowed"
	| "not_found"
	| "link_rejected"
	| "origin_rejected"
	| "rate_limited"
	| "unsupported_media_type"
	| "body_too_large"
	| "form_invalid"
	| "cookie_missing"
	| "cookie_invalid"
	| "csrf_invalid"
	| "internal_error";
export type CoordinatorBrowserLinkResponse = Readonly<{
	response: Response;
	outcome: CoordinatorBrowserLinkOutcome;
}>;
export interface CoordinatorBrowserLinkHandlers {
	completeLink: CoordinatorBrowserLinkCallback;
	confirm(request: Request, clientKey: string): Promise<CoordinatorBrowserLinkResponse>;
	cancel(request: Request, clientKey: string): Promise<CoordinatorBrowserLinkResponse>;
}
export type CoordinatorBrowserLinkResult =
	| Readonly<{ ok: false; error: "browser_auth_disabled" }>
	| Readonly<{ ok: true; handlers: Readonly<CoordinatorBrowserLinkHandlers> }>;
type Context = Readonly<CoordinatorBrowserLinkInput & { scope: BrowserCsrfScope }>;

function result(
	response: Response,
	outcome: CoordinatorBrowserLinkOutcome,
): CoordinatorBrowserLinkResponse {
	return Object.freeze({ response, outcome });
}
function pageResponse(
	page: CoordinatorAuthBrowserPage,
	status = 200,
	extra?: Record<string, string>,
): Response {
	const headers = new Headers(page.headers);
	headers.set("Cache-Control", "no-store");
	if (extra)
		new Headers(extra).forEach((value, name) => {
			headers.set(name, value);
		});
	return new Response(page.body, { status, headers });
}
function fallback(): CoordinatorBrowserLinkResponse {
	return result(
		new Response("Account linking unavailable. Try again.", {
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
	outcome: CoordinatorBrowserLinkOutcome,
	extra?: Record<string, string>,
): Promise<CoordinatorBrowserLinkResponse> {
	try {
		return result(
			pageResponse(await renderAuthBrowserNotice("auth_unavailable"), status, extra),
			outcome,
		);
	} catch {
		return fallback();
	}
}
function guardFailure(guard: Extract<BrowserFormGuardResult, { ok: false }>) {
	switch (guard.error) {
		case "rate_limited":
			return notice(429, guard.error, { "Retry-After": String(guard.retryAfterS) });
		case "unsupported_media_type":
			return notice(415, guard.error);
		case "body_too_large":
			return notice(413, guard.error);
		case "form_invalid":
			return notice(400, guard.error);
		case "origin_rejected":
		case "cookie_missing":
		case "cookie_invalid":
		case "csrf_invalid":
			return notice(403, guard.error);
		default:
			return notice(503, "internal_error");
	}
}
async function failAttempt(
	context: Context,
	attemptId: string,
	browserTransactionHash: string,
	reason: "cancelled" | "provider_failure",
): Promise<CoordinatorBrowserLinkResponse> {
	// Build the clearing response before persistence; rendering failure leaves a retry possible.
	const page = await renderAuthBrowserNotice(
		reason === "cancelled" ? "link_cancelled" : "auth_unavailable",
	);
	const response = pageResponse(page, reason === "cancelled" ? 200 : 403);
	response.headers.append("Set-Cookie", clearBrowserCookie("transaction"));
	const written = await context.store.failAuthLinkAttempt(
		{
			attemptId,
			requester: { kind: "browser", browserTransactionHash },
			reason,
		},
		context.config,
	);
	if (
		(written.kind !== "applied" && written.kind !== "existing") ||
		written.status.state !== "failed"
	)
		return notice(403, "link_rejected");
	const retired = await context.store.retireAuthBrowserTransactions(context.config, { attemptId });
	if (retired.kind !== "retired" || retired.more) return notice(503, "internal_error");
	if (reason === "cancelled") return result(response, "link_cancelled");
	return result(response, "link_rejected");
}
async function completeLink(
	context: Context,
	input: CoordinatorBrowserAuthLinkCompletionInput,
): Promise<Response> {
	try {
		const value = callbackCookieValue(input);
		if (value === null) return (await notice(403, "link_rejected")).response;
		const cookie = await readBrowserCookie(
			`${BROWSER_COOKIE_NAMES.transaction}=${value}`,
			"transaction",
		);
		if (cookie.kind !== "present" || cookie.cookieHash !== input.transactionCookieHash)
			return (await notice(403, "link_rejected")).response;
		const transaction = await context.store.resolveAuthLinkBrowserTransaction(
			{
				attemptId: input.attemptId,
				binderHash: cookie.cookieHash,
			},
			context.config,
		);
		if (!transaction || transaction.browserTransactionHash !== input.browserTransactionHash)
			return (await notice(403, "link_rejected")).response;
		if (!input.verification.ok)
			return (
				await failAttempt(
					context,
					input.attemptId,
					transaction.browserTransactionHash,
					"provider_failure",
				)
			).response;
		if (input.verification.account.issuer !== context.config.issuer)
			return (await notice(403, "link_rejected")).response;
		const recorded = await context.store.recordAuthLinkOidcVerified(
			{
				attemptId: input.attemptId,
				browserTransactionHash: transaction.browserTransactionHash,
				account: input.verification.account,
			},
			context.config,
		);
		if (recorded.kind !== "applied") return (await notice(403, "link_rejected")).response;
		return await confirmationPage(
			context,
			input.attemptId,
			cookie.secret,
			input.verification.profile,
			recorded.target,
		);
	} catch {
		return (await notice(503, "internal_error")).response;
	}
}
async function confirmationPage(
	context: Context,
	attemptId: string,
	cookie: BrowserCookieSecret,
	profile: unknown,
	target: { identityId: string; deviceId: string; groupId: string },
): Promise<Response> {
	const csrfToken = await issueBrowserCsrfToken(
		context.csrfKey,
		cookie,
		"transaction",
		context.scope,
	);
	return pageResponse(
		await renderAuthLinkConfirmPage({
			profile,
			issuer: context.config.issuer,
			identity: { id: target.identityId },
			device: { id: target.deviceId },
			group: { id: target.groupId },
			attemptId,
			csrfToken,
		}),
	);
}
function callbackCookieValue(input: CoordinatorBrowserAuthLinkCompletionInput): string | null {
	try {
		return browserCookieValue(input.transactionCookie, "transaction");
	} catch {
		return null;
	}
}
async function confirmAttempt(
	context: Context,
	attemptId: string,
	browserTransactionHash: string,
): Promise<CoordinatorBrowserLinkResponse> {
	const destination = await context.store.readAuthLinkCompletionDestination(
		{ attemptId, browserTransactionHash },
		context.config,
	);
	if (!destination) return notice(403, "link_rejected");
	const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
	const completionSecret = btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
	// The loopback protocol hashes decoded raw bytes, not the encoded string.
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	const completionSecretHash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	const response = pageResponse(
		await renderAuthLinkCompletionHopPage({
			destination: destination.destination,
			attemptId,
			completionSecret,
		}),
	);
	const written = await context.store.confirmAuthLinkAttempt(
		{ attemptId, browserTransactionHash, completionSecretHash },
		context.config,
	);
	if (written.kind !== "applied") return notice(403, "link_rejected");
	// Retain the transaction cookie for later original-browser session redemption.
	return result(response, "link_confirmed");
}
async function post(
	context: Context,
	request: Request,
	clientKey: string,
	action: "confirmLink" | "cancelLink",
): Promise<CoordinatorBrowserLinkResponse> {
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "POST")
			return await notice(405, "method_not_allowed", { Allow: "POST" });
		if (snapshot.url !== `${context.scope.publicOrigin}${AUTH_BROWSER_FORM_ACTIONS[action]}`)
			return await notice(404, "not_found");
		// The guard captures native headers in this same tick, before either caller awaits.
		const pendingGuard = guardBrowserForm({
			request,
			clientKey,
			scope: context.scope,
			csrfKey: context.csrfKey,
			limiter: context.limiter,
			action: "transaction_attempt",
		});
		const guard = await pendingGuard;
		if (!guard.ok) return await guardFailure(guard);
		if (guard.action !== "transaction_attempt") return await notice(503, "internal_error");
		const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
		if (cookie.kind !== "present" || cookie.cookieHash !== guard.cookieHash)
			return await notice(403, "link_rejected");
		const transaction = await context.store.resolveAuthLinkBrowserTransaction(
			{
				attemptId: guard.attemptId,
				binderHash: guard.cookieHash,
			},
			context.config,
		);
		if (!transaction) return await notice(403, "link_rejected");
		if (action === "cancelLink")
			return await failAttempt(
				context,
				guard.attemptId,
				transaction.browserTransactionHash,
				"cancelled",
			);
		return await confirmAttempt(context, guard.attemptId, transaction.browserTransactionHash);
	} catch {
		return await notice(503, "internal_error");
	}
}

/** Requires trusted store config from captureCoordinatorBrowserAuthConfig, never HTTP input.
 * Unmounted continuation only: no provider client, profile/session writes or finalization.
 */
export function createCoordinatorBrowserLinkHandlers(
	input: CoordinatorBrowserLinkInput,
): CoordinatorBrowserLinkResult {
	const config = Object.freeze({
		coordinatorId: input.config.coordinatorId,
		issuer: input.config.issuer,
		revision: input.config.revision,
		redirectUri: input.config.redirectUri,
		enabled: input.config.enabled,
	});
	if (!config.enabled) return Object.freeze({ ok: false, error: "browser_auth_disabled" });
	const receiver = input.store;
	const store: LinkStore = Object.freeze({
		resolveAuthLinkBrowserTransaction: receiver.resolveAuthLinkBrowserTransaction.bind(receiver),
		retireAuthBrowserTransactions: receiver.retireAuthBrowserTransactions.bind(receiver),
		recordAuthLinkOidcVerified: receiver.recordAuthLinkOidcVerified.bind(receiver),
		readAuthLinkCompletionDestination: receiver.readAuthLinkCompletionDestination.bind(receiver),
		confirmAuthLinkAttempt: receiver.confirmAuthLinkAttempt.bind(receiver),
		failAuthLinkAttempt: receiver.failAuthLinkAttempt.bind(receiver),
	});
	const scope = Object.freeze({ publicOrigin: new URL(config.redirectUri).origin, store: config });
	const context: Context = Object.freeze({
		config,
		scope,
		store,
		csrfKey: input.csrfKey,
		limiter: input.limiter,
	});
	return Object.freeze({
		ok: true,
		handlers: Object.freeze({
			completeLink: (completion: CoordinatorBrowserAuthLinkCompletionInput) =>
				completeLink(context, completion),
			confirm: (request: Request, clientKey: string) =>
				post(context, request, clientKey, "confirmLink"),
			cancel: (request: Request, clientKey: string) =>
				post(context, request, clientKey, "cancelLink"),
		}),
	});
}
