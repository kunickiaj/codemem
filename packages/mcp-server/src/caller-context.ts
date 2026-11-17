/**
 * Per-call caller context for a server process that several project
 * directories share (OpenCode's pooled MCP connections).
 *
 * A pooled process has one fixed working directory, so it cannot tell which
 * project a call came from. In `required` mode every tool declares one extra
 * argument that the codemem OpenCode plugin fills in on each call. The server
 * removes it before the tool runs, and rejects any call that arrives without
 * it instead of using its own directory.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorContent } from "./content.js";

/** Name of the argument the host plugin adds to each tool call. */
export const CALLER_ARGUMENT = "_codemem_caller";
export const CALLER_CONTEXT_REQUIRED_ERROR = "caller_context_required";

export const callerArgumentSchema = z
	.object({
		directory: z
			.string()
			.refine(isAbsolute, "directory must be an absolute path")
			.describe("Absolute directory of the session that made the call"),
		env_project: z.string().nullable().describe("The caller's CODEMEM_PROJECT, or null"),
		session_id: z.string().min(1).describe("Host session that made the call"),
		request_id: z.string().min(1).describe("Host identity of this call, stable across redelivery"),
	})
	.describe("Set by the codemem host plugin. Do not supply this argument.");

export interface CallerContext {
	readonly directory: string;
	readonly envProject: string | null;
	readonly sessionId: string;
	readonly requestId: string;
}

export interface CallerScope {
	/** The context of the tool call running on this async path, if any. */
	current(): CallerContext | undefined;
	run<T>(caller: CallerContext, callback: () => T): T;
}

export function createCallerScope(): CallerScope {
	const storage = new AsyncLocalStorage<CallerContext>();
	return {
		current: () => storage.getStore(),
		run: (caller, callback) => storage.run(caller, callback),
	};
}

type ToolHandler = (...handlerArguments: unknown[]) => unknown;
type ToolConfig = { inputSchema?: z.ZodObject } & Record<string, unknown>;
type RegisterTool = (name: string, config: ToolConfig, handler: ToolHandler) => unknown;

function toCallerContext(value: z.infer<typeof callerArgumentSchema>): CallerContext {
	return Object.freeze({
		directory: value.directory,
		envProject: value.env_project,
		sessionId: value.session_id,
		requestId: value.request_id,
	});
}

/**
 * Make every tool registered on `server` after this call declare the caller
 * argument, run inside that caller's scope, and fail without it. Tools see
 * their arguments exactly as they do on a private connection.
 */
export function requireCallerContext(server: McpServer, scope: CallerScope): void {
	const register = server.registerTool.bind(server) as unknown as RegisterTool;
	const registerWithCaller: RegisterTool = (name, config, handler) => {
		const declaredInput = config.inputSchema;
		const inputSchema = (declaredInput ?? z.object({})).extend({
			[CALLER_ARGUMENT]: callerArgumentSchema.optional(),
		});
		return register(name, { ...config, inputSchema }, (input, extra) => {
			const { [CALLER_ARGUMENT]: caller, ...toolArguments } = input as Record<string, unknown>;
			if (!caller) return errorContent(CALLER_CONTEXT_REQUIRED_ERROR);
			const context = toCallerContext(caller as z.infer<typeof callerArgumentSchema>);
			return scope.run(context, () =>
				declaredInput ? handler(toolArguments, extra) : handler(extra),
			);
		});
	};
	server.registerTool = registerWithCaller as unknown as McpServer["registerTool"];
}
