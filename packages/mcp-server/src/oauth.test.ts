import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	authorizeMcpOAuthClient,
	createInMemoryOAuthAccessTokenStore,
	createInMemoryOAuthAuthorizationCodeStore,
	createInMemoryOAuthClientsStore,
	createMcpOAuthMetadata,
	createMcpProtectedResourceMetadata,
	exchangeMcpOAuthAuthorizationCode,
	normalizeMcpPublicUrl,
	registerMcpOAuthClient,
	revokeMcpOAuthAccessToken,
} from "./oauth.js";

describe("MCP OAuth metadata and dynamic client registration", () => {
	it("builds authorization server metadata from the MCP public URL", () => {
		const clientsStore = createInMemoryOAuthClientsStore();

		const metadata = createMcpOAuthMetadata({
			mcpUrl: "https://codemem.example.test/mcp",
			clientsStore,
		});

		expect(metadata).toMatchObject({
			issuer: "https://codemem.example.test/",
			authorization_endpoint: "https://codemem.example.test/authorize",
			token_endpoint: "https://codemem.example.test/token",
			revocation_endpoint: "https://codemem.example.test/oauth/revoke",
			registration_endpoint: "https://codemem.example.test/register",
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			client_id_metadata_document_supported: false,
		});
	});

	it("builds protected resource metadata for /mcp", () => {
		expect(createMcpProtectedResourceMetadata("https://codemem.example.test/mcp")).toEqual({
			resource: "https://codemem.example.test/mcp",
			authorization_servers: ["https://codemem.example.test/"],
			bearer_methods_supported: ["header"],
			resource_name: "codemem MCP",
		});
	});

	it("normalizes and validates MCP public URLs", () => {
		expect(normalizeMcpPublicUrl("https://codemem.example.test").href).toBe(
			"https://codemem.example.test/mcp",
		);
		expect(normalizeMcpPublicUrl("http://127.0.0.1:38889/mcp").href).toBe(
			"http://127.0.0.1:38889/mcp",
		);
		expect(normalizeMcpPublicUrl("http://[::1]:38889/mcp").href).toBe("http://[::1]:38889/mcp");
		expect(() => normalizeMcpPublicUrl("http://codemem.example.test/mcp")).toThrow(/use HTTPS/);
		expect(() => normalizeMcpPublicUrl("https://user:secret@codemem.example.test/mcp")).toThrow(
			/credentials/,
		);
		expect(() => normalizeMcpPublicUrl("https://codemem.example.test/other")).toThrow(
			/expected \/mcp path/,
		);
	});

	it("registers public clients and stores them by client id", () => {
		const clientsStore = createInMemoryOAuthClientsStore();

		const result = registerMcpOAuthClient(
			{
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				client_name: "Claude",
				token_endpoint_auth_method: "none",
			},
			clientsStore,
		);

		expect(result.status).toBe(201);
		if (result.status !== 201) throw new Error("expected successful registration");
		expect(result.body.client_id).toMatch(/[0-9a-f-]{36}/);
		expect(result.body.client_secret).toBeUndefined();
		expect(result.body.token_endpoint_auth_method).toBe("none");
		expect(result.body.grant_types).toEqual(["authorization_code"]);
		expect(result.body.response_types).toEqual(["code"]);
		expect(clientsStore.getClient(result.body.client_id)).toEqual(result.body);
	});

	it("accepts native loopback callback redirects", () => {
		const result = registerMcpOAuthClient(
			{
				redirect_uris: ["http://localhost:42713/callback", "http://[::1]:42713/callback"],
				token_endpoint_auth_method: "none",
			},
			createInMemoryOAuthClientsStore(),
		);

		expect(result.status).toBe(201);
	});

	it("rejects unsupported redirect URIs and confidential-client registration", () => {
		const clientsStore = createInMemoryOAuthClientsStore();

		expect(
			registerMcpOAuthClient({ redirect_uris: ["https://evil.test/callback"] }, clientsStore),
		).toMatchObject({ status: 400, body: { error: "invalid_client_metadata" } });

		expect(
			registerMcpOAuthClient(
				{
					redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
					token_endpoint_auth_method: "client_secret_post",
				},
				clientsStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_client_metadata" } });

		expect(
			registerMcpOAuthClient(
				{
					redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
					grant_types: ["authorization_code", "refresh_token"],
				},
				clientsStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_client_metadata" } });
	});

	it("issues authorization codes and exchanges them with PKCE S256", () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const verifier = "a".repeat(43);
		const registered = registerMcpOAuthClient(
			{
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			},
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected successful registration");

		const authorize = authorizeMcpOAuthClient(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: pkceS256(verifier),
				state: "opaque-state",
			}),
			clientsStore,
			codeStore,
		);

		expect(authorize.status).toBe(302);
		if (authorize.status !== 302) throw new Error("expected authorization redirect");
		const redirect = new URL(authorize.location);
		expect(redirect.searchParams.get("state")).toBe("opaque-state");
		const code = redirect.searchParams.get("code") ?? "";

		const token = exchangeMcpOAuthAuthorizationCode(
			new URLSearchParams({
				grant_type: "authorization_code",
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				code,
				code_verifier: verifier,
			}),
			clientsStore,
			codeStore,
			tokenStore,
		);

		expect(token.status).toBe(200);
		if (token.status !== 200) throw new Error("expected token response");
		expect(token.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
		expect(token.body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const verification = tokenStore.verifyToken(token.body.access_token);
		expect(verification).toMatchObject({
			ok: true,
			record: { clientId: registered.body.client_id },
		});
	});

	it("rejects invalid authorize and token PKCE requests", () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const verifier = "b".repeat(43);
		const registered = registerMcpOAuthClient(
			{
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			},
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected successful registration");

		expect(
			authorizeMcpOAuthClient(
				new URLSearchParams({
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					response_type: "code",
					code_challenge_method: "plain",
					code_challenge: verifier,
				}),
				clientsStore,
				codeStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_request" } });

		expect(
			authorizeMcpOAuthClient(
				new URLSearchParams({
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					response_type: "code",
					code_challenge_method: "S256",
					code_challenge: "not-a-valid-s256-challenge",
				}),
				clientsStore,
				codeStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_request" } });

		expect(
			authorizeMcpOAuthClient(
				new URLSearchParams({
					client_id: registered.body.client_id,
					redirect_uri: "https://evil.test/callback",
					response_type: "code",
					code_challenge_method: "S256",
					code_challenge: pkceS256(verifier),
				}),
				clientsStore,
				codeStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_request" } });

		const authorize = authorizeMcpOAuthClient(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: pkceS256(verifier),
			}),
			clientsStore,
			codeStore,
		);
		if (authorize.status !== 302) throw new Error("expected authorization redirect");
		const code = new URL(authorize.location).searchParams.get("code") ?? "";

		expect(
			exchangeMcpOAuthAuthorizationCode(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					code,
					code_verifier: "c".repeat(43),
				}),
				clientsStore,
				codeStore,
				tokenStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

		expect(
			exchangeMcpOAuthAuthorizationCode(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					code,
					code_verifier: verifier,
				}),
				clientsStore,
				codeStore,
				tokenStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
	});

	it("rejects expired and reused authorization codes", () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const verifier = "e".repeat(43);
		const registered = registerMcpOAuthClient(
			{
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			},
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected successful registration");

		const expiredAuthorize = authorizeMcpOAuthClient(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: pkceS256(verifier),
			}),
			clientsStore,
			codeStore,
			1_000,
		);
		if (expiredAuthorize.status !== 302) throw new Error("expected authorization redirect");
		const expiredCode = new URL(expiredAuthorize.location).searchParams.get("code") ?? "";
		expect(
			exchangeMcpOAuthAuthorizationCode(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					code: expiredCode,
					code_verifier: verifier,
				}),
				clientsStore,
				codeStore,
				tokenStore,
				1_000 + 5 * 60 * 1000 + 1,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

		const freshAuthorize = authorizeMcpOAuthClient(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: pkceS256(verifier),
			}),
			clientsStore,
			codeStore,
		);
		if (freshAuthorize.status !== 302) throw new Error("expected authorization redirect");
		const freshCode = new URL(freshAuthorize.location).searchParams.get("code") ?? "";
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: registered.body.client_id,
			redirect_uri: "https://claude.ai/api/mcp/auth_callback",
			code: freshCode,
			code_verifier: verifier,
		});

		expect(
			exchangeMcpOAuthAuthorizationCode(params, clientsStore, codeStore, tokenStore),
		).toMatchObject({
			status: 200,
		});
		expect(
			exchangeMcpOAuthAuthorizationCode(params, clientsStore, codeStore, tokenStore),
		).toMatchObject({
			status: 400,
			body: { error: "invalid_grant" },
		});
	});

	it("does not evict unexpired authorization codes when the in-memory cap is reached", () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const registered = registerMcpOAuthClient(
			{
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			},
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected successful registration");
		const firstVerifier = "f".repeat(43);
		const firstAuthorize = authorizeMcpOAuthClient(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: pkceS256(firstVerifier),
			}),
			clientsStore,
			codeStore,
			1_000,
		);
		if (firstAuthorize.status !== 302) throw new Error("expected authorization redirect");

		for (let index = 0; index < 99; index += 1) {
			const verifier = `${index}`.padStart(43, "g");
			expect(
				authorizeMcpOAuthClient(
					new URLSearchParams({
						client_id: registered.body.client_id,
						redirect_uri: "https://claude.ai/api/mcp/auth_callback",
						response_type: "code",
						code_challenge_method: "S256",
						code_challenge: pkceS256(verifier),
					}),
					clientsStore,
					codeStore,
					1_000,
				),
			).toMatchObject({ status: 302 });
		}

		expect(
			authorizeMcpOAuthClient(
				new URLSearchParams({
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					response_type: "code",
					code_challenge_method: "S256",
					code_challenge: pkceS256("h".repeat(43)),
				}),
				clientsStore,
				codeStore,
				1_000,
			),
		).toMatchObject({ status: 400, body: { error: "temporarily_unavailable" } });

		const firstCode = new URL(firstAuthorize.location).searchParams.get("code") ?? "";
		expect(
			exchangeMcpOAuthAuthorizationCode(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					code: firstCode,
					code_verifier: firstVerifier,
				}),
				clientsStore,
				codeStore,
				tokenStore,
				1_000,
			),
		).toMatchObject({ status: 200 });
	});

	it("preserves the authorization code when token issuance is temporarily unavailable", () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const exhaustedTokenStore = {
			issueToken: () => undefined,
			verifyToken: () => undefined,
			revokeToken: () => false,
		};
		const verifier = "j".repeat(43);
		const registered = registerMcpOAuthClient(
			{
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			},
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected successful registration");
		const authorize = authorizeMcpOAuthClient(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: pkceS256(verifier),
			}),
			clientsStore,
			codeStore,
		);
		if (authorize.status !== 302) throw new Error("expected authorization redirect");
		const code = new URL(authorize.location).searchParams.get("code") ?? "";
		const params = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: registered.body.client_id,
			redirect_uri: "https://claude.ai/api/mcp/auth_callback",
			code,
			code_verifier: verifier,
		});

		expect(
			exchangeMcpOAuthAuthorizationCode(params, clientsStore, codeStore, exhaustedTokenStore),
		).toMatchObject({ status: 400, body: { error: "temporarily_unavailable" } });

		// The auth code must still be reusable after a transient token-store
		// failure; only successful exchange or permanent grant failures consume it.
		const workingTokenStore = createInMemoryOAuthAccessTokenStore();
		expect(
			exchangeMcpOAuthAuthorizationCode(params, clientsStore, codeStore, workingTokenStore),
		).toMatchObject({ status: 200 });
		expect(
			exchangeMcpOAuthAuthorizationCode(params, clientsStore, codeStore, workingTokenStore),
		).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
	});

	it("consumes the authorization code on permanent grant failures", () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const verifier = "k".repeat(43);
		const registered = registerMcpOAuthClient(
			{
				redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
				token_endpoint_auth_method: "none",
			},
			clientsStore,
		);
		if (registered.status !== 201) throw new Error("expected successful registration");
		const authorize = authorizeMcpOAuthClient(
			new URLSearchParams({
				client_id: registered.body.client_id,
				redirect_uri: "https://claude.ai/api/mcp/auth_callback",
				response_type: "code",
				code_challenge_method: "S256",
				code_challenge: pkceS256(verifier),
			}),
			clientsStore,
			codeStore,
		);
		if (authorize.status !== 302) throw new Error("expected authorization redirect");
		const code = new URL(authorize.location).searchParams.get("code") ?? "";

		// Wrong PKCE verifier permanently invalidates the grant; the code must
		// be consumed so it can never be replayed.
		expect(
			exchangeMcpOAuthAuthorizationCode(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					code,
					code_verifier: "z".repeat(43),
				}),
				clientsStore,
				codeStore,
				tokenStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_grant" } });

		// Retrying with the correct verifier must fail because the code is now
		// gone (consumed by the permanent failure above).
		expect(
			exchangeMcpOAuthAuthorizationCode(
				new URLSearchParams({
					grant_type: "authorization_code",
					client_id: registered.body.client_id,
					redirect_uri: "https://claude.ai/api/mcp/auth_callback",
					code,
					code_verifier: verifier,
				}),
				clientsStore,
				codeStore,
				tokenStore,
			),
		).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
	});

	it("stores only hashed access-token material and rejects expired or revoked tokens", () => {
		const tokenStore = createInMemoryOAuthAccessTokenStore();

		const issued = tokenStore.issueToken("client-123", 1_000);

		expect(issued).toBeDefined();
		if (!issued) throw new Error("expected access token");
		const firstVerify = tokenStore.verifyToken(issued.token, 1_000);
		expect(firstVerify).toMatchObject({
			ok: true,
			record: { clientId: "client-123", lastUsedAt: 1_000, revokedAt: null },
		});
		if (firstVerify.ok) {
			expect(firstVerify.record.tokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(firstVerify.record.tokenHash).not.toBe(issued.token);
		}
		expect(tokenStore.verifyToken(issued.token, 1_000 + 60 * 60 * 1000 + 1)).toEqual({
			ok: false,
			reason: "expired_token",
		});

		const revocable = tokenStore.issueToken("client-456", 2_000);
		if (!revocable) throw new Error("expected revocable access token");
		expect(
			revokeMcpOAuthAccessToken(new URLSearchParams({ token: revocable.token }), tokenStore),
		).toEqual({
			status: 200,
			body: {},
		});
		expect(tokenStore.verifyToken(revocable.token, 2_001)).toEqual({
			ok: false,
			reason: "revoked_token",
		});
		expect(tokenStore.verifyToken("entirely-bogus-token", 2_001)).toEqual({
			ok: false,
			reason: "unknown_token",
		});
	});
});

function pkceS256(verifier: string): string {
	return createHash("sha256").update(verifier).digest("base64url");
}
