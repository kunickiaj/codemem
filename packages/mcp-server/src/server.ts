import { randomUUID } from "node:crypto";
import { type MemoryStore, VERSION } from "@codemem/core";
import { McpServer } from "@modelcontextprotocol/server";
import {
	CALLER_CONTEXT_REQUIRED_ERROR,
	type CallerContext,
	createCallerScope,
	requireCallerContext,
} from "./caller-context.js";
import { resolveDefaultProject } from "./project-scope.js";
import type { CodememMcpServerOptions, ToolRegistrationContext } from "./tool-context.js";
import { registerDistillTools } from "./tools/distill.js";
import { registerItemTools } from "./tools/items.js";
import { registerLearnTools } from "./tools/learn.js";
import { registerSessionSearchTools } from "./tools/pi-session-search.js";
import { registerSchemaTools } from "./tools/schema.js";
import { registerSearchTools } from "./tools/search.js";
import { registerTimelineTools } from "./tools/timeline.js";

export function createCodememMcpServer(
	store: MemoryStore,
	options: CodememMcpServerOptions = {},
): McpServer {
	const server = new McpServer({ name: "codemem", version: VERSION });
	const callerScope = options.callerContext === "required" ? createCallerScope() : undefined;
	if (callerScope) requireCallerContext(server, callerScope);
	// With a caller scope, nothing below may fall back to this process's
	// directory or environment: a call outside a caller's scope is an error.
	const caller = (): CallerContext | undefined => {
		const current = callerScope?.current();
		if (callerScope && !current) throw new Error(CALLER_CONTEXT_REQUIRED_ERROR);
		return current;
	};
	const envProject = () => {
		const current = caller();
		if (current) return current.envProject;
		return options.envProject !== undefined
			? options.envProject
			: (process.env.CODEMEM_PROJECT ?? null);
	};
	const cwd = () => caller()?.directory ?? options.cwd ?? process.cwd();
	const context: ToolRegistrationContext = {
		store,
		// Resolve lazily per call so long-running servers pick up the current
		// CODEMEM_PROJECT / process.cwd() rather than the value at construction.
		defaultProject: () => {
			if (caller()) return resolveDefaultProject({ envProject: envProject(), cwd: cwd() });
			if (options.resolveDefaultProject) return options.resolveDefaultProject();
			if (options.defaultProject !== undefined) return options.defaultProject;
			return resolveDefaultProject({ envProject: envProject(), cwd: cwd() });
		},
		envProject,
		cwd,
		callIdentity: () => callerScope?.current(),
		captureRetrievalLedger: options.captureRetrievalLedger !== false,
		retrievalLedgerScopeId: options.retrievalLedgerScopeId ?? randomUUID(),
		// A caller-supplied request ID already separates distinct calls, so a
		// redelivered call must collapse onto its first record.
		retrievalLedgerIdentityMode:
			options.retrievalLedgerIdentityMode ?? (callerScope ? "stateless" : "session"),
		...(options.retrievalLedgerRequestId
			? { retrievalLedgerRequestId: options.retrievalLedgerRequestId }
			: {}),
	};

	registerSearchTools(server, context);
	registerSessionSearchTools(server, context);
	registerTimelineTools(server, context);
	registerDistillTools(server, context);
	registerItemTools(server, context);
	registerSchemaTools(server);
	registerLearnTools(server);

	return server;
}
