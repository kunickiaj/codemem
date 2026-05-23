import { createPublicKey, randomUUID, verify } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
	type McpOAuthErrorResult,
	type McpOAuthRedirectResult,
	prepareMcpOAuthAuthorizationRequest,
} from "./oauth.js";

export const MCP_OIDC_ISSUER_URL_ENV = "CODEMEM_MCP_OIDC_ISSUER_URL";
export const MCP_OIDC_CLIENT_ID_ENV = "CODEMEM_MCP_OIDC_CLIENT_ID";
export const MCP_OIDC_CLIENT_SECRET_ENV = "CODEMEM_MCP_OIDC_CLIENT_SECRET";
export const MCP_OAUTH_ALLOWED_SUBJECT_ENV = "CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT";
export const MCP_OAUTH_ALLOWED_EMAIL_ENV = "CODEMEM_MCP_OAUTH_ALLOWED_EMAIL";

const PENDING_AUTH_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_AUTH = 100;
const ID_TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1000;

type JsonWebKey = Record<string, unknown>;

export interface OidcConfig {
	issuerUrl: string;
	clientId: string;
	clientSecret: string;
	allowedSubject?: string;
	allowedEmail?: string;
}

export interface PendingOidcAuthorization {
	oauthParams: string;
	nonce: string;
	expiresAt: number;
}

export interface OidcPendingAuthorizationStore {
	issue(record: Omit<PendingOidcAuthorization, "expiresAt">, now?: number): string | undefined;
	consume(state: string): PendingOidcAuthorization | undefined;
}

interface OidcDiscoveryMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
}

interface OidcTokensResponse {
	id_token?: string;
	error?: string;
	error_description?: string;
}

interface JwtHeader {
	alg?: string;
	kid?: string;
}

interface JwtClaims {
	iss?: string;
	aud?: string | string[];
	azp?: string;
	exp?: number;
	iat?: number;
	nonce?: string;
	sub?: string;
	email?: string;
	email_verified?: boolean;
}

interface JsonWebKeySet {
	keys?: JsonWebKey[];
}

export class InMemoryOidcPendingAuthorizationStore implements OidcPendingAuthorizationStore {
	readonly #records = new Map<string, PendingOidcAuthorization>();

	issue(record: Omit<PendingOidcAuthorization, "expiresAt">, now = Date.now()): string | undefined {
		this.#deleteExpired(now);
		if (this.#records.size >= MAX_PENDING_AUTH) return undefined;
		const state = randomUUID();
		this.#records.set(state, { ...record, expiresAt: now + PENDING_AUTH_TTL_MS });
		return state;
	}

	consume(state: string): PendingOidcAuthorization | undefined {
		const record = this.#records.get(state);
		this.#records.delete(state);
		return record;
	}

	#deleteExpired(now: number): void {
		for (const [state, record] of this.#records) {
			if (record.expiresAt <= now) this.#records.delete(state);
		}
	}
}

export function createInMemoryOidcPendingAuthorizationStore(): OidcPendingAuthorizationStore {
	return new InMemoryOidcPendingAuthorizationStore();
}

export function resolveOidcConfig(env: NodeJS.ProcessEnv = process.env): OidcConfig | undefined {
	const issuerUrl = env[MCP_OIDC_ISSUER_URL_ENV]?.trim();
	const clientId = env[MCP_OIDC_CLIENT_ID_ENV]?.trim();
	const clientSecret = env[MCP_OIDC_CLIENT_SECRET_ENV]?.trim();
	const allowedSubject = env[MCP_OAUTH_ALLOWED_SUBJECT_ENV]?.trim();
	const allowedEmail = env[MCP_OAUTH_ALLOWED_EMAIL_ENV]?.trim().toLowerCase();
	if (!issuerUrl && !clientId && !clientSecret && !allowedSubject && !allowedEmail)
		return undefined;
	if (!issuerUrl || !clientId || !clientSecret) {
		throw new Error("Incomplete MCP OIDC configuration");
	}
	validateOidcUrl(issuerUrl, "issuer", { allowLoopbackHttp: true });
	if (!allowedSubject && !allowedEmail) {
		throw new Error(
			"MCP OIDC requires CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT or CODEMEM_MCP_OAUTH_ALLOWED_EMAIL",
		);
	}
	return { issuerUrl, clientId, clientSecret, allowedSubject, allowedEmail };
}

export async function beginOidcAuthorization(
	params: URLSearchParams,
	clientsStore: OAuthRegisteredClientsStore,
	pendingStore: OidcPendingAuthorizationStore,
	config: OidcConfig | undefined,
	publicMcpUrl: string,
	now = Date.now(),
): Promise<McpOAuthRedirectResult | McpOAuthErrorResult> {
	if (!config) return invalidOAuthRequest("temporarily_unavailable", "OIDC is not configured");
	const prepared = prepareMcpOAuthAuthorizationRequest(params, clientsStore);
	if ("status" in prepared) return prepared;

	const discovery = await fetchOidcDiscovery(config.issuerUrl);
	const nonce = randomUUID();
	const upstreamState = pendingStore.issue({ oauthParams: params.toString(), nonce }, now);
	if (!upstreamState)
		return invalidOAuthRequest("temporarily_unavailable", "Too many pending OIDC authorizations");

	const redirectUri = getCallbackUrl(publicMcpUrl);
	const upstream = new URL(discovery.authorization_endpoint);
	upstream.searchParams.set("response_type", "code");
	upstream.searchParams.set("client_id", config.clientId);
	upstream.searchParams.set("redirect_uri", redirectUri);
	upstream.searchParams.set("scope", "openid email");
	upstream.searchParams.set("state", upstreamState);
	upstream.searchParams.set("nonce", nonce);
	return { status: 302, location: upstream.href };
}

export async function completeOidcAuthorization(
	callbackParams: URLSearchParams,
	pendingStore: OidcPendingAuthorizationStore,
	config: OidcConfig,
	publicMcpUrl: string,
	now = Date.now(),
): Promise<{ oauthParams: URLSearchParams } | McpOAuthErrorResult> {
	try {
		const code = callbackParams.get("code") ?? "";
		const state = callbackParams.get("state") ?? "";
		if (!state) return invalidOAuthRequest("invalid_request", "Missing OIDC state");
		const pending = pendingStore.consume(state);
		if (!pending || pending.expiresAt <= now)
			return invalidOAuthRequest("invalid_request", "Expired or unknown OIDC state");
		if (!code) return invalidOAuthRequest("invalid_request", "Missing OIDC code");

		const discovery = await fetchOidcDiscovery(config.issuerUrl);
		const tokens = await exchangeOidcCode(
			discovery.token_endpoint,
			config,
			getCallbackUrl(publicMcpUrl),
			code,
		);
		if (!tokens.id_token)
			return invalidOAuthRequest("invalid_request", "OIDC token exchange failed");
		const claims = await validateIdToken(
			tokens.id_token,
			discovery,
			config.clientId,
			pending.nonce,
			now,
		);
		if (!isAllowedIdentity(claims, config))
			return invalidOAuthRequest("access_denied", "OIDC identity is not allowed");

		return { oauthParams: new URLSearchParams(pending.oauthParams) };
	} catch {
		return invalidOAuthRequest("access_denied", "OIDC identity verification failed");
	}
}

function getCallbackUrl(publicMcpUrl: string): string {
	const url = new URL(publicMcpUrl);
	return new URL("/oauth/callback", url.origin).href;
}

async function fetchOidcDiscovery(issuerUrl: string): Promise<OidcDiscoveryMetadata> {
	const issuer = new URL(issuerUrl);
	if (issuer.search || issuer.hash)
		throw new Error("OIDC issuer must not include query or fragment");
	if (issuer.username || issuer.password)
		throw new Error("OIDC issuer must not include credentials");
	const discoveryUrl = new URL(
		`${issuer.pathname.replace(/\/$/, "")}/.well-known/openid-configuration`,
		issuer.origin,
	);
	const response = await fetch(discoveryUrl);
	if (!response.ok) throw new Error("OIDC discovery request failed");
	const metadata = (await response.json()) as Partial<OidcDiscoveryMetadata>;
	if (metadata.issuer !== issuer.href && metadata.issuer !== issuer.href.replace(/\/$/, "")) {
		throw new Error("OIDC discovery issuer mismatch");
	}
	if (!metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
		throw new Error("OIDC discovery metadata is incomplete");
	}
	const allowLoopbackHttp = issuer.protocol === "http:" && isLoopbackHostname(issuer.hostname);
	validateOidcUrl(metadata.authorization_endpoint, "authorization endpoint", { allowLoopbackHttp });
	validateOidcUrl(metadata.token_endpoint, "token endpoint", { allowLoopbackHttp });
	validateOidcUrl(metadata.jwks_uri, "JWKS URI", { allowLoopbackHttp });
	return metadata as OidcDiscoveryMetadata;
}

async function exchangeOidcCode(
	tokenEndpoint: string,
	config: OidcConfig,
	redirectUri: string,
	code: string,
): Promise<OidcTokensResponse> {
	const body = new URLSearchParams({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: config.clientId,
		client_secret: config.clientSecret,
	});
	const response = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body,
	});
	if (!response.ok) throw new Error("OIDC token request failed");
	return (await response.json()) as OidcTokensResponse;
}

async function validateIdToken(
	idToken: string,
	discovery: OidcDiscoveryMetadata,
	clientId: string,
	nonce: string,
	now: number,
): Promise<JwtClaims> {
	const [encodedHeader, encodedClaims, signature] = idToken.split(".");
	if (!encodedHeader || !encodedClaims || !signature) throw new Error("Invalid OIDC id_token");
	const header = parseJwtPart<JwtHeader>(encodedHeader);
	const claims = parseJwtPart<JwtClaims>(encodedClaims);
	if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported OIDC id_token signature");
	if (claims.iss !== discovery.issuer) throw new Error("OIDC id_token issuer mismatch");
	if (!audienceIncludes(claims.aud, clientId)) throw new Error("OIDC id_token audience mismatch");
	if (!isValidAuthorizedParty(claims.aud, claims.azp, clientId))
		throw new Error("OIDC id_token authorized party mismatch");
	if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now)
		throw new Error("OIDC id_token is expired");
	if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat))
		throw new Error("OIDC id_token issued-at time is missing");
	if (claims.iat * 1000 > now + ID_TOKEN_CLOCK_SKEW_MS)
		throw new Error("OIDC id_token issued-at time is in the future");
	if (claims.nonce !== nonce) throw new Error("OIDC id_token nonce mismatch");
	if (!claims.sub) throw new Error("OIDC id_token subject is missing");

	const jwksResponse = await fetch(discovery.jwks_uri);
	if (!jwksResponse.ok) throw new Error("OIDC JWKS request failed");
	const jwks = (await jwksResponse.json()) as JsonWebKeySet;
	const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
	if (!jwk) throw new Error("OIDC signing key not found");
	const key = createPublicKey({ key: jwk, format: "jwk" });
	const signed = `${encodedHeader}.${encodedClaims}`;
	const ok = verify("RSA-SHA256", Buffer.from(signed), key, Buffer.from(signature, "base64url"));
	if (!ok) throw new Error("OIDC id_token signature verification failed");
	return claims;
}

function parseJwtPart<T>(encoded: string): T {
	return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
}

function audienceIncludes(audience: string | string[] | undefined, clientId: string): boolean {
	return Array.isArray(audience) ? audience.includes(clientId) : audience === clientId;
}

function isValidAuthorizedParty(
	audience: string | string[] | undefined,
	authorizedParty: string | undefined,
	clientId: string,
): boolean {
	if (authorizedParty && authorizedParty !== clientId) return false;
	return !Array.isArray(audience) || audience.length <= 1 || authorizedParty === clientId;
}

function isAllowedIdentity(claims: JwtClaims, config: OidcConfig): boolean {
	if (config.allowedSubject && claims.sub === config.allowedSubject) return true;
	if (!config.allowedEmail) return false;
	return claims.email_verified === true && claims.email?.toLowerCase() === config.allowedEmail;
}

function validateOidcUrl(
	value: string,
	label: string,
	options: { allowLoopbackHttp?: boolean } = {},
): void {
	const url = new URL(value);
	if (url.username || url.password) throw new Error(`OIDC ${label} must not include credentials`);
	if (url.protocol === "https:") return;
	if (options.allowLoopbackHttp && url.protocol === "http:" && isLoopbackHostname(url.hostname))
		return;
	throw new Error(`OIDC ${label} must use HTTPS`);
}

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.replace(/^\[(.*)]$/, "$1").toLowerCase();
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function invalidOAuthRequest(error: string, description?: string): McpOAuthErrorResult {
	return {
		status: 400,
		body: description ? { error, error_description: description } : { error },
	};
}
