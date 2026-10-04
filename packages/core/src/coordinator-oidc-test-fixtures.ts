import { generateKeyPairSync, sign } from "node:crypto";
import type { CustomFetch, CustomFetchOptions } from "openid-client";
import { vi } from "vitest";
import { createCoordinatorOidcClient } from "./coordinator-oidc.js";

export const ISSUER = "https://issuer.example.test";
export const PROVIDER = {
	issuer: ISSUER,
	clientId: "fixture-client",
	clientSecret: "fixture-secret",
	redirectUri: "https://app.example.test/auth/callback",
};

// Fixture-only signing keys; the real SDK must verify every token against JWKS.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const wrongKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256" };

function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export async function challenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return Buffer.from(digest).toString("base64url");
}

function response(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fixtureState(issuer: string) {
	const metadata: Record<string, unknown> = {
		issuer,
		authorization_endpoint: `${issuer}/authorize`,
		token_endpoint: `${issuer}/token`,
		jwks_uri: `${issuer}/jwks`,
		userinfo_endpoint: `${issuer}/userinfo`,
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
		token_endpoint_auth_methods_supported: ["client_secret_post"],
	};
	const claims: Record<string, unknown> = {};
	const userInfo: Record<string, unknown> = { sub: "fixture-subject", name: "User Info" };
	const settings = { failure: "", omitIdToken: false, signature: "valid", alg: "RS256" };
	const codes = new Map<string, { nonce: string; challenge: string }>();
	const requests: { url: string; options: CustomFetchOptions }[] = [];
	return { issuer, metadata, claims, userInfo, settings, codes, requests };
}

type FixtureState = ReturnType<typeof fixtureState>;

function idToken(state: FixtureState, nonce: string): string {
	const { settings, claims } = state;
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		iss: state.issuer,
		aud: PROVIDER.clientId,
		sub: "fixture-subject",
		iat: now,
		exp: now + 600,
		nonce,
		name: "Fixture User",
		email: "user@example.test",
		email_verified: true,
		picture: "https://images.example.test/avatar.png",
		...claims,
	};
	const input = `${encode({ alg: settings.alg, kid: "fixture-key" })}.${encode(payload)}`;
	if (settings.alg === "none") return `${input}.`;
	const key = settings.signature === "wrong-key" ? wrongKeys.privateKey : keys.privateKey;
	const signature = sign("RSA-SHA256", Buffer.from(input), key).toString("base64url");
	return `${input}.${settings.signature === "modified" ? "A".repeat(signature.length) : signature}`;
}

async function token(state: FixtureState, options: CustomFetchOptions): Promise<Response> {
	const { settings, codes } = state;
	if (!(options.body instanceof URLSearchParams)) throw new Error("Unexpected token body");
	const form = options.body;
	const code = form.get("code") ?? "";
	const authorization = codes.get(code);
	codes.delete(code);
	const valid =
		authorization &&
		form.get("grant_type") === "authorization_code" &&
		form.get("client_id") === PROVIDER.clientId &&
		form.get("client_secret") === PROVIDER.clientSecret &&
		form.get("redirect_uri") === PROVIDER.redirectUri &&
		(await challenge(form.get("code_verifier") ?? "")) === authorization.challenge;
	if (!valid) return response({ error: "invalid_grant", error_description: "fixture-secret" }, 400);
	return response({
		access_token: "fixture-access-token",
		refresh_token: "fixture-refresh-token",
		token_type: "Bearer",
		expires_in: 600,
		...(settings.omitIdToken ? {} : { id_token: idToken(state, authorization.nonce) }),
	});
}

function fixtureTransport(state: FixtureState): CustomFetch {
	const { issuer, requests, settings, metadata, userInfo } = state;
	const transport: CustomFetch = async (url, options) => {
		requests.push({ url, options });
		if (url === settings.failure)
			throw new Error("fixture-secret fixture-access-token backend failure");
		if (url === `${issuer}/.well-known/openid-configuration`) return response(metadata);
		if (url === `${issuer}/token`) return token(state, options);
		if (url === `${issuer}/jwks`) return response({ keys: [jwk] });
		if (url === `${issuer}/userinfo`) {
			if (new Headers(options.headers).get("authorization") !== "Bearer fixture-access-token") {
				throw new Error("Missing userinfo bearer token");
			}
			return response(userInfo);
		}
		throw new Error(`Unexpected fixture URL: ${url}`);
	};
	return transport;
}

async function beginTransaction(state: FixtureState, fetch: CustomFetch) {
	const { codes, requests } = state;
	const result = await createCoordinatorOidcClient(
		{ ...PROVIDER, issuer: state.issuer },
		{ fetch },
	);
	if (!result.ok) throw new Error(result.error);
	const request = await result.client.createAuthorizationRequest();
	const url = new URL(request.authorizationUrl);
	const code = `fixture-code-${codes.size}-${requests.length}`;
	codes.set(code, {
		nonce: request.material.nonce,
		challenge: url.searchParams.get("code_challenge") ?? "",
	});
	const callback = new URL(PROVIDER.redirectUri);
	callback.searchParams.set("code", code);
	callback.searchParams.set("state", request.material.state);
	return {
		client: result.client,
		request,
		callback,
		input: { callbackUrl: callback.href, material: request.material },
	};
}

export function oidcFixture(options: { issuer?: string } = {}) {
	const state = fixtureState(options.issuer ?? ISSUER);
	const fetch = vi.fn(fixtureTransport(state));
	return { ...state, fetch, begin: () => beginTransaction(state, fetch) };
}
