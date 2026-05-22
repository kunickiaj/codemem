#!/usr/bin/env node

/**
 * @codemem/mcp — MCP stdio server bootstrap.
 *
 * Runs as a separate process spawned by the host (OpenCode/Claude).
 * Owns its own better-sqlite3 connection. Communicates via stdio JSON-RPC.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodememMcpServer } from "./server.js";

/** Default viewer host/port for health checks. */
const VIEWER_HOST = process.env.CODEMEM_VIEWER_HOST ?? "127.0.0.1";
const VIEWER_PORT = process.env.CODEMEM_VIEWER_PORT ?? "38888";

/** Resolve the `codemem` CLI binary path. Checks package-local paths first, then PATH. */
function resolveCliPath(): string | null {
	// When installed via npm/npx, the MCP server and CLI share node_modules.
	// Walk up from this file to find the CLI's bin entry.
	const candidates: string[] = [];
	const selfDir = dirname(import.meta.dirname ?? ".");
	// Monorepo dev: sibling package
	candidates.push(join(selfDir, "..", "cli", "dist", "index.js"));
	// npm install: node_modules/.bin/codemem
	candidates.push(join(selfDir, "..", ".bin", "codemem"));
	// npm install: deeper node_modules
	candidates.push(join(selfDir, "..", "..", ".bin", "codemem"));
	for (const p of candidates) {
		if (existsSync(p)) return p;
	}
	// Fall back to PATH
	return "codemem";
}

/** Check if the viewer is already running. */
async function isViewerHealthy(): Promise<boolean> {
	try {
		const url = `http://${VIEWER_HOST}:${VIEWER_PORT}/api/health`;
		const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Attempt to start the viewer server as a detached background process.
 * Best-effort: failures are logged to stderr but never block MCP startup.
 */
async function ensureViewer(): Promise<void> {
	if (process.env.CODEMEM_VIEWER === "0" || process.env.CODEMEM_VIEWER_AUTO === "0") return;

	if (await isViewerHealthy()) return;

	const cli = resolveCliPath();
	if (!cli) return;

	try {
		// If the resolved path is a .js file, run it with node.
		// Otherwise it's a bin script that can run directly.
		const isJsFile = cli.endsWith(".js");
		const cmd = isJsFile ? process.execPath : cli;
		const args = isJsFile ? [cli, "serve", "start"] : ["serve", "start"];
		// Pass non-default host/port so the spawned viewer matches what we health-check.
		if (VIEWER_HOST !== "127.0.0.1") args.push("--host", VIEWER_HOST);
		if (VIEWER_PORT !== "38888") args.push("--port", VIEWER_PORT);

		const child = spawn(cmd, args, {
			detached: true,
			stdio: "ignore",
			env: { ...process.env, CODEMEM_PLUGIN_IGNORE: "1" },
		});
		child.on("error", () => {}); // swallow — best effort
		child.unref();

		// Brief health check loop — don't block for long
		for (let i = 0; i < 5; i++) {
			await new Promise((r) => setTimeout(r, 1_000));
			if (await isViewerHealthy()) return;
		}
	} catch {
		// Best effort — MCP server continues regardless
	}
}

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
