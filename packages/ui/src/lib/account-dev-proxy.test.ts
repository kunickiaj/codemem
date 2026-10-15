// @vitest-environment node
import { EventEmitter, once } from "node:events";
import {
	createServer as createHttpServer,
	IncomingMessage,
	request,
	type Server,
	ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { type AddressInfo, Socket } from "node:net";
import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountGuard } from "../../../viewer-server/src/account/guard";
import { ACCOUNT_DEV_PROXY_KEY, createAccountDevProxy } from "./account-dev-proxy";

const requireServer = createRequire(
	new URL("../../../viewer-server/package.json", import.meta.url),
);
const { Hono } = requireServer("hono") as {
	Hono: new () => ReturnType<typeof createAccountGuard>["routes"];
};
const SESSION = "/api/account/session";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	try {
		const results = await Promise.allSettled(cleanup.reverse().map((close) => close()));
		const failure = results.find((result) => result.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	} finally {
		cleanup.length = 0;
		vi.restoreAllMocks();
	}
});
function address(server: Pick<Server, "address">) {
	return server.address() as AddressInfo;
}
async function listen(server: Server) {
	cleanup.push(async () => {
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeAllConnections();
		await closed;
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return address(server).port;
}
async function send(
	port: number,
	options: { path?: string; method?: string; headers?: Record<string, string>; body?: string } = {},
) {
	return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
		(resolve, reject) => {
			const req = request(
				{
					hostname: "127.0.0.1",
					port,
					path: SESSION,
					agent: false,
					...options,
					headers: {
						...(options.body ? { "Content-Length": String(Buffer.byteLength(options.body)) } : {}),
						...options.headers,
					},
				},
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
				},
			);
			req.on("error", reject);
			req.end(options.body);
		},
	);
}
function privateResponse(response: Awaited<ReturnType<typeof send>>) {
	expect(response.headers["cache-control"]).toBe("no-store");
	expect(response.headers["referrer-policy"]).toBe("no-referrer");
	expect(response.headers["x-content-type-options"]).toBe("nosniff");
	expect(
		Object.keys(response.headers).filter((name) => name.startsWith("access-control-")),
	).toEqual([]);
}

async function fixture(
	options: {
		occupiedPort?: boolean;
		noAdapter?: boolean;
		noPrivacyStrip?: boolean;
		onProxyResponse?: (upstream: IncomingMessage, res: ServerResponse) => void;
	} = {},
) {
	const seen: { path: string; host: string | null; origin: string | null; body: string }[] = [];
	let backendPort = 0;
	const guard = createAccountGuard({
		getListenerAddress: () => ({ host: "127.0.0.1", port: backendPort }),
	});
	const app = new Hono();
	app.use("*", guard.middleware);
	app.route("/", guard.routes);
	for (const path of ["/api/account/echo", "/api/echo", "/assets/echo", "/api/accounting"])
		app.all(path, async (c) =>
			c.json({
				host: c.req.header("host"),
				origin: c.req.header("origin"),
				body: await c.req.text(),
			}),
		);
	const backend = createHttpServer(async (req, res) => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString();
		seen.push({
			path: req.url ?? "",
			host: req.headers.host ?? null,
			origin: req.headers.origin ?? null,
			body,
		});
		const init: RequestInit = {
			method: req.method,
			headers: req.headers as Record<string, string>,
		};
		if (body) init.body = body;
		const response = await app.request(`http://${req.headers.host}${req.url}`, init);
		res.writeHead(response.status, Object.fromEntries(response.headers));
		res.end(await response.text());
	});
	backendPort = await listen(backend);
	const target = `http://127.0.0.1:${backendPort}`;
	const adapter = createAccountDevProxy({ viewerPort: backendPort });
	const configure = adapter.proxy.configure;
	if (options.onProxyResponse)
		adapter.proxy.configure = (proxy, config) => {
			configure(proxy, config);
			proxy.on("proxyRes", (upstream, _req, res) => options.onProxyResponse(upstream, res));
		};
	if (options.noPrivacyStrip)
		adapter.proxy.configure = (proxy, config) => {
			configure(proxy, config);
			proxy.removeAllListeners("proxyRes");
		};
	let configuredPort = 0;
	if (options.occupiedPort) configuredPort = await listen(createHttpServer());
	const vite = await createServer({
		configFile: false,
		root: import.meta.dirname,
		logLevel: "silent",
		plugins: options.noAdapter ? [] : [adapter.plugin],
		server: {
			host: "127.0.0.1",
			port: configuredPort,
			strictPort: false,
			proxy: {
				...(options.noAdapter ? {} : { [ACCOUNT_DEV_PROXY_KEY]: adapter.proxy }),
				"/api": { target, changeOrigin: false },
				"/assets": { target, changeOrigin: false },
			},
			watch: null,
		},
	});
	cleanup.push(() => vite.close());
	await vite.listen();
	const port = address(vite.httpServer).port;
	return {
		port,
		configuredPort,
		origin: `http://127.0.0.1:${port}`,
		target,
		backend,
		seen,
		vite,
	};
}

describe("account dev proxy with a strict real backend guard", () => {
	it.each([false, true])(
		"uses the actual bound frontend port (fallback=%s), then rewrites only to the backend",
		async (occupiedPort) => {
			// Arrange: no real viewer, profile, database, or coordinator is started.
			const f = await fixture({ occupiedPort });
			// Act
			const session = await send(f.port, { headers: { Origin: f.origin } });
			const { csrfToken } = JSON.parse(session.body);
			const posted = await send(f.port, {
				path: "/api/account/echo",
				method: "POST",
				body: "fixture-body",
				headers: { Origin: f.origin, "X-Codemem-Account-Csrf": csrfToken },
			});
			// Assert: the original production guard validates the rewritten context and token.
			expect(f.port).toBeGreaterThan(0);
			expect(f.port).not.toBe(f.configuredPort);
			expect(session.status).toBe(200);
			expect(csrfToken).toEqual(expect.any(String));
			expect(posted.status).toBe(200);
			expect(JSON.parse(posted.body)).toEqual({
				host: new URL(f.target).host,
				origin: f.target,
				body: "fixture-body",
			});
			privateResponse(session);
			privateResponse(posted);
		},
	);

	it.each([true, false])(
		"demonstrates Vite CORS leaks without response stripping (adapter absent=%s)",
		async (noAdapter) => {
			// Arrange
			const f = await fixture({ noAdapter, noPrivacyStrip: !noAdapter });
			// Act
			const response = await send(f.port, { headers: { Origin: f.origin } });
			// Assert: backend strips its own CORS, but Vite has already set its response header.
			expect(response.status).toBe(noAdapter ? 403 : 200);
			expect(response.headers["access-control-allow-origin"]).toBe(f.origin);
			expect(response.body.includes("csrfToken")).toBe(!noAdapter);
		},
	);

	it.each([
		["foreign origin", { Origin: "https://attacker.invalid" }],
		["other loopback origin", { Origin: "http://127.0.0.1:1" }],
		["same-site fetch", { "Sec-Fetch-Site": "same-site" }],
		["cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
		["rebinding host", { Host: "attacker.invalid" }],
		["wrong host port", { Host: "127.0.0.1:1" }],
	] as const)("rejects %s before forwarding or returning secrets", async (_name, headers) => {
		// Arrange
		const f = await fixture();
		// Act
		const response = await send(f.port, { headers: { Origin: f.origin, ...headers } });
		// Assert
		expect(response.status).toBe(403);
		expect(f.seen).toEqual([]);
		expect(JSON.parse(response.body)).toEqual({ error: expect.any(String) });
		expect(response.body).not.toMatch(/csrfToken|https?:|fixture-body/);
		privateResponse(response);
	});

	it.each(["POST", "OPTIONS"])(
		"rejects %s without Origin before forwarding a body",
		async (method) => {
			// Arrange
			const f = await fixture();
			// Act
			const response = await send(f.port, { method, body: "fixture-body" });
			// Assert
			expect(response.status).toBe(403);
			expect(f.seen).toEqual([]);
			privateResponse(response);
		},
	);

	it("does not let a caller spoof the backend Host or forwarded headers", async () => {
		// Arrange
		const f = await fixture();
		// Act
		const response = await send(f.port, {
			headers: {
				Host: new URL(f.target).host,
				Origin: f.target,
				"X-Forwarded-Host": new URL(f.origin).host,
				"X-Forwarded-Origin": f.origin,
			},
		});
		// Assert
		expect(response.status).toBe(403);
		expect(f.seen).toEqual([]);
	});

	it.each(["/api/echo", "/assets/echo", "/api/accounting"])(
		"does not rewrite unrelated traffic at %s",
		async (path) => {
			// Arrange
			const f = await fixture();
			// Act
			const response = await send(f.port, { path, headers: { Origin: f.origin } });
			// Assert
			expect(response.status).toBe(200);
			expect(JSON.parse(response.body)).toMatchObject({
				host: new URL(f.origin).host,
				origin: f.origin,
			});
		},
	);

	it.each([
		"/api/%61ccount/session",
		"/api/account%2fsession",
		"/api/account/../account/session",
		"http://attacker.invalid/api/account/session",
	])("never discloses a session through ambiguous target %s", async (path) => {
		// Arrange
		const f = await fixture();
		// Act
		const response = await send(f.port, { path, headers: { Origin: "https://attacker.invalid" } });
		// Assert
		expect(response.body).not.toContain("csrfToken");
		expect(response.status).not.toBe(200);
	});
});
describe("account path aliases cannot bypass frontend validation", () => {
	it.each([
		["/api/%61ccount/session", "origin"],
		["/api/%61ccount/session", "host"],
		["/%61pi/account/session", "origin"],
		["/%61pi/account/session", "host"],
		["/api/other/../account/session", "origin"],
		["/api/other/../account/session", "backend"],
		["/api/other/../account/session", "options"],
		["/api/other/%2e%2e/account/session", "origin"],
		["/api/other/%2e%2e/account/session", "backend"],
		["/api/other/%2e%2e/account/session", "options"],
		["/api/other\\..\\account/session", "origin"],
		["/api/other\\..\\account/session", "backend"],
		["/api/other\\..\\account/session", "options"],
	])("rejects %s with hostile %s before any backend traffic", async (path, hostileHeader) => {
		// Arrange: a backend rejection alone must not make this regression pass.
		const f = await fixture();
		const headers = { Origin: f.origin, Host: new URL(f.origin).host };
		if (hostileHeader === "origin") headers.Origin = "https://attacker.invalid";
		else if (hostileHeader === "backend")
			Object.assign(headers, { Host: new URL(f.target).host, Origin: f.target });
		else if (hostileHeader === "options") headers.Origin = "http://127.0.0.1:1";
		else headers.Host = "127.0.0.1:1";
		// Act
		const response = await send(f.port, {
			path,
			headers,
			method: hostileHeader === "options" ? "OPTIONS" : "GET",
		});
		// Assert
		expect(response.status).toBe(403);
		expect(f.seen).toEqual([]);
		privateResponse(response);
		expect(response.body).not.toContain("csrfToken");
		expect(JSON.parse(response.body)).toEqual({ error: "account_request_rejected" });
	});
	it.each([null, { address: "0.0.0.0", port: 4567 }, { address: "::", port: 4567 }])(
		"does not pass encoded account paths on unsafe listener %j",
		(binding) => {
			// Arrange
			const paths = ["/api/%61ccount/session", "/%61pi/account/session"];
			for (const path of paths) {
				// Act
				const f = middlewareFixture(binding, { path, origin: "http://127.0.0.1:4567" });
				// Assert
				expect(f.next).not.toHaveBeenCalled();
				expect(f.res.statusCode).toBe(403);
			}
		},
	);
});
describe("account proxy backend failures", () => {
	it.each([false, true])(
		"handles errors after headers without rewriting an ended response (ended=%s)",
		(ended) => {
			const f = middlewareFixture({ address: "127.0.0.1", port: 4567 });
			Object.defineProperties(f.res, {
				headersSent: { value: true },
				writableEnded: { value: ended },
			});
			const destroy = vi.spyOn(f.res, "destroy").mockReturnValue(f.res);
			const headers = vi.spyOn(f.res, "setHeader");
			const emitter = new EventEmitter();
			f.adapter.proxy.configure(emitter as never, {});
			emitter.emit("error", new Error("fixture failure"), f.req, f.res);
			expect(destroy).toHaveBeenCalledTimes(ended ? 0 : 1);
			expect(headers).not.toHaveBeenCalled();
			expect(f.end).not.toHaveBeenCalled();
		},
	);
	it("closes a partial response when the backend disconnects without logging private details", async () => {
		let probe: (destroyed: boolean) => void;
		const probed = new Promise<boolean>((resolve) => {
			probe = resolve;
		});
		const f = await fixture({
			onProxyResponse(upstream, res) {
				// Probe after the adapter's close listener, before awaiting client close.
				upstream.once("close", () => probe(res.destroyed));
			},
		});
		let backendResponse: ServerResponse;
		f.backend.removeAllListeners("request");
		f.backend.on("request", (_req, res) => {
			backendResponse = res;
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": "*",
			});
			res.write('{"pending":');
		});
		const logs = [
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(f.vite.config.logger, "error"),
		];
		const res = await new Promise<IncomingMessage>((resolve, reject) => {
			const req = request(
				{
					hostname: "127.0.0.1",
					port: f.port,
					path: SESSION,
					agent: false,
					headers: { Origin: f.origin },
				},
				resolve,
			);
			req.on("error", reject);
			req.end();
		});
		const closed = new Promise<void>((resolve) => res.once("close", resolve));
		res.on("error", () => {}); // Truncated HTTP bodies must not become unhandled test errors.
		res.setEncoding("utf8");
		let body = "";
		await new Promise<void>((resolve) =>
			res.once("data", (chunk) => {
				body += chunk;
				resolve();
			}),
		);
		backendResponse.destroy();
		// The old adapter fails here immediately instead of hanging until the test timeout.
		expect(await probed).toBe(true);
		await closed;
		expect(res.aborted).toBe(true);
		expect(res.complete).toBe(false);
		expect(body).toBe('{"pending":');
		privateResponse({ status: res.statusCode ?? 0, headers: res.headers, body });
		expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
	});
});
describe("account proxy headers-only backend failures", () => {
	it("closes a headers-only truncated response instead of sending JSON under upstream headers", async () => {
		let probe: (destroyed: boolean) => void;
		const probed = new Promise<boolean>((resolve) => {
			probe = resolve;
		});
		let backendResponse: ServerResponse;
		const f = await fixture({
			onProxyResponse(upstream, res) {
				upstream.once("close", () => probe(res.destroyed));
				queueMicrotask(() => backendResponse.destroy());
			},
		});
		f.backend.removeAllListeners("request");
		f.backend.on("request", (_req, res) => {
			backendResponse = res;
			res.writeHead(200, {
				"Content-Type": "application/json",
				"Content-Length": "100",
				"Content-Encoding": "gzip",
				"Set-Cookie": "fixture=value",
				ETag: '"fixture"',
				"Access-Control-Allow-Origin": "*",
			});
			res.flushHeaders();
		});
		const logs = [
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(f.vite.config.logger, "error"),
		];
		const receivedResponse = vi.fn();
		const errors: string[] = [];
		const req = request(
			{
				hostname: "127.0.0.1",
				port: f.port,
				path: SESSION,
				agent: false,
				headers: { Origin: f.origin },
			},
			(res) => {
				receivedResponse();
				res.on("error", () => {});
				res.resume();
			},
		);
		const closed = new Promise<void>((resolve) => req.once("close", resolve));
		req.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? ""));
		req.end();
		expect(await probed).toBe(true);
		await closed;
		expect(receivedResponse).not.toHaveBeenCalled();
		expect(errors).toEqual(["ECONNRESET"]);
		expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
	});
});
describe("account proxy backend rejection responses", () => {
	it("keeps invalid CSRF rejected after the frontend request passes validation", async () => {
		// Arrange
		const f = await fixture();
		// Act
		const response = await send(f.port, {
			method: "POST",
			path: "/api/account/echo",
			headers: { Origin: f.origin, "X-Codemem-Account-Csrf": "invalid" },
		});
		// Assert
		expect(response.status).toBe(403);
		expect(JSON.parse(response.body)).toEqual({ error: "account_csrf_invalid" });
		privateResponse(response);
	});
	it("returns a private fixed error without logging backend URLs or raw failures", async () => {
		// Arrange
		const f = await fixture();
		await new Promise<void>((resolve) => f.backend.close(() => resolve()));
		const logs = [
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
		];
		const viteLog = vi.spyOn(f.vite.config.logger, "error");
		// Act
		const response = await send(f.port, { headers: { Origin: f.origin } });
		// Assert
		expect(response.status).toBe(502);
		expect(JSON.parse(response.body)).toEqual({ error: "account_request_rejected" });
		privateResponse(response);
		expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
		expect(viteLog).not.toHaveBeenCalled();
	});
});
function middlewareFixture(
	binding: { address: string; port: number } | null,
	options: {
		host?: string;
		origin?: string;
		path?: string;
		method?: string;
		headers?: Record<string, string>;
	} = {},
) {
	const socket = new Socket();
	const req = new IncomingMessage(socket);
	req.url = options.path ?? SESSION;
	req.method = options.method ?? "GET";
	req.headers = { host: options.host ?? "127.0.0.1:4567", ...options.headers };
	if (options.origin !== undefined) req.headers.origin = options.origin;
	req.rawHeaders = Object.entries(req.headers).flatMap(([key, value]) => [key, String(value)]);
	const res = new ServerResponse(req);
	const end = vi.spyOn(res, "end").mockReturnValue(res);
	const next = vi.fn();
	const stack: { handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => void }[] =
		[];
	const adapter = createAccountDevProxy({ viewerPort: 7654 });
	const server = {
		httpServer: { address: () => binding },
		config: { server: {} },
		middlewares: { stack },
	} as unknown as ViteDevServer;
	const hook = adapter.plugin.configureServer;
	if (typeof hook !== "function") throw new Error("Expected server middleware hook");
	hook.call({} as never, server);
	try {
		stack[0].handle(req, res, next);
	} finally {
		socket.destroy();
	}
	return { adapter, req, res, end, next };
}

describe("listener authority and proxy approval", () => {
	it.each([true, false])(
		"rewrites only requests approved by the middleware (approved=%s)",
		(approved) => {
			// Arrange
			const f = middlewareFixture(
				{ address: "127.0.0.1", port: 4567 },
				{ origin: "http://127.0.0.1:4567" },
			);
			const emitter = new EventEmitter();
			const outgoing = { destroy: vi.fn(), setHeader: vi.fn(), removeHeader: vi.fn() };
			const req = approved ? f.req : new IncomingMessage(new Socket());
			f.adapter.proxy.configure(emitter as never, {});
			// Act
			emitter.emit("proxyReq", outgoing, req, f.res);
			// Assert
			expect(outgoing.destroy).toHaveBeenCalledTimes(approved ? 0 : 1);
			expect(outgoing.setHeader.mock.calls).toEqual(
				approved ? [["Origin", "http://127.0.0.1:7654"]] : [],
			);
			req.socket.destroy();
		},
	);
	it.each([
		["127.0.0.1", "127.0.0.1:4567", undefined],
		["127.0.0.1", "localhost:4567", "http://localhost:4567"],
		["::1", "[::1]:4567", "http://[::1]:4567"],
		["::1", "localhost:4567", "http://localhost:4567"],
		["127.0.0.1", "127.0.0.1:80", "http://127.0.0.1"],
		["127.0.0.1", "127.0.0.1", "http://127.0.0.1"],
	])("accepts exact canonical loopback authority %s %s", (host, authority, origin) => {
		// Arrange
		const port = origin === "http://127.0.0.1" ? 80 : 4567;
		// Act
		const f = middlewareFixture({ address: host, port }, { host: authority, origin });
		// Assert
		expect(f.next).toHaveBeenCalledOnce();
		expect(f.end).not.toHaveBeenCalled();
	});

	it.each([
		null,
		{ address: "0.0.0.0", port: 4567 },
		{ address: "::", port: 4567 },
		{ address: "127.0.0.1", port: 0 },
	])("rejects unsafe/unbound actual listener %j despite a loopback Host", (binding) => {
		// Arrange
		const origin = "http://127.0.0.1:4567";
		// Act
		const f = middlewareFixture(binding, { origin });
		// Assert
		expect(f.next).not.toHaveBeenCalled();
		expect(f.res.statusCode).toBe(403);
		expect(f.end).toHaveBeenCalledWith(JSON.stringify({ error: "account_request_rejected" }));
	});

	it.each([
		{ method: "OPTIONS", host: "[::1]:4567", origin: "http://[::1]:4567" },
		{ host: "[::1]:4567", origin: "http://[::1]:4568" },
		{ host: "localhost:4567", origin: "http://127.0.0.1:4567" },
		{ path: "http://attacker.invalid/api/account/session" },
		{ headers: { expect: "100-continue" } },
		{ headers: { "x-forwarded-host": "localhost:4567" }, host: "attacker.invalid" },
	])("rejects mismatched or alternate request context %j", (options) => {
		// Arrange
		const binding = { address: "::1", port: 4567 };
		// Act
		const f = middlewareFixture(binding, options);
		// Assert
		expect(f.next).not.toHaveBeenCalled();
		expect(f.res.statusCode).toBe(403);
	});

	it.each([0, -1, 65536, 1.5, Number.NaN])("rejects invalid backend port %s", (viewerPort) => {
		// Arrange / Act
		const create = () => createAccountDevProxy({ viewerPort });
		// Assert
		expect(create).toThrow("Invalid development viewer port");
	});
});
