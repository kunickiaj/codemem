import { CoordinatorAuthBrowserTransactions } from "./coordinator-auth-browser-transaction.js";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { authLinkNow } from "./coordinator-auth-link.js";
import { captureCoordinatorBrowserAuthConfig } from "./coordinator-browser-auth-config.js";
import {
	type BrowserCookieReadResult,
	readBrowserCookie,
} from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	isBrowserCsrfKey,
	issueBrowserCsrfToken,
	verifyBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { readBrowserStartTransaction } from "./coordinator-browser-start-transaction.js";
import { renderOwnerEnrollmentStartForm } from "./coordinator-owner-enrollment-http.js";
import {
	ownerAdmissionSchemaReady,
	readOwnerAdmissionAuthority,
} from "./owner-browser-admission-authority.js";
import { readOwnerAdmissionUpload } from "./owner-browser-admission-body.js";
import {
	isOwnerEnrollmentAdmissionKey,
	issueOwnerEnrollmentAdmissionV2,
	type OwnerEnrollmentAdmissionKey,
	type OwnerEnrollmentResolvedOwner,
} from "./owner-enrollment-admission.js";
import {
	type createCoordinatorOwnerEnrollment,
	ownerEnrollmentHash,
} from "./owner-enrollment-start.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export const OWNER_BROWSER_ADMISSION_PATH = "/auth/owner/admit";
type Enrollment = Extract<
	Awaited<ReturnType<typeof createCoordinatorOwnerEnrollment>>,
	{ ok: true }
>["enrollment"];
export interface OwnerBrowserAdmissionOptions {
	/** Explicit owner opt-in, independent of management sign-in being enabled. */
	enabled: boolean;
	config: unknown;
	backend: AuthLinkBackend;
	csrfKey: BrowserCsrfKey;
	admissionKey: OwnerEnrollmentAdmissionKey;
	limiter: InMemoryRequestRateLimiter;
	clock?: () => number;
	/** Lazy production owner composition. No OIDC discovery may run during setup. */
	getEnrollment(): Promise<Pick<Enrollment, "startOwnerBound">>;
}

function response(body: string, status = 400, cookies: string[] = []): Response {
	const headers = new Headers({
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy":
			"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	});
	for (const cookie of cookies) headers.append("Set-Cookie", cookie);
	return new Response(body, { status, headers });
}
function denied(status = 400) {
	return response(
		'Owner admission unavailable. Sign in at <a href="/auth/sign-in">Sign in</a> and prepare a new device request on this computer.',
		status,
	);
}
function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? "",
	);
}
function uploadPage(csrf: string): Response {
	return response(
		`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize device request</title><body>
<h1>Authorize device request</h1>
<p>Upload the private capability-request.json created on this computer. Do not upload a request sent by someone else: its signature proves possession of a key, not that the key belongs to this computer.</p>
<p>Read your local device review first. Compare the device ID and key fingerprint shown in the next step before choosing an account. This authorizes a request; it does not finish enrollment. A fresh account check and device confirmation still follow.</p>
<form method="post" action="${OWNER_BROWSER_ADMISSION_PATH}" enctype="multipart/form-data">
<input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
<label>Private device request <input type="file" name="request" accept="application/json,.json" required></label>
<button type="submit">Authorize device request</button></form></body></html>`,
		200,
	);
}
function transportValid(request: Request, origin: string): boolean {
	const url = new URL(request.url);
	const source = request.headers.get("origin");
	return (
		request.url.length <= 8192 &&
		url.origin === origin &&
		!url.username &&
		!url.password &&
		!url.search &&
		!url.hash &&
		(source === null || source === origin) &&
		(request.method !== "POST" || source === origin)
	);
}

/** Unmounted first slice: caller must reserve this path and dispatch BEFORE browser/OIDC setup.
 * No capability is returned to the browser. Session authority admits only a new exact start;
 * it never replaces the later fresh owner-purpose OIDC proof or pending-key finalization.
 */
export function createOwnerBrowserAdmissionHandler(options: OwnerBrowserAdmissionOptions) {
	const settings = captureCoordinatorBrowserAuthConfig(options.config);
	if (
		settings.kind === "enabled" &&
		new URL(settings.store.redirectUri).pathname === OWNER_BROWSER_ADMISSION_PATH
	)
		throw new Error("owner_admission_callback_collision");
	const enabled =
		options.enabled &&
		settings.kind === "enabled" &&
		isBrowserCsrfKey(options.csrfKey) &&
		isOwnerEnrollmentAdmissionKey(options.admissionKey);
	return async (request: Request, trustedClientKey: string): Promise<Response | null> => {
		if (new URL(request.url).pathname !== OWNER_BROWSER_ADMISSION_PATH) return null;
		if (!enabled || settings.kind !== "enabled") return denied(404);
		try {
			const rejection = checkTransport(request, trustedClientKey, options, settings);
			if (rejection) return rejection;
			return await handle(request, trustedClientKey, options, settings);
		} catch {
			return denied();
		}
	};
}
type Settings = Extract<
	ReturnType<typeof captureCoordinatorBrowserAuthConfig>,
	{ kind: "enabled" }
>;
function checkTransport(
	request: Request,
	clientKey: string,
	options: OwnerBrowserAdmissionOptions,
	settings: Settings,
): Response | null {
	if (!transportValid(request, settings.publicOrigin)) return denied();
	if (request.method !== "GET" && request.method !== "POST") return denied(405);
	if (!isAuthControllerId(clientKey) || clientKey.length > 128) return denied();
	if (
		!options.limiter.check(
			JSON.stringify(["owner-admit-client", settings.store.coordinatorId, clientKey]),
			20,
		).allowed
	)
		return denied(429);
	return null;
}
async function availableTransaction(
	request: Request,
	backend: AuthLinkBackend,
	settings: Settings,
	now: () => number,
) {
	const transactions = new CoordinatorAuthBrowserTransactions(backend, now);
	const activity = (header: string | null) =>
		readBrowserStartTransaction(header, transactions, settings.store);
	const transaction = await activity(request.headers.get("cookie"));
	if (transaction === "active" || transaction === "invalid") return null;
	const startCookie = await readBrowserCookie(request.headers.get("cookie"), "start");
	return startCookie.kind === "invalid" ? null : activity;
}
async function handle(
	request: Request,
	clientKey: string,
	options: OwnerBrowserAdmissionOptions,
	settings: Settings,
): Promise<Response> {
	const { backend, csrfKey } = options;
	if (!(await ownerAdmissionSchemaReady(backend))) return denied();
	const cookie = await readBrowserCookie(request.headers.get("cookie"), "session");
	if (cookie.kind !== "present") return denied(403);
	const now = () => authLinkNow(options.clock ?? Date.now);
	const base = { backend, config: settings.store, sessionCookieHash: cookie.cookieHash };
	// GET has no pending key yet. This checks trusted grants and orphan exclusions;
	// POST repeats the same predicate with the exact signed device and canonical key.
	const owner = await readOwnerAdmissionAuthority({
		...base,
		time: now(),
		deviceId: "",
		fingerprint: "",
	});
	if (!owner) return denied(403);
	if (
		!options.limiter.check(
			JSON.stringify(["owner-admit-identity", owner.coordinatorId, owner.identityId]),
			10,
		).allowed
	)
		return denied(429);
	const scope = { publicOrigin: settings.publicOrigin, store: settings.store };
	const transactionActivity = await availableTransaction(request, backend, settings, now);
	if (!transactionActivity) return denied();
	if (request.method === "GET")
		return uploadPage(await issueBrowserCsrfToken(csrfKey, cookie.secret, "session", scope));
	return submitUpload(request, clientKey, options, settings, {
		cookie,
		owner,
		transactionActivity,
		now,
	});
}
interface UploadContext {
	cookie: Extract<BrowserCookieReadResult, { kind: "present" }>;
	owner: OwnerEnrollmentResolvedOwner;
	transactionActivity: NonNullable<Awaited<ReturnType<typeof availableTransaction>>>;
	now: () => number;
}
async function submitUpload(
	request: Request,
	clientKey: string,
	options: OwnerBrowserAdmissionOptions,
	settings: Settings,
	context: UploadContext,
): Promise<Response> {
	const { cookie, owner, transactionActivity, now } = context;
	const { backend, csrfKey, admissionKey } = options;
	const scope = { publicOrigin: settings.publicOrigin, store: settings.store };
	const upload = await readOwnerAdmissionUpload(request);
	if (
		!upload ||
		!(await verifyBrowserCsrfToken(csrfKey, cookie.secret, "session", scope, upload.csrf))
	)
		return denied();
	const { start } = upload;
	const fingerprint = await ownerEnrollmentHash(start.publicKey);
	const current = await readOwnerAdmissionAuthority({
		backend,
		config: settings.store,
		sessionCookieHash: cookie.cookieHash,
		time: now(),
		deviceId: start.deviceId,
		fingerprint,
	});
	if (!current || JSON.stringify(current) !== JSON.stringify(owner)) return denied(403);
	const pin = {
		coordinatorId: settings.store.coordinatorId,
		origin: settings.publicOrigin,
		issuer: settings.store.issuer,
		revision: settings.store.revision,
	};
	const admissionToken = await issueOwnerEnrollmentAdmissionV2(admissionKey, pin, start, {
		resolvedOwner: current,
		nowMs: now(),
		ttlMs: 60_000,
	});
	const enrollment = await options.getEnrollment();
	const result = await enrollment.startOwnerBound(start, clientKey, {
		admissionToken,
		resolvedOwner: current,
		sessionCookieHash: cookie.cookieHash,
	});
	if (result.kind !== "started") return denied();
	return renderOwnerEnrollmentStartForm(
		request,
		{ scope, key: csrfKey, transactionActivity },
		{
			attemptId: start.attemptId,
			startCode: start.browserStartCode,
			deviceId: start.deviceId,
			fingerprint,
		},
	);
}
