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
- `packages/embeddings/package.json` (`version`)
- `packages/cli/package.json` (`version`)
- `packages/opencode-plugin/package.json` (`version`)
- `packages/mcp-server/package.json` (`version`)
- `packages/viewer-server/package.json` (`version`)
- `packages/core/src/index.ts` (`VERSION` export)
- `packages/core/src/index.test.ts` (version assertion)
- `packages/cli/.opencode/plugins/codemem.js` (`PINNED_BACKEND_VERSION`)
- `packages/opencode-plugin/.opencode/lib/runtime.js` (`PINNED_BACKEND_VERSION`)
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

### First publication of a new package

npm sets `latest` on a package's first-ever version regardless of `--tag`. A new package whose debut is a prerelease therefore exposes that prerelease to untagged installs (`npm install <pkg>`).

The release workflow cannot fix this automatically: OIDC trusted publishing grants `publish` only, not dist-tag mutation. Instead, a post-publish step runs `scripts/release-latest-guard.mjs` in verify mode and reports any package whose `latest` points at a prerelease. Fix it once, by hand, from a machine with an npm login:

```fish
node scripts/release-latest-guard.mjs --apply <package>
```

The guard only removes; it never adds or moves `latest`, so an established package's stable `latest` is untouched. Until a package's first stable release, untagged installs of it correctly fail with "no matching version". The verify step is `continue-on-error` while any package is still dirty; flip it to a hard gate once the guard reports clean.

## Release tag preflight

Before creating or pushing a release tag, run:

```bash
pnpm run release:preflight-tag
```

This verifies release tagging safety in two contexts:

- local preflight: target commit must match `origin/main` HEAD, the current branch must be `main`, and the working tree must be clean
- CI tag workflow: tagged commit must be reachable from `origin/main` (avoids false failures if `main` advances after tag push)

Tag only after the release PR has merged to `main` and you have verified that `HEAD` on `main` is the merged release commit. Release and feature branch tips fail preflight and must not be tagged directly.

## Release discovery

`codemem update check` derives the release channel from the installed version and queries the fixed
public npm registry endpoint for the matching dist-tag: alpha uses `alpha`, beta uses `beta`, release
candidates use `rc`, and a stable version uses `latest`. Registry responses, status output, guidance,
and cache records must
match that channel. Results are cached locally for six hours; use `--refresh` to bypass a fresh cache
and `--json` for the additive automation contract. Existing stable-only cache records remain valid
for stable installations, but no cache or in-process result is reused across channels. If a refresh
fails, a previously validated same-channel cache may be returned as stale guidance. A running process
backs off failed registry checks for 15 minutes, while `--refresh` bypasses that backoff.
`codemem update check` remains informational. It detects a semver-qualified
`mise/installs/npm-codemem/<version>/` layout from the resolved CLI entry path, or the equivalent
layout beneath a normalized `MISE_DATA_DIR`, and reports
`mise use -g npm:codemem@<exact-version>` for that installation kind.
`codemem update install` separately requires fresh validated status. Proven npm-global installations
retain the 24-hour first-seen delay and install exact matching `codemem` and
`@codemem/embeddings` versions with an argv-only npm command. Before mutation, proven mise
installations compare bounded machine-readable active and global source records and require current
install-path ownership. A recognized user-level `~/.config/mise.toml` source may migrate when the
bounded global query succeeds with an empty result. The matching source must resolve within the user's home directory; system,
unresolved, and ambiguous custom paths fail closed. Matching evidence authorizes codemem to
execute the exact reported `mise use -g` command without a shell, inherited environment, and pinned
public default and `@codemem` registries; Linux also sets `ONNXRUNTIME_NODE_INSTALL=skip`. This writes
the exact release into the primary global config, so a declaration may move from user `conf.d` or `~/.config/mise.toml` to
`config.toml`. Mise verification re-reads bounded global state, requires an exact target `version` or
`requested_version` value, and runs `mise exec -- codemem version` outside the invoking project;
npm-global verification uses the active CLI.
Bare `codemem update` remains non-mutating. Installing an alpha, beta, or release candidate is
explicit opt-in, so the
existing auto-update policy may install a delayed eligible update within that installed channel.
Installation refuses pinned, cross-channel, unsupported-prerelease, downgrade, development, stale,
Docker, and unknown states. The npm-global updater always installs exact matching `codemem` and
`@codemem/embeddings` versions. The npm operation runs the packages' installation scripts for native
CPU dependencies, just as a manual global install does.
Mise remains ineligible for background auto-update because its command changes declarative global
tool configuration; only a direct user install command may authorize that change, and a local source
that overrides the global source is refused with manual global-update guidance.

Release discovery compares the running product version with the latest release on its channel.
It is separate from the compatibility-floor check below: discovering a newer release does not
change whether the current CLI satisfies the plugin's minimum supported version.

## Compatibility-floor check

The OpenCode 1 plugin performs a runtime CLI version check and warns if the local CLI is below
`CODEMEM_MIN_VERSION` (default `0.9.20`).

The compatibility reaction is controlled by `CODEMEM_BACKEND_UPDATE_POLICY`:

- `notify` (default): warn with an upgrade hint
- `auto`: attempt a best-effort same-channel update for eligible npm runners and delayed releases, then re-check
- `off`: suppress compatibility toasts

This check enforces a minimum supported CLI version. It does not query the npm registry or report
the latest available release, and its existing policy and update behavior are unchanged by release
discovery.

## OpenCode host compatibility

Codemem 0.45 raises the minimum supported OpenCode 1 host to 1.18.29. The
`@codemem/opencode-plugin` package records this floor through
`engines.opencode`, which OpenCode checks when loading npm plugins, and CI runs
the V1 plugin suite against that exact SDK release. The packed-artifact smoke
also installs OpenCode 1.18.30 and requires the dual entrypoint to complete the
host's non-pure startup path. The package default export changes from a callable
V1 plugin function to the documented dual-host object; named V1 exports remain
available for integrations that invoke the function directly.
This is a breaking host-compatibility change from Codemem 0.44; upgrade OpenCode
before installing the 0.45 plugin.

Dependabot continues to propose SDK updates, but accepting one requires updating
all checked-in runtime pins together. CI keeps the minimum host gate fixed at
1.18.29 until the documented compatibility floor changes. The ignored
`.opencode/package.json` is only a local contributor runtime and is not a release
pin. Refresh it when testing the minimum host locally:

```fish
npm install --prefix .opencode --save-exact @opencode-ai/plugin@1.18.29
```

The OpenCode 2 contract spike separately pins matching
`@opencode/cli@0.0.0-beta-19296` and
`@opencode/plugin@0.0.0-beta-19296` development dependencies. The workspace
allows the CLI package's postinstall because it installs the matching platform
binary used by the packed-host smoke test. For beta-19296, the reviewed
postinstall copies that platform binary and detects AVX2 support with `sysctl` on
macOS or PowerShell on Windows. Re-review the postinstall whenever the exact pin
changes. Update both beta revisions together and rerun the executable checks
documented in [the OpenCode 2 beta contract](opencode-v2-contract.md); do not
replace these pins with a moving beta tag or semver range.

Override for testing:

```bash
export CODEMEM_MIN_VERSION=0.9.20
```

## Transition notes

- `codemem` is the CLI package on npm.
- `@codemem/opencode-plugin` is the OpenCode plugin identifier.
