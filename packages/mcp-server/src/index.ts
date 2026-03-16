/**
 * @codemem/mcp-server — MCP stdio server.
 *
 * Runs as a separate process spawned by the host (OpenCode/Claude).
 * Owns its own better-sqlite3 connection. Communicates via stdio JSON-RPC.
 */

export { VERSION } from "@codemem/core";
