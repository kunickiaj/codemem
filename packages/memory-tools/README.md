# @codemem/memory-tools

Host-neutral pieces that thin codemem hosts (the OpenCode plugin and the pi
extension) share when they expose the `memory_*` tools without opening the
store in-process:

- `contracts.ts`: the fourteen tool names, descriptions, and JSON Schema inputs,
  plus each tool's retrieval-ledger surface and project-scoping rule. These are
  pinned to the MCP server registrations by
  `packages/mcp-server/src/tool-contract-parity.test.ts`.
- `viewer-target.ts` and `http.ts`: target-proven JSON requests to the viewer,
  so a stale viewer on the port can never serve another database. The proof
  also returns the viewer's advertised capabilities.
- `cli.ts`: a `codemem` CLI runner for the fallback path that kills the child
  when the caller aborts.
- `project.ts`: the project label a stdio MCP server would derive for a
  directory, without importing `@codemem/core`.

This package is private. Consumers bundle it; nothing here may import
`@codemem/core` or any package that loads native SQLite, because the module
runs inside the host's process.

Design: `docs/plans/2026-11-04-shared-mcp-service-design.md`.
