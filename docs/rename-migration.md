# Rename Migration Plan

This document tracks migration from `opencode-mem` naming to `CodeMem` package names.

## Canonical names

- GitHub repo: `kunickiaj/codemem`
- npm plugin package: `@kunickiaj/codemem`
- PyPI package: `codemem`

## Compatibility policy

- Keep `opencode-mem` CLI command compatibility for two releases after the first `codemem` release.
- Keep git-based install commands as fallback during migration; move them to advanced docs.
- Keep old references in release notes with explicit replacement commands.

## User migration guidance

### Plugin config migration

Old:

```json
{
  "plugin": ["opencode-mem"]
}
```

New:

```json
{
  "plugin": ["@kunickiaj/codemem"]
}
```

### Runtime/CLI migration

- Prefer published package installs (`codemem`) over git-based `uvx --from git+...`.
- If runtime is older than supported minimum, plugin warns and provides upgrade command.

## Release communication template

Use this snippet in release notes for migration releases:

```text
CodeMem rename update:
- Repo moved to github.com/kunickiaj/codemem
- Plugin package: @kunickiaj/codemem
- Python package: codemem
- Existing opencode-mem command remains supported during transition window
```

## Completion criteria

- Docs updated to show new names first
- Release notes include migration snippet
- Fallback paths documented and tested
- Transition window end date announced before alias removal
