import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
	AccessDeniedError,
	InvalidClientError,
	InvalidGrantError,
	InvalidRequestError,
	InvalidTokenError,
	ServerError,
	TemporarilyUnavailableError,
	UnsupportedResponseTypeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
	AuthorizationParams,
	OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
	type OAuthClientInformationFull,
	type OAuthErrorResponse,
	type OAuthTokenRevocationRequest,
	type OAuthTokens,
	OAuthTokensSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import {
	createInMemoryOAuthRefreshTokenStore,
	type OAuthAccessTokenStore,
	type OAuthAuthorizationCodeStore,
	type OAuthRefreshTokenStore,
} from "./oauth.js";
import {
	beginOidcAuthorization,
	type OidcConfig,
	type OidcPendingAuthorizationStore,
} from "./oidc.js";

export interface MemoryOAuthServerProviderOptions {
	clientsStore: OAuthRegisteredClientsStore;
	codeStore: OAuthAuthorizationCodeStore;
	tokenStore: OAuthAccessTokenStore;
	refreshTokenStore?: OAuthRefreshTokenStore;
	publicMcpUrl: string;
	oidc?: { config: OidcConfig; pendingStore: OidcPendingAuthorizationStore };
	now?: () => number;
}

/**
 * MemoryOAuthServerProvider adapts codemem's existing in-memory stores to the
 * `@modelcontextprotocol/sdk` `OAuthServerProvider` contract so the SDK's
 * `mcpAuthRouter` and `requireBearerAuth` middleware can drive the OAuth
 * lifecycle. This class is the boundary between SDK-handled HTTP and
 * codemem-owned storage / upstream-OIDC bridging.
 *
 * Conventions encoded here:
 * - `authorize()` does NOT mint the MCP authorization code itself. It
 *   persists pending state and redirects the user-agent to the upstream OIDC
 *   provider. The MCP code is issued later by codemem's own /oauth/callback
 *   route (wired in codemem-b20m.3) after the upstream identity is validated.
 * - PKCE is validated by the SDK token handler against the challenge returned
 *   from `challengeForAuthorizationCode`. We do not re-verify here.
 * - `expiresAt` returned in `AuthInfo` is epoch SECONDS per the SDK's
 *   `requireBearerAuth` expectations; the underlying store records ms.
 * - Refresh-token grants use dual-token rotation: the current token and one
 *   previous token are accepted to tolerate client retry races, while older
 *   replayed tokens revoke the whole grant.
 */
export class MemoryOAuthServerProvider implements OAuthServerProvider {
	readonly #clientsStore: OAuthRegisteredClientsStore;
	readonly #codeStore: OAuthAuthorizationCodeStore;
	readonly #tokenStore: OAuthAccessTokenStore;
	readonly #refreshTokenStore: OAuthRefreshTokenStore;
	readonly #publicMcpUrl: string;
	readonly #resourceServerUrl: string;
	readonly #oidc?: { config: OidcConfig; pendingStore: OidcPendingAuthorizationStore };
	readonly #now: () => number;

	constructor(options: MemoryOAuthServerProviderOptions) {
		this.#clientsStore = options.clientsStore;
		this.#codeStore = options.codeStore;
		this.#tokenStore = options.tokenStore;
		this.#refreshTokenStore = options.refreshTokenStore ?? createInMemoryOAuthRefreshTokenStore();
		this.#publicMcpUrl = options.publicMcpUrl;
		this.#resourceServerUrl = new URL(options.publicMcpUrl).href;
		this.#oidc = options.oidc;
		this.#now = options.now ?? Date.now;
	}

	get clientsStore(): OAuthRegisteredClientsStore {
		return this.#clientsStore;
	}

	async authorize(
		client: OAuthClientInformationFull,
		params: AuthorizationParams,
		res: Response,
	): Promise<void> {
		if (!this.#oidc) {
			throw new TemporarilyUnavailableError("OIDC is not configured");
		}
		const upstreamParams = buildUpstreamAuthorizationParams(client, params);
		const result = await beginOidcAuthorization(
			upstreamParams,
			this.#clientsStore,
			this.#oidc.pendingStore,
			this.#oidc.config,
			this.#publicMcpUrl,
			this.#now(),
		);
		if (result.status === 302) {
			res.redirect(302, result.location);
			return;
		}
		throw mapOAuthErrorBody(result.body);
	}

	async challengeForAuthorizationCode(
		_client: OAuthClientInformationFull,
		authorizationCode: string,
	): Promise<string> {
		const record = this.#codeStore.peekCode(authorizationCode);
		if (!record) throw new InvalidGrantError("Invalid or already used code");
		if (record.clientId !== _client.client_id) {
			throw new InvalidGrantError("Code does not match client");
		}
		if (record.expiresAt <= this.#now()) {
			this.#codeStore.consumeCode(authorizationCode);
			throw new InvalidGrantError("Expired code");
		}
		return record.codeChallenge;
	}

	async exchangeAuthorizationCode(
		client: OAuthClientInformationFull,
		authorizationCode: string,
		_codeVerifier?: string,
		redirectUri?: string,
		resource?: URL,
	): Promise<OAuthTokens> {
		const now = this.#now();
		const record = this.#codeStore.peekCode(authorizationCode);
		if (!record) throw new InvalidGrantError("Invalid or already used code");
		if (record.expiresAt <= now) {
			this.#codeStore.consumeCode(authorizationCode);
			throw new InvalidGrantError("Expired code");
		}
		if (record.clientId !== client.client_id) {
			this.#codeStore.consumeCode(authorizationCode);
			throw new InvalidGrantError("Code does not match client");
		}
		// RFC 6749 §4.1.3: if the authorization request included redirect_uri,
		// the token request MUST include the same value. codemem always binds a
		// redirect_uri at /authorize, so a missing value at /token is always a
		// grant mismatch, not an optional check.
		if (redirectUri === undefined || record.redirectUri !== redirectUri) {
			this.#codeStore.consumeCode(authorizationCode);
			throw new InvalidGrantError("Code does not match redirect_uri");
		}
		if ((record.resource ?? null) !== (resource?.href ?? null)) {
			this.#codeStore.consumeCode(authorizationCode);
			throw new InvalidGrantError("Code does not match resource");
		}

		const scopes = normalizeClientScopes(record.scopes) ?? [];
		const grant = this.#refreshTokenStore.issueGrant(
			{ clientId: client.client_id, scopes, resource: record.resource },
			now,
		);
		if (!grant) {
			throw new TemporarilyUnavailableError("Too many active refresh grants");
		}
		const issued = this.#tokenStore.issueToken(
			client.client_id,
			now,
			record.resource,
			grant.grant.grantId,
			scopes,
		);
		if (!issued) {
			// Token-store overload is transient: leave the auth code unused so the
			// client can retry token exchange without restarting the OAuth flow.
			this.#refreshTokenStore.revokeGrant(grant.grant.grantId, now);
			throw new TemporarilyUnavailableError("Too many active access tokens");
		}

		const consumed = this.#codeStore.consumeCode(authorizationCode);
		if (!consumed) {
			this.#tokenStore.revokeToken(issued.token, now);
			this.#refreshTokenStore.revokeGrant(grant.grant.grantId, now);
			// Lost a race with a concurrent exchange that consumed the code in
			// the gap between peek and consume. Reject rather than issuing a
			// duplicate usable token.
			throw new InvalidGrantError("Authorization code already used");
		}

		return OAuthTokensSchema.parse({
			access_token: issued.token,
			token_type: "Bearer",
			expires_in: issued.expiresIn,
			refresh_token: grant.refreshToken,
		});
	}

	async exchangeRefreshToken(
		client: OAuthClientInformationFull,
		refreshToken: string,
		scopes?: string[],
		resource?: URL,
	): Promise<OAuthTokens> {
		const now = this.#now();
		const rotation = this.#refreshTokenStore.rotateRefreshToken(
			client.client_id,
			refreshToken,
			{ scopes: normalizeClientScopes(scopes), ...(resource ? { resource: resource.href } : {}) },
			now,
		);
		if (!rotation.ok) {
			if (rotation.reason === "refresh_token_replay" && rotation.grantId) {
				this.#tokenStore.revokeTokensForGrant?.(rotation.grantId, now);
			}
			throw new InvalidGrantError(refreshTokenErrorDescription(rotation.reason));
		}
		const issued = this.#tokenStore.issueToken(
			client.client_id,
			now,
			rotation.grant.resource,
			rotation.grant.grantId,
			rotation.grant.scopes,
		);
		if (!issued) throw new TemporarilyUnavailableError("Too many active access tokens");
		return OAuthTokensSchema.parse({
			access_token: issued.token,
			token_type: "Bearer",
			expires_in: issued.expiresIn,
			refresh_token: rotation.refreshToken,
		});
	}

	async verifyAccessToken(token: string): Promise<AuthInfo> {
		const result = this.#tokenStore.verifyToken(token, this.#now());
		if (!result.ok) {
			const reason =
				result.reason === "expired_token"
					? "Token has expired"
					: result.reason === "revoked_token"
						? "Token has been revoked"
						: "Token is invalid";
			throw new InvalidTokenError(reason);
		}
		const authInfo: AuthInfo = {
			token,
			clientId: result.record.clientId,
			scopes: result.record.scopes,
			expiresAt: Math.floor(result.record.expiresAt / 1000),
		};
		if (result.record.resource) {
			if (new URL(result.record.resource).href !== this.#resourceServerUrl) {
				throw new InvalidTokenError("Token audience does not match this resource server");
			}
			authInfo.resource = new URL(result.record.resource);
		}
		return authInfo;
	}

	async revokeToken(
		_client: OAuthClientInformationFull,
		request: OAuthTokenRevocationRequest,
	): Promise<void> {
		const now = this.#now();
		this.#tokenStore.revokeToken(request.token, now);
		const grantId = this.#refreshTokenStore.revokeRefreshToken(request.token, now);
		if (grantId) this.#tokenStore.revokeTokensForGrant?.(grantId, now);
	}
}

function buildUpstreamAuthorizationParams(
	client: OAuthClientInformationFull,
	params: AuthorizationParams,
): URLSearchParams {
	const upstream = new URLSearchParams();
	upstream.set("client_id", client.client_id);
	upstream.set("redirect_uri", params.redirectUri);
	upstream.set("response_type", "code");
	upstream.set("code_challenge", params.codeChallenge);
	upstream.set("code_challenge_method", "S256");
	if (params.state) upstream.set("state", params.state);
	if (params.scopes?.length) upstream.set("scope", params.scopes.join(" "));
	if (params.resource) upstream.set("resource", params.resource.href);
	return upstream;
}

function mapOAuthErrorBody(body: OAuthErrorResponse): Error {
	const description = body.error_description ?? body.error;
	switch (body.error) {
		case "temporarily_unavailable":
			return new TemporarilyUnavailableError(description);
		case "invalid_request":
			return new InvalidRequestError(description);
		case "invalid_client":
			return new InvalidClientError(description);
		case "access_denied":
			return new AccessDeniedError(description);
		case "unsupported_response_type":
			return new UnsupportedResponseTypeError(description);
		default:
			return new ServerError(description);
	}
}

function refreshTokenErrorDescription(reason: string): string {
	switch (reason) {
		case "expired_refresh_token":
			return "Refresh token has expired";
		case "revoked_refresh_token":
			return "Refresh token has been revoked";
		case "client_mismatch":
			return "Refresh token does not match client";
		case "scope_mismatch":
			return "Refresh token scope cannot be expanded";
		case "resource_mismatch":
			return "Refresh token does not match resource";
		case "refresh_token_replay":
			return "Refresh token replay detected";
		default:
			return "Invalid refresh token";
	}
}

function normalizeClientScopes(scopes: string[] | undefined): string[] | undefined {
	const normalized = scopes
		?.map((scope) => scope.trim())
		.filter(Boolean)
		.map((scope) => {
			if (scope === "memory:read_access") return "memory:read";
			if (scope === "memory:write_access") return "memory:write";
			return scope;
		});
	return normalized && normalized.length > 0 ? normalized : undefined;
}
