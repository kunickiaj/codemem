import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import type { CoordinatorAuthBrowserConfig } from "./coordinator-auth-browser-transaction-contract.js";
import {
	type CoordinatorAuthBrowserPage,
	renderAuthSigninContinuePage,
} from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	decodeCoordinatorAuthProof32,
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
	reissueStartCookieAsTransaction,
} from "./coordinator-browser-credential.js";
import { type BrowserCsrfKey, issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { readBrowserFormBody } from "./coordinator-browser-form-body.js";
import { checkBrowserAuthRequestRate, guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { readBrowserStartTransaction } from "./coordinator-browser-start-transaction.js";
import { renderDeviceRebindHopPage } from "./coordinator-device-rebind-view.js";
import { REJOIN_HASH } from "./coordinator-device-rejoin-browser-evidence.js";
import {
	claimDeviceRejoinBrowser,
	consumeDeviceRejoinCallback,
} from "./coordinator-device-rejoin-browser-transaction.js";
import {
	DEVICE_REJOIN_BROWSER_PATHS,
	renderRejoinNotice,
	renderRejoinRefusal,
	renderRejoinReview,
	renderRejoinStartPage,
} from "./coordinator-device-rejoin-browser-view.js";
import {
	confirmDeviceRejoinAttempt,
	readDeviceRejoinConfirmation,
} from "./coordinator-device-rejoin-confirmation.js";
import { readDeviceRejoinLinkEvidence } from "./coordinator-device-rejoin-link-evidence.js";
import { pinVerifiedDeviceRejoinAccount } from "./coordinator-device-rejoin-oidc-pins.js";
import type { CoordinatorOidcClient } from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

interface Context {
	backend: AuthLinkBackend;
	client: CoordinatorOidcClient;
	scope: { store: CoordinatorAuthBrowserConfig; publicOrigin: string };
	csrfKey: BrowserCsrfKey;
	limiter: InMemoryRequestRateLimiter;
	now(): number;
}

function pins(ctx: Context) {
	const c = ctx.scope.store;
	return {
		coordinatorId: c.coordinatorId,
		origin: ctx.scope.publicOrigin,
		issuer: c.issuer,
		authConfigRevision: c.revision,
		redirectUri: c.redirectUri,
		now: ctx.now(),
	};
}

function page(output: CoordinatorAuthBrowserPage, status = 200) {
	return new Response(output.body, { status, headers: output.headers });
}

async function unavailable(status = 403) {
	return page(await renderRejoinNotice({ unknown: status === 503 }), status);
}

function transactionState(ctx: Context, cookie: string | null) {
	return readBrowserStartTransaction(
		cookie,
		new CoordinatorAuthBrowserTransactions(ctx.backend, ctx.now),
		ctx.scope.store,
	);
}

function startQuery(ctx: Context, request: Request) {
	if (request.url.length > 8192 || request.url.includes("#")) return null;
	const url = new URL(request.url);
	if (
		url.origin !== ctx.scope.publicOrigin ||
		url.pathname !== DEVICE_REJOIN_BROWSER_PATHS.start ||
		url.username ||
		url.password ||
		[...url.searchParams].length !== 2
	)
		return null;
	const attemptId = url.searchParams.get("attempt_id");
	const startCode = url.searchParams.get("start_code");
	if (!isAuthControllerId(attemptId) || !startCode || !decodeCoordinatorAuthProof32(startCode))
		return null;
	return { attemptId, startCode };
}

async function startPage(ctx: Context, request: Request, clientKey: string) {
	const rate = checkBrowserAuthRequestRate(
		request,
		ctx.limiter,
		JSON.stringify(["rejoin-start-page", clientKey]),
		30,
	);
	if (!rate.allowed) return unavailable(429);
	const query = startQuery(ctx, request);
	if (!query) return unavailable(400);
	const cookie = request.headers.get("cookie");
	const activity = await transactionState(ctx, cookie);
	if (activity === "active") return unavailable(409);
	if (activity === "invalid") return unavailable(400);
	const existing = await readBrowserCookie(cookie, "start");
	if (existing.kind === "invalid") return unavailable(400);
	const issued = existing.kind === "absent" ? await issueBrowserCookie("start") : null;
	const secret = existing.kind === "present" ? existing.secret : issued?.secret;
	if (!secret) return unavailable(503);
	const csrf = await issueBrowserCsrfToken(ctx.csrfKey, secret, "start", ctx.scope);
	const response = page(await renderRejoinStartPage({ ...query, csrf }));
	if (issued) response.headers.append("Set-Cookie", issued.setCookie);
	return response;
}

async function stateHash(state: string) {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function start(ctx: Context, request: Request, clientKey: string) {
	const rawCookie = request.headers.get("cookie");
	const activity = await transactionState(ctx, rawCookie);
	if (activity === "active" || activity === "invalid") return unavailable();
	const checked = await guardBrowserForm({ ...ctx, request, clientKey, action: "link_start" });
	if (!checked.ok || checked.action !== "link_start") return unavailable();
	const cookie = await readBrowserCookie(rawCookie, "start");
	if (cookie.kind !== "present" || cookie.cookieHash !== checked.cookieHash) return unavailable();
	const { authorizationUrl, material } = await ctx.client.createAuthorizationRequest();
	const url = new URL(authorizationUrl);
	url.searchParams.set("prompt", "select_account");
	const claimed = await claimDeviceRejoinBrowser(ctx.backend, {
		...pins(ctx),
		attemptId: checked.attemptId,
		startCode: checked.startCode,
		binderHash: checked.cookieHash,
		stateHash: await stateHash(material.state),
		transactionHash: await hashCoordinatorAuthProofBytes32(
			crypto.getRandomValues(new Uint8Array(32)),
		),
		nonce: material.nonce,
		pkceVerifier: material.pkceVerifier,
	});
	if (!claimed) return unavailable();
	const response = page(await renderAuthSigninContinuePage({ authorizationUrl: url.href }));
	response.headers.append("Set-Cookie", reissueStartCookieAsTransaction(cookie.secret));
	response.headers.append("Set-Cookie", clearBrowserCookie("start"));
	return response;
}

function callbackState(ctx: Context, request: Request): string | null {
	if (request.method !== "GET" || request.url.length > 8192 || request.url.includes("#"))
		return null;
	const url = new URL(request.url);
	if (
		`${url.origin}${url.pathname}` !== ctx.scope.store.redirectUri ||
		url.username ||
		url.password
	)
		return null;
	const states = url.searchParams.getAll("state");
	const state = states[0];
	return states.length === 1 && state && /^[A-Za-z0-9._~-]{43,128}$/u.test(state) ? state : null;
}

type Consumed = Extract<
	Awaited<ReturnType<typeof consumeDeviceRejoinCallback>>,
	{ kind: "consumed" }
>;

async function refused(target: Consumed, reason: Parameters<typeof renderRejoinRefusal>[1]) {
	return endBrowserTransaction(page(await renderRejoinRefusal(target, reason), 403));
}

function endBrowserTransaction(response: Response): Response {
	response.headers.append("Set-Cookie", clearBrowserCookie("transaction"));
	return response;
}

async function accountRefusal(
	ctx: Context,
	a: Consumed,
	account: { issuer: string; subject: string },
) {
	const c = pins(ctx);
	const link = await ctx.backend.first<{ identity_id: string }>({
		sql: `SELECT identity_id FROM coordinator_auth_account_links
 WHERE coordinator_id = ? AND issuer = ? AND subject = ? AND revoked_at_ms IS NULL`,
		values: [c.coordinatorId, c.issuer, account.subject],
	});
	if (
		!link ||
		!(await readDeviceRejoinLinkEvidence(ctx.backend, {
			...c,
			...account,
			identityId: link.identity_id,
		}))
	)
		return "account_not_linked";
	return link.identity_id === a.identityId ? "removal_changed" : "wrong_account";
}

async function callback(ctx: Context, request: Request): Promise<Response | null> {
	const state = callbackState(ctx, request);
	if (!state) return null;
	const cookie = await readBrowserCookie(request.headers.get("cookie"), "transaction");
	if (cookie.kind !== "present") return null;
	const consumed = await consumeDeviceRejoinCallback(ctx.backend, {
		...pins(ctx),
		stateHash: await stateHash(state),
		binderHash: cookie.cookieHash,
	});
	if (!consumed) return null;
	if (consumed.kind !== "consumed") return unavailable();
	const verified = await ctx.client.verifyCallback(
		{
			callbackUrl: request.url,
			material: { state, nonce: consumed.nonce, pkceVerifier: consumed.pkceVerifier },
		},
		{ fetchUserInfo: false },
	);
	if (!verified.ok || verified.account.issuer !== ctx.scope.store.issuer)
		return refused(consumed, "retry");
	const scope = {
		...pins(ctx),
		attemptId: consumed.attemptId,
		binderHash: cookie.cookieHash,
		transactionHash: consumed.transactionHash,
	};
	const pinned = await pinVerifiedDeviceRejoinAccount(ctx.backend, {
		...scope,
		claimToken: consumed.claimToken,
		account: verified.account,
	});
	if (!pinned) return refused(consumed, await accountRefusal(ctx, consumed, verified.account));
	const review = await readDeviceRejoinConfirmation(ctx.backend, scope);
	if (!review) return refused(consumed, "removal_changed");
	const csrf = await issueBrowserCsrfToken(ctx.csrfKey, cookie.secret, "transaction", ctx.scope);
	const response = page(
		await renderRejoinReview({
			...consumed,
			...review,
			csrf,
			account: verified.profile.emailVerified
				? (verified.profile.email ?? verified.account.subject)
				: verified.account.subject,
		}),
	);
	return review.destinationsJson === "[]" ? endBrowserTransaction(response) : response;
}

async function confirmationForm(ctx: Context, request: Request) {
	const media = request.headers.get("content-type") ?? "";
	if (
		request.method !== "POST" ||
		request.headers.get("origin") !== ctx.scope.publicOrigin ||
		!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/iu.test(media)
	)
		return null;
	const read = await readBrowserFormBody({
		body: request.body,
		contentLength: request.headers.get("content-length"),
	});
	if (!read.ok) return null;
	const fields = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
	const commitments = fields.getAll("confirmation_hash");
	const confirmation = commitments[0];
	if (commitments.length !== 1 || !confirmation || !REJOIN_HASH.test(confirmation)) return null;
	fields.delete("confirmation_hash");
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	return {
		confirmation,
		request: new Request(request.url, { method: "POST", headers, body: fields.toString() }),
	};
}

async function confirm(ctx: Context, request: Request, clientKey: string) {
	const form = await confirmationForm(ctx, request);
	if (!form) return unavailable(400);
	const checked = await guardBrowserForm({
		...ctx,
		request: form.request,
		clientKey,
		action: "transaction_attempt",
	});
	if (!checked.ok || checked.action !== "transaction_attempt") return unavailable();
	const c = pins(ctx);
	const row = await ctx.backend.first<{ browser_transaction_hash: string }>({
		sql: `SELECT browser_transaction_hash FROM coordinator_device_rejoin_attempts
 WHERE coordinator_id = ? AND attempt_id = ? AND browser_binder_hash = ? AND state = 'oidc_verified'`,
		values: [c.coordinatorId, checked.attemptId, checked.cookieHash],
	});
	if (!row) return unavailable();
	const scope = {
		...c,
		attemptId: checked.attemptId,
		binderHash: checked.cookieHash,
		transactionHash: row.browser_transaction_hash,
	};
	const review = await readDeviceRejoinConfirmation(ctx.backend, scope);
	if (!review || review.confirmation !== form.confirmation) return unavailable();
	const secret = crypto.getRandomValues(new Uint8Array(32));
	const confirmed = await confirmDeviceRejoinAttempt(ctx.backend, {
		...scope,
		confirmation: form.confirmation,
		completionSecretHash: await hashCoordinatorAuthProofBytes32(secret),
	});
	if (!confirmed) return unavailable();
	const response = page(
		await renderDeviceRebindHopPage({
			loopbackRedirect: review.loopbackRedirect,
			attemptId: checked.attemptId,
			completionSecret: encodeCoordinatorAuthProof32(secret),
			confirmationHash: form.confirmation,
		}),
	);
	response.headers.append("Set-Cookie", clearBrowserCookie("transaction"));
	return response;
}

interface DeviceRejoinBrowserHandlers {
	startPage(request: Request, clientKey: string): Promise<Response>;
	start(request: Request, clientKey: string): Promise<Response>;
	confirm(request: Request, clientKey: string): Promise<Response>;
	callback(request: Request): Promise<Response | null>;
}

/** Site registration owns path/method pinning. Each state change repeats its own store predicates. */
export function createDeviceRejoinBrowser(ctx: Context): DeviceRejoinBrowserHandlers {
	function guard<A extends unknown[], R>(step: (c: Context, ...args: A) => Promise<R>) {
		return async (...args: A) => {
			try {
				return await step(ctx, ...args);
			} catch {
				return unavailable(503);
			}
		};
	}
	return {
		startPage: guard(startPage),
		start: guard(start),
		confirm: guard(confirm),
		callback: guard(callback),
	};
}
