# CodeMem Versioning Policy

CodeMem uses one shared semantic version stream across npm and PyPI artifacts.

## Canonical packages

- npm: `@kunickiaj/codemem`
- PyPI: `codemem` (runtime/CLI)

## Policy

- Release tags `vX.Y.Z` represent the product version.
- npm and PyPI artifacts should publish the same `X.Y.Z`.
- Changelog/release notes are shared per version.

## Compatibility check

The OpenCode plugin performs a runtime CLI version check and warns if the local CLI is below
`CODEMEM_MIN_VERSION` (default `0.9.20`).

Override for testing:

```bash
export CODEMEM_MIN_VERSION=0.9.20
```

## Transition notes

- `codemem` and `codemem-core` are reserved on PyPI.
- `codemem` and `@kunickiaj/codemem` are reserved on npm.
- Git-based install paths remain fallback only during migration.
