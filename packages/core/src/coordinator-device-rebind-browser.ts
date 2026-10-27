/** Browser routes for ADR 0005 Section 8 rebinding; the ceremony re-checks every step. */
import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import {
	type CoordinatorAuthBrowserPage,
	renderAuthSigninContinuePage,
} from "./coordinator-auth-browser-view.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { decodeCoordinatorAuthProof32 } from "./coordinator-auth-proof.js";
import { captureCoordinatorBrowserAuthConfig } from "./coordinator-browser-auth-config.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import { type BrowserCsrfKey, issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { readBrowserFormBody } from "./coordinator-browser-form-body.js";
import { checkBrowserAuthRequestRate } from "./coordinator-browser-form-guard.js";
import { snapshotBrowserRequest } from "./coordinator-browser-request.js";
import { readBrowserStartTransaction } from "./coordinator-browser-start-transaction.js";
import {
	createDeviceRebindCeremony,
	type DeviceRebindResult,
} from "./coordinator-device-rebind-ceremony.js";
import {
	DEVICE_REBIND_BROWSER_PATHS,
	renderDeviceRebindConfirmPage,
	renderDeviceRebindHopPage,
	renderDeviceRebindNotice,
	renderDeviceRebindReturnPage,
	renderDeviceRebindStartPage,
} from "./coordinator-device-rebind-view.js";
import {
	type CoordinatorOidcClient,
	type CoordinatorOidcOptions,
	createCoordinatorOidcClient,
} from "./coordinator-oidc.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export interface DeviceRebindBrowserInput {
	config: unknown;
	csrfKey: BrowserCsrfKey;
	limiter: InMemoryRequestRateLimiter;
	/** Must already have the rebind tables; see readDeviceRebindBackend. */
	backend: AuthLinkBackend;
	oidcOptions?: CoordinatorOidcOptions;
	now?: () => number;
}

type Ceremony = ReturnType<typeof createDeviceRebindCeremony>;
interface Context {
	ceremony: Ceremony;
	csrfKey: BrowserCsrfKey;
	limiter: InMemoryRequestRateLimiter;
	scope: { publicOrigin: string; store: Parameters<typeof readBrowserStartTransaction>[2] };
	startUrl: string;
	transactions: CoordinatorAuthBrowserTransactions;
}

function pageResponse(page: CoordinatorAuthBrowserPage, status = 200): Response {
	return new Response(page.body, { status, headers: page.headers });
}

async function notice(result: DeviceRebindResult | null, status = 403): Promise<Response> {
	const reason = result?.kind === "refused" ? result.reason : "unknown";
	return pageResponse(await renderDeviceRebindNotice(reason), reason === "unknown" ? 503 : status);
}

async function browserNotice(kind: "rate_limited" | "busy", status: 409 | 429): Promise<Response> {
	return pageResponse(await renderDeviceRebindNotice(kind), status);
}

/** Exactly `attempt_id` and a canonical 32-byte `start_code` at the start URL. */
function startQuery(text: string, startUrl: string) {
	if (text.length > 8192 || text.includes("#")) return null;
	const url = new URL(text);
	if (`${url.origin}${url.pathname}` !== startUrl || url.username || url.password) return null;
	const attemptId = url.searchParams.get("attempt_id");
	const startCode = url.searchParams.get("start_code");
	if (
		[...url.searchParams].length !== 2 ||
		!isAuthControllerId(attemptId) ||
		!startCode ||
		!decodeCoordinatorAuthProof32(startCode)
	)
		return null;
	return { attemptId, startCode };
}

async function startPage(context: Context, request: Request, clientKey: string) {
	const snapshot = snapshotBrowserRequest(request);
	const rateKey = JSON.stringify(["device-rebind-start-page", clientKey]);
	if (!checkBrowserAuthRequestRate(request, context.limiter, rateKey, 30).allowed)
		return browserNotice("rate_limited", 429);
	const query = startQuery(snapshot.url, context.startUrl);
	if (!query) return notice({ kind: "refused", reason: "unavailable" }, 400);
	const transaction = await readBrowserStartTransaction(
		snapshot.cookie,
		context.transactions,
		context.scope.store,
	);
	const current = await readBrowserCookie(snapshot.cookie, "start");
	if (transaction === "active") return browserNotice("busy", 409);
	if (transaction === "invalid" || current.kind === "invalid")
		return notice({ kind: "refused", reason: "unavailable" }, 400);
	const issued = current.kind === "absent" ? await issueBrowserCookie("start") : null;
	const secret = current.kind === "present" ? current.secret : issued?.secret;
	if (!secret) return notice(null);
	const csrf = await issueBrowserCsrfToken(context.csrfKey, secret, "start", context.scope);
	const response = pageResponse(await renderDeviceRebindStartPage({ ...query, csrf }));
	if (issued) response.headers.append("Set-Cookie", issued.setCookie);
	return response;
}

async function start(context: Context, request: Request, clientKey: string) {
	const result = await context.ceremony.claimBrowser(request, clientKey);
	if (result?.kind !== "browser_claimed") return notice(result);
	const response = pageResponse(
		await renderAuthSigninContinuePage({ authorizationUrl: result.authorizationUrl }),
	);
	for (const cookie of result.setCookies) response.headers.append("Set-Cookie", cookie);
	return response;
}

/**
 * The form carries the confirmation hash the person saw. It is removed before
 * the shared form guard reads the body, then checked by the ceremony.
 */
async function confirmationForm(request: Request, origin: string) {
	if (
		request.headers.get("origin") !== origin ||
		!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(
			request.headers.get("content-type") ?? "",
		)
	)
		return null;
	const copy = request.clone();
	const read = await readBrowserFormBody({
		body: copy.body,
		contentLength: copy.headers.get("content-length"),
	});
	if (!read.ok) return null;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
	} catch {
		return null;
	}
	const fields = new URLSearchParams(text);
	const hashes = fields.getAll("confirmation_hash");
	const attemptId = fields.get("attempt_id");
	if (hashes.length !== 1 || !/^[a-f0-9]{64}$/.test(hashes[0] ?? "") || !attemptId) return null;
	fields.delete("confirmation_hash");
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	const checked = new Request(request.url, { method: "POST", headers, body: fields.toString() });
	return { checked, attemptId, confirmationHash: hashes[0] as string };
}

async function confirm(context: Context, request: Request, clientKey: string) {
	const form = await confirmationForm(request, context.scope.publicOrigin);
	if (!form) return notice({ kind: "refused", reason: "unavailable" }, 400);
	const result = await context.ceremony.confirm(form.checked, clientKey, form.confirmationHash);
	if (result?.kind !== "confirmed") return notice(result);
	const response = pageResponse(
		await renderDeviceRebindHopPage({
			loopbackRedirect: result.loopbackRedirect,
			attemptId: form.attemptId,
			completionSecret: result.completionSecret,
			confirmationHash: form.confirmationHash,
		}),
	);
	response.headers.append("Set-Cookie", clearBrowserCookie("transaction"));
	return response;
}

/** null when the callback belongs to another ceremony. */
async function callback(context: Context, request: Request): Promise<Response | null> {
	const result = await context.ceremony.verifyCallback(request);
	if (result === null) return null;
	if (result.kind === "refused" && result.retired) {
		const response = result.returnTo
			? pageResponse(
					await renderDeviceRebindReturnPage({ reason: result.reason, ...result.returnTo }),
				)
			: await notice(result);
		// Without this, the spent transaction blocks a fresh start until it expires.
		response.headers.append("Set-Cookie", clearBrowserCookie("transaction"));
		return response;
	}
	if (result.kind !== "verified") return notice(result);
	return pageResponse(
		await renderDeviceRebindConfirmPage({ confirmation: result.confirmation, csrf: result.csrf }),
	);
}

/** Unexpected errors render the unknown-outcome page; the device then reads status. */
function guarded<A extends unknown[]>(
	step: (context: Context, ...args: A) => Promise<Response>,
	context: Context,
) {
	return async (...args: A): Promise<Response> => {
		try {
			return await step(context, ...args);
		} catch {
			return notice(null);
		}
	};
}

export async function createDeviceRebindBrowser(input: DeviceRebindBrowserInput) {
	const settings = captureCoordinatorBrowserAuthConfig(input.config);
	if (settings.kind !== "enabled") return { ok: false as const };
	const now = input.now ?? (() => Date.now());
	// Discovery waits for the first rebind. Only a finished client is kept, so
	// concurrent requests never share another request's discovery.
	let finished: CoordinatorOidcClient | undefined;
	const oidc = async () => {
		if (finished) return finished;
		const created = await createCoordinatorOidcClient(settings.oidc, input.oidcOptions);
		if (!created.ok) throw new Error("device_rebind_oidc_unavailable");
		finished ??= created.client;
		return finished;
	};
	const client: Pick<CoordinatorOidcClient, "createAuthorizationRequest" | "verifyCallback"> = {
		createAuthorizationRequest: async () => (await oidc()).createAuthorizationRequest(),
		verifyCallback: async (...args) => (await oidc()).verifyCallback(...args),
	};
	const context: Context = {
		ceremony: createDeviceRebindCeremony({
			backend: input.backend,
			config: settings.store,
			publicOrigin: settings.publicOrigin,
			csrfKey: input.csrfKey,
			limiter: input.limiter,
			client,
			now,
		}),
		csrfKey: input.csrfKey,
		limiter: input.limiter,
		scope: { publicOrigin: settings.publicOrigin, store: settings.store },
		startUrl: `${settings.publicOrigin}${DEVICE_REBIND_BROWSER_PATHS.start}`,
		transactions: new CoordinatorAuthBrowserTransactions(input.backend, now),
	};
	return {
		ok: true as const,
		handlers: Object.freeze({
			startPage: guarded(startPage, context),
			start: guarded(start, context),
			confirm: guarded(confirm, context),
			callback: async (request: Request): Promise<Response | null> => {
				try {
					return await callback(context, request);
				} catch {
					return notice(null);
				}
			},
		}),
	};
}
