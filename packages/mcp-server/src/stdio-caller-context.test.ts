import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CALLER_ARGUMENT, CALLER_CONTEXT_REQUIRED_ERROR } from "./caller-context.js";

const workspace = resolve(import.meta.dirname, "../../..");
let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-stdio-caller-"));
	for (const name of ["pool", "alpha", "beta"]) mkdirSync(join(directory, name));
	writeFileSync(join(directory, "config.json"), "{}");
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function serverCommand(extraArgs: string[], extraEnv: Record<string, string> = {}) {
	return {
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
			...extraArgs,
		],
		cwd: join(directory, "pool"),
		env: {
			PATH: process.env.PATH ?? "",
			HOME: directory,
			XDG_CONFIG_HOME: directory,
			XDG_DATA_HOME: directory,
			XDG_CACHE_HOME: directory,
			CODEMEM_CONFIG: join(directory, "config.json"),
			CODEMEM_EMBEDDING_DISABLED: "1",
			CODEMEM_VIEWER: "0",
			...extraEnv,
		},
	};
}

type Reply = { isError?: boolean; content: Array<{ text?: string }> };

it("serves two directories from one modern stdio process started with --caller-context required", async () => {
	const client = new Client(
		{ name: "pooled-fixture", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(
		new StdioClientTransport({
			...serverCommand(["--caller-context", "required"]),
			stderr: "pipe",
		}),
	);
	const call = async (name: string, args: Record<string, unknown>, caller?: string) => {
		const stamp = caller && {
			directory: join(directory, caller),
			env_project: null,
			session_id: `ses_${caller}`,
			request_id: `call_${caller}_${name}`,
		};
		const stamped = stamp ? { ...args, [CALLER_ARGUMENT]: stamp } : args;
		const reply = (await client.callTool({ name, arguments: stamped })) as Reply;
		return { isError: reply.isError === true, text: reply.content[0]?.text ?? "" };
	};
	try {
		for (const project of ["alpha", "beta"]) {
			const args = { kind: "decision", title: `${project} memory`, body: "sentinel", project };
			expect((await call("memory_remember", args, project)).isError).toBe(false);
		}

		const fromAlpha = await call("memory_search", { query: "sentinel" }, "alpha");
		const fromBeta = await call("memory_search", { query: "sentinel" }, "beta");
		const unstamped = await call("memory_search", { query: "sentinel" });

		expect(fromAlpha.text).toContain("alpha memory");
		expect(fromAlpha.text).not.toContain("beta memory");
		expect(fromBeta.text).toContain("beta memory");
		expect(fromBeta.text).not.toContain("alpha memory");
		expect(unstamped).toEqual({
			isError: true,
			text: JSON.stringify({ error: CALLER_CONTEXT_REQUIRED_ERROR }),
		});
	} finally {
		await client.close();
	}
}, 60_000);

it("refuses to start when the caller-context setting is not recognized", () => {
	const { command, args, cwd, env } = serverCommand([], { CODEMEM_MCP_CALLER_CONTEXT: "pooled" });

	const result = spawnSync(command, args, {
		cwd,
		env,
		input: "",
		encoding: "utf8",
		timeout: 30_000,
	});

	expect(result.status).toBe(1);
	expect(result.stderr).toContain("CODEMEM_MCP_CALLER_CONTEXT");
}, 60_000);
