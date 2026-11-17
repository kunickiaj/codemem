import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, initTestSchema, MemoryStore, queryRetrievalAttempts } from "@codemem/core";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CALLER_ARGUMENT, CALLER_CONTEXT_REQUIRED_ERROR } from "./caller-context.js";
import { createCodememMcpServer } from "./server.js";
import type { CodememMcpServerOptions } from "./tool-context.js";

const ENV_KEYS = ["CODEMEM_CONFIG", "CODEMEM_EMBEDDING_DISABLED", "HOME", "CODEMEM_PROJECT"];
const savedEnv: Record<string, string | undefined> = {};

let store: MemoryStore;
let tempDirectory: string;
let alpha: string;
let beta: string;
let poolDirectory: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	tempDirectory = mkdtempSync(join(tmpdir(), "codemem-caller-context-"));
	alpha = join(tempDirectory, "alpha");
	beta = join(tempDirectory, "beta");
	poolDirectory = join(tempDirectory, "pool");
	for (const directory of [alpha, beta, poolDirectory]) mkdirSync(directory);
	process.env.CODEMEM_CONFIG = join(tempDirectory, "config.json");
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	process.env.HOME = tempDirectory;
	// The shared process has its own directory and project override. Neither
	// may reach a call that names a different caller.
	process.env.CODEMEM_PROJECT = "pool-env-project";
	vi.spyOn(process, "cwd").mockReturnValue(poolDirectory);

	const databasePath = join(tempDirectory, "memory.sqlite");
	const database = connect(databasePath);
	initTestSchema(database);
	database.close();
	store = new MemoryStore(databasePath);
});

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	store.close();
	vi.restoreAllMocks();
	rmSync(tempDirectory, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

async function connectClient(
	options: CodememMcpServerOptions = { callerContext: "required" },
	configure: (server: McpServer) => void = () => {},
) {
	const server = createCodememMcpServer(store, options);
	configure(server);
	const client = new Client({ name: "caller-context-test", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	closers.push(async () => {
		await client.close();
		await server.close();
	});
	return client;
}

let nextRequest = 0;
function callerOf(directory: string, overrides: Record<string, unknown> = {}) {
	nextRequest += 1;
	return {
		directory,
		env_project: null,
		session_id: `ses_${directory.split("/").at(-1)}`,
		request_id: `call_${nextRequest}`,
		...overrides,
	};
}

type ToolReply = { isError?: boolean; structuredContent?: Record<string, unknown> } & {
	content: Array<{ type: string; text?: string }>;
};

async function call(client: Client, name: string, args: Record<string, unknown>, caller?: unknown) {
	const stamped = caller === undefined ? args : { ...args, [CALLER_ARGUMENT]: caller };
	return (await client.callTool({ name, arguments: stamped })) as ToolReply;
}

const errorOf = (reply: ToolReply) => JSON.parse(reply.content[0]?.text ?? "{}").error;
const titlesOf = (reply: ToolReply) => {
	const items = (reply.structuredContent?.items ?? []) as Array<{ title: string }>;
	return items.map((item) => item.title);
};

async function rememberIn(client: Client, directory: string, title: string) {
	const reply = await call(
		client,
		"memory_remember",
		{
			kind: "decision",
			title,
			body: `${title} sentinel body`,
			project: directory.split("/").at(-1),
		},
		callerOf(directory),
	);
	return reply.structuredContent?.id as number;
}

function sessionOf(memoryId: number) {
	return store.db
		.prepare(
			"SELECT sessions.cwd AS cwd, sessions.project AS project FROM memory_items JOIN sessions ON sessions.id = memory_items.session_id WHERE memory_items.id = ?",
		)
		.get(memoryId) as { cwd: string; project: string | null };
}

describe("required caller context", () => {
	it("rejects a call that carries no caller instead of using the process directory", async () => {
		const client = await connectClient();

		for (const [name, args] of [
			["memory_search", { query: "sentinel" }],
			["memory_remember", { kind: "decision", title: "No caller", body: "Must not be stored." }],
			["memory_get", { memory_id: 1 }],
			["memory_schema", {}],
		] as const) {
			const reply = await call(client, name, args);
			expect(reply.isError, name).toBe(true);
			expect(errorOf(reply), name).toBe(CALLER_CONTEXT_REQUIRED_ERROR);
		}
		expect(store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({
			count: 0,
		});
	});

	it("rejects a caller whose directory is not absolute", async () => {
		const client = await connectClient();

		const attempt = call(client, "memory_schema", {}, callerOf("relative/alpha"));

		await expect(
			attempt.then((reply) => {
				if (reply.isError) throw new Error(reply.content[0]?.text);
			}),
		).rejects.toThrow(/absolute/);
	});

	it("scopes default reads to each caller's project on one shared connection", async () => {
		const client = await connectClient();
		await rememberIn(client, alpha, "Alpha memory");
		await rememberIn(client, beta, "Beta memory");

		const [fromAlpha, fromBeta] = await Promise.all([
			call(client, "memory_search", { query: "sentinel" }, callerOf(alpha)),
			call(client, "memory_search", { query: "sentinel" }, callerOf(beta)),
		]);

		expect(titlesOf(fromAlpha)).toEqual(["Alpha memory"]);
		expect(titlesOf(fromBeta)).toEqual(["Beta memory"]);
	});

	it("records the caller's directory and project override on a write", async () => {
		const client = await connectClient();

		const plain = await call(
			client,
			"memory_remember",
			{ kind: "decision", title: "Plain write", body: "No override." },
			callerOf(alpha),
		);
		const overridden = await call(
			client,
			"memory_remember",
			{ kind: "decision", title: "Override write", body: "Caller override." },
			callerOf(beta, { env_project: "beta-override" }),
		);

		expect(sessionOf(plain.structuredContent?.id as number)).toEqual({ cwd: alpha, project: null });
		expect(sessionOf(overridden.structuredContent?.id as number)).toEqual({
			cwd: beta,
			project: "beta-override",
		});
	});

	it("uses the caller's project override for default reads", async () => {
		const client = await connectClient();
		await rememberIn(client, alpha, "Alpha memory");

		const reply = await call(
			client,
			"memory_search",
			{ query: "sentinel" },
			callerOf(beta, { env_project: "alpha" }),
		);

		expect(titlesOf(reply)).toEqual(["Alpha memory"]);
	});

	it("records a redelivered call once and separate calls separately, under the host session", async () => {
		const client = await connectClient();
		await rememberIn(client, alpha, "Alpha memory");
		const first = callerOf(alpha, { request_id: "call_a:0" });

		await call(client, "memory_search", { query: "sentinel" }, first);
		await call(client, "memory_search", { query: "sentinel" }, first);
		await call(
			client,
			"memory_search",
			{ query: "sentinel" },
			{ ...first, request_id: "call_a:1" },
		);

		const attempts = queryRetrievalAttempts(store.db, { surface: "mcp_search" });
		expect(attempts).toHaveLength(2);
		expect(new Set(attempts.map((attempt) => attempt.streamId))).toEqual(new Set(["ses_alpha"]));
	});

	it("declares the caller argument only when it is required", async () => {
		const required = await connectClient();
		const privateClient = await connectClient({});

		const declares = async (client: Client) =>
			(await client.listTools()).tools.map(
				(tool) => CALLER_ARGUMENT in (tool.inputSchema.properties ?? {}),
			);

		expect(new Set(await declares(required))).toEqual(new Set([true]));
		expect(new Set(await declares(privateClient))).toEqual(new Set([false]));
	});

	it("leaves a private connection on the process directory", async () => {
		const client = await connectClient({});
		delete process.env.CODEMEM_PROJECT;

		const reply = await call(client, "memory_remember", {
			kind: "decision",
			title: "Private write",
			body: "Process directory.",
		});

		expect(sessionOf(reply.structuredContent?.id as number).cwd).toBe(poolDirectory);
	});
});

describe("calls sharing one connection", () => {
	it("cancels one caller's call without disturbing another caller on the same connection", async () => {
		const entered = Promise.withResolvers<void>();
		const cancelled = Promise.withResolvers<void>();
		const client = await connectClient({ callerContext: "required" }, (server) => {
			server.registerTool("slow_probe", { inputSchema: z.object({}) }, async (_args, ctx) => {
				entered.resolve();
				await new Promise<void>((resolve) =>
					ctx.mcpReq.signal.addEventListener("abort", () => resolve(), { once: true }),
				);
				cancelled.resolve();
				return { content: [{ type: "text" as const, text: "cancelled" }] };
			});
		});
		await rememberIn(client, alpha, "Alpha memory");
		await rememberIn(client, beta, "Beta memory");
		const abort = new AbortController();
		const slow = client.callTool(
			{ name: "slow_probe", arguments: { [CALLER_ARGUMENT]: callerOf(alpha) } },
			{ signal: abort.signal },
		);
		const rejected = expect(slow).rejects.toThrow();
		await entered.promise;

		const whileBlocked = await call(client, "memory_search", { query: "sentinel" }, callerOf(beta));
		abort.abort(new Error("caller cancelled"));
		await rejected;
		await cancelled.promise;
		const afterCancel = await call(client, "memory_search", { query: "sentinel" }, callerOf(alpha));

		expect(titlesOf(whileBlocked)).toEqual(["Beta memory"]);
		expect(titlesOf(afterCancel)).toEqual(["Alpha memory"]);
	});
});
