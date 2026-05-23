import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryOAuthClientsStore, registerMcpOAuthClient } from "./oauth.js";
import {
	beginOidcAuthorization,
	completeOidcAuthorization,
	createInMemoryOidcPendingAuthorizationStore,
	type OidcConfig,
	resolveOidcConfig,
} from "./oidc.js";

const servers: { close: () => Promise<void> }[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("OIDC-backed MCP OAuth authorization", () => {
	it("resolves explicit OIDC configuration and requires an allowlist", () => {
		expect(resolveOidcConfig({})).toBeUndefined();
		expect(() =>
			resolveOidcConfig({
				CODEMEM_MCP_OIDC_ISSUER_URL: "http://accounts.example.test/",
				CODEMEM_MCP_OIDC_CLIENT_ID: "client",
				CODEMEM_MCP_OIDC_CLIENT_SECRET: "secret",
				CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT: "owner-sub",
			}),
		).toThrow(/HTTPS/);
		expect(() =>
			resolveOidcConfig({
				CODEMEM_MCP_OIDC_ISSUER_URL: "https://user:pass@accounts.example.test/",
				CODEMEM_MCP_OIDC_CLIENT_ID: "client",
				CODEMEM_MCP_OIDC_CLIENT_SECRET: "secret",
				CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT: "owner-sub",
			}),
		).toThrow(/credentials/);
		expect(() =>
			resolveOidcConfig({
				CODEMEM_MCP_OIDC_ISSUER_URL: "https://accounts.example.test/",
				CODEMEM_MCP_OIDC_CLIENT_ID: "client",
				CODEMEM_MCP_OIDC_CLIENT_SECRET: "secret",
			}),
		).toThrow(/requires/);
		expect(
			resolveOidcConfig({
				CODEMEM_MCP_OIDC_ISSUER_URL: "https://accounts.example.test/",
				CODEMEM_MCP_OIDC_CLIENT_ID: "client",
				CODEMEM_MCP_OIDC_CLIENT_SECRET: "secret",
				CODEMEM_MCP_OAUTH_ALLOWED_EMAIL: "ME@EXAMPLE.TEST",
			}),
		).toMatchObject({ allowedEmail: "me@example.test" });
	});

	it("preserves path-based issuer URLs during discovery", async () => {
		const oidc = await startFakeOidc(
			{ sub: "owner-sub", email: "owner@example.test" },
			"/realms/test",
		);
		servers.push(oidc);
		const config: OidcConfig = {
			issuerUrl: oidc.issuer,
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedSubject: "owner-sub",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");

		const begin = await beginOidcAuthorization(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: "a".repeat(43),
			}),
			clientsStore,
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);

		expect(begin.status).toBe(302);
		expect(oidc.requests).toContain("/realms/test/.well-known/openid-configuration");
	});

	it("rejects non-HTTPS discovered endpoints outside loopback", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" }, "", {
			authorizationEndpoint: "http://evil.example.test/authorize",
		});
		servers.push(oidc);
		const config: OidcConfig = {
			issuerUrl: oidc.issuer,
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedSubject: "owner-sub",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");

		await expect(
			beginOidcAuthorization(
				new URLSearchParams({
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					response_type: "code",
					code_challenge_method: "S256",
					code_challenge: "a".repeat(43),
				}),
				clientsStore,
				pendingStore,
				config,
				"http://127.0.0.1:38889/mcp",
			),
		).rejects.toThrow(/HTTPS/);
	});

	it("rejects discovered loopback HTTP endpoints for HTTPS issuers", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					issuer: "https://accounts.example.test/",
					authorization_endpoint: "https://accounts.example.test/authorize",
					token_endpoint: "https://accounts.example.test/token",
					jwks_uri: "http://127.0.0.1:9999/jwks",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const config: OidcConfig = {
			issuerUrl: "https://accounts.example.test/",
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedSubject: "owner-sub",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");

		await expect(
			beginOidcAuthorization(
				new URLSearchParams({
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					response_type: "code",
					code_challenge_method: "S256",
					code_challenge: "a".repeat(43),
				}),
				clientsStore,
				pendingStore,
				config,
				"https://mcp.example.test/mcp",
			),
		).rejects.toThrow(/HTTPS/);
	});

	it("rejects discovered endpoints containing credentials", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					issuer: "https://accounts.example.test/",
					authorization_endpoint: "https://accounts.example.test/authorize",
					token_endpoint: "https://client:secret@accounts.example.test/token",
					jwks_uri: "https://accounts.example.test/jwks",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const config: OidcConfig = {
			issuerUrl: "https://accounts.example.test/",
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedSubject: "owner-sub",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");

		await expect(
			beginOidcAuthorization(
				new URLSearchParams({
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					response_type: "code",
					code_challenge_method: "S256",
					code_challenge: "a".repeat(43),
				}),
				clientsStore,
				pendingStore,
				config,
				"https://mcp.example.test/mcp",
			),
		).rejects.toThrow(/credentials/);
	});

	it("redirects to upstream OIDC and accepts an allowed identity", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" });
		servers.push(oidc);
		const config: OidcConfig = {
			issuerUrl: oidc.issuer,
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedSubject: "owner-sub",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");

		const begin = await beginOidcAuthorization(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: "a".repeat(43),
				state: "claude-state",
			}),
			clientsStore,
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);

		expect(begin.status).toBe(302);
		if (begin.status !== 302) throw new Error("expected OIDC redirect");
		const upstream = new URL(begin.location);
		await fetch(upstream);
		expect(upstream.pathname).toBe("/authorize");
		expect(upstream.searchParams.get("scope")).toBe("openid email");
		const completed = await completeOidcAuthorization(
			new URLSearchParams({
				code: "upstream-code",
				state: upstream.searchParams.get("state") ?? "",
			}),
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);

		expect("oauthParams" in completed).toBe(true);
		if (!("oauthParams" in completed)) throw new Error("expected completed OIDC auth");
		expect(completed.oauthParams.get("state")).toBe("claude-state");
	});

	it("denies identities outside the configured allowlist", async () => {
		const oidc = await startFakeOidc({ sub: "other-sub", email: "other@example.test" });
		servers.push(oidc);
		const config: OidcConfig = {
			issuerUrl: oidc.issuer,
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedSubject: "owner-sub",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");
		const begin = await beginOidcAuthorization(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: "a".repeat(43),
			}),
			clientsStore,
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);
		if (begin.status !== 302) throw new Error("expected OIDC redirect");
		await fetch(begin.location);

		const denied = await completeOidcAuthorization(
			new URLSearchParams({
				code: "upstream-code",
				state: new URL(begin.location).searchParams.get("state") ?? "",
			}),
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);

		expect(denied).toMatchObject({ status: 400, body: { error: "access_denied" } });
	});

	it("consumes pending state when upstream OIDC returns an error callback", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" });
		servers.push(oidc);
		const config: OidcConfig = {
			issuerUrl: oidc.issuer,
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedSubject: "owner-sub",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");
		const begin = await beginOidcAuthorization(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: "a".repeat(43),
			}),
			clientsStore,
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);
		if (begin.status !== 302) throw new Error("expected OIDC redirect");
		const state = new URL(begin.location).searchParams.get("state") ?? "";

		const denied = await completeOidcAuthorization(
			new URLSearchParams({ error: "access_denied", state }),
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);
		const replayed = await completeOidcAuthorization(
			new URLSearchParams({ code: "upstream-code", state }),
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);

		expect(denied).toMatchObject({ status: 400, body: { error: "invalid_request" } });
		expect(replayed).toMatchObject({ status: 400, body: { error: "invalid_request" } });
		if ("oauthParams" in replayed) throw new Error("expected replay to be rejected");
		expect(replayed.body.error_description).toMatch(/Expired or unknown/);
	});

	it("rejects ID tokens missing a subject", async () => {
		const oidc = await startFakeOidc({ email: "owner@example.test" });
		servers.push(oidc);
		const config: OidcConfig = {
			issuerUrl: oidc.issuer,
			clientId: "codemem-client",
			clientSecret: "secret",
			allowedEmail: "owner@example.test",
		};
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const registered = registerMcpOAuthClient(
			{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected client registration");
		const begin = await beginOidcAuthorization(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: "a".repeat(43),
			}),
			clientsStore,
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);
		if (begin.status !== 302) throw new Error("expected OIDC redirect");
		await fetch(begin.location);

		const denied = await completeOidcAuthorization(
			new URLSearchParams({
				code: "upstream-code",
				state: new URL(begin.location).searchParams.get("state") ?? "",
			}),
			pendingStore,
			config,
			"http://127.0.0.1:38889/mcp",
		);

		expect(denied).toMatchObject({ status: 400, body: { error: "access_denied" } });
	});

	it("rejects ID tokens missing issued-at time", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" }, "", {
			idTokenClaims: { iat: undefined },
		});
		servers.push(oidc);
		const denied = await completeSuccessfulRedirect(oidc.issuer, "owner-sub");

		expect(denied).toMatchObject({ status: 400, body: { error: "access_denied" } });
	});

	it("rejects ID tokens issued too far in the future", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" }, "", {
			idTokenClaims: { iat: Math.floor(Date.now() / 1000) + 3600 },
		});
		servers.push(oidc);
		const denied = await completeSuccessfulRedirect(oidc.issuer, "owner-sub");

		expect(denied).toMatchObject({ status: 400, body: { error: "access_denied" } });
	});

	it("rejects multi-audience ID tokens without a matching authorized party", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" }, "", {
			idTokenClaims: { aud: ["codemem-client", "other-client"] },
		});
		servers.push(oidc);
		const denied = await completeSuccessfulRedirect(oidc.issuer, "owner-sub");

		expect(denied).toMatchObject({ status: 400, body: { error: "access_denied" } });
	});

	it("rejects ID tokens with a mismatched authorized party", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" }, "", {
			idTokenClaims: { aud: ["codemem-client", "other-client"], azp: "other-client" },
		});
		servers.push(oidc);
		const denied = await completeSuccessfulRedirect(oidc.issuer, "owner-sub");

		expect(denied).toMatchObject({ status: 400, body: { error: "access_denied" } });
	});

	it("rejects non-2xx token responses even when they include an ID token", async () => {
		const oidc = await startFakeOidc({ sub: "owner-sub", email: "owner@example.test" }, "", {
			tokenStatus: 500,
		});
		servers.push(oidc);
		const denied = await completeSuccessfulRedirect(oidc.issuer, "owner-sub");

		expect(denied).toMatchObject({ status: 400, body: { error: "access_denied" } });
	});
});

async function completeSuccessfulRedirect(issuerUrl: string, allowedSubject: string) {
	const config: OidcConfig = {
		issuerUrl,
		clientId: "codemem-client",
		clientSecret: "secret",
		allowedSubject,
	};
	const clientsStore = createInMemoryOAuthClientsStore();
	const pendingStore = createInMemoryOidcPendingAuthorizationStore();
	const registered = registerMcpOAuthClient(
		{ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] },
		clientsStore,
	);
	if (registered.status !== 201) throw new Error("expected client registration");
	const begin = await beginOidcAuthorization(
		new URLSearchParams({
			client_id: registered.body.client_id,
			redirect_uri: "https://claude.ai/api/mcp/auth_callback",
			response_type: "code",
			code_challenge_method: "S256",
			code_challenge: "a".repeat(43),
		}),
		clientsStore,
		pendingStore,
		config,
		"http://127.0.0.1:38889/mcp",
	);
	if (begin.status !== 302) throw new Error("expected OIDC redirect");
	await fetch(begin.location);
	return completeOidcAuthorization(
		new URLSearchParams({
			code: "upstream-code",
			state: new URL(begin.location).searchParams.get("state") ?? "",
		}),
		pendingStore,
		config,
		"http://127.0.0.1:38889/mcp",
	);
}

async function startFakeOidc(
	identity: { sub?: string; email: string },
	issuerPath = "",
	overrides: {
		authorizationEndpoint?: string;
		tokenEndpoint?: string;
		jwksUri?: string;
		tokenStatus?: number;
		idTokenClaims?: Partial<{ aud: string | string[]; azp: string; iat: number }>;
	} = {},
) {
	const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const kid = "test-key";
	const publicJwk = publicKey.export({ format: "jwk" });
	let issuer = "";
	const requests: string[] = [];
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", issuer);
		requests.push(url.pathname);
		if (url.pathname === `${issuerPath}/.well-known/openid-configuration`) {
			writeJson(res, {
				issuer,
				authorization_endpoint: overrides.authorizationEndpoint ?? `${issuer}authorize`,
				token_endpoint: overrides.tokenEndpoint ?? `${issuer}token`,
				jwks_uri: overrides.jwksUri ?? `${issuer}jwks`,
			});
			return;
		}
		if (url.pathname === "/jwks") {
			writeJson(res, { keys: [{ ...publicJwk, kid, alg: "RS256", use: "sig" }] });
			return;
		}
		if (url.pathname === "/token") {
			const body = await readBody(req);
			const params = new URLSearchParams(body);
			res.statusCode = overrides.tokenStatus ?? 200;
			writeJson(res, {
				id_token: createIdToken({
					issuer,
					clientId: params.get("client_id") ?? "codemem-client",
					nonce: lastNonce ?? "missing-nonce",
					kid,
					privateKey,
					sub: identity.sub,
					email: identity.email,
					claims: overrides.idTokenClaims,
				}),
			});
			return;
		}
		if (url.pathname === "/authorize") {
			lastNonce = url.searchParams.get("nonce");
			writeJson(res, { ok: true });
			return;
		}
		res.statusCode = 404;
		res.end();
	});
	let lastNonce: string | null = null;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("missing fake OIDC port");
			issuer = `http://127.0.0.1:${address.port}${issuerPath}/`;
			resolve();
		});
	});
	return {
		issuer,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function createIdToken(input: {
	issuer: string;
	clientId: string;
	nonce: string;
	kid: string;
	privateKey: KeyObject;
	sub?: string;
	email: string;
	claims?: Partial<{ aud: string | string[]; azp: string; iat: number }>;
}): string {
	const header = encodeJwtPart({ alg: "RS256", kid: input.kid, typ: "JWT" });
	const claims = encodeJwtPart({
		iss: input.issuer,
		aud: input.claims?.aud ?? input.clientId,
		azp: input.claims?.azp,
		exp: Math.floor(Date.now() / 1000) + 300,
		iat: input.claims && "iat" in input.claims ? input.claims.iat : Math.floor(Date.now() / 1000),
		nonce: input.nonce,
		sub: input.sub,
		email: input.email,
		email_verified: true,
	});
	const payload = `${header}.${claims}`;
	const signature = sign("RSA-SHA256", Buffer.from(payload), input.privateKey).toString(
		"base64url",
	);
	return `${payload}.${signature}`;
}

function encodeJwtPart(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function readBody(req: IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of req) body += chunk;
	return body;
}

function writeJson(res: ServerResponse, body: unknown): void {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(body));
}
