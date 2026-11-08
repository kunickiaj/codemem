import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as nodeRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "@codemem/core";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	Client,
	InMemoryTransport,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import * as toolContent from "./content.js";
import { startCodememMcpHttpServer } from "./http.js";
import { createInMemoryOAuthAccessTokenStore } from "./oauth.js";
import { createCodememMcpServer } from "./server.js";

let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-sdk-modern-"));
	vi.stubEnv("HOME", directory);
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

const modernMeta = {
	[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
	[CLIENT_INFO_META_KEY]: { name: "modern-http-fixture", version: "1" },
	[CLIENT_CAPABILITIES_META_KEY]: {},
};

interface HttpReply {
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
}

function httpRequest(url: string, era: "legacy" | "modern") {
	let id = 0;
	return async (method: string, params: Record<string, unknown> = {}): Promise<HttpReply> => {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (era === "modern") {
			headers["MCP-Protocol-Version"] = "2026-07-28";
			headers["Mcp-Method"] = method;
			if (typeof params.name === "string") headers["Mcp-Name"] = params.name;
		}
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: ++id,
				method,
				params: era === "modern" ? { ...params, _meta: modernMeta } : params,
			}),
		});
		const text = await response.text();
		expect(response.status, text).toBe(200);
		return JSON.parse(
			text.startsWith("event:") ? (text.split("data: ")[1]?.split("\n")[0] ?? "") : text,
		) as HttpReply;
	};
}

async function assertProjectFilters(request: ReturnType<typeof httpRequest>) {
	const remembered = await request("tools/call", {
		name: "memory_remember",
		arguments: {
			kind: "discovery",
			title: "SDK fixture",
			body: "SDK fixture searchable sentinel",
			project: "sdk-project",
		},
	});
	expect(remembered.result?.isError).not.toBe(true);
	const search = await request("tools/call", {
		name: "memory_search",
		arguments: { query: "sentinel", project: "sdk-project" },
	});
	expect(search.result?.structuredContent).toMatchObject({
		items: [{ title: "SDK fixture", confidence: 0.5 }],
	});
	const other = await request("tools/call", {
		name: "memory_search",
		arguments: { query: "sentinel", project: "other-project" },
	});
	expect(other.result?.structuredContent).toEqual({ items: [] });
}

function publicModernSchemaRequest(url: string, authorization?: string) {
	return new Promise<{ status: number | undefined; challenge: string | undefined; text: string }>(
		(resolve, reject) => {
			const request = nodeRequest(
				url,
				{
					method: "POST",
					headers: {
						host: "codemem.example.test",
						origin: "https://codemem.example.test",
						"Content-Type": "application/json",
						Accept: "application/json, text/event-stream",
						"MCP-Protocol-Version": "2026-07-28",
						"Mcp-Method": "tools/call",
						"Mcp-Name": "memory_schema",
						...(authorization ? { authorization } : {}),
					},
				},
				(response) => {
					let text = "";
					response.setEncoding("utf8");
					response.on("data", (chunk: string) => {
						text += chunk;
					});
					response.on("error", reject);
					response.on("end", () =>
						resolve({
							status: response.statusCode,
							challenge: response.headers["www-authenticate"],
							text,
						}),
					);
				},
			);
			request.on("error", reject);
			request.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "memory_schema", arguments: {}, _meta: modernMeta },
				}),
			);
		},
	);
}

it.each(["valid", "missing", "invalid"] as const)(
	"authenticates modern public tool calls with a %s bearer token before dispatch",
	async (credential) => {
		// Arrange: exercise the OAuth adapter on loopback without an external identity provider.
		const tokenStore = createInMemoryOAuthAccessTokenStore();
		const issued = tokenStore.issueToken("modern-http-client");
		if (!issued) throw new Error("expected access token");
		const authorization = {
			valid: `Bearer ${issued.token}`,
			missing: undefined,
			invalid: "Bearer not-a-token",
		}[credential];
		const http = await startCodememMcpHttpServer({
			port: 0,
			dbPath: join(directory, "memory.sqlite"),
			publicUrl: "https://codemem.example.test/mcp",
			oauthAccessTokenStore: tokenStore,
			auditEmitter: () => {},
		});
		// memory_schema calls jsonContent directly, so this observes actual tool execution.
		const dispatch = vi.spyOn(toolContent, "jsonContent");
		try {
			// Act: use the same modern tool request for every authentication outcome.
			const response = await publicModernSchemaRequest(http.url, authorization);

			// Assert: authorization failures must be challenges, never adapter errors or tool calls.
			if (credential !== "valid") {
				expect(response.status, response.text).toBe(401);
				expect(response.challenge).toContain("Bearer");
				expect(response.challenge).toContain("resource_metadata=");
				expect(dispatch).not.toHaveBeenCalled();
				return;
			}
			expect(response.status, response.text).toBe(200);
			const reply = JSON.parse(response.text) as HttpReply;
			expect(reply.error).toBeUndefined();
			expect(reply.result?.isError).not.toBe(true);
			expect(reply.result?.structuredContent).toMatchObject({
				kinds: expect.arrayContaining(["discovery"]),
				fields: { title: "short text" },
			});
			expect(dispatch).toHaveBeenCalledOnce();
		} finally {
			await http.close();
		}
	},
);

it.each(["legacy", "modern"] as const)(
	"serves real %s HTTP discovery and tool calls with recovery after errors",
	async (era) => {
		const http = await startCodememMcpHttpServer({
			port: 0,
			dbPath: join(directory, "memory.sqlite"),
		});
		const request = httpRequest(http.url, era);
		try {
			if (era === "modern") {
				expect((await request("server/discover")).result?.supportedVersions).toEqual([
					"2026-07-28",
				]);
			} else {
				expect(
					(
						await request("initialize", {
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "legacy-http-fixture", version: "1" },
						})
					).result?.protocolVersion,
				).toBe("2025-11-25");
			}
			expect((await request("tools/list")).result?.tools).toHaveLength(14);
			expect(
				(await request("tools/call", { name: "no_such_tool", arguments: {} })).error?.code,
			).toBe(-32602);
			expect(
				(await request("tools/call", { name: "memory_get", arguments: { memory_id: "bad" } }))
					.result?.isError,
			).toBe(true);
			const result = await request("tools/call", { name: "memory_schema", arguments: {} });
			expect(result.result?.structuredContent).toMatchObject({
				kinds: expect.arrayContaining(["discovery"]),
			});
			await assertProjectFilters(request);
			const metadata = await fetch(
				http.url.replace("/mcp", "/.well-known/oauth-authorization-server"),
			);
			expect(await metadata.json()).toMatchObject({
				authorization_response_iss_parameter_supported: false,
			});
		} finally {
			await http.close();
		}
	},
);

it("preserves modern request metadata and cancellation, and constructs one server for repeated discovery", async () => {
	const store = new MemoryStore(join(directory, "memory.sqlite"));
	const server = createCodememMcpServer(store);
	const entered = Promise.withResolvers<void>();
	const cancelled = Promise.withResolvers<void>();
	server.registerTool("context_probe", { inputSchema: z.object({}) }, async (_args, ctx) => {
		expect(ctx.mcpReq._meta).toMatchObject({ "fixture/custom": "preserved" });
		expect(ctx.mcpReq._meta).not.toHaveProperty(PROTOCOL_VERSION_META_KEY);
		expect(ctx.mcpReq.envelope).toHaveProperty(PROTOCOL_VERSION_META_KEY, "2026-07-28");
		expect(ctx.mcpReq.id).toBeDefined();
		entered.resolve();
		await new Promise<void>((resolve) =>
			ctx.mcpReq.signal.addEventListener(
				"abort",
				() => {
					cancelled.resolve();
					resolve();
				},
				{ once: true },
			),
		);
		return { content: [{ type: "text", text: "cancelled" }] };
	});
	const factory = vi.fn(() => server);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const handle = serveStdio(factory, { transport: serverTransport, legacy: "serve" });
	const client = new Client(
		{ name: "context-fixture", version: "1" },
		{
			versionNegotiation: { mode: { pin: "2026-07-28" } },
		},
	);
	try {
		await client.connect(clientTransport);
		await client.discover();
		await client.discover();
		expect(factory).toHaveBeenCalledOnce();
		const abort = new AbortController();
		const call = client.callTool(
			{ name: "context_probe", arguments: {}, _meta: { "fixture/custom": "preserved" } },
			{ signal: abort.signal },
		);
		const rejected = expect(call).rejects.toThrow();
		await entered.promise;
		abort.abort(new Error("fixture cancellation"));
		await rejected;
		await cancelled.promise;
		expect((await client.callTool({ name: "memory_schema", arguments: {} })).isError).not.toBe(
			true,
		);
	} finally {
		await client.close();
		await handle.close();
		await store.closeAsync();
	}
}, 10_000);

it("keeps custom-callback issuer support unadvertised while SDK authorization errors include iss", async () => {
	vi.stubEnv("CODEMEM_MCP_OIDC_ISSUER_URL", "");
	const http = await startCodememMcpHttpServer({
		port: 0,
		dbPath: join(directory, "memory.sqlite"),
		publicUrl: "https://codemem.example.test/mcp",
		auditEmitter: () => {},
	});
	const base = http.url.replace("/mcp", "");
	const callback = "https://claude.ai/api/mcp/auth_callback";
	try {
		const registration = await fetch(`${base}/register`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ redirect_uris: [callback], token_endpoint_auth_method: "none" }),
		});
		expect(registration.status).toBe(201);
		const client = (await registration.json()) as { client_id: string };
		const authorize = new URL(`${base}/authorize`);
		authorize.search = new URLSearchParams({
			client_id: client.client_id,
			redirect_uri: callback,
			response_type: "code",
			code_challenge_method: "S256",
			state: "fixture-state",
			code_challenge: createHash("sha256").update("d".repeat(43)).digest("base64url"),
		}).toString();
		const response = await fetch(authorize, { redirect: "manual" });
		expect(response.status).toBe(302);
		const redirected = new URL(response.headers.get("location") ?? "");
		expect(redirected.searchParams.get("error")).toBe("temporarily_unavailable");
		expect(redirected.searchParams.get("state")).toBe("fixture-state");
		expect(redirected.searchParams.get("iss")).toBe("https://codemem.example.test/");
		const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
		expect(await metadata.json()).toMatchObject({
			authorization_response_iss_parameter_supported: false,
		});
	} finally {
		await http.close();
	}
});
