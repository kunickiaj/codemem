# CodeMem Versioning Policy

CodeMem uses one shared semantic version stream across its npm packages.

## Canonical packages

- npm: `codemem` (CLI)
- npm: `@codemem/opencode-plugin` (OpenCode plugin)

## Policy

- Release tags `vX.Y.Z` represent the product version.
- npm packages publish the same `X.Y.Z`.
- GitHub Release notes are shared per version.

## Release workflow

Version bumps are prepared on a release branch and touch these files:

- `packages/core/package.json` (`version`)
- `packages/cli/package.json` (`version`)
- `packages/opencode-plugin/package.json` (`version`)
- `packages/mcp-server/package.json` (`version`)
- `packages/viewer-server/package.json` (`version`)
- `packages/core/src/index.ts` (`VERSION` export)
- `packages/core/src/index.test.ts` (version assertion)
- `packages/cli/.opencode/plugins/codemem.js` (`PINNED_BACKEND_VERSION`)
- `packages/opencode-plugin/.opencode/plugins/codemem.js` (`PINNED_BACKEND_VERSION`)
- `.claude-plugin/marketplace.json` (marketplace metadata version and codemem plugin entry version)
- `plugins/claude/.claude-plugin/plugin.json` (Claude plugin metadata version)
- `plugins/codex/.codex-plugin/plugin.json` (Codex plugin metadata version; also pins the `npx -y codemem@<version>` fallback used by Codex hook scripts)

Use the release version helper to verify or apply the bump:

- `pnpm run release:version -- check`
- `pnpm run release:version -- set X.Y.Z`

Regenerate release artifacts before opening the release PR:

- `pnpm install` (lockfile and generated artifacts when applicable)
- `pnpm build` (viewer UI bundle/assets)

Keep `.opencode/.npmrc` pinned to the public npm registry:

- `registry=https://registry.npmjs.org/`

## Release tag preflight

Before creating or pushing a release tag, run:

```bash
pnpm run release:preflight-tag
```

This verifies release tagging safety in two contexts:

- local preflight: target commit must match `origin/main` HEAD, and the working tree must be clean
- CI tag workflow: tagged commit must be reachable from `origin/main` (avoids false failures if `main` advances after tag push)

Tag only after the release PR has merged to `main` and you have verified that `HEAD` on `main` is the merged release commit. Do not tag the release branch tip directly.

## Release discovery

`codemem update check` queries the fixed public npm registry endpoint for the latest stable
`codemem` release. Results are cached locally for six hours; use `--refresh` to bypass a fresh
cache and `--json` for the stable automation contract. If a refresh fails, a previously validated
cache may be returned as stale guidance. A running process backs off failed registry checks for 15
minutes, while `--refresh` bypasses that backoff. `codemem update check` remains informational.
`codemem update install` separately requires fresh validated status, a 24-hour first-seen delay,
and a proven eligible npm installation before it executes an argv-only npm command and verifies
the active CLI version. It refuses pinned, prerelease, downgrade, development, stale, Docker, and
unknown states.

Release discovery compares the running product version with the latest published stable release.
It is separate from the compatibility-floor check below: discovering a newer release does not
change whether the current CLI satisfies the plugin's minimum supported version.

## Compatibility-floor check

The OpenCode plugin performs a runtime CLI version check and warns if the local CLI is below
`CODEMEM_MIN_VERSION` (default `0.9.20`).

The compatibility reaction is controlled by `CODEMEM_BACKEND_UPDATE_POLICY`:

- `notify` (default): warn with an upgrade hint
- `auto`: attempt a best-effort update for eligible npm runners and delayed stable releases, then re-check
- `off`: suppress compatibility toasts

This check enforces a minimum supported CLI version. It does not query the npm registry or report
the latest available release, and its existing policy and update behavior are unchanged by release
discovery.

Override for testing:

```bash
export CODEMEM_MIN_VERSION=0.9.20
```

## Transition notes

- `codemem` is the CLI package on npm.
- `@codemem/opencode-plugin` is the OpenCode plugin identifier.
