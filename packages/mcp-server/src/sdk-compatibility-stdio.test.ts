import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const protocolVersion = "2025-11-25";
const deadlineMs = 15_000;

type ToolResult = {
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
};
type Reply = {
	jsonrpc: string;
	id: number;
	result?: Record<string, unknown>;
	error?: { code: number; message: string };
};

function startFixture() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-sdk-stdio-"));
	const config = join(directory, "config.json");
	writeFileSync(config, "{}");
	// Match the source CLI runner's source condition without a pnpm/tsx wrapper
	// process, so final cleanup owns exactly the process serving the protocol.
	const child = spawn(
		process.execPath,
		[
			"--require",
			join(import.meta.dirname, "sdk-compatibility-no-network.cjs"),
			"--import",
			resolve(workspaceRoot, "node_modules/tsx/dist/loader.mjs"),
			"--conditions",
			"source",
			resolve(workspaceRoot, "packages/cli/src/index.ts"),
			"mcp",
			"--db-path",
			join(directory, "memory.sqlite"),
		],
		{
			cwd: directory,
			stdio: "pipe",
			env: {
				PATH: process.env.PATH,
				HOME: directory,
				XDG_CONFIG_HOME: directory,
				XDG_DATA_HOME: directory,
				XDG_CACHE_HOME: directory,
				CODEMEM_CONFIG: config,
				CODEMEM_EMBEDDING_DISABLED: "1",
				CODEMEM_VIEWER: "0",
			},
		},
	);
	let stderr = "";
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolveExit) => {
		child.once("close", (code, signal) => resolveExit({ code, signal }));
	});
	// Bound the whole conversation as well as each request, below Vitest's deadline.
	const lifetime = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<Reply>>>();
	const protocolFailures: string[] = [];
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		try {
			const reply = JSON.parse(line) as Reply;
			if (reply.jsonrpc !== "2.0") protocolFailures.push(line);
			pending.get(reply.id)?.resolve(reply);
		} catch {
			protocolFailures.push(line);
		}
	});
	child.on("error", (error) => {
		for (const response of pending.values()) response.reject(error);
	});
	child.stdin.on("error", (error) => {
		for (const response of pending.values()) response.reject(error);
	});
	void exited.then(({ code, signal }) => {
		clearTimeout(lifetime);
		for (const response of pending.values()) {
			response.reject(new Error(`MCP exited (${code}, ${signal}): ${stderr}`));
		}
	});
	let nextId = 0;
	const notify = (method: string) => {
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
	};
	const request = async (method: string, params: Record<string, unknown> = {}) => {
		const id = ++nextId;
		const response = Promise.withResolvers<Reply>();
		pending.set(id, response);
		const timeout = setTimeout(() => {
			response.reject(new Error(`MCP ${method} timed out: ${stderr}`));
		}, deadlineMs);
		try {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
			return await response.promise;
		} finally {
			clearTimeout(timeout);
			pending.delete(id);
		}
	};
	return {
		request,
		async initialize() {
			const reply = await request("initialize", {
				protocolVersion,
				capabilities: {},
				clientInfo: { name: "sdk-compatibility-fixture", version: "1.0.0" },
			});
			notify("notifications/initialized");
			return reply;
		},
		async closeInput() {
			child.stdin.end();
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				return await Promise.race([
					exited,
					new Promise<never>((_, reject) => {
						timeout = setTimeout(() => reject(new Error(`MCP did not exit: ${stderr}`)), 5_000);
					}),
				]);
			} finally {
				clearTimeout(timeout);
			}
		},
		protocolFailures,
		async dispose() {
			// Kill only this fixture, including when an assertion or request fails.
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
			lines.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

it("negotiates legacy stdio through the source CLI, lists tools, calls one, and exits on EOF", async () => {
	// Arrange: raw protocol messages keep this acceptance test independent of SDK imports.
	const fixture = startFixture();
	try {
		// Act
		const initialized = await fixture.initialize();
		const listed = await fixture.request("tools/list");
		const called = await fixture.request("tools/call", { name: "memory_schema", arguments: {} });
		const exit = await fixture.closeInput();

		// Assert: focus on the process boundary. Full schema parity lives in tool-contract-parity.
		expect(initialized.error).toBeUndefined();
		expect(initialized.result).toMatchObject({ protocolVersion, capabilities: { tools: {} } });
		expect(listed.result?.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "memory_schema" })]),
		);
		expect(called.error).toBeUndefined();
		const result = called.result as ToolResult;
		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.type).toBe("text");
		expect(result.structuredContent).toEqual(JSON.parse(result.content[0]?.text ?? ""));
		expect(result.structuredContent?.kinds).toEqual(expect.arrayContaining(["discovery"]));
		expect(exit).toEqual({ code: 0, signal: null });
		expect(fixture.protocolFailures).toEqual([]);
	} finally {
		await fixture.dispose();
	}
}, 30_000);

it.each([
	{ label: "invalid arguments", name: "memory_get", arguments: { memory_id: "invalid" } },
	{ label: "unknown tool", name: "no_such_tool", arguments: {} },
	{ label: "missing memory", name: "memory_get", arguments: { memory_id: 999_999 } },
])(
	"returns a text tool error for $label and keeps the stdio session usable",
	async (input) => {
		// Arrange
		const fixture = startFixture();
		try {
			await fixture.initialize();
			await fixture.request("tools/list");

			// Act: the next valid call must still work after the rejected call.
			const failed = await fixture.request("tools/call", {
				name: input.name,
				arguments: input.arguments,
			});
			const recovered = await fixture.request("tools/call", {
				name: "memory_schema",
				arguments: {},
			});
			const exit = await fixture.closeInput();

			// Assert: tool errors stay in the result envelope rather than JSON-RPC errors.
			expect(failed.error).toBeUndefined();
			expect(failed.result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: expect.any(String) }],
			});
			expect(failed.result?.structuredContent).toBeUndefined();
			expect(recovered.error).toBeUndefined();
			expect(recovered.result?.isError).not.toBe(true);
			expect(recovered.result?.structuredContent).toHaveProperty("kinds");
			expect(exit).toEqual({ code: 0, signal: null });
			expect(fixture.protocolFailures).toEqual([]);
		} finally {
			await fixture.dispose();
		}
	},
	30_000,
);
