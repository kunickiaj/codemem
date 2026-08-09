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
- `pnpm run release:version -- parse vX.Y.Z`

`parse` validates exact package/tag alignment and prints the dist-tag,
prerelease state, attestation policy, and deterministic attestation path used by
release preflight and the publish workflow.

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

- local preflight: target commit must be reachable from `origin/main` or exactly one `origin/release/*` branch, the current branch must match that qualifying branch, and the working tree must be clean
- CI tag workflow: tagged commit must be reachable from `origin/main` or exactly one `origin/release/*` branch (avoids false failures if `main` advances after tag push)

It also parses the release tag with the same strict policy used by the publish
workflow. Stable `vX.Y.Z` tags require offline verification of the exact
candidate-bound release attestation at
`scripts/eval/baselines/releases/vX.Y.Z/release-attestation-v1.json` before any
package is published. The verifier derives no "newest" fallback, uses no
network, and rejects missing, stale, future-dated, malformed, incomplete,
failing, or mismatched evidence.
The fixed freshness window is seven days with at most five minutes of future
clock skew.
Because freshness is verified on every run, a `workflow_dispatch` retry after
the evidence expires requires newly generated and reviewed evidence. There is
no stale-evidence bypass.

Recognized `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N`, and `vX.Y.Z-rc.N` tags report the
attestation policy as `not_required` and skip this stable-only gate. Any other
prerelease syntax is rejected; it is never treated as `latest` or silently
skipped.

Tag only after the release PR has merged to `main` and you have verified that `HEAD` on `main` is the merged release commit. Do not tag the release branch tip directly.

For a stable release, bump the version first and generate evaluation evidence
afterward from the exact clean post-bump candidate. Review the fresh sanitized
threshold profile and attestation separately before committing them. Partial
evaluation reports are inputs for review, not release attestations. Until fresh
evidence is present at the deterministic path, stable preflight is expected to
fail closed.

`RELEASE_SKIP_LOCAL_GUARDS=1` is only for controlled local testing of branch and
clean-tree checks. CI ignores it, and it does not skip version parsing,
attestation selection, freshness, or verification. It is not an attestation
bypass.

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

- `codemem` is the CLI package on npm.
- `@codemem/opencode-plugin` is the OpenCode plugin identifier.
