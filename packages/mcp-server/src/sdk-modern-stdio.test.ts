import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	type JSONRPCMessage,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

const workspace = resolve(import.meta.dirname, "../../..");
const modernMeta = {
	[PROTOCOL_VERSION_META_KEY]: "2026-07-28",
	[CLIENT_INFO_META_KEY]: { name: "modern-compatibility-fixture", version: "1" },
	[CLIENT_CAPABILITIES_META_KEY]: {},
};
type Reply = { result?: Record<string, unknown>; error?: { code: number; message: string } };

async function startFixture() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-modern-stdio-"));
	const config = join(directory, "config.json");
	writeFileSync(config, "{}");
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [
			"--require",
			join(import.meta.dirname, "sdk-compatibility-no-network.cjs"),
			"--import",
			resolve(workspace, "node_modules/tsx/dist/loader.mjs"),
			"--conditions",
			"source",
			resolve(workspace, "packages/cli/src/index.ts"),
			"mcp",
			"--db-path",
			join(directory, "memory.sqlite"),
		],
		cwd: directory,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: directory,
			XDG_CONFIG_HOME: directory,
			XDG_DATA_HOME: directory,
			XDG_CACHE_HOME: directory,
			CODEMEM_CONFIG: config,
			CODEMEM_EMBEDDING_DISABLED: "1",
			CODEMEM_VIEWER: "0",
		},
		stderr: "pipe",
	});
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
	transport.onmessage = (message: JSONRPCMessage) => {
		if ("id" in message && typeof message.id === "number") {
			pending.get(message.id)?.resolve(message as Reply);
		}
	};
	transport.onerror = (error) => {
		for (const response of pending.values()) response.reject(error);
	};
	await transport.start();
	let id = 0;
	return {
		async request(
			method: string,
			params: Record<string, unknown> = {},
			options: { legacy?: boolean } = {},
		) {
			const requestId = ++id;
			const response = Promise.withResolvers<Reply>();
			pending.set(requestId, response);
			const timeout = setTimeout(() => response.reject(new Error(`${method} timed out`)), 15_000);
			try {
				await transport.send({
					jsonrpc: "2.0",
					id: requestId,
					method,
					params: options.legacy ? params : { ...params, _meta: modernMeta },
				});
				return await response.promise;
			} finally {
				clearTimeout(timeout);
				pending.delete(requestId);
			}
		},
		async close() {
			await transport.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

it("serves repeated modern discovery and calls, preserves tool errors, and recovers from an unknown tool", async () => {
	const fixture = await startFixture();
	try {
		const first = await fixture.request("server/discover");
		const repeated = await fixture.request("server/discover");
		expect(first.error).toBeUndefined();
		expect(first.result).toEqual(repeated.result);
		expect(first.result).toMatchObject({ supportedVersions: ["2026-07-28"] });
		const listed = await fixture.request("tools/list");
		expect(listed.result?.tools).toHaveLength(14);
		const unknown = await fixture.request("tools/call", { name: "no_such_tool", arguments: {} });
		expect(unknown.error).toMatchObject({ code: -32602 });
		const invalid = await fixture.request("tools/call", {
			name: "memory_get",
			arguments: { memory_id: "bad" },
		});
		expect(invalid.error).toBeUndefined();
		expect(invalid.result?.isError).toBe(true);
		const missing = await fixture.request("tools/call", {
			name: "memory_get",
			arguments: { memory_id: 999_999 },
		});
		expect(missing.error).toBeUndefined();
		expect(missing.result?.isError).toBe(true);
		const schema = await fixture.request("tools/call", { name: "memory_schema", arguments: {} });
		expect(schema.error).toBeUndefined();
		expect(schema.result?.structuredContent).toHaveProperty("kinds");
	} finally {
		await fixture.close();
	}
}, 30_000);

it("falls back to legacy initialize on the same connection after a modern discovery probe", async () => {
	const fixture = await startFixture();
	try {
		expect((await fixture.request("server/discover")).error).toBeUndefined();
		const initialized = await fixture.request(
			"initialize",
			{
				protocolVersion: "2025-11-25",
				capabilities: {},
				clientInfo: { name: "fallback-fixture", version: "1" },
			},
			{ legacy: true },
		);
		expect(initialized.result).toMatchObject({ protocolVersion: "2025-11-25" });
		const result = await fixture.request(
			"tools/call",
			{ name: "memory_schema", arguments: {} },
			{ legacy: true },
		);
		expect(result.error).toBeUndefined();
		expect(result.result?.structuredContent).toHaveProperty("kinds");
	} finally {
		await fixture.close();
	}
}, 30_000);
