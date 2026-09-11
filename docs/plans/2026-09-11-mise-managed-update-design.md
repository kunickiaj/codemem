# Mise-Managed Update Design

**Status:** Approved
**Date:** 2026-09-11

## Decision

Codemem will detect installations managed by mise's `npm:codemem` backend and provide a channel-preserving upgrade command. An explicit `codemem update install` may run mise, but background auto-update remains limited to npm-global installations.

## Detection

Installation detection will continue to use the resolved CLI entry path as evidence. Detection requires a semver-qualified `mise/installs/npm-codemem/<version>/` segment or the equivalent path beneath a normalized `MISE_DATA_DIR`, avoiding generic `installs/npm-codemem` false positives.

The detector will classify a matching path as `mise`. Environment markers may narrow permissions but will not be allowed to claim an executable install kind, preserving the current fail-closed policy.

## Update Behavior

`codemem update check` will return this exact action for a mise-managed release:

```text
mise use -g npm:codemem@<version>
```

The explicit `codemem update install` command will retain the update lock, read bounded JSON from active and global `mise ls` queries, require their canonical source paths to match under the user's home directory, and require the active install path to own the running CLI entrypoint. A recognized user-level `~/.config/mise.toml` source may migrate only when the global query succeeds with an empty array. System, unresolved, and ambiguous custom sources fail closed. It runs the update without a shell using inherited environment, pinned public npm registries, and Linux's CPU-only ONNX setting, writing the exact release into the primary global config. Verification permits the source to move from user `conf.d` or `~/.config/mise.toml` to `config.toml`, re-reads bounded global state, requires an exact target `version` or `requested_version` value, then runs `mise exec -- codemem version` outside the invoking project. It reports unproven global ownership, missing mise, command failure, and version mismatch as actionable errors.

Mise installations will remain ineligible for background auto-update. Updating a mise global tool changes declarative user configuration, so only a direct user command may authorize it.

## Alternatives Rejected

- Probing npm, pnpm, Yarn, and mise was rejected because `PATH` may contain multiple installations and identify a manager that does not own the running executable.
- Writing installation metadata from lifecycle scripts was rejected because existing installs lack the metadata and additional install scripts increase supply-chain exposure.
- Treating mise as npm-global was rejected because npm could update a different prefix while leaving the active mise installation unchanged.

## Validation

Tests will cover Unix and Windows-style path normalization, exact extracted versions, detection precedence, exact release guidance, explicit mise command execution, source and install-path ownership, failed execution, configured-state and executable version verification, and refusal of background eligibility. The UI type mirror and user-facing update documentation will include the new install kind.
