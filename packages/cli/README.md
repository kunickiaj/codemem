# codemem

Persistent memory for AI coding agents — local-first SQLite storage, hybrid retrieval,
automatic OpenCode injection, and optional peer-to-peer sync.

This is the published npm package for the `codemem` CLI.

## Install

**Prerequisites:** Node.js 24.15+ and npm (or pnpm). Native database support
covers macOS x64/arm64, Linux x64/arm64 (glibc 2.34+ or musl), and Windows x64.
32-bit targets, including Linux armv7, are not supported.

```bash
npm install -g codemem
```

Or run without installing:

```bash
npx -y codemem stats
```

## Quick commands

```bash
codemem --help
codemem setup --opencode-only
codemem stats
codemem search "query"
codemem distill --limit 10
codemem serve start
codemem mcp
```

## Documentation

- Repository: https://github.com/kunickiaj/codemem
- Full README: https://github.com/kunickiaj/codemem#readme
- User guide: https://github.com/kunickiaj/codemem/blob/main/docs/user-guide.md
- Architecture: https://github.com/kunickiaj/codemem/blob/main/docs/architecture.md
