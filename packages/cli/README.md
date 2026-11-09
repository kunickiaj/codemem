# codemem

Persistent memory for AI coding agents — local-first SQLite storage, hybrid retrieval,
automatic OpenCode and Pi injection, and optional peer-to-peer sync.

This is the published npm package for the `codemem` CLI.

## Install

**Prerequisites:** Node.js 24.15+ and npm. Native database support
covers macOS x64/arm64, Linux x64/arm64 (glibc 2.34+ or musl), and Windows x64.
32-bit targets, including Linux armv7, are not supported.

On Linux, skip the unused ONNX Runtime GPU provider download:

```text
env ONNXRUNTIME_NODE_INSTALL=skip npm install -g codemem
```

On Apple silicon macOS and Windows:

```text
npm install -g codemem
```

The CLI installs its matching embedding runtime by default. For a smaller
keyword-only install, use `npm install -g codemem --omit=optional` and set
`CODEMEM_EMBEDDING_DISABLED=1` in every Codemem process. The flag is required
because npm also omits sqlite-vec's optional platform package; the CLI then
remains functional with FTS5.

Intel x64 Macs have no ONNX Runtime 1.24.3 artifact and remain on FTS5 retrieval.

Or run without installing:

```text
npx -y codemem memory stats
```

## Quick commands

```text
codemem --help
codemem setup --opencode-only
codemem setup --pi-only
codemem memory stats
codemem memory search "query"
codemem memory context "investigate the retry regression"
codemem memory context trace "investigate the retry regression"
codemem memory distill --limit 10
codemem service start
codemem mcp
```

`memory context <task>` prints prompt-ready memory text. Add `--json` for the
structured pack response and its metrics. It supports the pack retrieval and
rendering flags, including `--compact` and `--compression-mode`. `memory pack`
remains available as a hidden compatibility entrypoint for installed integrations
and Pi callers.

## Documentation

- Repository: https://github.com/kunickiaj/codemem
- Full README: https://github.com/kunickiaj/codemem#readme
- User guide: https://github.com/kunickiaj/codemem/blob/main/docs/user-guide.md
- Architecture: https://github.com/kunickiaj/codemem/blob/main/docs/architecture.md
- Pi integration: https://github.com/kunickiaj/codemem/blob/main/docs/plugin-reference.md#pi-extension
