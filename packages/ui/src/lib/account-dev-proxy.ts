import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { Connect, Plugin, ProxyOptions, ViteDevServer } from "vite";

export const ACCOUNT_DEV_PROXY_KEY = "^/api/account(?:/|\\?|$)";
const accountPath = new RegExp(ACCOUNT_DEV_PROXY_KEY);
const aliases: Readonly<Record<string, readonly string[]>> = {
	"127.0.0.1": ["127.0.0.1", "localhost"],
	"::1": ["[::1]", "localhost"],
};

function privateHeaders(res: ServerResponse): void {
	for (const name of res.getHeaderNames()) {
		if (name.toLowerCase().startsWith("access-control-")) res.removeHeader(name);
	}
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
}

function privateUpstreamResponse(upstream: IncomingMessage, res: ServerResponse): void {
	// Never replace a truncated response with JSON under copied upstream headers.
	upstream.once("close", () => {
		if (!upstream.complete && !res.writableEnded) res.destroy();
	});
	for (const name of Object.keys(upstream.headers)) {
		if (name.toLowerCase().startsWith("access-control-")) delete upstream.headers[name];
	}
	privateHeaders(res);
	upstream.headers["cache-control"] = "no-store";
	upstream.headers["x-content-type-options"] = "nosniff";
	upstream.headers["referrer-policy"] = "no-referrer";
}

function reject(res: ServerResponse, status = 403): void {
	if (res.writableEnded) return;
	if (res.headersSent) {
		res.destroy();
		return;
	}
	privateHeaders(res);
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json");
	res.end(JSON.stringify({ error: "account_request_rejected" }));
}

function singleHeader(req: IncomingMessage, name: string): string | undefined | false {
	const value = req.headers[name];
	if (value !== undefined && typeof value !== "string") return false;
	let count = 0;
	for (let i = 0; i < req.rawHeaders.length; i += 2) {
		if (req.rawHeaders[i].toLowerCase() === name) count++;
	}
	if (count > 1 || typeof value !== "string") return value === undefined ? undefined : false;
	return value;
}

function listenerAuthorities(server: ViteDevServer): string[] {
	let address: ReturnType<NonNullable<ViteDevServer["httpServer"]>["address"]> | undefined;
	try {
		address = server.httpServer?.address();
	} catch {
		return [];
	}
	if (!address || typeof address === "string" || !Object.hasOwn(aliases, address.address)) {
		return [];
	}
	if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535) return [];
	const protocol = server.config.server.https ? "https" : "http";
	return aliases[address.address].flatMap((alias) => {
		const authority = `${alias}:${address.port}`;
		return [authority, new URL(`${protocol}://${authority}`).host];
	});
}

function frontendOrigin(req: IncomingMessage, server: ViteDevServer): string | null {
	const host = singleHeader(req, "host");
	if (!host || !listenerAuthorities(server).includes(host)) return null;
	const protocol = server.config.server.https ? "https" : "http";
	const expected = new URL(`${protocol}://${host}`).origin;
	try {
		if (!req.url || new URL(req.url, expected).origin !== expected) return null;
	} catch {
		return null;
	}
	const origin = singleHeader(req, "origin");
	if (origin === false || (origin !== undefined && origin !== expected)) return null;
	if (req.method === "POST" && origin === undefined) return null;
	const fetchSite = singleHeader(req, "sec-fetch-site");
	if (fetchSite !== undefined && fetchSite !== "same-origin") return null;
	// http-proxy skips proxyReq when Expect is set; disallow that alternate path.
	if (req.headers.expect !== undefined || req.method === "OPTIONS") return null;
	return expected;
}

function requestPath(url: string): string {
	if (url.startsWith("/")) return url.split(/[?#]/, 1)[0];
	const absolutePath = /^[a-z][a-z\d+.-]*:\/\/[^/\\?#]*(.*)$/i.exec(url)?.[1] ?? "";
	return absolutePath.split(/[?#]/, 1)[0];
}

function accountScope(url: string): "other" | "alias" | "account" {
	const raw = requestPath(url);
	let canonical = "";
	try {
		canonical = new URL(url, "http://localhost").pathname;
	} catch {
		// Invalid URLs in raw account scope must still fail closed.
	}
	if (!accountPath.test(decodedPath(raw)) && !accountPath.test(decodedPath(canonical))) {
		return "other";
	}
	// URL normalization and encoded aliases must not escape through the broad proxy.
	if (raw !== canonical || !accountPath.test(raw)) return "alias";
	return "account";
}

function decodedPath(path: string): string {
	// Match Hono's path decoding, including valid chunks beside malformed escapes.
	const escaped = path.replace(/%25/g, "%2525");
	try {
		return decodeURI(escaped);
	} catch {
		return escaped.replace(/(?:%[0-9a-f]{2})+/gi, (chunk) => {
			try {
				return decodeURI(chunk);
			} catch {
				return chunk;
			}
		});
	}
}

function viewerTarget(port: number): string {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error("Invalid development viewer port");
	}
	return `http://127.0.0.1:${port}`;
}

/** Dev-server only: validate browser authority before adapting to the viewer authority. */
export function createAccountDevProxy(options: { viewerPort: number }): {
	plugin: Plugin;
	proxy: ProxyOptions;
} {
	const target = viewerTarget(options.viewerPort);
	const approved = new WeakMap<IncomingMessage, { hasOrigin: boolean }>();
	return {
		plugin: {
			name: "account-dev-proxy",
			apply: "serve",
			configureServer(server) {
				// Vite 8 installs CORS before configureServer hooks. Prepend so OPTIONS
				// cannot be answered by CORS before the account authority check.
				server.middlewares.stack.unshift({
					route: "",
					handle(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction) {
						const requestUrl = req.url ?? "";
						const scope = accountScope(requestUrl);
						if (scope === "other") return next();
						if (scope === "alias") return reject(res);
						if (!frontendOrigin(req, server)) return reject(res);
						approved.set(req, { hasOrigin: req.headers.origin !== undefined });
						// Preserve the endpoint and query for validated absolute-form requests.
						if (!requestUrl.startsWith("/")) {
							const url = new URL(requestUrl);
							req.url = url.pathname + url.search;
						}
						next();
					},
				});
			},
		},
		proxy: {
			target,
			changeOrigin: true,
			bypass(req, res) {
				if (approved.has(req)) return;
				if (res) reject(res);
				return false;
			},
			configure(proxy) {
				proxy.on("proxyReq", (outgoing, req, res) => {
					const approval = approved.get(req);
					if (!approval) {
						outgoing.destroy();
						reject(res);
						return;
					}
					if (approval.hasOrigin) outgoing.setHeader("Origin", target);
					else outgoing.removeHeader("Origin");
				});
				proxy.on("proxyRes", (upstream, _req, res) => {
					privateUpstreamResponse(upstream, res);
				});
				const onError = (_error: Error, _req: IncomingMessage, res: ServerResponse | Socket) => {
					if ("setHeader" in res) reject(res, 502);
					else res.destroy();
				};
				proxy.on("error", onError);
				// Vite synchronously adds a URL-logging error listener after configure.
				// Replace only this account proxy's listeners before the server can listen.
				queueMicrotask(() => {
					for (const listener of proxy.listeners("error")) {
						if (listener !== onError) proxy.removeListener("error", listener);
					}
				});
			},
		},
	};
}
