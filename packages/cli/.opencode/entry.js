// Minimal module entry point for package resolution.
// OpenCode needs to resolve this package as a module to discover
// .opencode/plugins/codemem.js — the actual plugin is loaded from there.
// This file intentionally does nothing; the CLI lives at bin/codemem.
export const name = "codemem";
