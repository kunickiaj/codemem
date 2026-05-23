#!/usr/bin/env node

/**
 * @codemem/mcp — MCP Streamable HTTP server bootstrap.
 *
 * Local-first HTTP transport for MCP clients. OAuth metadata and Dynamic Client
 * Registration are exposed for remote MCP setup; bearer enforcement is added in
 * a later slice.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	authorizeMcpOAuthClient,
	createInMemoryOAuthAuthorizationCodeStore,
	createInMemoryOAuthClientsStore,
	createMcpOAuthMetadata,
	createMcpProtectedResourceMetadata,
	exchangeMcpOAuthAuthorizationCode,
	MCP_OAUTH_PUBLIC_URL_ENV,
	normalizeMcpPublicUrl,
	registerMcpOAuthClient,
} from "./oauth.js";
import { createCodememMcpServer } from "./server.js";

export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 38889;
const HTTP_DEFAULT_PORT = 80;

const VALID_HOSTNAME = /^[a-zA-Z0-9.-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

interface ActiveRequest {
	mcpServer: McpServer;
}

export interface CodememMcpHttpOptions {
	host?: string;
	port?: number | string;
	dbPath?: string;
	allowUnsafePublic?: boolean;
	publicUrl?: string;
}

export interface CodememMcpHttpServer {
	server: Server;
	store: MemoryStore;
	url: string;
	close: () => Promise<void>;
}

export function validateMcpHttpHost(host: string | undefined, allowUnsafePublic = false): string {
	const value = host?.trim() || DEFAULT_MCP_HTTP_HOST;
	if (value.includes("://") || value.includes("/") || value.includes("\\")) {
		throw new Error(`Invalid MCP HTTP host: ${host}`);
	}
	if (!(isIP(value) || value === "localhost" || VALID_HOSTNAME.test(value))) {
		throw new Error(`Invalid MCP HTTP host: ${host}`);
	}
	if (!allowUnsafePublic && !isLoopbackHost(value)) {
		throw new Error(
			`Refusing unsafe MCP HTTP host ${value}; set CODEMEM_MCP_HTTP_UNSAFE_PUBLIC=1 to allow non-loopback binding`,
		);
	}
	return value;
}

export function isLoopbackHost(host: string): boolean {
	return LOOPBACK_HOSTS.has(normalizeHost(host));
}

export function isUnsafePublicBindAllowed(
	value = process.env.CODEMEM_MCP_HTTP_UNSAFE_PUBLIC,
): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}

export function isAllowedMcpHttpRequestHost(
	header: string | undefined,
	expectedPort: number,
): boolean {
	const parsed = parseHostHeader(header);
	if (!parsed) return false;
	if (!isLoopbackHost(parsed.host)) return false;
	if (parsed.port === null) {
		// No `:port` in the Host header means the client is using the protocol
		// default. This server is plain HTTP, so the implied port is 80. Only
		// accept the bare-host form when the bound port is also 80.
		return expectedPort === HTTP_DEFAULT_PORT;
	}
	return parsed.port === expectedPort;
}

export function isAllowedMcpHttpRequestOrigin(
	header: string | undefined,
	expectedPort: number,
): boolean {
	if (!header) return true;
	try {
		const url = new URL(header);
		const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			url.username === "" &&
			url.password === "" &&
			url.pathname === "/" &&
			url.search === "" &&
			url.hash === "" &&
			isLoopbackHost(url.hostname) &&
			port === expectedPort
		);
	} catch {
		return false;
	}
}

function normalizeHost(host: string): string {
	return host.replace(/^\[(.*)]$/, "$1").toLowerCase();
}

function parseHostHeader(header: string | undefined): { host: string; port: number | null } | null {
	if (!header) return null;
	if (header.startsWith("[")) {
		// Bracketed IPv6: `[::1]` or `[::1]:8080`.
		const withPort = /^\[([^\]]+)]:(\d+)$/.exec(header);
		if (withPort?.[1] && withPort[2]) {
			return { host: withPort[1], port: Number(withPort[2]) };
		}
		const bareIpv6 = /^\[([^\]]+)]$/.exec(header);
		if (bareIpv6?.[1]) return { host: bareIpv6[1], port: null };
		return null;
	}
	const lastColon = header.lastIndexOf(":");
	if (lastColon < 0) {
		// RFC-compliant clients may omit `:port` on default-port requests. Treat
		// the implied port as "use the protocol default" and let the caller
		// reconcile against the actually bound port.
		return { host: header, port: null };
	}
	const host = header.slice(0, lastColon);
	const port = Number(header.slice(lastColon + 1));
	if (!Number.isInteger(port)) return null;
	return { host, port };
}

export function parseMcpHttpPort(port: number | string | undefined): number {
	if (port === undefined || port === "") return DEFAULT_MCP_HTTP_PORT;
	const value = typeof port === "number" ? port : Number(port);
	if (!Number.isInteger(value) || value < 0 || value > 65_535) {
		throw new Error(`Invalid MCP HTTP port: ${port}`);
	}
	return value;
}

export async function startCodememMcpHttpServer(
	options: CodememMcpHttpOptions = {},
): Promise<CodememMcpHttpServer> {
	const host = validateMcpHttpHost(
		options.host ?? process.env.CODEMEM_MCP_HTTP_HOST,
		options.allowUnsafePublic ?? isUnsafePublicBindAllowed(),
	);
	const port = parseMcpHttpPort(options.port ?? process.env.CODEMEM_MCP_HTTP_PORT);
	const configuredPublicUrl = options.publicUrl ?? process.env[MCP_OAUTH_PUBLIC_URL_ENV];
	const configuredPublicMcpUrl = configuredPublicUrl
		? normalizeMcpPublicUrl(configuredPublicUrl)
		: undefined;
	const store = new MemoryStore(options.dbPath ?? resolveDbPath());
	const clientsStore = createInMemoryOAuthClientsStore();
	const codeStore = createInMemoryOAuthAuthorizationCodeStore();
	const activeRequests = new Set<ActiveRequest>();
	let closePromise: Promise<void> | null = null;

	const server = createServer(async (req, res) => {
		try {
			const pathname = getRequestPathname(req);
			const publicMcpUrl = configuredPublicMcpUrl?.href ?? getServerUrl(server, host);
			const boundPort = getBoundPort(server);

			if (pathname === "/.well-known/oauth-authorization-server") {
				if (!prepareHttpRoute(req, res, ["GET", "OPTIONS"])) return;
				writeJson(res, 200, createMcpOAuthMetadata({ mcpUrl: publicMcpUrl, clientsStore }));
				return;
			}

			if (pathname === "/.well-known/oauth-protected-resource/mcp") {
				if (!prepareHttpRoute(req, res, ["GET", "OPTIONS"])) return;
				writeJson(res, 200, createMcpProtectedResourceMetadata(publicMcpUrl));
				return;
			}

			if (pathname === "/register") {
				if (!prepareOAuthRoute(req, res, ["POST", "OPTIONS"], boundPort, configuredPublicMcpUrl))
					return;
				const requestBody = await readJsonBody(req).catch(() => ({
					__codememInvalidJson: "Invalid JSON request body",
				}));
				if (isInvalidJsonBody(requestBody)) {
					writeJson(res, 400, {
						error: "invalid_client_metadata",
						error_description: requestBody.__codememInvalidJson,
					});
					return;
				}
				const result = registerMcpOAuthClient(requestBody, clientsStore);
				writeJson(res, result.status, result.body);
				return;
			}

			if (pathname === "/authorize") {
				if (!prepareOAuthRoute(req, res, ["GET", "OPTIONS"], boundPort, configuredPublicMcpUrl))
					return;
				const url = new URL(req.url ?? "/authorize", "http://codemem.local");
				const result = authorizeMcpOAuthClient(url.searchParams, clientsStore, codeStore);
				if (result.status === 302) {
					res.statusCode = result.status;
					res.setHeader("location", result.location);
					res.end();
					return;
				}
				writeJson(res, result.status, result.body);
				return;
			}

			if (pathname === "/token") {
				if (!prepareOAuthRoute(req, res, ["POST", "OPTIONS"], boundPort, configuredPublicMcpUrl))
					return;
				const params = await readFormBody(req).catch(() => new URLSearchParams());
				const result = exchangeMcpOAuthAuthorizationCode(params, clientsStore, codeStore);
				writeJson(res, result.status, result.body);
				return;
			}

			if (pathname !== "/mcp") {
				writeText(res, 404, "Not found");
				return;
			}
			if (!allowMethod(req, res, ["POST"])) return;
			if (!isAllowedMcpHttpRequest(req, getBoundPort(server))) {
				writeText(res, 403, "Forbidden");
				return;
			}

			const mcpServer = createCodememMcpServer(store);
			const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
			const activeRequest = { mcpServer };
			activeRequests.add(activeRequest);
			try {
				await mcpServer.connect(transport);
				await transport.handleRequest(req, res);
			} finally {
				activeRequests.delete(activeRequest);
				await mcpServer.close();
			}
		} catch (err) {
			if (!res.headersSent) writeText(res, 500, "MCP request failed");
			console.error("codemem MCP HTTP request failed:", err);
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host, port }, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const close = () => {
		closePromise ??= (async () => {
			await Promise.allSettled([...activeRequests].map(({ mcpServer }) => mcpServer.close()));
			await new Promise<void>((resolve, reject) => {
				server.close((err) => {
					if (!err || (err as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") {
						resolve();
						return;
					}
					reject(err);
				});
				server.closeAllConnections();
			});
			store.close();
		})();
		return closePromise;
	};

	return {
		server,
		store,
		url: `http://${formatHostForUrl(host)}:${getBoundPort(server)}/mcp`,
		close,
	};
}

function getRequestPathname(req: IncomingMessage): string {
	return new URL(req.url ?? "/", "http://codemem.local").pathname;
}

function allowMethod(req: IncomingMessage, res: ServerResponse, methods: string[]): boolean {
	if (req.method && methods.includes(req.method)) return true;
	res.setHeader("Allow", methods.join(", "));
	writeText(res, 405, "Method not allowed");
	return false;
}

function prepareHttpRoute(req: IncomingMessage, res: ServerResponse, methods: string[]): boolean {
	if (!allowMethod(req, res, methods)) return false;
	if (req.method === "OPTIONS") {
		writeCorsNoContent(res);
		return false;
	}
	return true;
}

function prepareOAuthRoute(
	req: IncomingMessage,
	res: ServerResponse,
	methods: string[],
	expectedPort: number,
	publicMcpUrl: URL | undefined,
): boolean {
	if (!prepareHttpRoute(req, res, methods)) return false;
	if (isAllowedOAuthHttpRequest(req, expectedPort, publicMcpUrl)) return true;
	writeText(res, 403, "Forbidden");
	return false;
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
	res.statusCode = statusCode;
	res.setHeader("access-control-allow-origin", "*");
	res.setHeader("cache-control", "no-store");
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

function writeCorsNoContent(res: ServerResponse): void {
	res.statusCode = 204;
	res.setHeader("access-control-allow-origin", "*");
	res.setHeader("access-control-allow-headers", "content-type");
	res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
	res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
	const body = await readRequestBody(req);
	if (!body) return {};
	return JSON.parse(body) as unknown;
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
	const contentType = req.headers["content-type"] ?? "";
	if (!contentType.toString().toLowerCase().startsWith("application/x-www-form-urlencoded")) {
		throw new Error("OAuth token request body must be form-encoded");
	}
	return new URLSearchParams(await readRequestBody(req));
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) {
		body += chunk;
		if (body.length > 64 * 1024) throw new Error("OAuth request body is too large");
	}
	return body;
}

function isInvalidJsonBody(body: unknown): body is { __codememInvalidJson: string } {
	return (
		typeof body === "object" &&
		body !== null &&
		"__codememInvalidJson" in body &&
		typeof body.__codememInvalidJson === "string"
	);
}

function isAllowedMcpHttpRequest(req: IncomingMessage, expectedPort: number): boolean {
	return (
		isAllowedMcpHttpRequestHost(req.headers.host, expectedPort) &&
		isAllowedMcpHttpRequestOrigin(req.headers.origin, expectedPort)
	);
}

function isAllowedOAuthHttpRequest(
	req: IncomingMessage,
	expectedPort: number,
	publicMcpUrl: URL | undefined,
): boolean {
	if (!publicMcpUrl) return isAllowedMcpHttpRequest(req, expectedPort);
	return isAllowedPublicOrigin(req.headers.origin, publicMcpUrl);
}

function isAllowedPublicOrigin(header: string | undefined, publicMcpUrl: URL): boolean {
	if (!header) return true;
	try {
		const origin = new URL(header);
		return origin.origin === publicMcpUrl.origin;
	} catch {
		return false;
	}
}

function writeText(res: ServerResponse, statusCode: number, body: string): void {
	res.statusCode = statusCode;
	res.setHeader("content-type", "text/plain; charset=utf-8");
	res.end(body);
}

function getBoundPort(server: Server): number {
	const address = server.address();
	if (!address || typeof address === "string") return DEFAULT_MCP_HTTP_PORT;
	return address.port;
}

function formatHostForUrl(host: string): string {
	return isIP(host) === 6 ? `[${host}]` : host;
}

function getServerUrl(server: Server, host: string): string {
	return `http://${formatHostForUrl(host)}:${getBoundPort(server)}/mcp`;
}

function isEntrypoint(): boolean {
	const script = process.argv[1];
	return script ? import.meta.url === pathToFileURL(script).href : false;
}

async function main() {
	const httpServer = await startCodememMcpHttpServer();
	console.error(`codemem MCP HTTP server listening at ${httpServer.url}`);

	const shutdown = async () => {
		try {
			await httpServer.close();
		} catch {
			// Best effort — process is exiting.
		}
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

if (isEntrypoint()) {
	main().catch((err) => {
		console.error("codemem MCP HTTP server failed to start:", err);
		process.exit(1);
	});
}
