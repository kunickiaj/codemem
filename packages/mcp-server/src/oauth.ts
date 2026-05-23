import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import {
	type OAuthClientInformationFull,
	type OAuthClientMetadata,
	OAuthClientMetadataSchema,
	type OAuthMetadata,
	type OAuthProtectedResourceMetadata,
	OAuthProtectedResourceMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const MCP_OAUTH_PUBLIC_URL_ENV = "CODEMEM_MCP_HTTP_PUBLIC_URL";
export const MCP_OAUTH_RESOURCE_NAME = "codemem MCP";

const CLAUDE_HOSTED_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const LOCAL_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const SUPPORTED_GRANT_TYPES = new Set(["authorization_code"]);
const SUPPORTED_RESPONSE_TYPES = new Set(["code"]);

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

export function createInMemoryOAuthClientsStore(): OAuthRegisteredClientsStore {
	return new InMemoryOAuthClientsStore();
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
