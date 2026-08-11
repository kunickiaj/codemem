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

async function main() {
	const dbPath = resolveDbPath();
	const store = new MemoryStore(dbPath);

	try {
		// Auto-start viewer in background (belt and suspenders with any hook-based start)
		ensureViewer().catch(() => {});

		const server = createCodememMcpServer(store);
		const transport = new StdioServerTransport();

		const shutdown = () => {
			try {
				store.close();
			} catch {
				// Best effort — process is exiting
			}
			process.exit(0);
		};

		process.on("SIGINT", shutdown);
		process.on("SIGTERM", shutdown);

		await server.connect(transport);
	} catch (err) {
		// Close the store before bubbling so a startup failure does not leave
		// the SQLite journal behind. Signal handlers are not yet attached if we
		// crash before `server.connect` resolves.
		try {
			store.close();
		} catch {
			// best effort
		}
		throw err;
	}
}

main().catch((err) => {
	console.error("codemem MCP server failed to start:", err);
	process.exit(1);
});
