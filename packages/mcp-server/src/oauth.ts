import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
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
export const MCP_OAUTH_SCOPES_SUPPORTED = ["memory:read", "memory:write"];
export const MCP_OAUTH_SERVICE_DOCUMENTATION_URL = "https://github.com/kunickiaj/codemem#readme";

const CLAUDE_HOSTED_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const CHATGPT_LEGACY_HOSTED_CALLBACK = "https://chatgpt.com/connector_platform_oauth_redirect";
const LOCAL_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SUPPORTED_GRANT_TYPES = new Set(["authorization_code", "refresh_token"]);
const SUPPORTED_RESPONSE_TYPES = new Set(["code"]);
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_AUTHORIZATION_CODES = 100;
const MAX_ACCESS_TOKENS = 100;
const MAX_REFRESH_GRANTS = 100;
const ACCESS_TOKEN_BYTES = 32;
const ACCESS_TOKEN_BASE64URL_LENGTH = 43;
const ACCESS_TOKEN_BASE64URL = /^[A-Za-z0-9_-]{43}$/;
const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CHATGPT_CONNECTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;

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
	scopes: string[];
	resource?: string;
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
	grantId?: string;
	scopes: string[];
	resource?: string;
	tokenHash: string;
	issuedAt: number;
	expiresAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export type AccessTokenVerificationResult =
	| { ok: true; record: AccessTokenRecord }
	| { ok: false; reason: "unknown_token" | "expired_token" | "revoked_token" };

export interface OAuthAccessTokenStore {
	issueToken(
		clientId: string,
		now?: number,
		resource?: string,
		grantId?: string,
		scopes?: string[],
	): { token: string; expiresIn: number } | undefined;
	verifyToken(token: string, now?: number): AccessTokenVerificationResult;
	revokeToken(token: string, now?: number): boolean;
	revokeTokensForGrant?(grantId: string, now?: number): number;
}

export interface RefreshTokenGrantRecord {
	grantId: string;
	clientId: string;
	scopes: string[];
	resource?: string;
	currentRefreshTokenHash: string;
	previousRefreshTokenHash: string | null;
	issuedAt: number;
	expiresAt: number;
	rotatedAt: number | null;
	revokedAt: number | null;
}

export type RefreshTokenRotationResult =
	| { ok: true; grant: RefreshTokenGrantRecord; refreshToken: string; expiresIn: number }
	| {
			ok: false;
			reason:
				| "unknown_refresh_token"
				| "expired_refresh_token"
				| "revoked_refresh_token"
				| "client_mismatch"
				| "scope_mismatch"
				| "resource_mismatch"
				| "refresh_token_replay";
			grantId?: string;
	  };

export interface OAuthRefreshTokenStore {
	issueGrant(
		record: { clientId: string; scopes?: string[]; resource?: string },
		now?: number,
	): { grant: RefreshTokenGrantRecord; refreshToken: string; expiresIn: number } | undefined;
	rotateRefreshToken(
		clientId: string,
		refreshToken: string,
		options?: { scopes?: string[]; resource?: string },
		now?: number,
	): RefreshTokenRotationResult;
	revokeRefreshToken(token: string, now?: number): string | undefined;
	revokeGrant(grantId: string, now?: number): boolean;
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
	scopes: string[];
	resource: string | null;
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
		const redirectError = validateRedirectUris(client.redirect_uris);
		if (redirectError) throw new InvalidClientMetadataError(redirectError);
		if (client.client_secret || client.token_endpoint_auth_method !== "none") {
			throw new InvalidClientMetadataError(
				"Only public clients with token_endpoint_auth_method=none are supported",
			);
		}
		if (client.grant_types && !isSupportedList(client.grant_types, SUPPORTED_GRANT_TYPES)) {
			throw new InvalidClientMetadataError(
				"Only authorization_code and refresh_token grant_types are supported",
			);
		}
		if (
			client.response_types &&
			!isSupportedList(client.response_types, SUPPORTED_RESPONSE_TYPES)
		) {
			throw new InvalidClientMetadataError("Only code response_type is supported");
		}
		if (this.#clients.size >= 100) {
			const oldestClientId = this.#clients.keys().next().value;
			if (oldestClientId) this.#clients.delete(oldestClientId);
		}
		const registered = {
			...client,
			token_endpoint_auth_method: "none" as const,
			grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
			response_types: client.response_types ?? ["code"],
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

	issueToken(
		clientId: string,
		now = Date.now(),
		resource?: string,
		grantId?: string,
		scopes: string[] = [],
	): { token: string; expiresIn: number } | undefined {
		this.#deleteInactiveTokens(now);
		if (this.#tokensByHash.size >= MAX_ACCESS_TOKENS) return undefined;
		const tokenBytes = randomBytes(ACCESS_TOKEN_BYTES);
		const tokenHash = signOAuthAccessTokenBytes(tokenBytes, this.#tokenHashKey);
		this.#tokensByHash.set(tokenHash, {
			clientId,
			grantId,
			scopes: [...scopes],
			resource,
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

	verifyToken(token: string, now = Date.now()): AccessTokenVerificationResult {
		const tokenBytes = decodeOAuthAccessToken(token);
		if (!tokenBytes) return { ok: false, reason: "unknown_token" };
		const tokenHash = signOAuthAccessTokenBytes(tokenBytes, this.#tokenHashKey);
		const record = this.#tokensByHash.get(tokenHash);
		if (!record || !isSameTokenHash(record.tokenHash, tokenHash)) {
			return { ok: false, reason: "unknown_token" };
		}
		if (record.revokedAt !== null) return { ok: false, reason: "revoked_token" };
		if (record.expiresAt <= now) return { ok: false, reason: "expired_token" };
		record.lastUsedAt = now;
		return { ok: true, record: { ...record } };
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

	revokeTokensForGrant(grantId: string, now = Date.now()): number {
		let revoked = 0;
		for (const record of this.#tokensByHash.values()) {
			if (record.grantId !== grantId || record.revokedAt !== null) continue;
			record.revokedAt = now;
			revoked += 1;
		}
		return revoked;
	}

	#deleteInactiveTokens(now: number): void {
		for (const [tokenHash, record] of this.#tokensByHash) {
			if (record.expiresAt <= now || record.revokedAt !== null)
				this.#tokensByHash.delete(tokenHash);
		}
	}
}

export class InMemoryOAuthRefreshTokenStore implements OAuthRefreshTokenStore {
	readonly #grantsById = new Map<string, RefreshTokenGrantRecord>();
	readonly #grantIdsByRefreshHash = new Map<string, string>();
	readonly #refreshHashesByGrantId = new Map<string, Set<string>>();
	readonly #tokenHashKey = randomBytes(32);

	issueGrant(
		record: { clientId: string; scopes?: string[]; resource?: string },
		now = Date.now(),
	): { grant: RefreshTokenGrantRecord; refreshToken: string; expiresIn: number } | undefined {
		this.#deleteInactiveGrants(now);
		if (this.#grantsById.size >= MAX_REFRESH_GRANTS) return undefined;
		const refreshToken = randomToken();
		const refreshTokenHash = hashSerializedOAuthToken(refreshToken, this.#tokenHashKey);
		if (!refreshTokenHash) return undefined;
		const grant: RefreshTokenGrantRecord = {
			grantId: randomUUID(),
			clientId: record.clientId,
			scopes: [...(record.scopes ?? [])],
			resource: record.resource,
			currentRefreshTokenHash: refreshTokenHash,
			previousRefreshTokenHash: null,
			issuedAt: now,
			expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
			rotatedAt: null,
			revokedAt: null,
		};
		this.#grantsById.set(grant.grantId, grant);
		this.#grantIdsByRefreshHash.set(refreshTokenHash, grant.grantId);
		this.#refreshHashesByGrantId.set(grant.grantId, new Set([refreshTokenHash]));
		return {
			grant: { ...grant, scopes: [...grant.scopes] },
			refreshToken,
			expiresIn: REFRESH_TOKEN_TTL_SECONDS,
		};
	}

	rotateRefreshToken(
		clientId: string,
		refreshToken: string,
		options: { scopes?: string[]; resource?: string } = {},
		now = Date.now(),
	): RefreshTokenRotationResult {
		const tokenHash = hashSerializedOAuthToken(refreshToken, this.#tokenHashKey);
		if (!tokenHash) return { ok: false, reason: "unknown_refresh_token" };
		const grantId = this.#grantIdsByRefreshHash.get(tokenHash);
		if (!grantId) return { ok: false, reason: "unknown_refresh_token" };
		const grant = this.#grantsById.get(grantId);
		if (!grant) return { ok: false, reason: "unknown_refresh_token" };
		if (grant.revokedAt !== null) return { ok: false, reason: "revoked_refresh_token", grantId };
		if (grant.expiresAt <= now) {
			this.revokeGrant(grantId, now);
			return { ok: false, reason: "expired_refresh_token", grantId };
		}
		if (grant.clientId !== clientId) return { ok: false, reason: "client_mismatch", grantId };
		if (!isScopeSubset(options.scopes ?? grant.scopes, grant.scopes)) {
			return { ok: false, reason: "scope_mismatch", grantId };
		}
		if ((grant.resource ?? null) !== (options.resource ?? grant.resource ?? null)) {
			return { ok: false, reason: "resource_mismatch", grantId };
		}

		const matchesCurrent = isSameTokenHash(grant.currentRefreshTokenHash, tokenHash);
		const matchesPrevious =
			grant.previousRefreshTokenHash !== null &&
			isSameTokenHash(grant.previousRefreshTokenHash, tokenHash);
		if (!matchesCurrent && !matchesPrevious) {
			this.revokeGrant(grantId, now);
			return { ok: false, reason: "refresh_token_replay", grantId };
		}

		const nextRefreshToken = randomToken();
		const nextRefreshTokenHash = hashSerializedOAuthToken(nextRefreshToken, this.#tokenHashKey);
		if (!nextRefreshTokenHash) return { ok: false, reason: "unknown_refresh_token" };
		grant.scopes = [...(options.scopes ?? grant.scopes)];
		grant.previousRefreshTokenHash = matchesCurrent ? grant.currentRefreshTokenHash : null;
		grant.currentRefreshTokenHash = nextRefreshTokenHash;
		grant.rotatedAt = now;
		this.#grantIdsByRefreshHash.set(nextRefreshTokenHash, grantId);
		this.#refreshHashesByGrantId.get(grantId)?.add(nextRefreshTokenHash);
		return {
			ok: true,
			grant: { ...grant, scopes: [...grant.scopes] },
			refreshToken: nextRefreshToken,
			expiresIn: Math.max(0, Math.floor((grant.expiresAt - now) / 1000)),
		};
	}

	revokeRefreshToken(token: string, now = Date.now()): string | undefined {
		const tokenHash = hashSerializedOAuthToken(token, this.#tokenHashKey);
		if (!tokenHash) return undefined;
		const grantId = this.#grantIdsByRefreshHash.get(tokenHash);
		if (!grantId) return undefined;
		this.revokeGrant(grantId, now);
		return grantId;
	}

	revokeGrant(grantId: string, now = Date.now()): boolean {
		const grant = this.#grantsById.get(grantId);
		if (!grant) return false;
		if (grant.revokedAt !== null) return true;
		grant.revokedAt = now;
		this.#deleteGrantRefreshHashIndexEntries(grant);
		return true;
	}

	#deleteInactiveGrants(now: number): void {
		for (const [grantId, grant] of this.#grantsById) {
			if (grant.expiresAt > now && grant.revokedAt === null) continue;
			this.#grantsById.delete(grantId);
			this.#deleteGrantRefreshHashIndexEntries(grant);
		}
	}

	#deleteGrantRefreshHashIndexEntries(grant: RefreshTokenGrantRecord): void {
		const refreshHashes = this.#refreshHashesByGrantId.get(grant.grantId);
		if (refreshHashes) {
			for (const refreshHash of refreshHashes) this.#grantIdsByRefreshHash.delete(refreshHash);
			this.#refreshHashesByGrantId.delete(grant.grantId);
			return;
		}
		this.#grantIdsByRefreshHash.delete(grant.currentRefreshTokenHash);
		if (grant.previousRefreshTokenHash)
			this.#grantIdsByRefreshHash.delete(grant.previousRefreshTokenHash);
	}
}

interface OAuthStateFileData {
	version: 1;
	clients: OAuthClientInformationFull[];
	accessTokens: AccessTokenRecord[];
	refreshGrants: RefreshTokenGrantRecord[];
	refreshHashesByGrantId: Record<string, string[]>;
}

/**
 * JSON-backed OAuth state for remote MCP clients.
 *
 * Claude keeps its dynamically-registered `client_id` and refresh token across
 * connector reconnects. If codemem only stores that state in memory, a package
 * upgrade or MCP process restart makes Claude's next refresh look like an
 * unknown client. This store persists client registrations, access tokens, and
 * refresh-token grants so routine restarts do not force users through OAuth
 * again.
 */
export class JsonFileOAuthStateStore
	implements
		OAuthRegisteredClientsStore,
		OAuthAuthorizationCodeStore,
		OAuthAccessTokenStore,
		OAuthRefreshTokenStore
{
	readonly #path: string;
	readonly #codes = new Map<string, AuthorizationCodeRecord>();
	#clients = new Map<string, OAuthClientInformationFull>();
	#tokensByHash = new Map<string, AccessTokenRecord>();
	#grantsById = new Map<string, RefreshTokenGrantRecord>();
	#grantIdsByRefreshHash = new Map<string, string>();
	#refreshHashesByGrantId = new Map<string, Set<string>>();

	constructor(path = getDefaultMcpOAuthStatePath()) {
		this.#path = path;
		this.#load();
	}

	getClient(clientId: string): OAuthClientInformationFull | undefined {
		return this.#clients.get(clientId);
	}

	registerClient(
		client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
	): OAuthClientInformationFull {
		const redirectError = validateRedirectUris(client.redirect_uris);
		if (redirectError) throw new InvalidClientMetadataError(redirectError);
		if (client.client_secret || client.token_endpoint_auth_method !== "none") {
			throw new InvalidClientMetadataError(
				"Only public clients with token_endpoint_auth_method=none are supported",
			);
		}
		if (client.grant_types && !isSupportedList(client.grant_types, SUPPORTED_GRANT_TYPES)) {
			throw new InvalidClientMetadataError(
				"Only authorization_code and refresh_token grant_types are supported",
			);
		}
		if (
			client.response_types &&
			!isSupportedList(client.response_types, SUPPORTED_RESPONSE_TYPES)
		) {
			throw new InvalidClientMetadataError("Only code response_type is supported");
		}
		this.#deleteInactive(Date.now());
		if (this.#clients.size >= 100) {
			const oldestClientId = this.#clients.keys().next().value;
			if (oldestClientId) this.#clients.delete(oldestClientId);
		}
		const registered = {
			...client,
			token_endpoint_auth_method: "none" as const,
			grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
			response_types: client.response_types ?? ["code"],
			client_id: randomUUID(),
			client_id_issued_at: Math.floor(Date.now() / 1000),
		};
		this.#clients.set(registered.client_id, registered);
		this.#save();
		return registered;
	}

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

	issueToken(
		clientId: string,
		now = Date.now(),
		resource?: string,
		grantId?: string,
		scopes: string[] = [],
	): { token: string; expiresIn: number } | undefined {
		this.#deleteInactive(now);
		if (this.#tokensByHash.size >= MAX_ACCESS_TOKENS) return undefined;
		const token = randomToken();
		const tokenHash = hashOAuthTokenForStateFile(token);
		if (!tokenHash) return undefined;
		this.#tokensByHash.set(tokenHash, {
			clientId,
			grantId,
			scopes: [...scopes],
			resource,
			tokenHash,
			issuedAt: now,
			expiresAt: now + ACCESS_TOKEN_TTL_SECONDS * 1000,
			lastUsedAt: null,
			revokedAt: null,
		});
		this.#save();
		return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
	}

	verifyToken(token: string, now = Date.now()): AccessTokenVerificationResult {
		const tokenHash = hashOAuthTokenForStateFile(token);
		if (!tokenHash) return { ok: false, reason: "unknown_token" };
		const record = this.#tokensByHash.get(tokenHash);
		if (!record || !isSameTokenHash(record.tokenHash, tokenHash)) {
			return { ok: false, reason: "unknown_token" };
		}
		if (record.revokedAt !== null) return { ok: false, reason: "revoked_token" };
		if (record.expiresAt <= now) return { ok: false, reason: "expired_token" };
		record.lastUsedAt = now;
		return { ok: true, record: { ...record, scopes: [...record.scopes] } };
	}

	revokeToken(token: string, now = Date.now()): boolean {
		const tokenHash = hashOAuthTokenForStateFile(token);
		if (!tokenHash) return false;
		const record = this.#tokensByHash.get(tokenHash);
		if (!record || !isSameTokenHash(record.tokenHash, tokenHash)) return false;
		if (record.revokedAt !== null) return true;
		record.revokedAt = now;
		this.#save();
		return true;
	}

	revokeTokensForGrant(grantId: string, now = Date.now()): number {
		let revoked = 0;
		for (const record of this.#tokensByHash.values()) {
			if (record.grantId !== grantId || record.revokedAt !== null) continue;
			record.revokedAt = now;
			revoked += 1;
		}
		if (revoked > 0) this.#save();
		return revoked;
	}

	issueGrant(
		record: { clientId: string; scopes?: string[]; resource?: string },
		now = Date.now(),
	): { grant: RefreshTokenGrantRecord; refreshToken: string; expiresIn: number } | undefined {
		this.#deleteInactive(now);
		if (this.#grantsById.size >= MAX_REFRESH_GRANTS) return undefined;
		const refreshToken = randomToken();
		const refreshTokenHash = hashOAuthTokenForStateFile(refreshToken);
		if (!refreshTokenHash) return undefined;
		const grant: RefreshTokenGrantRecord = {
			grantId: randomUUID(),
			clientId: record.clientId,
			scopes: [...(record.scopes ?? [])],
			resource: record.resource,
			currentRefreshTokenHash: refreshTokenHash,
			previousRefreshTokenHash: null,
			issuedAt: now,
			expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
			rotatedAt: null,
			revokedAt: null,
		};
		this.#grantsById.set(grant.grantId, grant);
		this.#grantIdsByRefreshHash.set(refreshTokenHash, grant.grantId);
		this.#refreshHashesByGrantId.set(grant.grantId, new Set([refreshTokenHash]));
		this.#save();
		return {
			grant: { ...grant, scopes: [...grant.scopes] },
			refreshToken,
			expiresIn: REFRESH_TOKEN_TTL_SECONDS,
		};
	}

	rotateRefreshToken(
		clientId: string,
		refreshToken: string,
		options: { scopes?: string[]; resource?: string } = {},
		now = Date.now(),
	): RefreshTokenRotationResult {
		const tokenHash = hashOAuthTokenForStateFile(refreshToken);
		if (!tokenHash) return { ok: false, reason: "unknown_refresh_token" };
		const grantId = this.#grantIdsByRefreshHash.get(tokenHash);
		if (!grantId) return { ok: false, reason: "unknown_refresh_token" };
		const grant = this.#grantsById.get(grantId);
		if (!grant) return { ok: false, reason: "unknown_refresh_token" };
		if (grant.revokedAt !== null) return { ok: false, reason: "revoked_refresh_token", grantId };
		if (grant.expiresAt <= now) {
			this.revokeGrant(grantId, now);
			return { ok: false, reason: "expired_refresh_token", grantId };
		}
		if (grant.clientId !== clientId) return { ok: false, reason: "client_mismatch", grantId };
		if (!isScopeSubset(options.scopes ?? grant.scopes, grant.scopes)) {
			return { ok: false, reason: "scope_mismatch", grantId };
		}
		if ((grant.resource ?? null) !== (options.resource ?? grant.resource ?? null)) {
			return { ok: false, reason: "resource_mismatch", grantId };
		}

		const matchesCurrent = isSameTokenHash(grant.currentRefreshTokenHash, tokenHash);
		const matchesPrevious =
			grant.previousRefreshTokenHash !== null &&
			isSameTokenHash(grant.previousRefreshTokenHash, tokenHash);
		if (!matchesCurrent && !matchesPrevious) {
			this.revokeGrant(grantId, now);
			return { ok: false, reason: "refresh_token_replay", grantId };
		}

		const nextRefreshToken = randomToken();
		const nextRefreshTokenHash = hashOAuthTokenForStateFile(nextRefreshToken);
		if (!nextRefreshTokenHash) return { ok: false, reason: "unknown_refresh_token" };
		grant.scopes = [...(options.scopes ?? grant.scopes)];
		grant.previousRefreshTokenHash = matchesCurrent ? grant.currentRefreshTokenHash : null;
		grant.currentRefreshTokenHash = nextRefreshTokenHash;
		grant.rotatedAt = now;
		this.#grantIdsByRefreshHash.set(nextRefreshTokenHash, grantId);
		this.#refreshHashesByGrantId.get(grantId)?.add(nextRefreshTokenHash);
		this.#save();
		return {
			ok: true,
			grant: { ...grant, scopes: [...grant.scopes] },
			refreshToken: nextRefreshToken,
			expiresIn: Math.max(0, Math.floor((grant.expiresAt - now) / 1000)),
		};
	}

	revokeRefreshToken(token: string, now = Date.now()): string | undefined {
		const tokenHash = hashOAuthTokenForStateFile(token);
		if (!tokenHash) return undefined;
		const grantId = this.#grantIdsByRefreshHash.get(tokenHash);
		if (!grantId) return undefined;
		this.revokeGrant(grantId, now);
		return grantId;
	}

	revokeGrant(grantId: string, now = Date.now()): boolean {
		const grant = this.#grantsById.get(grantId);
		if (!grant) return false;
		if (grant.revokedAt !== null) return true;
		grant.revokedAt = now;
		this.#deleteGrantRefreshHashIndexEntries(grant);
		this.#save();
		return true;
	}

	#load(): void {
		if (!existsSync(this.#path)) return;
		let parsed: OAuthStateFileData;
		try {
			parsed = JSON.parse(readFileSync(this.#path, "utf8")) as OAuthStateFileData;
		} catch {
			return;
		}
		if (parsed.version !== 1) return;
		this.#clients = new Map(parsed.clients.map((client) => [client.client_id, client]));
		this.#tokensByHash = new Map(parsed.accessTokens.map((record) => [record.tokenHash, record]));
		this.#grantsById = new Map(parsed.refreshGrants.map((grant) => [grant.grantId, grant]));
		this.#grantIdsByRefreshHash = new Map();
		this.#refreshHashesByGrantId = new Map();
		for (const grant of this.#grantsById.values()) {
			const hashes = new Set(parsed.refreshHashesByGrantId[grant.grantId] ?? []);
			hashes.add(grant.currentRefreshTokenHash);
			if (grant.previousRefreshTokenHash) hashes.add(grant.previousRefreshTokenHash);
			this.#refreshHashesByGrantId.set(grant.grantId, hashes);
			for (const hash of hashes) this.#grantIdsByRefreshHash.set(hash, grant.grantId);
		}
		this.#deleteInactive(Date.now());
	}

	#save(): void {
		mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
		const data: OAuthStateFileData = {
			version: 1,
			clients: [...this.#clients.values()],
			accessTokens: [...this.#tokensByHash.values()],
			refreshGrants: [...this.#grantsById.values()],
			refreshHashesByGrantId: Object.fromEntries(
				[...this.#refreshHashesByGrantId.entries()].map(([grantId, hashes]) => [
					grantId,
					[...hashes],
				]),
			),
		};
		const tmpPath = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmpPath, this.#path);
		void chmod(this.#path, 0o600).catch(() => undefined);
	}

	#deleteExpiredCodes(now: number): void {
		for (const [code, record] of this.#codes) {
			if (record.expiresAt <= now) this.#codes.delete(code);
		}
	}

	#deleteInactive(now: number): void {
		let changed = false;
		for (const [tokenHash, record] of this.#tokensByHash) {
			if (record.expiresAt > now && record.revokedAt === null) continue;
			this.#tokensByHash.delete(tokenHash);
			changed = true;
		}
		for (const [grantId, grant] of this.#grantsById) {
			if (grant.expiresAt > now && grant.revokedAt === null) continue;
			this.#grantsById.delete(grantId);
			this.#deleteGrantRefreshHashIndexEntries(grant);
			changed = true;
		}
		if (changed) this.#save();
	}

	#deleteGrantRefreshHashIndexEntries(grant: RefreshTokenGrantRecord): void {
		const refreshHashes = this.#refreshHashesByGrantId.get(grant.grantId);
		if (refreshHashes) {
			for (const refreshHash of refreshHashes) this.#grantIdsByRefreshHash.delete(refreshHash);
			this.#refreshHashesByGrantId.delete(grant.grantId);
			return;
		}
		this.#grantIdsByRefreshHash.delete(grant.currentRefreshTokenHash);
		if (grant.previousRefreshTokenHash)
			this.#grantIdsByRefreshHash.delete(grant.previousRefreshTokenHash);
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

export function createInMemoryOAuthRefreshTokenStore(): OAuthRefreshTokenStore {
	return new InMemoryOAuthRefreshTokenStore();
}

export function createJsonFileOAuthStateStore(path?: string): JsonFileOAuthStateStore {
	return new JsonFileOAuthStateStore(path);
}

export function getDefaultMcpOAuthStatePath(): string {
	return join(process.env.HOME?.trim() || homedir(), ".codemem", "mcp-oauth-state.json");
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
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none"],
		scopes_supported: MCP_OAUTH_SCOPES_SUPPORTED,
		service_documentation: MCP_OAUTH_SERVICE_DOCUMENTATION_URL,
		revocation_endpoint: new URL("/revoke", issuerUrl).href,
		revocation_endpoint_auth_methods_supported: ["none"],
		client_id_metadata_document_supported: false,
	};
}

export function createMcpProtectedResourceMetadata(mcpUrl: string): OAuthProtectedResourceMetadata {
	const normalizedMcpUrl = normalizeMcpPublicUrl(mcpUrl);
	const metadata = {
		resource: normalizedMcpUrl.href,
		authorization_servers: [getOriginUrl(normalizedMcpUrl).href],
		scopes_supported: MCP_OAUTH_SCOPES_SUPPORTED,
		bearer_methods_supported: ["header"],
		resource_name: MCP_OAUTH_RESOURCE_NAME,
		resource_documentation: MCP_OAUTH_SERVICE_DOCUMENTATION_URL,
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
		return invalidClientMetadata(
			"Only authorization_code and refresh_token grant_types are supported",
		);
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
		grant_types: clientMetadata.grant_types ?? ["authorization_code", "refresh_token"],
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
			scopes: prepared.scopes,
			...(prepared.resource ? { resource: prepared.resource } : {}),
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
	const resource = params.get("resource");
	const scopes = parseScopeList(params.get("scope"));
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

	return { clientId, redirectUri, codeChallenge, scopes, resource, state };
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
	const resource = params.get("resource");
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
	if ((record.resource ?? null) !== (resource || null)) {
		codeStore.consumeCode(code);
		return invalidOAuthRequest("invalid_grant", "Code does not match resource");
	}

	const issued = tokenStore.issueToken(clientId, now, record.resource, undefined, record.scopes);
	if (!issued) {
		// Token-store overload is transient: leave the auth code unused so the
		// client can retry token exchange without restarting the OAuth flow.
		return invalidOAuthRequest("temporarily_unavailable", "Too many active access tokens");
	}

	const consumed = codeStore.consumeCode(code);
	if (!consumed) {
		tokenStore.revokeToken(issued.token, now);
		// Lost a race with another request that consumed the code in the gap
		// between peek and consume. Treat as invalid_grant rather than issuing
		// a duplicate usable token, since the code is no longer single-use atomic.
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
		if (url.username || url.password || url.hash) return "Invalid redirect URI";
		if (isSupportedHostedConnectorRedirectUrl(url)) continue;
		if (isLoopbackCallbackUrl(url)) continue;
		return "Unsupported redirect URI";
	}
	return null;
}

function isSupportedHostedConnectorRedirectUrl(url: URL): boolean {
	if (url.search !== "") return false;
	if (url.href === CLAUDE_HOSTED_CALLBACK) return true;
	if (url.href === CHATGPT_LEGACY_HOSTED_CALLBACK) return true;
	return url.protocol === "https:" && url.hostname === "chatgpt.com" && isChatGptConnectorPath(url);
}

function isChatGptConnectorPath(url: URL): boolean {
	const pathParts = url.pathname.split("/").filter(Boolean);
	return (
		pathParts.length === 3 &&
		pathParts[0] === "connector" &&
		pathParts[1] === "oauth" &&
		CHATGPT_CONNECTOR_ID.test(pathParts[2] ?? "")
	);
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
		(url.pathname === "/callback" || url.pathname === "/oauth/callback") &&
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

function parseScopeList(scope: string | null | undefined): string[] {
	return (
		scope
			?.split(/\s+/)
			.map((item) => item.trim())
			.filter(Boolean) ?? []
	);
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

function randomToken(): string {
	return randomBytes(ACCESS_TOKEN_BYTES).toString("base64url");
}

function hashSerializedOAuthToken(serialized: string, key: Buffer): string | null {
	const tokenBytes = decodeOAuthAccessToken(serialized);
	if (!tokenBytes) return null;
	return signOAuthToken(tokenBytes, key);
}

function hashOAuthTokenForStateFile(serialized: string): string | null {
	const tokenBytes = decodeOAuthAccessToken(serialized);
	if (!tokenBytes) return null;
	return createHash("sha256").update(tokenBytes).digest("base64url");
}

// Compute the HMAC-SHA256 signature of the binary access-token material using
// the per-store random key. This is an integrity signature over a random
// 256-bit value, not password hashing; tokens are validated by re-signing the
// presented bytes and comparing the digest to the stored signature.
function signOAuthAccessTokenBytes(material: Buffer, key: Buffer): string {
	return signOAuthToken(material, key);
}

function signOAuthToken(material: Buffer | string, key: Buffer): string {
	return createHmac("sha256", key).update(material).digest("base64url");
}

function isSameTokenHash(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isScopeSubset(requested: string[], granted: string[]): boolean {
	const grantedScopes = new Set(granted);
	return requested.every((scope) => grantedScopes.has(scope));
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
