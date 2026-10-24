#!/usr/bin/env node

/**
 * @codemem/mcp — MCP stdio server bootstrap.
 *
 * Runs as a separate process spawned by the host (OpenCode/Claude).
 * Owns its own better-sqlite3 connection. Communicates via stdio JSON-RPC.
 */

import { MemoryStore, resolveDbPath } from "@codemem/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodememMcpServer } from "./server.js";
import { ensureViewer } from "./stdio-viewer.js";

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
	const dbPath = resolveDbPath();
	const store = new MemoryStore(dbPath);
	let server: ReturnType<typeof createCodememMcpServer> | undefined;
	let closePromise: Promise<void> | undefined;
	let closing = false;
	const close = () => {
		if (closePromise) return closePromise;
		closing = true;
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

		server = createCodememMcpServer(store);
		const transport = new StdioServerTransport();
		server.server.onclose = () => {
			if (!closing) void shutdown(0);
		};

		process.on("SIGINT", () => void shutdown(0));
		process.on("SIGTERM", () => void shutdown(0));
		process.stdin.once("end", () => void shutdown(0));
		process.stdin.once("error", () => void shutdown(1));

		await server.connect(transport);
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
