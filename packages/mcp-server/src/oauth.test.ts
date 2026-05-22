import { describe, expect, it } from "vitest";
import {
	createInMemoryOAuthClientsStore,
	createMcpOAuthMetadata,
	createMcpProtectedResourceMetadata,
	normalizeMcpPublicUrl,
	registerMcpOAuthClient,
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
});
