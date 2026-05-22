import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CodememMcpHttpServer,
	DEFAULT_MCP_HTTP_HOST,
	DEFAULT_MCP_HTTP_PORT,
	isAllowedMcpHttpRequestHost,
	isAllowedMcpHttpRequestOrigin,
	isUnsafePublicBindAllowed,
	parseMcpHttpPort,
	startCodememMcpHttpServer,
	validateMcpHttpHost,
} from "./http.js";

const servers: CodememMcpHttpServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("MCP HTTP transport", () => {
	it("defaults to loopback host and validates host values", () => {
		expect(validateMcpHttpHost(undefined)).toBe(DEFAULT_MCP_HTTP_HOST);
		expect(validateMcpHttpHost("localhost")).toBe("localhost");
		expect(validateMcpHttpHost("::1")).toBe("::1");
		expect(() => validateMcpHttpHost("http://127.0.0.1")).toThrow(/Invalid MCP HTTP host/);
		expect(() => validateMcpHttpHost("127.0.0.1/mcp")).toThrow(/Invalid MCP HTTP host/);
		expect(() => validateMcpHttpHost("0.0.0.0")).toThrow(/Refusing unsafe MCP HTTP host/);
		expect(() => validateMcpHttpHost("192.168.1.10")).toThrow(/Refusing unsafe MCP HTTP host/);
		expect(validateMcpHttpHost("0.0.0.0", true)).toBe("0.0.0.0");
	});

	it("parses the explicit unsafe public bind switch", () => {
		expect(isUnsafePublicBindAllowed("1")).toBe(true);
		expect(isUnsafePublicBindAllowed("true")).toBe(true);
		expect(isUnsafePublicBindAllowed("yes")).toBe(true);
		expect(isUnsafePublicBindAllowed("0")).toBe(false);
	});

	it("allows only loopback Host and Origin headers for the selected port", () => {
		expect(isAllowedMcpHttpRequestHost("127.0.0.1:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("localhost:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("[::1]:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("evil.test:38889", 38889)).toBe(false);
		expect(isAllowedMcpHttpRequestHost("127.0.0.1:38888", 38889)).toBe(false);

		expect(isAllowedMcpHttpRequestOrigin(undefined, 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestOrigin("http://localhost:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestOrigin("http://[::1]:38889", 38889)).toBe(true);
		expect(isAllowedMcpHttpRequestOrigin("http://evil.test:38889", 38889)).toBe(false);
		expect(isAllowedMcpHttpRequestOrigin("http://localhost:38888", 38889)).toBe(false);
		expect(isAllowedMcpHttpRequestOrigin("http://localhost:38889/path", 38889)).toBe(false);
	});

	it("accepts loopback Host headers without an explicit port when bound to HTTP default (PR 1120 P2 regression)", () => {
		// RFC-compliant clients may send `Host: localhost` (no `:port`) when the
		// server listens on port 80. Reject anything that is not loopback or that
		// would inherit a default port other than the bound one.
		expect(isAllowedMcpHttpRequestHost("localhost", 80)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("127.0.0.1", 80)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("[::1]", 80)).toBe(true);
		expect(isAllowedMcpHttpRequestHost("evil.test", 80)).toBe(false);
		expect(isAllowedMcpHttpRequestHost("localhost", 38889)).toBe(false);
	});

	it("defaults and validates port values", () => {
		expect(parseMcpHttpPort(undefined)).toBe(DEFAULT_MCP_HTTP_PORT);
		expect(parseMcpHttpPort("0")).toBe(0);
		expect(parseMcpHttpPort(38889)).toBe(38889);
		expect(() => parseMcpHttpPort("abc")).toThrow(/Invalid MCP HTTP port/);
		expect(() => parseMcpHttpPort(65_536)).toThrow(/Invalid MCP HTTP port/);
	});

	it("exposes only POST /mcp", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const getResponse = await fetch(server.url);
		expect(getResponse.status).toBe(405);
		expect(getResponse.headers.get("allow")).toBe("POST");

		const missingResponse = await fetch(server.url.replace("/mcp", "/health"), { method: "POST" });
		expect(missingResponse.status).toBe(404);
	});

	it("handles repeated MCP initialize requests over POST", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const first = await initialize(server.url, 1);
		const second = await initialize(server.url, 2);

		expect(first.result?.serverInfo?.name).toBe("codemem");
		expect(second.result?.serverInfo?.name).toBe("codemem");
	});

	it("rejects browser requests from non-loopback origins", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const response = await fetch(server.url, {
			method: "POST",
			headers: {
				accept: "application/json, text/event-stream",
				"content-type": "application/json",
				origin: "http://evil.test",
			},
			body: initializeBody(1),
		});

		expect(response.status).toBe(403);
	});

	it("rejects requests with non-loopback Host headers", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		servers.push(server);

		const response = await postWithHost(server.url, "evil.test:38889");
		expect(response.statusCode).toBe(403);
	});

	it("closes idempotently", async () => {
		const server = await startCodememMcpHttpServer({ dbPath: tempDbPath(), port: 0 });
		await Promise.all([server.close(), server.close()]);
	});
});

async function initialize(
	url: string,
	id: number,
): Promise<{ result?: { serverInfo?: { name?: string } } }> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
		},
		body: initializeBody(id),
	});

	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	return parseSseJson(await response.text()) as { result?: { serverInfo?: { name?: string } } };
}

function initializeBody(id: number): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id,
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "codemem-test", version: "0.0.0" },
		},
	});
}

function parseSseJson(body: string): unknown {
	const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
	if (!dataLine) throw new Error(`Missing SSE data line: ${body}`);
	return JSON.parse(dataLine.slice("data: ".length));
}

async function postWithHost(
	url: string,
	host: string,
): Promise<{ statusCode: number | undefined }> {
	const target = new URL(url);
	return await new Promise((resolve, reject) => {
		const req = request(
			{
				hostname: target.hostname,
				port: target.port,
				path: target.pathname,
				method: "POST",
				headers: {
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					host,
				},
			},
			(res) => {
				res.resume();
				res.on("end", () => resolve({ statusCode: res.statusCode }));
			},
		);
		req.on("error", reject);
		req.end(initializeBody(1));
	});
}

function tempDbPath(): string {
	return join(mkdtempSync(join(tmpdir(), "codemem-mcp-http-")), "mem.sqlite");
}
