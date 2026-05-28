#!/usr/bin/env node

/**
 * @codemem/mcp — MCP Streamable HTTP server bootstrap.
 *
 * Local-first HTTP transport for MCP clients. OAuth metadata and Dynamic Client
 * Registration are exposed for remote MCP setup; public MCP requests require
 * OAuth bearer tokens.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import {
	getOAuthProtectedResourceMetadataUrl,
	mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import {
	type BearerDenyReason,
	buildOAuthAuditEvent,
	type OAuthAuditEmitter,
	resolveOAuthAuditEmitterFromEnv,
	wrapAuditEmitterBestEffort,
} from "./audit.js";
import {
	createInMemoryOAuthAccessTokenStore,
	createInMemoryOAuthAuthorizationCodeStore,
	createInMemoryOAuthClientsStore,
	createJsonFileOAuthStateStore,
	createMcpOAuthMetadata,
	createMcpProtectedResourceMetadata,
	MCP_OAUTH_PUBLIC_URL_ENV,
	MCP_OAUTH_RESOURCE_NAME,
	MCP_OAUTH_SCOPES_SUPPORTED,
	MCP_OAUTH_SERVICE_DOCUMENTATION_URL,
	normalizeMcpPublicUrl,
	type OAuthAccessTokenStore,
} from "./oauth.js";
import {
	completeOidcAuthorization,
	createInMemoryOidcPendingAuthorizationStore,
	resolveOidcConfig,
} from "./oidc.js";
import { MemoryOAuthServerProvider } from "./provider.js";
import { createCodememMcpServer } from "./server.js";

export const DEFAULT_MCP_HTTP_HOST = "127.0.0.1";
export const DEFAULT_MCP_HTTP_PORT = 38889;
const HTTP_DEFAULT_PORT = 80;
const TRUSTED_PUBLIC_BROWSER_ORIGINS = new Set(["https://claude.ai"]);
const CORS_ALLOW_HEADERS = "authorization,content-type,mcp-session-id";
const CORS_MAX_AGE_SECONDS = "600";
const MAX_GUARD_LOG_FIELD_LENGTH = 256;
const PUBLIC_MCP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const PUBLIC_MCP_RATE_LIMIT_REQUESTS = 600;

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
	oauthAccessTokenStore?: OAuthAccessTokenStore;
	oauthStatePath?: string;
	auditEmitter?: OAuthAuditEmitter;
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

export function isAllowedMcpHttpRequestRemoteAddress(address: string | undefined): boolean {
	if (!address) return false;
	return isLoopbackHost(address.replace(/^::ffff:/, ""));
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
	const oauthStateStore = options.oauthAccessTokenStore
		? undefined
		: createJsonFileOAuthStateStore(options.oauthStatePath);
	const clientsStore = oauthStateStore ?? createInMemoryOAuthClientsStore();
	const codeStore = oauthStateStore ?? createInMemoryOAuthAuthorizationCodeStore();
	const tokenStore =
		options.oauthAccessTokenStore ?? oauthStateStore ?? createInMemoryOAuthAccessTokenStore();
	const oidcConfig = resolveOidcConfig();
	const oidcPendingStore = createInMemoryOidcPendingAuthorizationStore();
	const shouldRequireMcpBearer = configuredPublicMcpUrl !== undefined || oidcConfig !== undefined;
	const auditEmit = wrapAuditEmitterBestEffort(
		options.auditEmitter ?? resolveOAuthAuditEmitterFromEnv(),
	);
	const activeRequests = new Set<ActiveRequest>();
	let closePromise: Promise<void> | null = null;

	const app = express();
	app.disable("x-powered-by");
	// Tailscale Funnel and similar local ingress proxies forward from loopback and
	// add X-Forwarded-For. Trust only loopback proxy hops so SDK rate limiters can
	// key on the real client IP without making public clients spoofable.
	app.set("trust proxy", "loopback");
	const server = createServer(app);

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host, port }, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const publicMcpUrl = configuredPublicMcpUrl?.href ?? getServerUrl(server, host);
	const publicMcpUrlObject = new URL(publicMcpUrl);
	const issuerUrl = getSdkIssuerUrl(publicMcpUrlObject, getBoundPort(server));
	const provider = new MemoryOAuthServerProvider({
		clientsStore,
		codeStore,
		tokenStore,
		publicMcpUrl,
		...(oauthStateStore ? { refreshTokenStore: oauthStateStore } : {}),
		...(oidcConfig ? { oidc: { config: oidcConfig, pendingStore: oidcPendingStore } } : {}),
	});
	const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(publicMcpUrlObject);

	app.use(
		rateLimit({
			windowMs: PUBLIC_MCP_RATE_LIMIT_WINDOW_MS,
			limit: PUBLIC_MCP_RATE_LIMIT_REQUESTS,
			standardHeaders: "draft-8",
			legacyHeaders: false,
			// Avoid express-rate-limit's default IPv6 subnet helper here: its current
			// transitive ip-address API throws on IPv6 loopback in our Node 24 test path.
			// This coarse limiter is defense-in-depth before the SDK OAuth limiters and
			// the Host/Origin guard; it must never break local IPv6 metadata requests.
			ipv6Subnet: false,
		}),
	);
	app.use((req, res, next) => {
		const boundPort = getBoundPort(server);
		const pathname = normalizeRoutePath(req.path);
		if (pathname === "/mcp") {
			if (isAllowedMcpHttpRequest(req, boundPort, configuredPublicMcpUrl)) {
				applyPublicCorsHeaders(req, res, configuredPublicMcpUrl);
				if (req.method === "OPTIONS") {
					res.status(204).send("");
					return;
				}
				return next();
			}
			emitHttpGuardDeny(req, pathname, configuredPublicMcpUrl);
			res.status(403).type("text/plain").send("Forbidden");
			return;
		}
		if (isOAuthOrMetadataPath(pathname)) {
			if (isAllowedOAuthHttpRequest(req, boundPort, configuredPublicMcpUrl)) {
				applyPublicCorsHeaders(req, res, configuredPublicMcpUrl);
				if (req.method === "OPTIONS") {
					res.status(204).send("");
					return;
				}
				return next();
			}
			emitHttpGuardDeny(req, pathname, configuredPublicMcpUrl);
			res.status(403).type("text/plain").send("Forbidden");
			return;
		}
		next();
	});

	app.use(auditOAuthRouteResponses(auditEmit));

	app.get("/oauth/callback", async (req, res) => {
		const remoteAddress = req.socket.remoteAddress ?? undefined;
		if (!oidcConfig) {
			auditEmit(
				buildOAuthAuditEvent("oidc_callback", {
					outcome: "denied",
					reason: "oidc_not_configured",
					remoteAddress,
				}),
			);
			res.status(400).json({
				error: "temporarily_unavailable",
				error_description: "OIDC is not configured",
			});
			return;
		}
		const completed = await completeOidcAuthorization(
			new URLSearchParams(req.query as Record<string, string>),
			oidcPendingStore,
			oidcConfig,
			publicMcpUrl,
		);
		if ("status" in completed) {
			auditEmit(
				buildOAuthAuditEvent("oidc_callback", {
					outcome: "denied",
					reason: completed.body.error,
					remoteAddress,
				}),
			);
			res.status(completed.status).json(completed.body);
			return;
		}
		const oauthClientId = completed.oauthParams.get("client_id") ?? undefined;
		const code = codeStore.issueCode({
			clientId: completed.oauthParams.get("client_id") ?? "",
			redirectUri: completed.oauthParams.get("redirect_uri") ?? "",
			codeChallenge: completed.oauthParams.get("code_challenge") ?? "",
			scopes: parseScopeList(completed.oauthParams.get("scope")),
			...(completed.oauthParams.get("resource")
				? { resource: completed.oauthParams.get("resource") ?? undefined }
				: {}),
			expiresAt: Date.now() + 5 * 60 * 1000,
		});
		if (!code) {
			auditEmit(
				buildOAuthAuditEvent("oidc_callback", {
					outcome: "denied",
					reason: "temporarily_unavailable",
					clientId: oauthClientId,
					remoteAddress,
				}),
			);
			res.status(400).json({
				error: "temporarily_unavailable",
				error_description: "Too many active authorization codes",
			});
			return;
		}
		const redirect = new URL(completed.oauthParams.get("redirect_uri") ?? "");
		redirect.searchParams.set("code", code);
		const state = completed.oauthParams.get("state");
		if (state) redirect.searchParams.set("state", state);
		auditEmit(
			buildOAuthAuditEvent("oidc_callback", {
				outcome: "success",
				reason: "code_issued",
				clientId: oauthClientId,
				remoteAddress,
			}),
		);
		res.redirect(302, redirect.href);
	});

	app.get("/.well-known/oauth-authorization-server", (_req, res) => {
		res.status(200).json(createMcpOAuthMetadata({ mcpUrl: publicMcpUrl, clientsStore }));
	});
	app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
		res.status(200).json(createMcpProtectedResourceMetadata(publicMcpUrl));
	});

	app.use(
		mcpAuthRouter({
			provider,
			issuerUrl,
			baseUrl: issuerUrl,
			resourceServerUrl: publicMcpUrlObject,
			resourceName: MCP_OAUTH_RESOURCE_NAME,
			scopesSupported: MCP_OAUTH_SCOPES_SUPPORTED,
			serviceDocumentationUrl: new URL(MCP_OAUTH_SERVICE_DOCUMENTATION_URL),
			clientRegistrationOptions: { clientSecretExpirySeconds: 0 },
		}),
	);

	const bearerMiddleware = shouldRequireMcpBearer
		? requireBearerAuth({ verifier: provider, resourceMetadataUrl })
		: (_req: Request, _res: Response, next: NextFunction) => next();
	const bearerAuditMiddleware = shouldRequireMcpBearer
		? auditBearerPreflight(auditEmit, tokenStore)
		: (_req: Request, _res: Response, next: NextFunction) => next();
	app.post("/mcp", bearerAuditMiddleware, bearerMiddleware, async (req, res) => {
		if (req.auth) {
			auditEmit(
				buildOAuthAuditEvent("bearer", {
					outcome: "success",
					clientId: req.auth.clientId,
					remoteAddress: req.socket.remoteAddress ?? undefined,
				}),
			);
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
	});
	app.all("/mcp", (_req, res) => {
		res.setHeader("Allow", "POST");
		res.status(405).type("text/plain").send("Method not allowed");
	});
	app.use((_req, res) => {
		res.status(404).type("text/plain").send("Not found");
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

function isAllowedMcpHttpRequest(
	req: IncomingMessage,
	expectedPort: number,
	publicMcpUrl: URL | undefined,
): boolean {
	if (isAllowedLocalMcpHttpRequest(req, expectedPort)) return true;
	if (!publicMcpUrl) return false;
	return (
		isAllowedPublicRequestHost(req.headers.host, publicMcpUrl) &&
		isAllowedPublicOrigin(req.headers.origin, publicMcpUrl)
	);
}

function isAllowedLocalMcpHttpRequest(req: IncomingMessage, expectedPort: number): boolean {
	return (
		isAllowedMcpHttpRequestRemoteAddress(req.socket.remoteAddress) &&
		isAllowedMcpHttpRequestHost(req.headers.host, expectedPort) &&
		isAllowedMcpHttpRequestOrigin(req.headers.origin, expectedPort)
	);
}

function isAllowedOAuthHttpRequest(
	req: IncomingMessage,
	expectedPort: number,
	publicMcpUrl: URL | undefined,
): boolean {
	if (isAllowedLocalMcpHttpRequest(req, expectedPort)) return true;
	if (!publicMcpUrl) return false;
	return (
		isAllowedPublicRequestHost(req.headers.host, publicMcpUrl) &&
		isAllowedPublicOrigin(req.headers.origin, publicMcpUrl)
	);
}

function isAllowedPublicOrigin(header: string | undefined, publicMcpUrl: URL): boolean {
	if (!header) return true;
	try {
		const origin = new URL(header);
		return (
			origin.origin === publicMcpUrl.origin || TRUSTED_PUBLIC_BROWSER_ORIGINS.has(origin.origin)
		);
	} catch {
		return false;
	}
}

function applyPublicCorsHeaders(
	req: IncomingMessage,
	res: Response,
	publicMcpUrl: URL | undefined,
): void {
	if (!publicMcpUrl) return;
	const origin = getAllowedPublicCorsOrigin(req.headers.origin, publicMcpUrl);
	if (!origin) return;
	res.setHeader("Access-Control-Allow-Origin", origin);
	res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
	res.setHeader(
		"Access-Control-Allow-Headers",
		req.headers["access-control-request-headers"] ?? CORS_ALLOW_HEADERS,
	);
	res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE_SECONDS);
	res.setHeader("Vary", "Origin");
}

function getAllowedPublicCorsOrigin(
	header: string | undefined,
	publicMcpUrl: URL,
): string | undefined {
	if (!header) return undefined;
	try {
		const origin = new URL(header).origin;
		if (origin === publicMcpUrl.origin || TRUSTED_PUBLIC_BROWSER_ORIGINS.has(origin)) {
			return origin;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function emitHttpGuardDeny(
	req: IncomingMessage,
	pathname: string,
	publicMcpUrl: URL | undefined,
): void {
	console.warn(
		JSON.stringify({
			source: "codemem-mcp-http-guard",
			timestamp: new Date().toISOString(),
			outcome: "denied",
			reason: "host_or_origin_mismatch",
			method: req.method,
			path: pathname,
			host: truncateGuardLogField(req.headers.host),
			origin: truncateGuardLogField(req.headers.origin),
			expectedOrigin: publicMcpUrl?.origin,
			remoteAddress: req.socket.remoteAddress ?? undefined,
		}),
	);
}

function truncateGuardLogField(value: string | undefined): string | undefined {
	if (!value || value.length <= MAX_GUARD_LOG_FIELD_LENGTH) return value;
	return `${value.slice(0, MAX_GUARD_LOG_FIELD_LENGTH)}…`;
}

function isAllowedPublicRequestHost(header: string | undefined, publicMcpUrl: URL): boolean {
	const parsed = parseHostHeader(header);
	if (!parsed) return false;
	const expectedPort = publicMcpUrl.port
		? Number(publicMcpUrl.port)
		: publicMcpUrl.protocol === "https:"
			? 443
			: 80;
	const impliedPort = publicMcpUrl.protocol === "https:" ? 443 : 80;
	const actualPort = parsed.port ?? impliedPort;
	return (
		normalizeHost(parsed.host) === normalizeHost(publicMcpUrl.hostname) &&
		actualPort === expectedPort
	);
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

function getSdkIssuerUrl(publicMcpUrl: URL, port: number): URL {
	if (publicMcpUrl.protocol === "https:") return new URL(publicMcpUrl.origin);
	if (isLoopbackHost(publicMcpUrl.hostname) && normalizeHost(publicMcpUrl.hostname) !== "::1") {
		return new URL(publicMcpUrl.origin);
	}
	return new URL(`http://localhost:${port}/`);
}

function isOAuthOrMetadataPath(pathname: string): boolean {
	return (
		pathname === "/register" ||
		pathname === "/authorize" ||
		pathname === "/token" ||
		pathname === "/revoke" ||
		pathname === "/oauth/callback" ||
		pathname === "/.well-known/oauth-authorization-server" ||
		pathname === "/.well-known/oauth-protected-resource/mcp"
	);
}

function normalizeRoutePath(pathname: string): string {
	return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function auditOAuthRouteResponses(
	auditEmit: (event: ReturnType<typeof buildOAuthAuditEvent>) => void,
) {
	return (req: Request, res: Response, next: NextFunction) => {
		const pathname = req.path;
		if (!isAuditedOAuthPath(pathname)) return next();
		let responseBody: unknown;
		const originalJson = res.json.bind(res);
		res.json = ((body: unknown) => {
			responseBody = body;
			return originalJson(body);
		}) as typeof res.json;
		res.on("finish", () => {
			if (pathname === "/oauth/callback") return;
			const kind = oauthAuditKindForRequest(pathname, req);
			if (!kind) return;
			const error = getOAuthResponseError(res, responseBody);
			const clientId = getRequestClientId(req, responseBody);
			auditEmit(
				buildOAuthAuditEvent(kind, {
					outcome: error ? "denied" : "success",
					...(error ? { reason: error } : {}),
					...(clientId ? { clientId } : {}),
					remoteAddress: req.socket.remoteAddress ?? undefined,
				}),
			);
		});
		next();
	};
}

function isAuditedOAuthPath(pathname: string): boolean {
	return oauthAuditKindForPath(pathname) !== null;
}

function oauthAuditKindForRequest(
	pathname: string,
	req: Request,
): "registration" | "authorize" | "token" | "refresh" | "revocation" | null {
	if (pathname === "/token" && req.body?.grant_type === "refresh_token") return "refresh";
	return oauthAuditKindForPath(pathname);
}

function oauthAuditKindForPath(
	pathname: string,
): "registration" | "authorize" | "token" | "revocation" | null {
	if (pathname === "/register") return "registration";
	if (pathname === "/authorize") return "authorize";
	if (pathname === "/token") return "token";
	if (pathname === "/revoke") return "revocation";
	return null;
}

function getOAuthResponseError(res: Response, body: unknown): string | undefined {
	const bodyError = getOAuthBodyError(body);
	if (bodyError) return bodyError;
	const location = res.getHeader("location");
	if (typeof location !== "string") return undefined;
	try {
		const redirect = new URL(location);
		return redirect.searchParams.get("error") ?? undefined;
	} catch {
		return undefined;
	}
}

function getOAuthBodyError(body: unknown): string | undefined {
	if (
		typeof body === "object" &&
		body !== null &&
		"error" in body &&
		typeof body.error === "string"
	) {
		return body.error;
	}
	return undefined;
}

function getRequestClientId(req: Request, body: unknown): string | undefined {
	if (
		typeof body === "object" &&
		body !== null &&
		"client_id" in body &&
		typeof body.client_id === "string"
	) {
		return body.client_id;
	}
	const bodyClientId = typeof req.body?.client_id === "string" ? req.body.client_id : undefined;
	if (bodyClientId) return bodyClientId;
	const queryClientId = typeof req.query.client_id === "string" ? req.query.client_id : undefined;
	return queryClientId;
}

function auditBearerPreflight(
	auditEmit: (event: ReturnType<typeof buildOAuthAuditEvent>) => void,
	tokenStore: OAuthAccessTokenStore,
) {
	return (req: Request, _res: Response, next: NextFunction) => {
		const reason = getBearerPreflightDenyReason(req.headers.authorization, tokenStore);
		if (reason) {
			auditEmit(
				buildOAuthAuditEvent("bearer", {
					outcome: "denied",
					reason,
					remoteAddress: req.socket.remoteAddress ?? undefined,
				}),
			);
		}
		next();
	};
}

function getBearerPreflightDenyReason(
	header: string | undefined,
	tokenStore: OAuthAccessTokenStore,
): BearerDenyReason | null {
	if (!header) return "missing_authorization_header";
	const [scheme, token, extra] = header.trim().split(/\s+/);
	if (!scheme || !token || extra || scheme.toLowerCase() !== "bearer") {
		return "malformed_authorization_header";
	}
	const verification = tokenStore.verifyToken(token);
	if (!verification.ok) return verification.reason;
	return null;
}

function parseScopeList(scope: string | null | undefined): string[] {
	return (
		scope
			?.split(/\s+/)
			.map((item) => item.trim())
			.filter(Boolean) ?? []
	);
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
