# Rename Migration Plan

This document tracks migration from `codemem` naming to `CodeMem` package names.

## Canonical names

- GitHub repo: `kunickiaj/codemem`
- npm plugin package: `@kunickiaj/codemem`
- PyPI package: `codemem`

## Compatibility policy

- Keep `codemem` CLI command compatibility for two releases after the first `codemem` release.
- Keep git-based install commands as fallback during migration; move them to advanced docs.
- Keep old references in release notes with explicit replacement commands.

## User migration guidance

### Plugin config migration

Old:

```json
{
  "plugin": ["codemem"]
}
```

New:

```json
{
  "plugin": ["@kunickiaj/codemem"]
}
```

### End-user cutover checklist (opencode-mem -> codemem)

1. Back up the legacy DB file:

```bash
cp ~/.opencode-mem.sqlite ~/.opencode-mem.sqlite.bak
```

2. Update OpenCode plugin config to `@kunickiaj/codemem`.
3. Update OpenCode MCP command to `codemem` (if configured):

```json
{
  "mcp": {
    "codemem": {
      "type": "local",
      "command": ["codemem", "mcp"],
      "enabled": true
    }
  }
}
```

4. Migrate runtime config file (if present):

```bash
mkdir -p ~/.config/codemem
cp ~/.config/opencode-mem/config.json ~/.config/codemem/config.json
```

5. Restart OpenCode.
6. Verify codemem health:

```bash
codemem stats
codemem db raw-events-status
```

7. Confirm migrated default DB exists:

```bash
ls ~/.codemem/mem.sqlite
```

8. Remove legacy tool only after successful verification:

```bash
uv tool uninstall opencode-mem
```

Expected DB behavior:
- First codemem run migrates `~/.opencode-mem.sqlite` to `~/.codemem/mem.sqlite`.
- Migration includes SQLite sidecars (`-wal`, `-shm`).
- If the new default DB already exists, legacy DB is left untouched.
- If migration is skipped because a new DB already exists, move/copy legacy DB manually.

### Runtime/CLI migration

- Prefer published package installs (`codemem`) over git-based `uvx --from git+...`.
- If runtime is older than supported minimum, plugin warns and provides upgrade command.
- Keep `opencode-mem` installed until one successful codemem run is confirmed, then uninstall it.
- Remove `runner_from` from `~/.config/codemem/config.json` for normal installed behavior.

### Dev machine behavior

- Inside the codemem repo, OpenCode auto-loads `.opencode/plugin/codemem.js` (dev mode).
- Outside the repo, OpenCode uses configured plugin package (`@kunickiaj/codemem`).
- For realistic migration validation on a dev machine, run at least one session outside the repo.
- Viewer auto-start now occurs on plugin initialization and is idempotent.

## Release communication template

Use this snippet in release notes for migration releases:

```text
CodeMem rename update:
- Repo moved to github.com/kunickiaj/codemem
- Plugin package: @kunickiaj/codemem
- Python package: codemem
- Existing codemem command remains supported during transition window
```

## Completion criteria

- Docs updated to show new names first
- Release notes include migration snippet
- Fallback paths documented and tested
- Transition window end date announced before alias removal
- Migration checklist includes backup, verification, and legacy uninstall order
