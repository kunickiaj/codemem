#!/usr/bin/env node

/**
 * @codemem/mcp — MCP stdio server bootstrap.
 *
 * Runs as a separate process spawned by the host (OpenCode/Claude).
 * Owns its own better-sqlite3 connection. Communicates via stdio JSON-RPC.
 */

import { MemoryStore, resolveDbPath } from "@codemem/core";
import {
	type StdioServerHandle,
	StdioServerTransport,
	serveStdio,
} from "@modelcontextprotocol/server/stdio";
import { createCodememMcpServer } from "./server.js";
import { ensureViewer } from "./stdio-viewer.js";
import type { CodememMcpServerOptions } from "./tool-context.js";

export const CALLER_CONTEXT_ENV = "CODEMEM_MCP_CALLER_CONTEXT";

/** An unrecognized value stops startup; it must never mean "use this process's directory". */
function callerContextMode(): NonNullable<CodememMcpServerOptions["callerContext"]> {
	const value = process.env[CALLER_CONTEXT_ENV]?.trim();
	if (!value || value === "process") return "process";
	if (value === "required") return "required";
	throw new Error(`${CALLER_CONTEXT_ENV} must be "process" or "required", got "${value}"`);
}

function createStdioShutdown(close: () => Promise<void>) {
	let shutdownPromise: Promise<void> | undefined;
	let shutdownExitCode = 0;
	return (exitCode: number): Promise<void> => {
		shutdownExitCode = Math.max(shutdownExitCode, exitCode);
		if (shutdownPromise) return shutdownPromise;
		// Parent embedding work cannot be interrupted; forced exit must not close SQLite under it.
		const deadline = setTimeout(() => process.exit(1), 30_000);
		deadline.unref();
		shutdownPromise = Promise.resolve().then(async () => {
			try {
				await close();
			} catch {
				shutdownExitCode = 1;
			} finally {
				clearTimeout(deadline);
			}
			process.exit(shutdownExitCode);
		});
		return shutdownPromise;
	};
}

async function main() {
	const callerContext = callerContextMode();
	const dbPath = resolveDbPath();
	const store = new MemoryStore(dbPath);
	let server: StdioServerHandle | undefined;
	let closePromise: Promise<void> | undefined;
	const close = () => {
		if (closePromise) return closePromise;
		closePromise = (async () => {
			try {
				// Stop dispatch and cancel active MCP request signals before draining the store.
				await server?.close();
			} finally {
				await store.closeAsync();
			}
		})();
		return closePromise;
	};
	const shutdown = createStdioShutdown(close);

	try {
		// Auto-start viewer in background (belt and suspenders with any hook-based start)
		ensureViewer().catch(() => {});

		process.on("SIGINT", () => void shutdown(0));
		process.on("SIGTERM", () => void shutdown(0));
		process.stdin.once("end", () => void shutdown(0));
		process.stdin.once("error", () => void shutdown(1));

		// The SDK may discard a discovery probe and create a legacy server. Only
		// the connection owner closes the shared store, never an individual instance.
		const transport = new StdioServerTransport();
		server = serveStdio(() => createCodememMcpServer(store, { callerContext }), {
			legacy: "serve",
			transport,
			onerror: (error) => {
				console.error("codemem MCP server failed:", error);
			},
		});
		const sdkOnClose = transport.onclose;
		transport.onclose = () => {
			sdkOnClose?.();
			void shutdown(0);
		};
	} catch (err) {
		// Preserve the startup error and exit code after transport and store cleanup.
		console.error("codemem MCP server failed to start:", err);
		await shutdown(1);
	}
}

main().catch((err) => {
	console.error("codemem MCP server failed to start:", err);
	process.exit(1);
});
