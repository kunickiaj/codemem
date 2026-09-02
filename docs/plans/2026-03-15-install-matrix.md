# Native Install & Package Matrix

**Status:** Decision
**Date:** 2026-03-15

Context: codemem's npm package ships three native dependencies. This document maps
what each package requires per platform, what users need installed, and what breaks.

## Platform Support Matrix

| Platform | better-sqlite3 | sqlite-vec | onnxruntime-node |
|---|---|---|---|
| macOS arm64 | ✅ Bundled prebuild | ✅ Prebuild (.dylib) | ✅ Prebuild |
| macOS x64 | ✅ Prebuild available | ✅ Prebuild (.dylib) | ✅ Prebuild |
| Linux x64 | ✅ Prebuild available | ✅ Prebuild (.so) | ✅ Prebuild |
| Linux arm64 | ✅ Bundled prebuild | ✅ Prebuild (.so) | ✅ Prebuild |
| Windows x64 | ✅ Prebuild available | ✅ Prebuild (.dll) | ✅ Prebuild |

better-sqlite3 13 bundles Node-API binaries for x64 and arm64 on macOS, Windows,
glibc Linux, and musl Linux. Node 24 therefore uses a bundled binary on every
platform in the supported matrix.

### How each package ships native code

| Package | Native strategy | Build system | Fallback |
|---|---|---|---|
| better-sqlite3 | Bundled platform binaries | node-gyp validates the bundled binary during install | Source compilation on unsupported targets |
| sqlite-vec | `optionalDependencies` per-platform packages | None — prebuilt binaries only | Fatal error if platform unsupported |
| onnxruntime-node | Single package, postinstall downloads platform binary | N-API addon, prebuilt | Fatal error if platform unsupported |

### sqlite-vec platform packages

The `sqlite-vec` npm package uses the `optionalDependencies` pattern with
platform-specific sub-packages:

- `sqlite-vec-darwin-arm64`
- `sqlite-vec-darwin-x64`
- `sqlite-vec-linux-arm64`
- `sqlite-vec-linux-x64`
- `sqlite-vec-windows-x64`

Each sub-package declares `os` and `cpu` fields so npm only installs the
matching one. No compilation step.

## SQLite Version Compatibility

**better-sqlite3 bundles its own SQLite** (currently v3.53.3) compiled from the
amalgamation source. It does NOT use a system SQLite.

**sqlite-vec does not conflict.** The sqlite-vec .dylib/.so is loaded via
`db.loadExtension()`, which loads the shared library into the running SQLite
instance managed by better-sqlite3. The extension hooks into the host's SQLite
API — it doesn't bundle or link its own SQLite. No version conflict, no symbol
collision.

The only requirement is that the host SQLite version supports the extension's
required APIs. sqlite-vec uses virtual tables and standard extension entry
points, which have been stable since SQLite 3.9.0 (2015). better-sqlite3's
bundled 3.53.3 is well above this.

## Install Size Budget

| Package | Unpacked size | Notes |
|---|---|---|
| better-sqlite3 | ~27 MB | Includes SQLite amalgamation source + eight platform prebuilds |
| sqlite-vec (per-platform) | ~160 KB | Only the matching platform package is installed |
| onnxruntime-node | **~220 MB** | Ships all platform binaries in one package |
| **Total (with onnxruntime)** | **~247 MB** | Dominated by onnxruntime |
| **Total (without onnxruntime)** | **~27 MB** | Core functionality only |

onnxruntime-node still dominates the install weight. This is the strongest argument
for making it optional (see §Optional Dependencies below).

## Build Tool Requirements

### Supported platforms

better-sqlite3 13 ships its supported binaries inside the npm package. Its
install step still invokes node-gyp to select the bundled binary, so Python and
the platform build runner must be available even though no C++ compilation is
expected on supported targets.

### When better-sqlite3 must compile from source

This applies to unsupported operating systems or CPU architectures, or when a
bundled binary cannot load.

| Platform | Required tools |
|---|---|
| macOS arm64 | Xcode Command Line Tools (`xcode-select --install`) — provides clang++, make, python3 |
| Linux arm64 | `build-essential` (gcc/g++, make), `python3` |
| Linux x64 | `build-essential`, `python3` (only if prebuild missing) |

Source compilation requires Python 3, a C++ compiler supporting C++20, and make.
These are standard on developer machines but **not** on minimal CI images or
Docker containers. better-sqlite3's node-gyp configuration selects a bundled
binary when the current platform and architecture are supported.

## CI Matrix

### Minimum test matrix

| Runner | Node | Arch | Purpose |
|---|---|---|---|
| `macos-14` (M1) | 22 | arm64 | Primary dev platform, prebuild test |
| `macos-14` (M1) | 24 | arm64 | Bundled prebuild test |
| `ubuntu-24.04` | 22 | x64 | Standard Linux, prebuild test |
| `ubuntu-24.04` | 24 | x64 | Latest Node on Linux |
| `ubuntu-24.04-arm` | 22 | arm64 | Linux arm64 prebuild test |

### Extended matrix (lower priority)

| Runner | Node | Arch | Purpose |
|---|---|---|---|
| `macos-13` | 22 | x64 | Intel Mac support |
| `windows-latest` | 22 | x64 | Windows baseline (if we support it) |
| `ubuntu-24.04-arm` | 24 | arm64 | Linux arm64 bundled prebuild test |

### What each CI job validates

1. `npm install` succeeds (prebuilds download or compilation works)
2. `better-sqlite3` opens a database and runs queries
3. `sqlite-vec` extension loads via `db.loadExtension()`
4. `onnxruntime-node` loads a model and produces embeddings (optional dep jobs only)
5. Cross-process WAL concurrency (two Node processes hitting the same DB)

## Optional Dependencies Strategy

### Recommendation: Ship two packages

**`optionalDependencies` does NOT reduce default install size** — npm still
installs optional dependencies unless the user explicitly passes
`--omit=optional`. Instead, split into two packages:

- **`codemem`** — core package, no onnxruntime (~27 MB). FTS search works, semantic search is unavailable.
- **`codemem-embeddings`** (or `@codemem/embeddings`) — adds `onnxruntime-node` + `@huggingface/transformers` (~220 MB). Enables semantic search.

Users install what they need:
```bash
npm install codemem                    # Core only (~27 MB)
npm install codemem codemem-embeddings # Full with semantic search (~247 MB)
```

The core package detects `codemem-embeddings` at runtime via dynamic import:

```typescript
let onnxruntime: typeof import('onnxruntime-node') | null = null;
try {
  onnxruntime = await import('onnxruntime-node');
} catch {
  // Embeddings unavailable — semantic search falls back to FTS
}
```

This is a real reduction in install size for the common case, unlike
`optionalDependencies` which is a no-op for default `npm install`.

#### Runtime detection

```typescript
let onnxruntime: typeof import('onnxruntime-node') | null = null;
try {
  onnxruntime = await import('onnxruntime-node');
} catch {
  // Embeddings unavailable — semantic search falls back to FTS
}
```

#### User-facing behavior

| onnxruntime installed? | Embedding commands | Semantic search | FTS search |
|---|---|---|---|
| Yes | Work normally | Available | Available |
| No | Error with install instructions | Unavailable (graceful) | Available |

The CLI should detect the missing optional dep and print:
```
Embeddings require onnxruntime-node. Install it with:
  npm install onnxruntime-node
```

#### Install instructions in README

```bash
# Core install (~27 MB)
npm install codemem

# With embedding support (~247 MB)
npm install codemem onnxruntime-node
```

## Open Risks

### 1. better-sqlite3 prebuild lag on new Node versions
**Risk:** Every major Node release has a window where prebuilds aren't published
yet for all platforms. Users on bleeding-edge Node hit a compilation requirement.
**Mitigation:** Pin `engines` to Node versions with confirmed prebuilds. Document
build tool requirements clearly. Consider self-hosting prebuilds if the window
is long.

### 2. onnxruntime-node postinstall fragility
**Risk:** onnxruntime-node's `postinstall` script downloads binaries at install
time. This fails behind corporate proxies, in air-gapped environments, or when
Microsoft's CDN is down.
**Mitigation:** Being an optional dependency limits blast radius. Document proxy
configuration (`global-agent` is already a dep of onnxruntime-node). Consider
bundling the model file separately from the runtime.

### 3. sqlite-vec alpha stability
**Risk:** sqlite-vec is `0.1.7-alpha.2`. API surface or binary format could
change. The npm package structure (optionalDependencies pattern) is good, but
the extension itself is pre-1.0.
**Mitigation:** Pin to a specific version. Test extension loading in CI. Be
prepared to vendor the .dylib/.so if the npm package becomes unmaintained.

### 4. glibc minimum on Linux
**Risk:** Prebuilt binaries (sqlite-vec, onnxruntime-node, better-sqlite3
prebuilds) are compiled against a specific glibc version. Old distros
(CentOS 7, Amazon Linux 2) may not have a new enough glibc.
**Mitigation:** Document minimum Linux versions. Test on Ubuntu 22.04+ which
covers the vast majority of Node.js deployments.

### 5. Total install weight with onnxruntime + model files
**Risk:** onnxruntime-node is 220 MB. Embedding models (e.g., all-MiniLM-L6-v2
ONNX) add another 20-80 MB. Total install weight for a user wanting embeddings
could hit 300+ MB.
**Mitigation:** Optional dependency strategy keeps the default install at ~27 MB.
Model files should be downloaded on first use, not at install time.
