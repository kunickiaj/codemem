# CodeMem Versioning Policy

CodeMem uses one shared semantic version stream across its npm packages.

## Canonical packages

- npm: `codemem` (plugin + CLI)

## Policy

- Release tags `vX.Y.Z` represent the product version.
- npm packages publish the same `X.Y.Z`.
- Changelog/release notes are shared per version.

## Release workflow

Version bumps are prepared on a release branch and touch these files:

- `packages/core/package.json` (`version`)
- `packages/cli/package.json` (`version`)
- `packages/mcp-server/package.json` (`version`)
- `packages/viewer-server/package.json` (`version`)
- `packages/core/src/index.ts` (`VERSION` export)
- `packages/core/src/index.test.ts` (version assertion)
- `packages/cli/.opencode/plugins/codemem.js` (`PINNED_BACKEND_VERSION`)

## Release tag preflight

Before creating or pushing a release tag, run:

```bash
pnpm run release:preflight-tag
```

This verifies release tagging safety in two contexts:

- local preflight: target commit must match `origin/main` HEAD, and the working tree must be clean
- CI tag workflow: tagged commit must be reachable from `origin/main` (avoids false failures if `main` advances after tag push)

## Compatibility check

The OpenCode plugin performs a runtime CLI version check and warns if the local CLI is below
`CODEMEM_MIN_VERSION` (default `0.9.20`).

The compatibility reaction is controlled by `CODEMEM_BACKEND_UPDATE_POLICY`:

- `notify` (default): warn with an upgrade hint
- `auto`: attempt a best-effort update for eligible runners, then re-check (skips dev runner mode and pinned git refs)
- `off`: suppress compatibility toasts

Override for testing:

```bash
export CODEMEM_MIN_VERSION=0.9.20
```

## Transition notes

- `codemem` is published on npm (CLI + plugin).
- `@kunickiaj/codemem` is the OpenCode plugin identifier.
