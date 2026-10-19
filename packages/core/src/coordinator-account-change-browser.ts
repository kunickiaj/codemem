import type { AccountChangeOperations } from "./coordinator-account-change.js";
import type {
	CoordinatorAuthBrowserConfig,
	CoordinatorAuthBrowserTransactionPurposeStore,
	CoordinatorAuthBrowserTransactionStore,
} from "./coordinator-auth-browser-transaction-contract.js";
import {
	type CoordinatorAuthBrowserPage,
	projectAccountProfileView,
	renderAuthBrowserNotice,
	renderAuthLinkCompletionHopPage,
	renderAuthSigninContinuePage,
} from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	decodeCoordinatorAuthProof32,
	encodeCoordinatorAuthProof32,
	hashCoordinatorAuthProofBytes32,
} from "./coordinator-auth-proof.js";
import { captureCoordinatorBrowserAuthConfig } from "./coordinator-browser-auth-config.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
	reissueStartCookieAsTransaction,
} from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	isBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { checkBrowserAuthRequestRate, guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest } from "./coordinator-browser-request.js";
import { readBrowserStartTransaction } from "./coordinator-browser-start-transaction.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

type Pins = { attemptId: string; binderHash: string; stateHash: string };
type Operations = Pick<
	AccountChangeOperations,
	| "claimBrowser"
	| "hasPendingCallback"
	| "consumeCallback"
	| "recordVerifiedCallback"
	| "confirmDisconnect"
	| "failConsumed"
	| "readBrowserView"
	| "readCallbackView"
>;
type Existing = Pick<CoordinatorAuthBrowserTransactionStore, "readAuthBrowserTransactionActivity"> &
	CoordinatorAuthBrowserTransactionPurposeStore;

/** Private storage capabilities, never public status DTOs or request-nominated context. */
export type AccountChangeBrowserReaders = Pick<
	AccountChangeOperations,
	"readStart" | "readManagementActivity" | "readBrowserBinding"
>;
type BrowserView = NonNullable<Awaited<ReturnType<Operations["readBrowserView"]>>> & {
	stateHash: string;
};
export interface AccountChangeBrowserInput {
	config: unknown;
	csrfKey: BrowserCsrfKey;
	operations: Operations;
	readers: AccountChangeBrowserReaders;
	existing: Existing;
	limiter: InMemoryRequestRateLimiter;
	oidcOptions?: CoordinatorOidcOptions;
}
export const ACCOUNT_CHANGE_BROWSER_PATHS = Object.freeze({
	start: "/auth/account/change/start",
	confirm: "/auth/account/change/confirm",
});

function pageResponse(page: CoordinatorAuthBrowserPage, status = 200) {
	return new Response(page.body, { status, headers: page.headers });
}
function escapeHtml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
async function notice(status = 403): Promise<Response> {
	try {
		return pageResponse(await renderAuthBrowserNotice("auth_unavailable"), status);
	} catch {
		return new Response("Account change unavailable. Return to your terminal and try again.", {
			status: 503,
			headers: {
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			},
		});
	}
}
async function formPage(
	title: string,
	action: string,
	fields: Record<string, string>,
	detail = "",
) {
	const headers = (await renderAuthBrowserNotice("auth_unavailable")).headers;
	headers["Referrer-Policy"] = "same-origin";
	const hidden = Object.entries(fields)
		.map(
			([name, value]) =>
				`<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
		)
		.join("");
	return new Response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="referrer" content="same-origin"><title>${escapeHtml(title)}</title><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><form method="post" action="${action}">${hidden}<button type="submit">${escapeHtml(title)}</button></form></main></html>`,
		{ headers },
	);
}
async function stateHash(state: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function startQuery(text: string, startUrl: string) {
	if (text.length > 8192 || text.includes("#")) return null;
	const url = new URL(text);
	if (
		url.href !== text ||
		`${url.origin}${url.pathname}` !== startUrl ||
		url.username ||
		url.password
	)
		return null;
	if (
		[...url.searchParams].length !== 2 ||
		url.searchParams.getAll("attempt_id").length !== 1 ||
		url.searchParams.getAll("start_code").length !== 1
	)
		return null;
	const attemptId = url.searchParams.get("attempt_id"),
		startCode = url.searchParams.get("start_code");
	if (!isAuthControllerId(attemptId) || !startCode || !decodeCoordinatorAuthProof32(startCode))
		return null;
	return { attemptId, startCode };
}
async function privateStart(
	readers: AccountChangeBrowserReaders,
	attemptId: string,
	startCode: string,
	config: CoordinatorAuthBrowserConfig,
) {
	const bytes = decodeCoordinatorAuthProof32(startCode);
	if (!bytes) return null;
	const browserStartHash = await hashCoordinatorAuthProofBytes32(bytes);
	const view = await readers.readStart({ attemptId, browserStartHash }, config);
	if (!view || (view.intent !== "refresh" && view.intent !== "disconnect")) return null;
	return { browserStartHash, intent: view.intent };
}
async function inactive(
	cookie: string | null,
	input: AccountChangeBrowserInput,
	config: CoordinatorAuthBrowserConfig,
) {
	const ordinary = await readBrowserStartTransaction(cookie, input.existing, config);
	if (ordinary === "invalid" || ordinary === "active") return false;
	const transaction = await readBrowserCookie(cookie, "transaction");
	if (transaction.kind === "absent") return true;
	if (transaction.kind !== "present") return false;
	return (
		(await input.readers.readManagementActivity({ binderHash: transaction.cookieHash }, config))
			.kind === "inactive"
	);
}
async function completion(view: { loopbackRedirect: string; attemptId: string }, secret: string) {
	return pageResponse(
		await renderAuthLinkCompletionHopPage({
			destination: view.loopbackRedirect,
			attemptId: view.attemptId,
			completionSecret: secret,
		}),
	);
}

/** Hosted handlers mounted by the schema-ready browser composition.
 * The composition root provides private, proof-bound readers.
 * Only a successful credential POST promotes a cookie; no GET/callback clears one.
 * Device-signed finalization remains separate. Never log queries, forms or proofs.
 */
type Context = {
	input: AccountChangeBrowserInput;
	config: CoordinatorAuthBrowserConfig;
	scope: { publicOrigin: string; store: CoordinatorAuthBrowserConfig };
	client: CoordinatorOidcClient;
	startUrl: string;
	confirmUrl: string;
};
async function startCookie(cookieHeader: string | null) {
	const existing = await readBrowserCookie(cookieHeader, "start");
	if (existing.kind === "invalid") return null;
	return existing.kind === "present" ? existing : issueBrowserCookie("start");
}
async function startPage(context: Context, request: Request): Promise<Response> {
	const { input, config, scope, startUrl } = context;
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "GET") return notice(405);
		const query = startQuery(snapshot.url, startUrl);
		if (!query) return notice(400);
		if (!(await privateStart(input.readers, query.attemptId, query.startCode, config)))
			return notice();
		if (!(await inactive(snapshot.cookie, input, config))) return notice(409);
		const cookie = await startCookie(snapshot.cookie);
		if (!cookie) return notice(400);
		const csrf = await issueBrowserCsrfToken(input.csrfKey, cookie.secret, "start", scope);
		const response = await formPage("Continue with Google", ACCOUNT_CHANGE_BROWSER_PATHS.start, {
			attempt_id: query.attemptId,
			start_code: query.startCode,
			csrf,
		});
		if ("setCookie" in cookie) response.headers.append("Set-Cookie", cookie.setCookie);
		return response;
	} catch {
		return notice(503);
	}
}
async function start(context: Context, request: Request, clientKey: string): Promise<Response> {
	const { input, config, scope, startUrl } = context;
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "POST") return notice(405);
		if (snapshot.url !== startUrl) return notice(404);
		const guard = await guardBrowserForm({
			request,
			clientKey,
			scope,
			csrfKey: input.csrfKey,
			limiter: input.limiter,
			action: "link_start",
		});
		if (!guard.ok) return notice(guard.error === "rate_limited" ? 429 : 403);
		if (guard.action !== "link_start") return notice();
		if (!(await inactive(snapshot.cookie, input, config))) return notice(409);
		return await admitStart(context, snapshot.cookie, guard);
	} catch {
		return notice(503);
	}
}
async function admitStart(
	context: Context,
	cookieHeader: string | null,
	guard: { attemptId: string; startCode: string; cookieHash: string },
) {
	const { input, config, client } = context;
	const proof = await privateStart(input.readers, guard.attemptId, guard.startCode, config);
	const cookie = await readBrowserCookie(cookieHeader, "start");
	if (!proof || cookie.kind !== "present" || cookie.cookieHash !== guard.cookieHash)
		return notice();
	const authorization = await client.createAuthorizationRequest();
	const response = pageResponse(
		await renderAuthSigninContinuePage({ authorizationUrl: authorization.authorizationUrl }),
	);
	const claimed = await input.operations.claimBrowser(
		{
			attemptId: guard.attemptId,
			browserStartHash: proof.browserStartHash,
			stateHash: await stateHash(authorization.material.state),
			binderHash: guard.cookieHash,
			nonce: authorization.material.nonce,
			pkceVerifier: authorization.material.pkceVerifier,
		},
		config,
	);
	if (!claimed) return notice(409);
	response.headers.append("Set-Cookie", reissueStartCookieAsTransaction(cookie.secret));
	response.headers.append("Set-Cookie", clearBrowserCookie("start"));
	return response;
}
async function callbackPins(context: Context, request: Request) {
	const { config } = context;
	const snapshot = snapshotBrowserRequest(request);
	if (snapshot.method !== "GET" || snapshot.url.length > 8192 || snapshot.url.includes("#"))
		return null;
	const url = new URL(snapshot.url),
		redirect = new URL(config.redirectUri);
	if (
		url.origin !== redirect.origin ||
		url.pathname !== redirect.pathname ||
		url.username ||
		url.password ||
		url.searchParams.getAll("state").length !== 1
	)
		return null;
	const state = url.searchParams.get("state");
	if (!state || !/^[A-Za-z0-9._~-]{43,128}$/.test(state)) return null;
	const cookie = await readBrowserCookie(snapshot.cookie, "transaction");
	if (cookie.kind !== "present") return null;
	return {
		state,
		stateHash: await stateHash(state),
		binderHash: cookie.cookieHash,
		cookie,
		callbackUrl: snapshot.url,
	};
}
async function matchesCallback(context: Context, request: Request): Promise<boolean> {
	const { input, config } = context;
	try {
		const pins = await callbackPins(context, request);
		return (
			!!pins &&
			(await input.operations.hasPendingCallback(
				{ stateHash: pins.stateHash, binderHash: pins.binderHash },
				config,
			))
		);
	} catch {
		return false;
	}
}
async function prepareVerifiedResponse(
	context: Context,
	pins: Pins,
	secret: string,
	cookie: Extract<Awaited<ReturnType<typeof readBrowserCookie>>, { kind: "present" }>,
	verifiedProfile: Parameters<typeof projectAccountProfileView>[0],
) {
	const { input, config, scope } = context;
	const view = await input.operations.readCallbackView(pins, config);
	if (!view || view.attemptId !== pins.attemptId) throw new Error("callback_unavailable");
	if (view.intent === "refresh") return completion(view, secret);
	if (view.intent !== "disconnect") throw new Error("callback_unavailable");
	const csrf = await issueBrowserCsrfToken(input.csrfKey, cookie.secret, "transaction", scope);
	const profile = projectAccountProfileView(verifiedProfile, config.issuer);
	return formPage(
		"Disconnect Google account",
		ACCOUNT_CHANGE_BROWSER_PATHS.confirm,
		{ attempt_id: pins.attemptId, csrf },
		`${profile.email ?? profile.title}. Disconnecting ends browser sessions for this connection and removes its display profile. Identity, device keys, history, membership, and access grants stay unchanged.`,
	);
}
async function browserView(context: Context, pins: { attemptId: string; binderHash: string }) {
	const { input, config } = context;
	const binding = await input.readers.readBrowserBinding(pins, config);
	if (!binding || !/^[a-f0-9]{64}$/.test(binding.stateHash)) return null;
	const view = await input.operations.readBrowserView(
		{ ...pins, stateHash: binding.stateHash },
		config,
	);
	return view ? { ...view, stateHash: binding.stateHash } : null;
}
async function callback(context: Context, request: Request, clientKey: string): Promise<Response> {
	const { input, config } = context;
	try {
		if (!isAuthControllerId(clientKey)) return notice(503);
		const rate = checkBrowserAuthRequestRate(
			request,
			input.limiter,
			JSON.stringify(["browser-callback", config.coordinatorId, clientKey]),
			20,
		);
		if (!rate.allowed) return notice(429);
		const material = await callbackPins(context, request);
		if (!material) return notice();
		const lookup = { stateHash: material.stateHash, binderHash: material.binderHash };
		// Shared-purpose collisions never consume either ceremony or contact Google.
		if (await input.existing.readAuthBrowserTransactionPurpose(lookup, config)) return notice();
		const consumed = await input.operations.consumeCallback(lookup, config);
		if (!consumed) return notice();
		const pins = { ...lookup, attemptId: consumed.attemptId };
		return await exchange(context, material, consumed, pins);
	} catch {
		return notice(503);
	}
}
async function exchange(
	context: Context,
	material: NonNullable<Awaited<ReturnType<typeof callbackPins>>>,
	consumed: NonNullable<Awaited<ReturnType<Operations["consumeCallback"]>>>,
	pins: Pins,
) {
	const { input, config, client } = context;
	try {
		if (!consumed.nonce || !consumed.pkceVerifier) throw new Error("missing_material");
		const verified = await client.verifyCallback({
			callbackUrl: material.callbackUrl,
			material: {
				state: material.state,
				nonce: consumed.nonce,
				pkceVerifier: consumed.pkceVerifier,
			},
		});
		if (!verified.ok) throw new Error("provider_rejected");
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const secret = encodeCoordinatorAuthProof32(bytes);
		const response = await prepareVerifiedResponse(
			context,
			pins,
			secret,
			material.cookie,
			verified.profile,
		);
		const recorded = await input.operations.recordVerifiedCallback(
			{
				...pins,
				issuer: verified.account.issuer,
				subject: verified.account.subject,
				profile: verified.profile,
				completionSecretHash: await hashCoordinatorAuthProofBytes32(bytes),
			},
			config,
		);
		if (!recorded) throw new Error("account_rejected");
		return response;
	} catch {
		await input.operations.failConsumed(pins, config);
		return notice();
	}
}
async function confirm(context: Context, request: Request, clientKey: string): Promise<Response> {
	const { input, config, scope, confirmUrl } = context;
	try {
		const snapshot = snapshotBrowserRequest(request);
		if (snapshot.method !== "POST") return notice(405);
		if (snapshot.url !== confirmUrl) return notice(404);
		const guard = await guardBrowserForm({
			request,
			clientKey,
			scope,
			csrfKey: input.csrfKey,
			limiter: input.limiter,
			action: "transaction_attempt",
		});
		if (!guard.ok) return notice(guard.error === "rate_limited" ? 429 : 403);
		if (guard.action !== "transaction_attempt") return notice();
		const view = await browserView(context, {
			attemptId: guard.attemptId,
			binderHash: guard.cookieHash,
		});
		if (!view || !confirmable(view, guard)) return notice();
		const bytes = crypto.getRandomValues(new Uint8Array(32));
		const response = await completion(view, encodeCoordinatorAuthProof32(bytes));
		if (
			!(await input.operations.confirmDisconnect(
				{
					attemptId: view.attemptId,
					stateHash: view.stateHash,
					binderHash: guard.cookieHash,
					completionSecretHash: await hashCoordinatorAuthProofBytes32(bytes),
				},
				config,
			))
		)
			return notice();
		return response;
	} catch {
		return notice(503);
	}
}
function confirmable(view: BrowserView, guard: { attemptId: string; cookieHash: string }) {
	return (
		view.attemptId === guard.attemptId && view.intent === "disconnect" && view.state === "verified"
	);
}
export async function createCoordinatorAccountChangeBrowser(input: AccountChangeBrowserInput) {
	const settings = captureCoordinatorBrowserAuthConfig(input.config);
	if (settings.kind !== "enabled") return { ok: false as const, error: "browser_auth_unavailable" };
	if (
		!isBrowserCsrfKey(input.csrfKey) ||
		!input.readers ||
		["readStart", "readManagementActivity", "readBrowserBinding"].some(
			(name) => typeof Reflect.get(input.readers, name) !== "function",
		)
	)
		return { ok: false as const, error: "private_reader_required" };
	const oidc = await createCoordinatorOidcClient(settings.oidc, input.oidcOptions);
	if (!oidc.ok) return oidc;
	const context: Context = {
		input,
		client: oidc.client,
		config: settings.store,
		scope: { publicOrigin: settings.publicOrigin, store: settings.store },
		startUrl: `${settings.publicOrigin}${ACCOUNT_CHANGE_BROWSER_PATHS.start}`,
		confirmUrl: `${settings.publicOrigin}${ACCOUNT_CHANGE_BROWSER_PATHS.confirm}`,
	};
	return {
		ok: true as const,
		handlers: Object.freeze({
			startPage: (request: Request) => startPage(context, request),
			start: (request: Request, key: string) => start(context, request, key),
			matchesCallback: (request: Request) => matchesCallback(context, request),
			callback: (request: Request, key: string) => callback(context, request, key),
			confirm: (request: Request, key: string) => confirm(context, request, key),
		}),
	};
}
