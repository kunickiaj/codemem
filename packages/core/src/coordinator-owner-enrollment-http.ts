/** Private owner-only transport. No public entrypoint mounts this adapter. */
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { parseCoordinatorAuthLoopback } from "./coordinator-auth-loopback.js";
import { captureCoordinatorBrowserAuthConfig } from "./coordinator-browser-auth-config.js";
import {
	clearBrowserCookie,
	issueBrowserCookie,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	type BrowserCsrfScope,
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { parseBrowserFormBody, readBrowserFormBody } from "./coordinator-browser-form-body.js";
import type { CoordinatorOidcOptions } from "./coordinator-oidc.js";
import {
	createCoordinatorOwnerEnrollment,
	type OwnerEnrollmentStart,
	type OwnerEnrollmentStartResult,
} from "./owner-enrollment-start.js";
import {
	createInMemoryRequestRateLimiter,
	type InMemoryRequestRateLimiter,
} from "./request-rate-limit.js";

interface HttpOptions {
	config: unknown;
	backend: AuthLinkBackend;
	oidcOptions: CoordinatorOidcOptions;
	clock?: () => number;
}
type Enrollment = Extract<
	Awaited<ReturnType<typeof createCoordinatorOwnerEnrollment>>,
	{ ok: true }
>["enrollment"];
type Verified = Extract<OwnerEnrollmentStartResult, { kind: "verified" }>;
const START_PATH = "/auth/owner/start";
const CONFIRM_PATH = "/auth/owner/confirm";
const ATTEMPTS_PATH = "/v1/auth/owner-attempts";

function respond(
	body: string | null,
	status: number,
	headers: ConstructorParameters<typeof Headers>[0] = {},
): Response {
	const safe = new Headers(headers);
	safe.set("Cache-Control", "no-store");
	safe.set("Referrer-Policy", "no-referrer");
	safe.set("X-Content-Type-Options", "nosniff");
	safe.set(
		"Content-Security-Policy",
		"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
	);
	return new Response(body, { status, headers: safe });
}
function reject(status = 400): Response {
	return respond("Owner enrollment unavailable.", status);
}
function json(value: unknown): Response {
	return respond(JSON.stringify(value), 200, { "Content-Type": "application/json" });
}
function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character] ?? "";
	});
}
function hidden(name: string, value: string): string {
	return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}
function form(action: string, fields: Record<string, string>, button: string): string {
	return `<form method="post" action="${action}">${Object.entries(fields)
		.map(([name, value]) => hidden(name, value))
		.join("")}<button type="submit">${button}</button></form>`;
}
function page(content: string, cookies: string[] = []): Response {
	const headers = new Headers({ "Content-Type": "text/html; charset=utf-8" });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return respond(
		`<!doctype html><html lang="en"><meta charset="utf-8"><title>Enroll owner device</title><body>${content}</body></html>`,
		200,
		headers,
	);
}
function redirect(location: string, cookies: string[]): Response {
	const headers = new Headers({ Location: location });
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return respond(null, 303, headers);
}
async function startPage(
	request: Request,
	scope: BrowserCsrfScope,
	key: BrowserCsrfKey,
): Promise<Response> {
	const url = new URL(request.url);
	const attemptId = url.searchParams.get("attempt_id");
	const startCode = url.searchParams.get("start_code");
	const fields = new URLSearchParams({
		csrf: "",
		attempt_id: attemptId ?? "",
		start_code: startCode ?? "",
	});
	if (
		url.searchParams.size !== 2 ||
		!parseBrowserFormBody(new TextEncoder().encode(fields.toString()), "link_start").ok
	)
		return reject();
	const transaction = await readBrowserCookie(request.headers.get("cookie"), "transaction");
	const current = await readBrowserCookie(request.headers.get("cookie"), "start");
	if (transaction.kind !== "absent" || current.kind === "invalid") return reject();
	const issued = current.kind === "absent" ? await issueBrowserCookie("start") : null;
	const secret = current.kind === "present" ? current.secret : issued?.secret;
	if (!secret) return reject();
	const csrf = await issueBrowserCsrfToken(key, secret, "start", scope);
	return page(
		`<h1>Enroll owner device</h1>${form(START_PATH, { csrf, attempt_id: attemptId ?? "", start_code: startCode ?? "" }, "Choose account")}`,
		issued ? [issued.setCookie] : [],
	);
}
function confirmationPage(result: Verified): Response {
	const c = result.confirmation;
	const details = {
		"Verified account subject": c.subject,
		Issuer: c.issuer,
		Identity: c.identityId,
		"Pending device ID": c.deviceId,
		Fingerprint: c.fingerprint,
		Groups: c.groups.join(", "),
	};
	const display = Object.entries(details)
		.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`)
		.join("");
	return page(
		`<h1>Confirm owner device</h1><dl>${display}</dl>${form(CONFIRM_PATH, { csrf: result.csrf, attempt_id: c.attemptId, confirmation_hash: c.confirmationHash }, "Enroll this device")}`,
	);
}
function formHeadersValid(request: Request, origin: string): boolean {
	return (
		request.headers.get("origin") === origin &&
		/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(
			request.headers.get("content-type") ?? "",
		)
	);
}
async function confirmBrowser(
	request: Request,
	api: Enrollment,
	clientKey: string,
	origin: string,
): Promise<Response> {
	// Check original transport/cookie headers before reading a bounded clone. The API
	// authenticates the same cookie and CSRF after removing the display commitment.
	if (!formHeadersValid(request, origin)) return reject();
	const cookie = await readBrowserCookie(request.headers.get("cookie"), "transaction");
	if (cookie.kind !== "present") return reject();
	const copy = request.clone();
	const read = await readBrowserFormBody({
		body: copy.body,
		contentLength: copy.headers.get("content-length"),
	});
	if (!read.ok) return reject();
	const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(read.bytes);
	if (!/^[A-Za-z0-9*._%+=&-]+$/.test(raw)) return reject();
	const fields = new URLSearchParams(raw);
	const hashes = fields.getAll("confirmation_hash");
	if (hashes.length !== 1 || !/^[a-f0-9]{64}$/.test(hashes[0] ?? "")) return reject();
	fields.delete("confirmation_hash");
	const body = fields.toString();
	if (!parseBrowserFormBody(new TextEncoder().encode(body), "transaction_attempt").ok)
		return reject();
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	const checked = new Request(request.url, { method: "POST", headers, body });
	const result = await api.confirm(checked, clientKey, hashes[0] as string);
	if (result.kind !== "confirmed") return reject();
	const destination = parseCoordinatorAuthLoopback(result.loopbackRedirect);
	if (!destination.ok) return reject();
	const location = new URL(destination.destination);
	location.searchParams.set("attempt_id", result.confirmation.attemptId);
	location.searchParams.set("completion", result.completionSecret);
	location.searchParams.set("confirmation", result.confirmation.confirmationHash);
	return redirect(location.href, [clearBrowserCookie("transaction")]);
}
async function jsonAction(request: Request, api: Enrollment, clientKey: string): Promise<Response> {
	if (
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")
	)
		return reject(415);
	const read = await readBrowserFormBody({
		body: request.body,
		contentLength: request.headers.get("content-length"),
	});
	if (!read.ok) return reject();
	const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
	if (!body || typeof body !== "object" || Array.isArray(body)) return reject();
	const finalize = new URL(request.url).pathname.endsWith("/finalize");
	const keys = finalize
		? ["attemptId", "completionSecret", "signature"]
		: ["attemptId", "deviceId", "publicKey", "loopbackRedirect", "browserStartCode", "signature"];
	if (
		Object.keys(body).length !== keys.length ||
		keys.some((name) => typeof Reflect.get(body, name) !== "string")
	)
		return reject();
	const result = finalize
		? await api.finalize(body as Parameters<Enrollment["finalize"]>[0])
		: await api.start(body as OwnerEnrollmentStart, clientKey);
	if (result.kind === "started" || result.kind === "finalized" || result.kind === "prior_commit")
		return json(result);
	return reject();
}
function routeMethod(path: string, callback: string): string | null {
	if (path === "/v1/auth/owner-pilot" || path === callback) return "GET";
	if (path === START_PATH) return "GET, POST";
	if (path === CONFIRM_PATH || path === ATTEMPTS_PATH || path === `${ATTEMPTS_PATH}/finalize`)
		return "POST";
	return null;
}
async function dispatch(
	request: Request,
	clientKey: string,
	context: HttpContext,
): Promise<Response> {
	const { api, scope, key, pin, callback } = context;
	const path = new URL(request.url).pathname;
	if (path === "/v1/auth/owner-pilot") return json(pin);
	if (path === ATTEMPTS_PATH || path === `${ATTEMPTS_PATH}/finalize`)
		return jsonAction(request, api, clientKey);
	if (path === START_PATH && request.method === "GET") return startPage(request, scope, key);
	if (path === START_PATH) {
		const result = await api.claimBrowser(request, clientKey);
		return result.kind === "browser_claimed"
			? redirect(result.authorizationUrl, result.setCookies)
			: reject();
	}
	if (path === CONFIRM_PATH) return confirmBrowser(request, api, clientKey, scope.publicOrigin);
	if (path === callback) {
		const result = await api.verifyCallback(request);
		return result.kind === "verified" ? confirmationPage(result) : reject();
	}
	return reject(404);
}

type HttpContext = {
	api: Enrollment;
	scope: BrowserCsrfScope;
	key: BrowserCsrfKey;
	pin: BrowserCsrfScope["store"] & { origin: string; issuer: string };
	callback: string;
	limiter: InMemoryRequestRateLimiter;
};
function checkTransport(request: Request, context: HttpContext): Response | null {
	const url = new URL(request.url);
	if (
		request.url.length > 8192 ||
		url.origin !== context.pin.origin ||
		url.username ||
		url.password ||
		url.hash
	)
		return reject();
	const methods = routeMethod(url.pathname, context.callback);
	if (!methods) return reject(404);
	if (!methods.split(", ").includes(request.method)) return respond(null, 405, { Allow: methods });
	if (url.search && ![START_PATH, context.callback].includes(url.pathname)) return reject();
	if (request.method === "POST" && url.search) return reject();
	const origin = request.headers.get("origin");
	if (origin !== null && origin !== context.pin.origin) return reject();
	return null;
}
async function handleOwnerRequest(
	request: Request,
	trustedClientKey: string,
	context: HttpContext,
): Promise<Response> {
	try {
		const error = checkTransport(request, context);
		if (error) return error;
		if (!isAuthControllerId(trustedClientKey) || trustedClientKey.length > 128) return reject();
		if (
			!context.limiter.check(
				JSON.stringify(["owner-http", context.pin.coordinatorId, trustedClientKey]),
				60,
			).allowed
		)
			return reject(429);
		return await dispatch(request, trustedClientKey, context);
	} catch {
		return reject();
	}
}

/** Server supplies the trusted client key; no header or request body can override it. */
export async function createCoordinatorOwnerEnrollmentHttp(options: HttpOptions) {
	const settings = captureCoordinatorBrowserAuthConfig(options.config);
	if (settings.kind !== "enabled") throw new Error("owner_enrollment_http_unavailable");
	const callback = new URL(settings.store.redirectUri).pathname;
	if (routeMethod(callback, "") !== null) throw new Error("owner_enrollment_http_unavailable");
	const csrfKey = await importBrowserCsrfKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
	const limiter = createInMemoryRequestRateLimiter({ now: options.clock });
	const created = await createCoordinatorOwnerEnrollment({
		...options,
		mode: "local_test",
		purpose: "owner_enroll",
		csrfKey,
		limiter,
	});
	if (!created.ok) throw new Error("owner_enrollment_http_unavailable");
	const pin = Object.freeze({
		coordinatorId: settings.store.coordinatorId,
		origin: settings.publicOrigin,
		issuer: settings.store.issuer,
		revision: settings.store.revision,
	});
	const scope = { publicOrigin: pin.origin, store: settings.store };
	const context = { api: created.enrollment, scope, key: csrfKey, pin, callback, limiter };
	return {
		pin,
		handle: (request: Request, trustedClientKey: string) =>
			handleOwnerRequest(request, trustedClientKey, context),
	};
}
