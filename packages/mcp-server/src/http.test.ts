import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthAuditEvent } from "./audit.js";
import {
	type CodememMcpHttpServer,
	DEFAULT_MCP_HTTP_HOST,
	DEFAULT_MCP_HTTP_PORT,
	isAllowedMcpHttpRequestHost,
	isAllowedMcpHttpRequestOrigin,
	isAllowedMcpHttpRequestRemoteAddress,
	isUnsafePublicBindAllowed,
	parseMcpHttpPort,
	startCodememMcpHttpServer,
	validateMcpHttpHost,
} from "./http.js";
import { createInMemoryOAuthAccessTokenStore } from "./oauth.js";

const servers: CodememMcpHttpServer[] = [];

const FORBIDDEN_AUDIT_FIELDS = new Set([
	"access_token",
	"refresh_token",
	"id_token",
	"code",
	"code_verifier",
	"code_challenge",
	"client_secret",
	"authorization",
	"password",
	"secret",
	"token",
]);

function captureAuditEmitter(): {
	emit: (event: OAuthAuditEvent) => void;
	events: OAuthAuditEvent[];
} {
	const events: OAuthAuditEvent[] = [];
	return {
		emit: (event) => {
			events.push(event);
		},
		events,
	};
}

function assertAuditEventsAreRedacted(events: OAuthAuditEvent[]): void {
	for (const event of events) {
		for (const key of Object.keys(event)) {
			expect(FORBIDDEN_AUDIT_FIELDS.has(key.toLowerCase())).toBe(false);
		}
		const serialized = JSON.stringify(event);
		for (const forbidden of FORBIDDEN_AUDIT_FIELDS) {
			expect(serialized.toLowerCase()).not.toContain(`"${forbidden}":`);
		}
	}
}

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("MCP HTTP transport", () => {
	it("defaults to loopback host and validates host values", () => {
		expect(validateMcpHttpHost(undefined)).toBe(DEFAULT_MCP_HTTP_HOST);
		expect(validateMcpHttpHost("localhost")).toBe("localhost");
		expect(validateMcpHttpHost("::1")).toBe("::1");
		expect(() => validateMcpHttpHost("http://127.0.0.1")).toThrow(/Invalid MCP HTTP host/);
		expect(() => validateMcpHttpHost("127.0.0.1/mcp")).toThrow(/Invalid MCP HTTP host/);
		expect(() => validateMcpHttpHost("0.0.0.0")).toThrow(/Refusing unsafe MCP HTTP host/);
		expect(() => validateMcpHttpHost("192.168.1.10")).toThrow(/Refusing unsafe MCP HTTP host/);
		expect(validateMcpHttpHost("0.0.0.0", true)).toBe("0.0.0.0");
	});

	it("parses the explicit unsafe public bind switch", () => {
		expect(isUnsafePublicBindAllowed("1")).toBe(true);
		expect(isUnsafePublicBindAllowed("true")).toBe(true);
		expect(isUnsafePublicBindAllowed("yes")).toBe(true);
		expect(isUnsafePublicBindAllowed("0")).toBe(false);
	});

	it("allows only loopback Host and Origin headers for the selected port", () => {
		expect(isAllowedMcpHttpRequestHost("127.0.0.1:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("localhost:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("[::1]:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("evil.test:38889", 38889)).toBe(false);
		expect(isAllowedMcpHttpRequestHost("127.0.0.1:38888", 38889)).toBe(false);

		expect(isAllowedMcpHttpRequestOrigin(undefined, 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestOrigin("http://localhost:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestOrigin("http://[::1]:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestOrigin("http://evil.test:38889", 38889)).toBe(false);
		expect(isAllowedMcpHttpRequestOrigin("http://localhost:38888", 38889)).toBe(false);
		expect(isAllowedMcpHttpRequestOrigin("http://localhost:38889/path", 38889)).toBe(false);

		expect(isAllowedMcpHttpRequestRemoteAddress("127.0.0.1")).toBe(true);
		expect(isAllowedMcpHttpRequestRemoteAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isAllowedMcpHttpRequestRemoteAddress("203.0.113.10")).toBe(false);
	});

	it("accepts loopback Host headers without an explicit port when bound to HTTP default (PR 1120 P2 regression)", () => {
		// RFC-compliant clients may send `Host: localhost` (no `:port`) when the
		// server listens on port 80. Reject anything that is not loopback or that
		// would inherit a default port other than the bound one.
		expect(isAllowedMcpHttpRequestHost("localhost", 80)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("127.0.0.1", 80)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("[::1]", 80)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("evil.test", 80)).toBe(false);
		expect(isAllowedMcpHttpRequestHost("localhost", 38889)).toBe(false);
	});

	it("defaults and validates port values", () => {
		expect(parseMcpHttpPort(undefined)).toBe(DEFAULT_MCP_HTTP_PORT);
		expect(parseMcpHttpPort("0")).toBe(0);
		expect(parseMcpHttpPort(38889)).toBe(38889);
		expect(() => parseMcpHttpPort("abc")).toThrow(/Invalid MCP HTTP port/);
		expect(() => parseMcpHttpPort(65_536)).toThrow(/Invalid MCP HTTP port/);
	});

	it("exposes only POST /mcp", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const getResponse = await fetch(server.url);
		expect(getResponse.status).toBe(405);
		expect(getResponse.headers.get("allow")).toBe("POST");

		const missingResponse = await fetch(server.url.replace("/mcp", "/health"), { method: "POST" });
		expect(missingResponse.status).toBe(404);
	});

	it("serves OAuth authorization server and protected resource metadata", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
		});
		servers.push(server);

		const baseUrl = server.url.replace("/mcp", "");
		const authorizationMetadata = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
		const protectedResourceMetadata = await fetch(
			`${baseUrl}/.well-known/oauth-protected-resource/mcp`,
		);

		expect(authorizationMetadata.status).toBe(200);
		expect(await authorizationMetadata.json()).toMatchObject({
			issuer: "https://codemem.example.test/",
			registration_endpoint: "https://codemem.example.test/register",
			code_challenge_methods_supported: ["S256"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			token_endpoint_auth_methods_supported: ["none"],
			revocation_endpoint: "https://codemem.example.test/revoke",
			scopes_supported: ["memory:read", "memory:write"],
		});
		expect(protectedResourceMetadata.status).toBe(200);
		expect(await protectedResourceMetadata.json()).toMatchObject({
			resource: "https://codemem.example.test/mcp",
			authorization_servers: ["https://codemem.example.test/"],
			resource_name: "codemem MCP",
			scopes_supported: ["memory:read", "memory:write"],
		});
	});

	it("derives default OAuth metadata from the bound HTTP host", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			host: "::1",
			port: 0,
		});
		servers.push(server);

		const response = await fetch(
			`${server.url.replace("/mcp", "")}/.well-known/oauth-protected-resource/mcp`,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ resource: server.url });
	});

	it("registers OAuth clients through Dynamic Client Registration", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
		});
		servers.push(server);

		const response = await fetch(server.url.replace("/mcp", "/register"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				client_name: "Claude",
				token_endpoint_auth_method: "none",
			}),
		});
		const registered = await response.json();

		expect(response.status).toBe(201);
		expect(registered).toMatchObject({
			redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
			client_name: "Claude",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
		});
		expect(registered.client_id).toMatch(/[0-9a-f-]{36}/);
		expect(registered.client_secret).toBeUndefined();
	});

	it("rejects local Dynamic Client Registration from non-loopback origins", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const register = await fetch(server.url.replace("/mcp", "/register"), {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://evil.test" },
			body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
		});
		const authorize = await fetch(server.url.replace("/mcp", "/authorize"), {
			headers: { origin: "http://evil.test" },
		});
		const token = await fetch(server.url.replace("/mcp", "/token"), {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "http://evil.test",
			},
		});

		expect(register.status).toBe(403);
		expect(authorize.status).toBe(403);
		expect(token.status).toBe(403);
	});

	it("rejects hostile browser origins on OAuth endpoints when a public URL is configured", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
		});
		servers.push(server);
		const baseUrl = server.url.replace("/mcp", "");

		const register = await fetch(`${baseUrl}/register`, {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://evil.test" },
			body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
		});
		const authorize = await fetch(`${baseUrl}/authorize`, {
			headers: { origin: "http://evil.test" },
		});
		const token = await fetch(`${baseUrl}/token`, {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: "http://evil.test",
			},
		});

		expect(register.status).toBe(403);
		expect(authorize.status).toBe(403);
		expect(token.status).toBe(403);
	});

	it("allows Claude browser preflight requests on public OAuth and MCP routes", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
		});
		servers.push(server);
		const baseUrl = server.url.replace("/mcp", "");

		const register = await requestWithHost(`${baseUrl}/register`, {
			method: "OPTIONS",
			host: "codemem.example.test",
			headers: {
				origin: "https://claude.ai",
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});
		const mcp = await requestWithHost(server.url, {
			method: "OPTIONS",
			host: "codemem.example.test",
			headers: {
				origin: "https://claude.ai",
				"access-control-request-method": "POST",
				"access-control-request-headers": "authorization,content-type,mcp-session-id",
			},
		});

		expect(register.statusCode).toBe(204);
		expect(register.headers["access-control-allow-origin"]).toBe("https://claude.ai");
		expect(register.headers["access-control-allow-headers"]).toBe("content-type");
		expect(mcp.statusCode).toBe(204);
		expect(mcp.headers["access-control-allow-origin"]).toBe("https://claude.ai");
		expect(mcp.headers["access-control-allow-headers"]).toBe(
			"authorization,content-type,mcp-session-id",
		);
	});

	it("logs early public Host and Origin guard denials", async () => {
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const server = await startCodememMcpHttpServer({
				dbPath: tempDbPath(),
				port: 0,
				publicUrl: "https://codemem.example.test/mcp",
			});
			servers.push(server);

			const response = await requestWithHost(server.url.replace("/mcp", "/register"), {
				method: "OPTIONS",
				host: "codemem.example.test",
				headers: {
					origin: "https://evil.test",
					"access-control-request-method": "POST",
				},
			});

			expect(response.statusCode).toBe(403);
			expect(consoleWarn).toHaveBeenCalledTimes(1);
			const event = JSON.parse(String(consoleWarn.mock.calls[0]?.[0])) as Record<string, unknown>;
			expect(event).toMatchObject({
				source: "codemem-mcp-http-guard",
				outcome: "denied",
				reason: "host_or_origin_mismatch",
				method: "OPTIONS",
				path: "/register",
				host: "codemem.example.test",
				origin: "https://evil.test",
				expectedOrigin: "https://codemem.example.test",
			});
		} finally {
			consoleWarn.mockRestore();
		}
	});

	it("accepts proxied OAuth token requests without rate-limit trust-proxy warnings", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const server = await startCodememMcpHttpServer({
				dbPath: tempDbPath(),
				port: 0,
				publicUrl: "https://codemem.example.test/mcp",
			});
			servers.push(server);

			const response = await fetch(server.url.replace("/mcp", "/token"), {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"x-forwarded-for": "203.0.113.10",
				},
				body: new URLSearchParams({
					client_id: "missing-client",
					grant_type: "refresh_token",
					refresh_token: "missing-refresh-token",
				}),
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: "invalid_client" });
			expect(consoleError).not.toHaveBeenCalledWith(
				expect.objectContaining({ code: "ERR_ERL_UNEXPECTED_X_FORWARDED_FOR" }),
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("rejects public OAuth requests with non-public Host headers", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
		});
		servers.push(server);

		const response = await postWithHost(server.url.replace("/mcp", "/register"), "evil.test");
		const trailingSlash = await postWithHost(server.url.replace("/mcp", "/register/"), "evil.test");
		const mcpTrailingSlash = await postWithHost(`${server.url}/`, "evil.test");

		expect(response.statusCode).toBe(403);
		expect(trailingSlash.statusCode).toBe(403);
		expect(mcpTrailingSlash.statusCode).toBe(403);
	});

	it("rejects bare public Host headers when the configured public URL uses a non-default port", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test:10000/mcp",
		});
		servers.push(server);

		const bareHost = await postWithHost(
			server.url.replace("/mcp", "/register"),
			"codemem.example.test",
		);
		const explicitHost = await postWithHost(
			server.url.replace("/mcp", "/register"),
			"codemem.example.test:10000",
		);

		expect(bareHost.statusCode).toBe(403);
		expect(explicitHost.statusCode).toBe(400);
	});

	it("rejects unsupported OAuth redirect URIs", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const response = await fetch(server.url.replace("/mcp", "/register"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ redirect_uris: ["https://evil.test/callback"] }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
	});

	it("fails closed at authorize when OIDC is not configured", async () => {
		const { emit, events } = captureAuditEmitter();
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
			auditEmitter: emit,
		});
		servers.push(server);
		const baseUrl = server.url.replace("/mcp", "");

		const registration = await fetch(`${baseUrl}/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			}),
		});
		const client = await registration.json();
		const authorizeUrl = new URL(`${baseUrl}/authorize`);
		authorizeUrl.searchParams.set("client_id", client.client_id);
		authorizeUrl.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
		authorizeUrl.searchParams.set("response_type", "code");
		authorizeUrl.searchParams.set("code_challenge_method", "S256");
		authorizeUrl.searchParams.set("code_challenge", pkceS256("d".repeat(43)));
		authorizeUrl.searchParams.set("state", "state-123");

		const authorize = await fetch(authorizeUrl, { redirect: "manual" });

		expect(authorize.status).toBe(302);
		expect(authorize.headers.get("location")).toContain("error=temporarily_unavailable");
		expect(events).toContainEqual(
			expect.objectContaining({
				kind: "authorize",
				outcome: "denied",
				reason: "temporarily_unavailable",
			}),
		);
	});

	it("requires valid bearer tokens for public MCP requests", async () => {
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const issued = tokenStore.issueToken("client-123");
		if (!issued) throw new Error("expected access token");
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
			oauthAccessTokenStore: tokenStore,
		});
		servers.push(server);

		const missing = await fetch(server.url, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: initializeBody(1),
		});
		const invalid = await fetch(server.url, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				authorization: "Bearer not-a-token",
				"content-type": "application/json",
			},
			body: initializeBody(2),
		});
		const valid = await initialize(server.url, 3, { authorization: `Bearer ${issued.token}` });

		expect(missing.status).toBe(401);
		expect(missing.headers.get("www-authenticate")).toContain("Bearer");
		expect(invalid.status).toBe(401);
		expect(valid.result?.serverInfo?.name).toBe("codemem");
	});

	it("allows valid public bearer requests with the configured external Host", async () => {
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const issued = tokenStore.issueToken("client-public");
		if (!issued) throw new Error("expected access token");
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
			oauthAccessTokenStore: tokenStore,
		});
		servers.push(server);

		const response = await postWithHost(server.url, "codemem.example.test", {
			authorization: `Bearer ${issued.token}`,
		});

		expect(response.statusCode).toBe(200);
	});

	it("emits redacted audit events for the full OAuth + bearer flow", async () => {
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const issued = tokenStore.issueToken("client-audit");
		if (!issued) throw new Error("expected access token");
		const { emit, events } = captureAuditEmitter();
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
			oauthAccessTokenStore: tokenStore,
			auditEmitter: emit,
		});
		servers.push(server);
		const baseUrl = server.url.replace("/mcp", "");

		const register = await fetch(`${baseUrl}/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			}),
		});
		expect(register.status).toBe(201);
		const registeredForRevocation = await register.json();
		await fetch(`${baseUrl}/revoke`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: registeredForRevocation.client_id,
				token: "ignored-since-unknown",
			}),
		});
		const missingBearer = await fetch(server.url, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
			},
			body: initializeBody(1),
		});
		expect(missingBearer.status).toBe(401);
		const validBearer = await initialize(server.url, 2, {
			authorization: `Bearer ${issued.token}`,
		});
		expect(validBearer.result?.serverInfo?.name).toBe("codemem");

		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("registration");
		expect(kinds).toContain("revocation");
		expect(kinds).toContain("bearer");

		const registration = events.find((e) => e.kind === "registration");
		expect(registration?.outcome).toBe("success");
		expect(registration?.clientId).toMatch(/[0-9a-f-]{36}/);

		const denied = events.find((e) => e.kind === "bearer" && e.outcome === "denied");
		expect(denied?.reason).toBe("missing_authorization_header");

		const accepted = events.find((e) => e.kind === "bearer" && e.outcome === "success");
		expect(accepted?.clientId).toBe("client-audit");

		assertAuditEventsAreRedacted(events);
	});

	it("rejects expired and revoked bearer tokens", async () => {
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const clientId = "client-revoked";
		const revocable = tokenStore.issueToken(clientId);
		const expired = tokenStore.issueToken("client-expired", Date.now() - 60 * 60 * 1000 - 1);
		if (!expired || !revocable) throw new Error("expected access tokens");
		const { emit, events } = captureAuditEmitter();
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
			oauthAccessTokenStore: tokenStore,
			auditEmitter: emit,
		});
		servers.push(server);
		const baseUrl = server.url.replace("/mcp", "");
		const registration = await fetch(`${baseUrl}/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			}),
		});
		const client = await registration.json();

		const expiredResponse = await fetch(server.url, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${expired.token}`,
				"content-type": "application/json",
			},
			body: initializeBody(1),
		});
		const revoke = await fetch(`${baseUrl}/revoke`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: client.client_id, token: revocable.token }),
		});
		const revokedResponse = await fetch(server.url, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				authorization: `Bearer ${revocable.token}`,
				"content-type": "application/json",
			},
			body: initializeBody(2),
		});

		expect(expiredResponse.status).toBe(401);
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toEqual({});
		expect(revokedResponse.status).toBe(401);
		expect(events).toContainEqual(
			expect.objectContaining({ kind: "bearer", outcome: "denied", reason: "expired_token" }),
		);
		expect(events).toContainEqual(
			expect.objectContaining({ kind: "bearer", outcome: "denied", reason: "revoked_token" }),
		);
	});

	it("handles repeated MCP initialize requests over POST", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const first = await initialize(server.url, 1);
		const second = await initialize(server.url, 2);

		expect(first.result?.serverInfo?.name).toBe("codemem");
		expect(second.result?.serverInfo?.name).toBe("codemem");
	});

	it("rejects browser requests from non-loopback origins", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const response = await fetch(server.url, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				origin: "http://evil.test",
			},
			body: initializeBody(1),
		});

		expect(response.status).toBe(403);
	});

	it("rejects requests with non-loopback Host headers", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const response = await postWithHost(server.url, "evil.test:38889");
		expect(response.statusCode).toBe(403);
	});

	it("closes idempotently", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		await Promise.all([server.close(), server.close()]);
	});
});

async function initialize(
	url: string,
	id: number,
	extraHeaders: Record<string, string> = {},
): Promise<{ result?: { serverInfo?: { name?: string } } }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			...extraHeaders,
		},
		body: initializeBody(id),
	});

	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	return parseSseJson(await response.text()) as { result?: { serverInfo?: { name?: string } } };
}

function initializeBody(id: number): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "codemem-test", version: "0.0.0" },
		},
	});
}

function parseSseJson(body: string): unknown {
	const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
	if (!dataLine) throw new Error(`Missing SSE data line: ${body}`);
	return JSON.parse(dataLine.slice("data: ".length));
}

async function postWithHost(
	url: string,
	host: string,
	extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number | undefined }> {
	const response = await requestWithHost(url, {
		method: "POST",
		host,
		headers: extraHeaders,
		body: initializeBody(1),
	});
	return { statusCode: response.statusCode };
}

async function requestWithHost(
	url: string,
	options: {
		method: string;
		host: string;
		headers?: Record<string, string>;
		body?: string;
	},
): Promise<{
	statusCode: number | undefined;
	headers: Record<string, string | string[] | undefined>;
}> {
	const target = new URL(url);
	return await new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname,
				method: options.method,
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					host: options.host,
					...options.headers,
				},
			},
			(res) => {
				res.resume();
				res.on("end", () =>
					resolve({
						statusCode: res.statusCode,
						headers: res.headers,
					}),
				);
			},
		);
		req.on("error", reject);
		req.end(options.body);
	});
}

function tempDbPath(): string {
	return join(mkdtempSync(join(tmpdir(), "codemem-mcp-http-")), "mem.sqlite");
}

function pkceS256(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}
