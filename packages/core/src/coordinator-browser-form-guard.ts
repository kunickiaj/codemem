import { isAuthControllerId } from "./coordinator-auth-controller.js";
import { type CookieKind, readBrowserCookie } from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	type BrowserCsrfScope,
	isBrowserCsrfToken,
	verifyBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import {
	BROWSER_FORM_BODY_MAX_BYTES,
	type BrowserFormAction,
	parseBrowserFormBody,
	readBrowserFormBody,
} from "./coordinator-browser-form-body.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export const BROWSER_FORM_REJECTIONS = Object.freeze([
	"invalid_input",
	"method_not_allowed",
	"client_unidentified",
	"rate_limited",
	"origin_rejected",
	"unsupported_media_type",
	"body_too_large",
	"form_invalid",
	"cookie_missing",
	"cookie_invalid",
	"csrf_invalid",
] as const);
type Rejection = (typeof BROWSER_FORM_REJECTIONS)[number];
type Failure = Readonly<{ ok: false; error: Rejection; retryAfterS?: number }>;
export type BrowserFormGuardResult =
	| Readonly<{ ok: true; action: "session_logout"; cookieHash: string }>
	| Readonly<{ ok: true; action: "signin_start"; cookieHash: string }>
	| Readonly<{ ok: true; action: "transaction_attempt"; cookieHash: string; attemptId: string }>
	| Failure;
export interface BrowserFormGuardInput {
	request: Request;
	scope: BrowserCsrfScope;
	csrfKey: BrowserCsrfKey;
	action: BrowserFormAction;
	limiter: InMemoryRequestRateLimiter;
	clientKey: string;
	limit?: number;
}
const INVALID_INPUT: Failure = Object.freeze({ ok: false, error: "invalid_input" });
const ACTION_COOKIE_KINDS: Readonly<Record<BrowserFormAction, CookieKind>> = Object.freeze({
	transaction_attempt: "transaction",
	session_logout: "session",
	signin_start: "start",
});
const ratePolicies = new WeakMap<InMemoryRequestRateLimiter, Map<string, number>>();
const headersGet = Headers.prototype.get;
function nativeRequestGetter(name: string): ((this: Request) => unknown) | undefined {
	let prototype: object | null = Request.prototype;
	while (prototype !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
		if (descriptor) return descriptor.get;
		prototype = Object.getPrototypeOf(prototype);
	}
	return undefined;
}
const requestGetters = Object.freeze({
	method: nativeRequestGetter("method"),
	url: nativeRequestGetter("url"),
	headers: nativeRequestGetter("headers"),
	body: nativeRequestGetter("body"),
});
type Snapshot = Readonly<{
	scope: BrowserCsrfScope;
	csrfKey: BrowserCsrfKey;
	action: BrowserFormAction;
	kind: CookieKind;
	limiter: InMemoryRequestRateLimiter;
	check: InMemoryRequestRateLimiter["check"];
	clientKey: unknown;
	limit: unknown;
	method: string;
	url: string;
	origin: string | null;
	mediaType: string | null;
	contentLength: string | null;
	cookie: string | null;
	body: ReadableStream<Uint8Array> | null;
}>;

function reject(error: Rejection): Failure {
	return Object.freeze({ ok: false, error });
}

function ownData(value: unknown, name: string): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw INVALID_INPUT;
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	if (!descriptor || !Object.hasOwn(descriptor, "value")) throw INVALID_INPUT;
	return descriptor.value;
}

function captureScope(value: unknown): BrowserCsrfScope {
	const publicOrigin = ownData(value, "publicOrigin");
	const store = ownData(value, "store");
	const coordinatorId = ownData(store, "coordinatorId");
	const revision = ownData(store, "revision");
	if (typeof publicOrigin !== "string" || /[\\\p{Cc}\p{Cf}\p{Cs}]/u.test(publicOrigin)) {
		throw INVALID_INPUT;
	}
	const url = new URL(publicOrigin);
	if (url.protocol !== "https:" || url.origin !== publicOrigin || url.username || url.password) {
		throw INVALID_INPUT;
	}
	if (
		!isAuthControllerId(coordinatorId) ||
		typeof revision !== "string" ||
		revision.length !== 64 ||
		!/^[a-f0-9]{64}$/.test(revision)
	)
		throw INVALID_INPUT;
	return Object.freeze({ publicOrigin, store: Object.freeze({ coordinatorId, revision }) });
}

function captureCheck(value: unknown): InMemoryRequestRateLimiter["check"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw INVALID_INPUT;
	const seen = new Set<object>();
	let cursor: object | null = value;
	while (cursor !== null) {
		if (seen.has(cursor)) throw INVALID_INPUT;
		seen.add(cursor);
		const descriptor = Object.getOwnPropertyDescriptor(cursor, "check");
		if (descriptor) {
			if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
				throw INVALID_INPUT;
			}
			return descriptor.value;
		}
		cursor = Object.getPrototypeOf(cursor);
	}
	throw INVALID_INPUT;
}

function captureInput(input: BrowserFormGuardInput): Snapshot {
	const request = ownData(input, "request");
	const scope = captureScope(ownData(input, "scope"));
	const csrfKey = ownData(input, "csrfKey") as BrowserCsrfKey;
	const action = ownData(input, "action");
	const limiter = ownData(input, "limiter");
	const check = captureCheck(limiter);
	const clientKey = ownData(input, "clientKey");
	const limitDescriptor = Object.getOwnPropertyDescriptor(input, "limit");
	if (limitDescriptor && !Object.hasOwn(limitDescriptor, "value")) throw INVALID_INPUT;
	const suppliedLimit: unknown = limitDescriptor?.value;
	const limit = suppliedLimit === undefined ? 20 : suppliedLimit;
	if (
		!(request instanceof Request) ||
		(action !== "session_logout" && action !== "transaction_attempt" && action !== "signin_start")
	) {
		throw INVALID_INPUT;
	}
	// Native getters enforce the Request brand and ignore caller-owned overrides.
	const method: unknown = requestGetters.method?.call(request);
	const url: unknown = requestGetters.url?.call(request);
	const headers = requestGetters.headers?.call(request) as Headers;
	const body = requestGetters.body?.call(request) as ReadableStream<Uint8Array> | null;
	if (typeof method !== "string" || typeof url !== "string") throw INVALID_INPUT;
	return Object.freeze({
		scope,
		csrfKey,
		action,
		kind: ACTION_COOKIE_KINDS[action],
		limiter: limiter as InMemoryRequestRateLimiter,
		check,
		clientKey,
		limit,
		method,
		url,
		body,
		origin: headersGet.call(headers, "origin"),
		mediaType: headersGet.call(headers, "content-type"),
		contentLength: headersGet.call(headers, "content-length"),
		cookie: headersGet.call(headers, "cookie"),
	});
}

function pinRatePolicy(snapshot: Snapshot, limit: number): boolean {
	let policies = ratePolicies.get(snapshot.limiter);
	if (!policies) {
		policies = new Map();
		ratePolicies.set(snapshot.limiter, policies);
	}
	const coordinatorId = snapshot.scope.store.coordinatorId;
	const existing = policies.get(coordinatorId);
	if (existing !== undefined) return existing === limit;
	policies.set(coordinatorId, limit);
	return true;
}

function checkRate(snapshot: Snapshot): Failure | null {
	const { clientKey, limit } = snapshot;
	if (!isAuthControllerId(clientKey) || clientKey.length > 128) {
		return reject("client_unidentified");
	}
	if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
		return INVALID_INPUT;
	}
	// The injected limiter includes the limit in its internal bucket key.
	if (!pinRatePolicy(snapshot, limit)) return INVALID_INPUT;
	const result: unknown = snapshot.check.call(
		snapshot.limiter,
		JSON.stringify(["browser-form", snapshot.scope.store.coordinatorId, clientKey]),
		limit,
	);
	const allowed = ownData(result, "allowed");
	const retryAfterS = ownData(result, "retryAfterS");
	if (
		typeof allowed !== "boolean" ||
		typeof retryAfterS !== "number" ||
		!Number.isFinite(retryAfterS)
	)
		return INVALID_INPUT;
	if (allowed === true) {
		return Number.isSafeInteger(retryAfterS) && retryAfterS >= 0 ? null : INVALID_INPUT;
	}
	return Object.freeze({
		ok: false,
		error: "rate_limited",
		retryAfterS: Math.max(1, Math.min(3600, Math.ceil(retryAfterS))),
	});
}

function validMediaType(value: string | null): boolean {
	if (value === null || /[^\x20-\x7e\t]/.test(value)) return false;
	const parts = value.toLowerCase().split(";");
	if (parts.length > 2 || parts[0]?.trim() !== "application/x-www-form-urlencoded") return false;
	if (parts.length === 1) return true;
	const charset = parts[1]?.split("=");
	return (
		charset?.length === 2 && charset[0]?.trim() === "charset" && charset[1]?.trim() === "utf-8"
	);
}

function checkOrigin(snapshot: Snapshot): Failure | null {
	if (
		new URL(snapshot.url).origin !== snapshot.scope.publicOrigin ||
		snapshot.origin !== snapshot.scope.publicOrigin
	)
		return reject("origin_rejected");
	return null;
}

function checkMediaAndLength(snapshot: Snapshot): Failure | null {
	if (!validMediaType(snapshot.mediaType)) return reject("unsupported_media_type");
	const length = snapshot.contentLength;
	if (length === null) return null;
	if (
		length.length < 1 ||
		length.length > 10 ||
		!/^[0-9]+$/.test(length) ||
		!/^[0-9]$/.test(length.slice(-1))
	)
		return reject("form_invalid");
	if (Number(length) > BROWSER_FORM_BODY_MAX_BYTES) return reject("body_too_large");
	return null;
}

async function verifyForm(snapshot: Snapshot): Promise<BrowserFormGuardResult> {
	let cookie: Awaited<ReturnType<typeof readBrowserCookie>>;
	try {
		cookie = await readBrowserCookie(snapshot.cookie, snapshot.kind);
	} catch {
		return reject("cookie_invalid");
	}
	if (cookie.kind === "absent") return reject("cookie_missing");
	if (cookie.kind !== "present") return reject("cookie_invalid");
	const body = await readBrowserFormBody({
		body: snapshot.body,
		contentLength: snapshot.contentLength,
	});
	if (!body.ok) return reject(body.error);
	const form = parseBrowserFormBody(body.bytes, snapshot.action);
	if (!form.ok) return reject(form.error);
	if (
		!isBrowserCsrfToken(form.csrf) ||
		!(await verifyBrowserCsrfToken(
			snapshot.csrfKey,
			cookie.secret,
			snapshot.kind,
			snapshot.scope,
			form.csrf,
		))
	)
		return reject("csrf_invalid");
	if (form.action === "session_logout" || form.action === "signin_start") {
		return Object.freeze({ ok: true, action: form.action, cookieHash: cookie.cookieHash });
	}
	return Object.freeze({
		ok: true,
		action: form.action,
		cookieHash: cookie.cookieHash,
		attemptId: form.attemptId,
	});
}

/** Unmounted transport guard, not authentication. Require a live store lookup afterwards.
 * cookieHash is sensitive internal data, never an HTTP response or log DTO.
 * Supply server-owned scope, an imported CSRF key, and trusted platform client identity.
 */
export async function guardBrowserForm(
	input: BrowserFormGuardInput,
): Promise<BrowserFormGuardResult> {
	try {
		const snapshot = captureInput(input);
		if (snapshot.method !== "POST") return reject("method_not_allowed");
		const originError = checkOrigin(snapshot);
		if (originError) return originError;
		const rateError = checkRate(snapshot);
		if (rateError) return rateError;
		const headerError = checkMediaAndLength(snapshot);
		if (headerError) return headerError;
		return await verifyForm(snapshot);
	} catch {
		return INVALID_INPUT;
	}
}
