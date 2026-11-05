/**
 * `codemem memory-tool <name>` — hidden plumbing for thin hosts.
 *
 * Runs one codemem memory tool in-process through the same handlers stdio MCP
 * uses, reading the tool arguments as a JSON object on stdin and printing one
 * JSON line on stdout:
 *
 *   {"ok":true,"result":<tool result>}
 *   {"ok":false,"error":"<message>","result":<tool error payload>}   exit 0
 *   {"ok":false,"error":"<code>","message":"<detail>"}                exit 1
 *
 * Exit 0 means the tool ran (its own error included); exit 1 means the
 * invocation itself was invalid or the store could not be opened. The caller's
 * working directory supplies the default project, write-session cwd, and
 * AGENTS.md context exactly as it does for `codemem mcp`.
 */

import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import { addDbOption, type DbOpts, resolveDbOpt } from "../shared-options.js";

const MEMORY_TOOL_NAME = /^memory_[a-z_]+$/;

interface MemoryToolOptions extends DbOpts {
	sessionId?: string;
	requestId?: string;
}

export interface MemoryToolDependencies {
	readStdin?: () => Promise<string>;
	write?: (line: string) => void;
}

async function readProcessStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf-8");
}

/** Empty stdin means no arguments; anything else must be a JSON object. */
export function parseToolArguments(raw: string): Record<string, unknown> {
	const trimmed = raw.trim();
	if (!trimmed) return {};
	const parsed: unknown = JSON.parse(trimmed);
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new TypeError("tool arguments must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function invocationError(write: (line: string) => void, error: string, message: string): void {
	write(JSON.stringify({ ok: false, error, message }));
	process.exitCode = 1;
}

export async function runMemoryTool(
	name: string,
	opts: MemoryToolOptions,
	dependencies: MemoryToolDependencies = {},
): Promise<void> {
	const write = dependencies.write ?? ((line: string) => console.log(line));
	if (!MEMORY_TOOL_NAME.test(name)) {
		invocationError(write, "invalid_tool", `not a memory tool: ${name}`);
		return;
	}
	let args: Record<string, unknown>;
	try {
		args = parseToolArguments(await (dependencies.readStdin ?? readProcessStdin)());
	} catch (err) {
		invocationError(write, "invalid_arguments", err instanceof Error ? err.message : String(err));
		return;
	}
	let store: MemoryStore | null = null;
	try {
		// Lazy: every codemem command loads the command tree, and only this one
		// needs the MCP SDK and tool modules.
		const { callCodememToolLocally } = await import("@codemem/mcp");
		store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		const outcome = await callCodememToolLocally(store, name, args, {
			sessionId: opts.sessionId?.trim() || undefined,
			requestId: opts.requestId?.trim() || undefined,
			// Same ledger identity as the viewer route, so a host call retried
			// through this fallback after a lost viewer response records once.
			statelessLedger: true,
		});
		write(JSON.stringify(outcome));
	} catch (err) {
		invocationError(write, "tool_failed", err instanceof Error ? err.message : String(err));
	} finally {
		await store?.closeAsync();
	}
}

const memoryToolCmd = new Command("memory-tool")
	.configureHelp(helpStyle)
	.description("Run one memory tool in-process (JSON arguments on stdin)")
	.argument("<name>", "memory tool name, for example memory_search")
	.option("--session-id <id>", "host session ID for retrieval-ledger attribution")
	.option(
		"--request-id <id>",
		"host tool-call ID; with --session-id, a retried call records one ledger attempt",
	);

addDbOption(memoryToolCmd);

export const memoryToolCommand = memoryToolCmd.action((name: string, opts: MemoryToolOptions) =>
	runMemoryTool(name, opts),
);
