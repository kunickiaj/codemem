# Mise-Managed Update Implementation Plan

The implementation adds one evidence-backed installer kind and keeps unattended behavior unchanged.

## 1. Extend Release Discovery

- Add `mise` to `InstallKind`.
- Detect semver-qualified resolved entry paths beneath mise's own data layout or a normalized `MISE_DATA_DIR` before generic package-manager patterns.
- Return `mise use -g npm:codemem@<latest-version>` as the recommended action.
- Keep `auto_update_eligible` false for mise.
- Add focused detection, precedence, guidance, and eligibility tests.

## 2. Execute Explicit Mise Updates

- Export explicit install eligibility from core while keeping background eligibility npm-only.
- Select npm or mise install arguments from the detected kind.
- Compare bounded JSON from active and global mise source queries before mutation, allowing a recognized user-level `~/.config/mise.toml` source only when the global query succeeds with an empty array, and refusing other local overrides, system or ambiguous custom sources, and install paths that do not canonically own the running entry.
- Spawn mise without a shell using inherited environment, pinned public npm registries, and Linux's CPU-only ONNX setting.
- Write the exact release into the primary global config, then re-read bounded global state, require an exact target `version` or `requested_version` value without requiring an unchanged source, and verify through unpinned `mise exec -- codemem version` outside the invoking project.
- Test Unix and Windows options, user and system source handling, symlinked ownership, bounded command output, failed execution, stale configured state, and executable verification failure.

## 3. Update Consumers and Documentation

- Add `mise` to the browser-side update-status type.
- Document mise detection, the exact manual command, explicit install behavior, and the background-update restriction.
- Avoid advertising pnpm, Yarn, or Bun installation until their native dependency behavior has dedicated validation.

## 4. Validate

- Run the core release-discovery tests.
- Run the CLI update-command tests.
- Run affected viewer and plugin update tests if the wire-contract change reaches their fixtures.
- Run TypeScript and lint checks for the final changed set.
