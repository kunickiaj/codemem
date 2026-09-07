# codemem

Persistent memory for AI coding agents — local-first SQLite storage, hybrid retrieval,
automatic OpenCode injection, and optional peer-to-peer sync.

This is the published npm package for the `codemem` CLI.

## Install

**Prerequisites:** Node.js 24.15+ and npm. Native database support
covers macOS x64/arm64, Linux x64/arm64 (glibc 2.34+ or musl), and Windows x64.
32-bit targets, including Linux armv7, are not supported.

On Linux, skip the unused ONNX Runtime GPU provider download:

```bash
env ONNXRUNTIME_NODE_INSTALL=skip npm install -g codemem
```

On Apple silicon macOS and Windows:

```bash
npm install -g codemem
```

The CLI installs its matching embedding runtime by default. For a smaller
keyword-only install, use `npm install -g codemem --omit=optional` and set
`CODEMEM_EMBEDDING_DISABLED=1` in every Codemem process. The flag is required
because npm also omits sqlite-vec's optional platform package; the CLI then
remains functional with FTS5.

Intel x64 Macs have no ONNX Runtime 1.24.3 artifact and remain on FTS5 retrieval.

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
