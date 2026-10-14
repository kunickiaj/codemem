import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { accountRoutes } from "../routes/account.js";

export interface AccountLinkOptions {
	/** Return the actual bound viewer listener, or null until it is listening. */
	getListenerAddress: () => { host: string; port: number } | null;
}

const ACCOUNT_PREFIX = "/api/account";
const SESSION_PATH = `${ACCOUNT_PREFIX}/session`;
const LISTENER_HOSTS: Readonly<Record<string, readonly string[]>> = {
	"127.0.0.1": ["127.0.0.1", "localhost"],
	"::1": ["[::1]", "localhost"],
	localhost: ["127.0.0.1", "[::1]", "localhost"],
};
type AccountGuardError =
	| "account_local_viewer_required"
	| "account_request_rejected"
	| "account_csrf_invalid";

function allowedAuthorities(options: AccountLinkOptions): string[] | null {
	try {
		const address = options.getListenerAddress();
		if (!address || !Number.isInteger(address.port) || address.port < 1 || address.port > 65535) {
			return null;
		}
		const { host, port } = address;
		if (!Object.hasOwn(LISTENER_HOSTS, host)) return null;
		const aliases = LISTENER_HOSTS[host];
		if (!aliases) return null;
		return aliases.flatMap((alias) => {
			const explicit = `${alias}:${port}`;
			return [...new Set([explicit, new URL(`http://${explicit}`).host])];
		});
	} catch {
		// Listener failures must not leak implementation details or enable access.
		return null;
	}
}

function validRequestContext(c: Context, authorities: readonly string[]): boolean {
	const host = c.req.header("Host");
	if (!host || !authorities.includes(host)) return false;
	const expectedOrigin = new URL(`http://${host}`).origin;
	try {
		if (new URL(c.req.url).origin !== expectedOrigin) return false;
	} catch {
		return false;
	}
	const origin = c.req.header("Origin");
	if (origin !== undefined && origin !== expectedOrigin) return false;
	if (c.req.method === "POST" && origin === undefined) return false;
	const fetchSite = c.req.header("Sec-Fetch-Site");
	return fetchSite === undefined || fetchSite === "same-origin";
}

function validSessionRequest(c: Context): boolean {
	const contentLength = c.req.header("Content-Length");
	return (
		c.req.method === "GET" &&
		!c.req.url.includes("?") &&
		c.req.raw.body === null &&
		(contentLength === undefined || contentLength === "0") &&
		c.req.header("Transfer-Encoding") === undefined
	);
}

function validCsrfToken(c: Context, token: Buffer): boolean {
	const supplied = c.req.header("X-Codemem-Account-Csrf");
	if (!supplied || supplied.length !== token.length) return false;
	const candidate = Buffer.from(supplied, "utf8");
	return candidate.length === token.length && timingSafeEqual(candidate, token);
}

function requestError(
	c: Context,
	options: AccountLinkOptions,
	token: Buffer,
): AccountGuardError | null {
	const authorities = allowedAuthorities(options);
	if (!authorities) return "account_local_viewer_required";
	if (c.req.method === "OPTIONS" || !validRequestContext(c, authorities)) {
		return "account_request_rejected";
	}
	if (c.req.path === SESSION_PATH) {
		return validSessionRequest(c) ? null : "account_request_rejected";
	}
	return validCsrfToken(c, token) ? null : "account_csrf_invalid";
}

function secureAccountResponse(c: Context): void {
	// Strip after downstream completion: the global origin middleware adds CORS.
	for (const name of [...c.res.headers.keys()]) {
		if (name.toLowerCase().startsWith("access-control-")) c.header(name, undefined);
	}
	c.header("Cache-Control", "no-store");
	c.header("X-Content-Type-Options", "nosniff");
	c.header("Referrer-Policy", "no-referrer");
}

/** One token per viewer app; only the exact GET session route can return it. */
export function createAccountGuard(options: AccountLinkOptions) {
	const csrfToken = randomBytes(32).toString("base64url");
	const token = Buffer.from(csrfToken, "utf8");
	const middleware = createMiddleware(async (c, next) => {
		if (c.req.path !== ACCOUNT_PREFIX && !c.req.path.startsWith(`${ACCOUNT_PREFIX}/`)) {
			await next();
			return;
		}
		try {
			const error = requestError(c, options, token);
			if (error) {
				c.res = c.json({ error }, 403);
				return;
			}
			await next();
		} catch {
			c.res = c.json({ error: "account_request_rejected" }, 500);
		} finally {
			// Hono handles normal handler exceptions before next() returns. This
			// also covers replacement responses from its onError/notFound handlers.
			secureAccountResponse(c);
		}
	});
	return {
		middleware,
		routes: accountRoutes(() => ({ version: 1, csrfToken })),
	};
}
