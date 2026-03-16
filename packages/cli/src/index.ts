/**
 * @codemem/cli — CLI entry point.
 *
 * Dispatches to subcommands:
 *   codemem serve  → starts viewer+sync process (@codemem/viewer-server)
 *   codemem mcp    → starts MCP stdio server (@codemem/mcp-server)
 *   codemem stats  → one-shot CLI commands (@codemem/core)
 *   codemem embed  → one-shot embedding (inline, no worker thread)
 */

export { VERSION } from "@codemem/core";
