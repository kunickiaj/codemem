import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
	type OAuthClientInformationFull,
	type OAuthClientMetadata,
	OAuthClientMetadataSchema,
	type OAuthErrorResponse,
	type OAuthMetadata,
	type OAuthProtectedResourceMetadata,
	OAuthProtectedResourceMetadataSchema,
	type OAuthTokens,
	OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const MCP_OAUTH_PUBLIC_URL_ENV = "CODEMEM_MCP_HTTP_PUBLIC_URL";
export const MCP_OAUTH_RESOURCE_NAME = "codemem MCP";

const CLAUDE_HOSTED_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const LOCAL_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SUPPORTED_GRANT_TYPES = new Set(["authorization_code"]);
const SUPPORTED_RESPONSE_TYPES = new Set(["code"]);
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const MAX_AUTHORIZATION_CODES = 100;
const MAX_ACCESS_TOKENS = 100;
const ACCESS_TOKEN_BYTES = 32;
const ACCESS_TOKEN_BASE64URL_LENGTH = 43;
const ACCESS_TOKEN_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export interface McpOAuthMetadataOptions {
	mcpUrl: string;
	clientsStore: OAuthRegisteredClientsStore;
}

export interface RegisteredMcpOAuthClient {
	status: 201;
	body: OAuthClientInformationFull;
}

export interface McpOAuthRegistrationError {
	status: 400;
	body: { error: "invalid_client_metadata"; error_description: string };
}

export interface AuthorizationCodeRecord {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	expiresAt: number;
	used: boolean;
}

export interface OAuthAuthorizationCodeStore {
	issueCode(record: Omit<AuthorizationCodeRecord, "used">, now?: number): string | undefined;
	peekCode(code: string): AuthorizationCodeRecord | undefined;
	consumeCode(code: string): AuthorizationCodeRecord | undefined;
}

export interface AccessTokenRecord {
	clientId: string;
	tokenHash: string;
	issuedAt: number;
	expiresAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export interface OAuthAccessTokenStore {
	issueToken(clientId: string, now?: number): { token: string; expiresIn: number } | undefined;
	verifyToken(token: string, now?: number): AccessTokenRecord | undefined;
	revokeToken(token: string, now?: number): boolean;
}

export interface McpOAuthRedirectResult {
	status: 302;
	location: string;
}

export interface McpOAuthErrorResult {
	status: 400;
	body: OAuthErrorResponse;
}

export interface McpOAuthTokenResult {
	status: 200;
	body: OAuthTokens;
}

export interface PreparedMcpOAuthAuthorizationRequest {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	state: string | null;
}

export class InMemoryOAuthClientsStore implements OAuthRegisteredClientsStore {
	readonly #clients = new Map<string, OAuthClientInformationFull>();

	getClient(clientId: string): OAuthClientInformationFull | undefined {
		return this.#clients.get(clientId);
	}

	registerClient(
		client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
	): OAuthClientInformationFull {
		if (this.#clients.size >= 100) {
			const oldestClientId = this.#clients.keys().next().value;
			if (oldestClientId) this.#clients.delete(oldestClientId);
		}
		const registered = {
			...client,
			client_id: randomUUID(),
			client_id_issued_at: Math.floor(Date.now() / 1000),
		};
		this.#clients.set(registered.client_id, registered);
		return registered;
	}
}

export class InMemoryOAuthAuthorizationCodeStore implements OAuthAuthorizationCodeStore {
	readonly #codes = new Map<string, AuthorizationCodeRecord>();

	issueCode(record: Omit<AuthorizationCodeRecord, "used">, now = Date.now()): string | undefined {
		this.#deleteExpiredCodes(now);
		if (this.#codes.size >= MAX_AUTHORIZATION_CODES) return undefined;
		const code = randomUUID();
		this.#codes.set(code, { ...record, used: false });
		return code;
	}

	peekCode(code: string): AuthorizationCodeRecord | undefined {
		const record = this.#codes.get(code);
		if (!record || record.used) return undefined;
		return record;
	}

	consumeCode(code: string): AuthorizationCodeRecord | undefined {
		const record = this.#codes.get(code);
		if (!record || record.used) return undefined;
		record.used = true;
		return record;
	}

	#deleteExpiredCodes(now: number): void {
		for (const [code, record] of this.#codes) {
			if (record.expiresAt <= now) this.#codes.delete(code);
		}
	}
}

export class InMemoryOAuthAccessTokenStore implements OAuthAccessTokenStore {
	readonly #tokensByHash = new Map<string, AccessTokenRecord>();
	readonly #tokenHashKey = randomBytes(32);

	issueToken(clientId: string, now = Date.now()): { token: string; expiresIn: number } | undefined {
		this.#deleteInactiveTokens(now);
		if (this.#tokensByHash.size >= MAX_ACCESS_TOKENS) return undefined;
		const tokenBytes = randomBytes(ACCESS_TOKEN_BYTES);
		const tokenHash = signOAuthAccessTokenBytes(tokenBytes, this.#tokenHashKey);
		this.#tokensByHash.set(tokenHash, {
			clientId,
			tokenHash,
			issuedAt: now,
			expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
			lastUsedAt: null,
			revokedAt: null,
		});
		return {
			token: tokenBytes.toString("base64url"),
			expiresIn: ACCESS_TOKEN_TTL_SECONDS,
		};
	}

	verifyToken(token: string, now = Date.now()): AccessTokenRecord | undefined {
		const tokenBytes = decodeOAuthAccessToken(token);
		if (!tokenBytes) return undefined;
		const tokenHash = signOAuthAccessTokenBytes(tokenBytes, this.#tokenHashKey);
		const record = this.#tokensByHash.get(tokenHash);
		if (!record || !isSameTokenHash(record.tokenHash, tokenHash)) return undefined;
		if (record.revokedAt !== null || record.expiresAt <= now) return undefined;
		record.lastUsedAt = now;
		return { ...record };
	}

	revokeToken(token: string, now = Date.now()): boolean {
		const tokenBytes = decodeOAuthAccessToken(token);
		if (!tokenBytes) return false;
		const tokenHash = signOAuthAccessTokenBytes(tokenBytes, this.#tokenHashKey);
		const record = this.#tokensByHash.get(tokenHash);
		if (!record || !isSameTokenHash(record.tokenHash, tokenHash)) return false;
		if (record.revokedAt !== null) return true;
		record.revokedAt = now;
		return true;
	}

	#deleteInactiveTokens(now: number): void {
		for (const [tokenHash, record] of this.#tokensByHash) {
			if (record.expiresAt <= now || record.revokedAt !== null)
				this.#tokensByHash.delete(tokenHash);
		}
	}
}

export function createInMemoryOAuthClientsStore(): OAuthRegisteredClientsStore {
	return new InMemoryOAuthClientsStore();
}

export function createInMemoryOAuthAuthorizationCodeStore(): OAuthAuthorizationCodeStore {
	return new InMemoryOAuthAuthorizationCodeStore();
}

export function createInMemoryOAuthAccessTokenStore(): OAuthAccessTokenStore {
	return new InMemoryOAuthAccessTokenStore();
}

export function createMcpOAuthMetadata(options: McpOAuthMetadataOptions): OAuthMetadata {
	const mcpUrl = normalizeMcpPublicUrl(options.mcpUrl);
	const issuerUrl = getOriginUrl(mcpUrl);
	const provider = createMetadataOnlyProvider(options.clientsStore);
	return {
		...createOAuthMetadata({
			provider,
			issuerUrl,
			baseUrl: issuerUrl,
		}),
		// Phase 1 treats claude.ai and local callback clients as public clients.
		// Do not issue or advertise client secrets until we have a concrete need.
		grant_types_supported: ["authorization_code"],
		token_endpoint_auth_methods_supported: ["none"],
		revocation_endpoint: new URL("/oauth/revoke", issuerUrl).href,
		revocation_endpoint_auth_methods_supported: ["none"],
		client_id_metadata_document_supported: false,
	};
}

export function createMcpProtectedResourceMetadata(mcpUrl: string): OAuthProtectedResourceMetadata {
	const normalizedMcpUrl = normalizeMcpPublicUrl(mcpUrl);
	const metadata = {
		resource: normalizedMcpUrl.href,
		authorization_servers: [getOriginUrl(normalizedMcpUrl).href],
		bearer_methods_supported: ["header"],
		resource_name: MCP_OAUTH_RESOURCE_NAME,
	};
	return OAuthProtectedResourceMetadataSchema.parse(metadata);
}

export function registerMcpOAuthClient(
	requestBody: unknown,
	clientsStore: OAuthRegisteredClientsStore,
): RegisteredMcpOAuthClient | McpOAuthRegistrationError {
	if (!clientsStore.registerClient) {
		return invalidClientMetadata("Dynamic client registration is not enabled");
	}

	const parseResult = OAuthClientMetadataSchema.safeParse(requestBody);
	if (!parseResult.success) {
		return invalidClientMetadata(parseResult.error.message);
	}

	const clientMetadata = parseResult.data;
	const redirectError = validateRedirectUris(clientMetadata.redirect_uris);
	if (redirectError) return invalidClientMetadata(redirectError);

	if (!isSupportedTokenEndpointAuthMethod(clientMetadata.token_endpoint_auth_method)) {
		return invalidClientMetadata(
			"Only public clients with token_endpoint_auth_method=none are supported",
		);
	}

	if (
		clientMetadata.grant_types &&
		!isSupportedList(clientMetadata.grant_types, SUPPORTED_GRANT_TYPES)
	) {
		return invalidClientMetadata("Only authorization_code grant_type is supported in this slice");
	}

	if (
		clientMetadata.response_types &&
		!isSupportedList(clientMetadata.response_types, SUPPORTED_RESPONSE_TYPES)
	) {
		return invalidClientMetadata("Only code response_type is supported");
	}

	const registered = clientsStore.registerClient({
		...clientMetadata,
		token_endpoint_auth_method: "none",
		grant_types: clientMetadata.grant_types ?? ["authorization_code"],
		response_types: clientMetadata.response_types ?? ["code"],
	});

	if (registered instanceof Promise) {
		throw new Error(
			"Asynchronous OAuth client stores are not supported by this HTTP bootstrap yet",
		);
	}

	return { status: 201, body: registered };
}

export function authorizeMcpOAuthClient(
	params: URLSearchParams,
	clientsStore: OAuthRegisteredClientsStore,
	codeStore: OAuthAuthorizationCodeStore,
	now = Date.now(),
): McpOAuthRedirectResult | McpOAuthErrorResult {
	const prepared = prepareMcpOAuthAuthorizationRequest(params, clientsStore);
	if ("status" in prepared) return prepared;

	const code = codeStore.issueCode(
		{
			clientId: prepared.clientId,
			redirectUri: prepared.redirectUri,
			codeChallenge: prepared.codeChallenge,
			expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
		},
		now,
	);
	if (!code)
		return invalidOAuthRequest("temporarily_unavailable", "Too many active authorization codes");
	const redirect = new URL(prepared.redirectUri);
	redirect.searchParams.set("code", code);
	if (prepared.state !== null) redirect.searchParams.set("state", prepared.state);
	return { status: 302, location: redirect.href };
}

export function prepareMcpOAuthAuthorizationRequest(
	params: URLSearchParams,
	clientsStore: OAuthRegisteredClientsStore,
): PreparedMcpOAuthAuthorizationRequest | McpOAuthErrorResult {
	const clientId = params.get("client_id") ?? "";
	const redirectUri = params.get("redirect_uri") ?? "";
	const responseType = params.get("response_type") ?? "";
	const codeChallenge = params.get("code_challenge") ?? "";
	const codeChallengeMethod = params.get("code_challenge_method") ?? "";
	const state = params.get("state");

	if (responseType !== "code") return invalidOAuthRequest("unsupported_response_type");
	if (codeChallengeMethod !== "S256") {
		return invalidOAuthRequest("invalid_request", "PKCE code_challenge_method=S256 is required");
	}
	if (!PKCE_S256_CHALLENGE.test(codeChallenge)) {
		return invalidOAuthRequest("invalid_request", "Valid PKCE S256 code_challenge is required");
	}

	const client = getRegisteredClient(clientsStore, clientId);
	if (!client) return invalidOAuthRequest("invalid_client", "Unknown OAuth client_id");
	if (!client.redirect_uris.includes(redirectUri)) {
		return invalidOAuthRequest("invalid_request", "redirect_uri is not registered for this client");
	}

	return { clientId, redirectUri, codeChallenge, state };
}

export function exchangeMcpOAuthAuthorizationCode(
	params: URLSearchParams,
	clientsStore: OAuthRegisteredClientsStore,
	codeStore: OAuthAuthorizationCodeStore,
	tokenStore: OAuthAccessTokenStore,
	now = Date.now(),
): McpOAuthTokenResult | McpOAuthErrorResult {
	if ((params.get("grant_type") ?? "") !== "authorization_code") {
		return invalidOAuthRequest("unsupported_grant_type", "Only authorization_code is supported");
	}

	const clientId = params.get("client_id") ?? "";
	const code = params.get("code") ?? "";
	const redirectUri = params.get("redirect_uri") ?? "";
	const codeVerifier = params.get("code_verifier") ?? "";
	const client = getRegisteredClient(clientsStore, clientId);
	if (!client) return invalidOAuthRequest("invalid_client", "Unknown OAuth client_id");
	if (!PKCE_VERIFIER.test(codeVerifier)) {
		return invalidOAuthRequest("invalid_grant", "Invalid PKCE code_verifier");
	}

	// Peek the authorization code without consuming it so a transient token-
	// store overflow (`temporarily_unavailable`) leaves the code reusable; only
	// permanent grant failures (expiry, client/redirect mismatch, PKCE) consume
	// the code. The code is finally consumed atomically with token issuance.
	const record = codeStore.peekCode(code);
	if (!record) return invalidOAuthRequest("invalid_grant", "Invalid or already used code");
	if (record.expiresAt <= now) {
		codeStore.consumeCode(code);
		return invalidOAuthRequest("invalid_grant", "Expired code");
	}
	if (record.clientId !== clientId || record.redirectUri !== redirectUri) {
		codeStore.consumeCode(code);
		return invalidOAuthRequest("invalid_grant", "Code does not match client or redirect_uri");
	}
	if (pkceS256(codeVerifier) !== record.codeChallenge) {
		codeStore.consumeCode(code);
		return invalidOAuthRequest("invalid_grant", "PKCE verification failed");
	}

	const issued = tokenStore.issueToken(clientId, now);
	if (!issued) {
		// Token-store overload is transient: leave the auth code unused so the
		// client can retry token exchange without restarting the OAuth flow.
		return invalidOAuthRequest("temporarily_unavailable", "Too many active access tokens");
	}

	const consumed = codeStore.consumeCode(code);
	if (!consumed) {
		// Lost a race with another request that consumed the code in the gap
		// between peek and consume. Treat as invalid_grant rather than issuing
		// the token, since the code is no longer single-use atomic.
		return invalidOAuthRequest("invalid_grant", "Authorization code already used");
	}

	const tokens = OAuthTokensSchema.parse({
		access_token: issued.token,
		token_type: "Bearer",
		expires_in: issued.expiresIn,
	});
	return { status: 200, body: tokens };
}

export function revokeMcpOAuthAccessToken(
	params: URLSearchParams,
	tokenStore: OAuthAccessTokenStore,
): { status: 200; body: Record<string, never> } {
	const token = params.get("token") ?? "";
	tokenStore.revokeToken(token);
	return { status: 200, body: {} };
}

export function normalizeMcpPublicUrl(value: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid MCP HTTP public URL; expected an HTTPS /mcp URL");
	}
	if (url.protocol !== "https:" && !isLoopbackUrl(url)) {
		throw new Error("Invalid MCP HTTP public URL; use HTTPS for non-loopback URLs");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error(
			"Invalid MCP HTTP public URL; credentials, query strings, and fragments are not allowed",
		);
	}
	if (url.pathname === "/") url.pathname = "/mcp";
	if (url.pathname !== "/mcp") {
		throw new Error("Invalid MCP HTTP public URL; expected /mcp path");
	}
	return url;
}

function getOriginUrl(url: URL): URL {
	return new URL(url.origin);
}

function validateRedirectUris(redirectUris: OAuthClientMetadata["redirect_uris"]): string | null {
	for (const redirectUri of redirectUris) {
		const url = new URL(redirectUri);
		if (url.username || url.password || url.hash) return `Invalid redirect URI: ${redirectUri}`;
		if (url.href === CLAUDE_HOSTED_CALLBACK) continue;
		if (isLoopbackCallbackUrl(url)) continue;
		return `Unsupported redirect URI: ${redirectUri}`;
	}
	return null;
}

function isSupportedTokenEndpointAuthMethod(method: string | undefined): boolean {
	return method === undefined || method === "none";
}

function isSupportedList(values: string[], supported: Set<string>): boolean {
	return values.length > 0 && values.every((value) => supported.has(value));
}

function isLoopbackCallbackUrl(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		LOCAL_CALLBACK_HOSTS.has(normalizeHostname(url.hostname)) &&
		url.pathname === "/callback" &&
		url.search === ""
	);
}

function isLoopbackUrl(url: URL): boolean {
	const hostname = normalizeHostname(url.hostname);
	return url.protocol === "http:" && LOCAL_CALLBACK_HOSTS.has(hostname);
}

function normalizeHostname(hostname: string): string {
	return hostname.replace(/^\[(.*)]$/, "$1").toLowerCase();
}

function invalidClientMetadata(description: string): McpOAuthRegistrationError {
	return {
		status: 400,
		body: { error: "invalid_client_metadata", error_description: description },
	};
}

function invalidOAuthRequest(error: string, description?: string): McpOAuthErrorResult {
	return {
		status: 400,
		body: description ? { error, error_description: description } : { error },
	};
}

function getRegisteredClient(
	clientsStore: OAuthRegisteredClientsStore,
	clientId: string,
): OAuthClientInformationFull | undefined {
	const client = clientsStore.getClient(clientId);
	if (client instanceof Promise) {
		throw new Error(
			"Asynchronous OAuth client stores are not supported by this HTTP bootstrap yet",
		);
	}
	return client;
}

function pkceS256(codeVerifier: string): string {
	return createHash("sha256").update(codeVerifier).digest("base64url");
}

// Decode an externally-supplied access-token string into the fixed-length
// random Buffer it represents. Rejects anything that is not a base64url-encoded
// ACCESS_TOKEN_BYTES-length value, so invalid input never reaches the HMAC
// signer. Returns null on any decode/length mismatch.
function decodeOAuthAccessToken(serialized: string): Buffer | null {
	if (typeof serialized !== "string") return null;
	if (serialized.length !== ACCESS_TOKEN_BASE64URL_LENGTH) return null;
	if (!ACCESS_TOKEN_BASE64URL.test(serialized)) return null;
	const bytes = Buffer.from(serialized, "base64url");
	if (bytes.length !== ACCESS_TOKEN_BYTES) return null;
	return bytes;
}

// Compute the HMAC-SHA256 signature of the binary access-token material using
// the per-store random key. This is an integrity signature over a random
// 256-bit value, not password hashing; tokens are validated by re-signing the
// presented bytes and comparing the digest to the stored signature.
function signOAuthAccessTokenBytes(material: Buffer, key: Buffer): string {
	return createHmac("sha256", key).update(material).digest("base64url");
}

function isSameTokenHash(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function createMetadataOnlyProvider(
	clientsStore: OAuthRegisteredClientsStore,
): OAuthServerProvider {
	return {
		clientsStore,
		async authorize() {
			throw new Error("OAuth authorize is not implemented yet");
		},
		async challengeForAuthorizationCode() {
			throw new Error("OAuth token exchange is not implemented yet");
		},
		async exchangeAuthorizationCode() {
			throw new Error("OAuth token exchange is not implemented yet");
		},
		async exchangeRefreshToken() {
			throw new Error("OAuth refresh is not implemented yet");
		},
		async verifyAccessToken() {
			throw new Error("OAuth bearer verification is not implemented yet");
		},
	};
}
