# CodeMem Versioning Policy

CodeMem uses one shared semantic version stream across npm and PyPI artifacts.

## Canonical packages

- npm: `@kunickiaj/codemem`
- PyPI: `codemem` (runtime/CLI)

## Policy

- Release tags `vX.Y.Z` represent the product version.
- npm and PyPI artifacts should publish the same `X.Y.Z`.
- Changelog/release notes are shared per version.

## Release helper

Use the helper script to keep versioned files aligned:

```bash
uv run python scripts/release_version.py set X.Y.Z
uv run python scripts/release_version.py check
```

The script updates/checks:

- `pyproject.toml` (`[project].version`)
- `codemem/__init__.py` (`__version__`)
- `package.json` (`version`)
- `.opencode/plugin/codemem.js` (`PINNED_BACKEND_VERSION`)
- `plugins/claude/.claude-plugin/plugin.json` (`version` and `codemem==X.Y.Z` MCP arg)
- `.claude-plugin/marketplace.json` (`metadata.version` and `plugins[*].version` for `codemem`)

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

- `codemem` and `codemem-core` are reserved on PyPI.
- `codemem` and `@kunickiaj/codemem` are reserved on npm.
- Git-based install paths remain fallback only during migration.
