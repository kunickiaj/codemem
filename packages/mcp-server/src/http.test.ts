import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CodememMcpHttpServer,
	DEFAULT_MCP_HTTP_HOST,
	DEFAULT_MCP_HTTP_PORT,
	isAllowedMcpHttpRequestHost,
	isAllowedMcpHttpRequestOrigin,
	isUnsafePublicBindAllowed,
	parseMcpHttpPort,
	startCodememMcpHttpServer,
	validateMcpHttpHost,
} from "./http.js";

const servers: CodememMcpHttpServer[] = [];

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
			token_endpoint_auth_methods_supported: ["none"],
		});
		expect(protectedResourceMetadata.status).toBe(200);
		expect(await protectedResourceMetadata.json()).toEqual({
			resource: "https://codemem.example.test/mcp",
			authorization_servers: ["https://codemem.example.test/"],
			bearer_methods_supported: ["header"],
			resource_name: "codemem MCP",
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
			grant_types: ["authorization_code"],
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

	it("runs OAuth authorize and token exchange with PKCE", async () => {
		const server = await startCodememMcpHttpServer({
			dbPath: tempDbPath(),
			port: 0,
			publicUrl: "https://codemem.example.test/mcp",
		});
		servers.push(server);
		const baseUrl = server.url.replace("/mcp", "");
		const verifier = "d".repeat(43);

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
		authorizeUrl.searchParams.set("code_challenge", pkceS256(verifier));
		authorizeUrl.searchParams.set("state", "state-123");

		const authorize = await fetch(authorizeUrl, { redirect: "manual" });
		const redirect = new URL(authorize.headers.get("location") ?? "");
		const token = await fetch(`${baseUrl}/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				client_id: client.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				code: redirect.searchParams.get("code") ?? "",
				code_verifier: verifier,
			}),
		});

		expect(authorize.status).toBe(302);
		expect(redirect.origin + redirect.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
		expect(redirect.searchParams.get("state")).toBe("state-123");
		expect(token.status).toBe(200);
		expect(await token.json()).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
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
): Promise<{ result?: { serverInfo?: { name?: string } } }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
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
): Promise<{ statusCode: number | undefined }> {
	const target = new URL(url);
	return await new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname,
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					host,
				},
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve({ statusCode: res.statusCode }));
			},
		);
		req.on("error", reject);
		req.end(initializeBody(1));
	});
}

function tempDbPath(): string {
	return join(mkdtempSync(join(tmpdir(), "codemem-mcp-http-")), "mem.sqlite");
}

function pkceS256(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}
