/** Browser code entry for headless account linking; the code selects a pending headless attempt. */
import type { CoordinatorAuthBrowserTransactionStore } from "./coordinator-auth-browser-transaction-contract.js";
import {
	type CoordinatorAuthBrowserPage,
	renderAuthBrowserNotice,
	renderAuthSigninContinuePage,
} from "./coordinator-auth-browser-view.js";
import {
	hashHeadlessCodeEntryClient,
	reserveHeadlessCodeEntry,
} from "./coordinator-auth-headless-code-limits.js";
import {
	HEADLESS_LINK_BROWSER_PATHS,
	renderHeadlessCodeLimitedPage,
	renderHeadlessCodePage,
} from "./coordinator-auth-headless-view.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	type CoordinatorAuthHeadlessBrowserStartInput,
	type CoordinatorAuthHeadlessBrowserStartResult,
	hashHeadlessUserCode,
	normalizeHeadlessUserCode,
} from "./coordinator-auth-link-headless.js";
import { captureCoordinatorBrowserAuthConfig } from "./coordinator-browser-auth-config.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
	reissueStartCookieAsTransaction,
} from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	type BrowserCsrfScope,
	deriveBrowserCsrfSubkey,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { type BrowserFormGuardResult, guardBrowserForm } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest, snapshotBrowserRoute } from "./coordinator-browser-request.js";
import { readBrowserStartTransaction } from "./coordinator-browser-start-transaction.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export interface CoordinatorBrowserHeadlessLinkStore
	extends Pick<CoordinatorAuthBrowserTransactionStore, "readAuthBrowserTransactionActivity"> {
	startHeadlessAuthLinkBrowserTransaction(
		input: CoordinatorAuthHeadlessBrowserStartInput,
		config: Parameters<CoordinatorAuthBrowserTransactionStore["startAuthBrowserTransaction"]>[1],
	): Promise<CoordinatorAuthHeadlessBrowserStartResult>;
}
export interface CoordinatorBrowserHeadlessLinkInput {
	config: unknown;
	csrfKey: BrowserCsrfKey;
	store: CoordinatorBrowserHeadlessLinkStore;
	/** Must already have the headless tables; see readHeadlessLinkBackend. */
	limits: Pick<AuthLinkBackend, "first" | "run">;
	limiter: InMemoryRequestRateLimiter;
	oidcOptions?: CoordinatorOidcOptions;
}
export interface CoordinatorBrowserHeadlessLinkHandlers {
	codePage(request: Request): Promise<Response>;
	/** clientAddress must come from the platform (for example CF-Connecting-IP), never a forwarding header. */
	codeStart(request: Request, clientKey: string, clientAddress: string | null): Promise<Response>;
}

type Settings = Extract<
	ReturnType<typeof captureCoordinatorBrowserAuthConfig>,
	{ kind: "enabled" }
>;
type Context = Readonly<{
	storeConfig: Settings["store"];
	scope: BrowserCsrfScope;
	csrfKey: BrowserCsrfKey;
	store: CoordinatorBrowserHeadlessLinkStore;
	limits: CoordinatorBrowserHeadlessLinkInput["limits"];
	limiter: InMemoryRequestRateLimiter;
	client: CoordinatorOidcClient;
	clientHashKey: Awaited<ReturnType<typeof deriveBrowserCsrfSubkey>>;
	pageUrl: string;
}>;
type CodeGuard = Extract<BrowserFormGuardResult, { ok: true; action: "headless_code" }>;
type Snapshot = ReturnType<typeof snapshotBrowserRequest>;

const CLIENT_HASH_LABEL = "codemem-headless-code-entry-client-v1";
// Unknown, expired, used, malformed and desktop codes all render this one response shape.
const CODE_REJECTED_STATUS = 400;
const headersGet = Headers.prototype.get;
const requestHeaders = Object.getOwnPropertyDescriptor(Request.prototype, "headers")?.get;

function pageResponse(page: CoordinatorAuthBrowserPage, status = 200): Response {
	return new Response(page.body, { status, headers: page.headers });
}

async function notice(status: number, headers: Record<string, string> = {}): Promise<Response> {
	const response = pageResponse(await renderAuthBrowserNotice("unavailable"), status);
	for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
	return response;
}

/** Renders the entry form against the browser's start cookie, issuing one if it has none. */
async function codeForm(
	context: Context,
	cookieHeader: string | null,
	options: { rejected: boolean },
): Promise<Response> {
	const transaction = await readBrowserStartTransaction(
		cookieHeader,
		context.store,
		context.storeConfig,
	);
	if (transaction === "invalid") return notice(400);
	if (transaction === "active") return notice(409);
	const existing = await readBrowserCookie(cookieHeader, "start");
	if (existing.kind === "invalid") return notice(400);
	const cookie = existing.kind === "present" ? existing : await issueBrowserCookie("start");
	const csrfToken = await issueBrowserCsrfToken(
		context.csrfKey,
		cookie.secret,
		"start",
		context.scope,
	);
	const status = options.rejected ? CODE_REJECTED_STATUS : 200;
	const response = pageResponse(
		await renderHeadlessCodePage({ csrfToken, rejected: options.rejected }),
		status,
	);
	if ("setCookie" in cookie) response.headers.append("Set-Cookie", cookie.setCookie);
	return response;
}

async function codePage(context: Context, request: Request): Promise<Response> {
	try {
		const route = snapshotBrowserRoute(request);
		if (route.method !== "GET") return await notice(405, { Allow: "GET" });
		const url = new URL(route.url);
		if (`${url.origin}${url.pathname}` !== context.pageUrl) return await notice(404);
		// A link or QR code must never carry a code; the person types it.
		if (route.url !== context.pageUrl) return await notice(400);
		return await codeForm(context, snapshotBrowserRequest(request).cookie, { rejected: false });
	} catch {
		return await notice(503);
	}
}

function guardFailure(guard: Extract<BrowserFormGuardResult, { ok: false }>) {
	switch (guard.error) {
		case "origin_rejected":
			return notice(403);
		case "rate_limited":
			return notice(429, { "Retry-After": String(guard.retryAfterS) });
		case "unsupported_media_type":
			return notice(415);
		case "body_too_large":
			return notice(413);
		case "form_invalid":
			return notice(400);
		case "cookie_invalid":
		case "cookie_missing":
		case "csrf_invalid":
			return notice(403);
		default:
			return notice(503);
	}
}

async function stateHash(state: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(state));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** null when the code selects no startable headless attempt, for any reason. */
async function startWithCode(
	context: Context,
	snapshot: Snapshot,
	guard: CodeGuard,
): Promise<Response | null> {
	const start = await readBrowserCookie(snapshot.cookie, "start");
	if (start.kind !== "present" || start.cookieHash !== guard.cookieHash) return notice(503);
	const code = normalizeHeadlessUserCode(guard.userCode);
	if (code === null) return null;
	// The server derives the hash from the typed code; the form cannot nominate one.
	const userCodeHash = await hashHeadlessUserCode(code);
	let authorization: Awaited<ReturnType<CoordinatorOidcClient["createAuthorizationRequest"]>>;
	try {
		authorization = await context.client.createAuthorizationRequest();
	} catch {
		return notice(503);
	}
	// Build the page and cookies before the single-use claim: a rendering failure afterwards
	// would spend the code without giving this browser its transaction cookie.
	const response = pageResponse(
		await renderAuthSigninContinuePage({ authorizationUrl: authorization.authorizationUrl }),
	);
	response.headers.append("Set-Cookie", reissueStartCookieAsTransaction(start.secret));
	response.headers.append("Set-Cookie", clearBrowserCookie("start"));
	const started = await context.store.startHeadlessAuthLinkBrowserTransaction(
		{
			userCodeHash,
			stateHash: await stateHash(authorization.material.state),
			binderHash: guard.cookieHash,
			nonce: authorization.material.nonce,
			pkceVerifier: authorization.material.pkceVerifier,
		},
		context.storeConfig,
	);
	// Released only after the claim commits.
	if (started.kind !== "started") return null;
	return response;
}

/** Counts the entry before any lookup; over either limit, no code is examined. */
async function reserveEntry(context: Context, clientAddress: string): Promise<Response | null> {
	const decision = await reserveHeadlessCodeEntry(context.limits, {
		coordinatorId: context.storeConfig.coordinatorId,
		clientKeyHash: await hashHeadlessCodeEntryClient(context.clientHashKey, clientAddress),
		nowMs: Date.now(),
	});
	if (decision.allowed) return null;
	const response = pageResponse(await renderHeadlessCodeLimitedPage(), 429);
	response.headers.set("Retry-After", String(Math.ceil(decision.retryAfterMs / 1000)));
	return response;
}

async function codeStart(
	context: Context,
	request: Request,
	clientKey: string,
	clientAddress: string | null,
): Promise<Response> {
	try {
		const route = snapshotBrowserRoute(request);
		if (route.method !== "POST") return await notice(405, { Allow: "POST" });
		const headers = requestHeaders?.call(request) as Headers;
		if (
			new URL(route.url).origin !== context.scope.publicOrigin ||
			headersGet.call(headers, "origin") !== context.scope.publicOrigin
		)
			return await notice(403);
		if (route.url !== context.pageUrl) return await notice(404);
		if (!clientAddress) return await notice(503);
		const snapshot = snapshotBrowserRequest(request);
		const guard = await guardBrowserForm({
			request,
			scope: context.scope,
			csrfKey: context.csrfKey,
			action: "headless_code",
			limiter: context.limiter,
			clientKey,
		});
		if (!guard.ok) return await guardFailure(guard);
		if (guard.action !== "headless_code") return await notice(503);
		const transaction = await readBrowserStartTransaction(
			snapshot.cookie,
			context.store,
			context.storeConfig,
		);
		if (transaction === "invalid") return await notice(400);
		if (transaction === "active") return await notice(409);
		const limited = await reserveEntry(context, clientAddress);
		if (limited) return limited;
		const started = await startWithCode(context, snapshot, guard);
		return started ?? (await codeForm(context, snapshot.cookie, { rejected: true }));
	} catch {
		return await notice(503);
	}
}

/** Discovers the provider and derives the client-hash key once; requests do no setup I/O. */
export async function createCoordinatorBrowserHeadlessLink(
	input: CoordinatorBrowserHeadlessLinkInput,
): Promise<
	| Readonly<{ ok: true; handlers: Readonly<CoordinatorBrowserHeadlessLinkHandlers> }>
	| Readonly<{ ok: false; error: string }>
> {
	const settings = captureCoordinatorBrowserAuthConfig(input.config);
	if (settings.kind !== "enabled") return Object.freeze({ ok: false, error: settings.kind });
	const oidc = await createCoordinatorOidcClient(settings.oidc, input.oidcOptions);
	if (!oidc.ok) return Object.freeze({ ok: false, error: oidc.error });
	const context: Context = Object.freeze({
		storeConfig: settings.store,
		scope: Object.freeze({ publicOrigin: settings.publicOrigin, store: settings.store }),
		csrfKey: input.csrfKey,
		store: input.store,
		limits: input.limits,
		limiter: input.limiter,
		client: oidc.client,
		clientHashKey: await deriveBrowserCsrfSubkey(input.csrfKey, CLIENT_HASH_LABEL),
		pageUrl: new URL(HEADLESS_LINK_BROWSER_PATHS.code, settings.publicOrigin).href,
	});
	return Object.freeze({
		ok: true,
		handlers: Object.freeze({
			codePage: (request: Request) => codePage(context, request),
			codeStart: (request: Request, clientKey: string, clientAddress: string | null) =>
				codeStart(context, request, clientKey, clientAddress),
		}),
	});
}
