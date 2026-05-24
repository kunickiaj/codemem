import type { Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OAuthAccessTokenStore, OAuthAuthorizationCodeStore } from "./oauth.js";
import {
	createInMemoryOAuthAccessTokenStore,
	createInMemoryOAuthAuthorizationCodeStore,
	createInMemoryOAuthClientsStore,
	registerMcpOAuthClient,
} from "./oauth.js";
import { createInMemoryOidcPendingAuthorizationStore, type OidcConfig } from "./oidc.js";
import { MemoryOAuthServerProvider } from "./provider.js";

const NOW = 1_000;
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const PUBLIC_MCP_URL = "https://mcp.example.test/mcp";
const CODE_CHALLENGE = "a".repeat(43);

afterEach(() => {
	vi.restoreAllMocks();
});

describe("MemoryOAuthServerProvider", () => {
	it("redirects authorize requests through upstream OIDC and preserves MCP OAuth params", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					issuer: "https://accounts.example.test/",
					authorization_endpoint: "https://accounts.example.test/authorize",
					token_endpoint: "https://accounts.example.test/token",
					jwks_uri: "https://accounts.example.test/jwks",
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);
		const clientsStore = createInMemoryOAuthClientsStore();
		const pendingStore = createInMemoryOidcPendingAuthorizationStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore: createInMemoryOAuthAuthorizationCodeStore(),
			tokenStore: createInMemoryOAuthAccessTokenStore(),
			publicMcpUrl: PUBLIC_MCP_URL,
			oidc: { config: oidcConfig(), pendingStore },
			now: () => NOW,
		});
		const client = registerClient(clientsStore);
		const response = fakeResponse();

		await provider.authorize(
			client,
			{
				redirectUri: REDIRECT_URI,
				codeChallenge: CODE_CHALLENGE,
				state: "claude-state",
				scopes: ["memory:read"],
				resource: new URL(PUBLIC_MCP_URL),
			},
			response,
		);

		expect(response.redirect).toHaveBeenCalledOnce();
		const [status, location] = response.redirect.mock.calls[0] ?? [];
		expect(status).toBe(302);
		const upstream = new URL(String(location));
		expect(upstream.href).toContain("https://accounts.example.test/authorize?");
		expect(upstream.searchParams.get("client_id")).toBe("codemem-oidc-client");
		expect(upstream.searchParams.get("redirect_uri")).toBe(
			"https://mcp.example.test/oauth/callback",
		);
		const pending = pendingStore.consume(upstream.searchParams.get("state") ?? "");
		expect(pending).toBeDefined();
		const oauthParams = new URLSearchParams(pending?.oauthParams);
		expect(oauthParams.get("client_id")).toBe(client.client_id);
		expect(oauthParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(oauthParams.get("response_type")).toBe("code");
		expect(oauthParams.get("code_challenge")).toBe(CODE_CHALLENGE);
		expect(oauthParams.get("code_challenge_method")).toBe("S256");
		expect(oauthParams.get("state")).toBe("claude-state");
		expect(oauthParams.get("scope")).toBe("memory:read");
		expect(oauthParams.get("resource")).toBe(PUBLIC_MCP_URL);
	});

	it("exposes the PKCE challenge for an active authorization code", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore,
			tokenStore: createInMemoryOAuthAccessTokenStore(),
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});
		const client = registerClient(clientsStore);
		const code = issueCode(codeStore, client.client_id);

		await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe(
			CODE_CHALLENGE,
		);
		await expect(provider.challengeForAuthorizationCode(client, "missing-code")).rejects.toThrow(
			/Invalid or already used code/,
		);
		await expect(
			provider.challengeForAuthorizationCode(registerClient(clientsStore), code),
		).rejects.toThrow(/Code does not match client/);
	});

	it("exchanges an authorization code for bearer tokens and consumes the code", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore,
			tokenStore,
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});
		const client = registerClient(clientsStore);
		const code = issueCode(codeStore, client.client_id);

		const tokens = await provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI);

		expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
		expect(tokens.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(tokenStore.verifyToken(tokens.access_token, NOW)).toMatchObject({
			ok: true,
			record: { clientId: client.client_id },
		});
		await expect(
			provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI),
		).rejects.toThrow(/Invalid or already used code/);
	});

	it("binds authorization-code exchanges and verified tokens to the requested resource", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore,
			tokenStore,
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});
		const client = registerClient(clientsStore);

		await expect(
			provider.exchangeAuthorizationCode(
				client,
				issueCode(codeStore, client.client_id, PUBLIC_MCP_URL),
				undefined,
				REDIRECT_URI,
				new URL("https://other.example.test/mcp"),
			),
		).rejects.toThrow(/Code does not match resource/);

		const tokens = await provider.exchangeAuthorizationCode(
			client,
			issueCode(codeStore, client.client_id, PUBLIC_MCP_URL),
			undefined,
			REDIRECT_URI,
			new URL(PUBLIC_MCP_URL),
		);

		await expect(provider.verifyAccessToken(tokens.access_token)).resolves.toMatchObject({
			clientId: client.client_id,
			resource: new URL(PUBLIC_MCP_URL),
		});
	});

	it("rejects token redemption that omits redirect_uri", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore,
			tokenStore: createInMemoryOAuthAccessTokenStore(),
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});
		const client = registerClient(clientsStore);
		const code = issueCode(codeStore, client.client_id);

		await expect(
			provider.exchangeAuthorizationCode(client, code, undefined, undefined),
		).rejects.toThrow(/Code does not match redirect_uri/);
		await expect(provider.challengeForAuthorizationCode(client, code)).rejects.toThrow(
			/Invalid or already used code/,
		);
	});

	it("rejects authorization-code client and redirect mismatches", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore,
			tokenStore: createInMemoryOAuthAccessTokenStore(),
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});
		const client = registerClient(clientsStore);
		const otherClient = registerClient(clientsStore);

		await expect(
			provider.exchangeAuthorizationCode(
				otherClient,
				issueCode(codeStore, client.client_id),
				undefined,
				REDIRECT_URI,
			),
		).rejects.toThrow(/Code does not match client/);
		await expect(
			provider.exchangeAuthorizationCode(
				client,
				issueCode(codeStore, client.client_id),
				undefined,
				"https://claude.ai/api/mcp/other_callback",
			),
		).rejects.toThrow(/Code does not match redirect_uri/);
	});

	it("leaves an authorization code reusable when token issuance is temporarily unavailable", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const codeStore = createInMemoryOAuthAuthorizationCodeStore();
		const exhaustedTokenStore: OAuthAccessTokenStore = {
			issueToken: () => undefined,
			verifyToken: () => ({ ok: false, reason: "unknown_token" }),
			revokeToken: () => false,
		};
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore,
			tokenStore: exhaustedTokenStore,
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});
		const client = registerClient(clientsStore);
		const code = issueCode(codeStore, client.client_id);

		await expect(
			provider.exchangeAuthorizationCode(client, code, undefined, REDIRECT_URI),
		).rejects.toThrow(/Too many active access tokens/);
		await expect(provider.challengeForAuthorizationCode(client, code)).resolves.toBe(
			CODE_CHALLENGE,
		);
	});

	it("revokes a token issued during a lost authorization-code consume race", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const tokenStore = createCapturingAccessTokenStore();
		const client = registerClient(clientsStore);
		const codeStore = raceLostCodeStore(client.client_id);
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore,
			tokenStore,
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});

		await expect(
			provider.exchangeAuthorizationCode(client, "race-code", undefined, REDIRECT_URI),
		).rejects.toThrow(/Authorization code already used/);

		expect(tokenStore.issuedTokens).toHaveLength(1);
		expect(tokenStore.verifyToken(tokenStore.issuedTokens[0] ?? "", NOW)).toMatchObject({
			ok: false,
			reason: "revoked_token",
		});
	});

	it("verifies and revokes access tokens with SDK AuthInfo semantics", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore: createInMemoryOAuthAuthorizationCodeStore(),
			tokenStore,
			publicMcpUrl: PUBLIC_MCP_URL,
			now: () => NOW,
		});
		const client = registerClient(clientsStore);
		const issued = tokenStore.issueToken(client.client_id, NOW);
		if (!issued) throw new Error("expected token issuance");

		await expect(provider.verifyAccessToken(issued.token)).resolves.toEqual({
			token: issued.token,
			clientId: client.client_id,
			scopes: [],
			expiresAt: 3601,
		});

		await provider.revokeToken(client, { token: issued.token });
		await expect(provider.verifyAccessToken(issued.token)).rejects.toThrow(/revoked/);
		await expect(provider.verifyAccessToken("not-a-token")).rejects.toThrow(/invalid/);
	});

	it("rejects refresh-token exchange until rotation support lands", async () => {
		const clientsStore = createInMemoryOAuthClientsStore();
		const provider = new MemoryOAuthServerProvider({
			clientsStore,
			codeStore: createInMemoryOAuthAuthorizationCodeStore(),
			tokenStore: createInMemoryOAuthAccessTokenStore(),
			publicMcpUrl: PUBLIC_MCP_URL,
		});

		await expect(provider.exchangeRefreshToken()).rejects.toThrow(/refresh_token grant/);
	});
});

function registerClient(clientsStore: ReturnType<typeof createInMemoryOAuthClientsStore>) {
	const registered = registerMcpOAuthClient(
		{ redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" },
		clientsStore,
	);
	if (registered.status !== 201) throw new Error("expected client registration");
	return registered.body;
}

function issueCode(
	codeStore: ReturnType<typeof createInMemoryOAuthAuthorizationCodeStore>,
	clientId: string,
	resource?: string,
): string {
	const code = codeStore.issueCode(
		{
			clientId,
			redirectUri: REDIRECT_URI,
			codeChallenge: CODE_CHALLENGE,
			...(resource ? { resource } : {}),
			expiresAt: NOW + 5 * 60 * 1000,
		},
		NOW,
	);
	if (!code) throw new Error("expected authorization code issuance");
	return code;
}

function fakeResponse(): Response & { redirect: ReturnType<typeof vi.fn> } {
	return { redirect: vi.fn() } as unknown as Response & { redirect: ReturnType<typeof vi.fn> };
}

function oidcConfig(): OidcConfig {
	return {
		issuerUrl: "https://accounts.example.test/",
		clientId: "codemem-oidc-client",
		clientSecret: "secret",
		allowedSubject: "owner-sub",
	};
}

function raceLostCodeStore(clientId: string): OAuthAuthorizationCodeStore {
	return {
		issueCode: () => "race-code",
		peekCode: () => ({
			clientId,
			redirectUri: REDIRECT_URI,
			codeChallenge: CODE_CHALLENGE,
			expiresAt: NOW + 5 * 60 * 1000,
			used: false,
		}),
		consumeCode: () => undefined,
	};
}

function createCapturingAccessTokenStore(): OAuthAccessTokenStore & { issuedTokens: string[] } {
	const store = createInMemoryOAuthAccessTokenStore();
	const issuedTokens: string[] = [];
	return {
		issuedTokens,
		issueToken: (clientId, now, resource) => {
			const issued = store.issueToken(clientId, now, resource);
			if (issued) issuedTokens.push(issued.token);
			return issued;
		},
		verifyToken: (token, now) => store.verifyToken(token, now),
		revokeToken: (token, now) => store.revokeToken(token, now),
	};
}
