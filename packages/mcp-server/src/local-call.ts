/**
 * Run one codemem MCP tool in-process against an open store and return its
 * result. Used by `codemem memory-tool`, the CLI fallback thin hosts call when
 * the viewer is unreachable, so the fallback goes through the exact same
 * handlers, input validation, and retrieval-ledger capture as stdio MCP.
 */

import { randomUUID } from "node:crypto";
import type { MemoryStore } from "@codemem/core";
import { Client, InMemoryTransport, ProtocolError } from "@modelcontextprotocol/client";
import { createCodememMcpServer } from "./server.js";

/**
 * The SDK's default request timeout is 60 s. `memory_distill_candidates` judges
 * up to `limit + 20` clusters with the observer model by default, which can run
 * longer on a slow model; callers bound the overall wait themselves (the CLI
 * runner's process timeout, the plugin's request timeout).
 */
const LOCAL_TOOL_CALL_TIMEOUT_MS = 10 * 60_000;

export type LocalToolCallResult =
	| { ok: true; result: unknown }
	| { ok: false; error: string; result?: unknown };

export interface LocalToolCallOptions {
	/**
	 * Host session that made the call. Recorded as the retrieval-ledger stream,
	 * the role a stdio MCP process's per-process scope ID plays.
	 */
	sessionId?: string;
	/**
	 * Caller's working directory. When set, it replaces `process.cwd()` for the
	 * default read project, write-session cwd, and distill context, so a shared
	 * process (the viewer) never acts in its own directory.
	 */
	cwd?: string;
	/**
	 * Caller's CODEMEM_PROJECT. `null` means the caller has none; `undefined`
	 * falls back to this process's environment (CLI and stdio behavior).
	 */
	envProject?: string | null;
	/** Stateless HTTP callers keep request-level retry dedupe in the ledger. */
	statelessLedger?: boolean;
	/**
	 * The host's ID for this tool call. Together with `sessionId`, a retried
	 * delivery of the same call records one ledger attempt and distinct calls
	 * record separately. Without `sessionId` each call gets its own ledger
	 * stream, so retries are not deduplicated. A random ID is used when absent.
	 */
	requestId?: string;
}

interface TextContent {
	type: string;
	text?: string;
}

function parseTextContent(content: unknown): unknown {
	if (!Array.isArray(content)) return null;
	const first = content[0] as TextContent | undefined;
	if (first?.type !== "text" || typeof first.text !== "string") return null;
	try {
		return JSON.parse(first.text);
	} catch {
		return first.text;
	}
}

function errorMessage(value: unknown): string {
	if (value != null && typeof value === "object" && "error" in value) {
		return String((value as { error: unknown }).error);
	}
	return typeof value === "string" ? value : "tool_error";
}

export async function callCodememToolLocally(
	store: MemoryStore,
	name: string,
	args: Record<string, unknown>,
	options: LocalToolCallOptions = {},
): Promise<LocalToolCallResult> {
	const server = createCodememMcpServer(store, {
		retrievalLedgerRequestId: options.requestId?.trim() || randomUUID(),
		...(options.sessionId ? { retrievalLedgerScopeId: options.sessionId } : {}),
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.envProject !== undefined ? { envProject: options.envProject } : {}),
		...(options.statelessLedger ? { retrievalLedgerIdentityMode: "stateless" as const } : {}),
	});
	const client = new Client({ name: "codemem-memory-tool", version: "1.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	try {
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const response = await client.callTool(
			{ name, arguments: args },
			{
				timeout: LOCAL_TOOL_CALL_TIMEOUT_MS,
			},
		);
		const value = response.structuredContent ?? parseTextContent(response.content);
		if (response.isError) return { ok: false, error: errorMessage(value), result: value };
		return { ok: true, result: value };
	} catch (error) {
		if (error instanceof ProtocolError) return { ok: false, error: error.message };
		throw error;
	} finally {
		await client.close();
		await server.close();
	}
}
