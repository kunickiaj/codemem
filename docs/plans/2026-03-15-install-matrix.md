# Native Install & Package Matrix

**Status:** Decision
**Date:** 2026-03-15

Context: codemem's npm package ships three native dependencies. This document maps
what each package requires per platform, what users need installed, and what breaks.

## Platform Support Matrix

| Platform | better-sqlite3 | sqlite-vec | onnxruntime-node |
|---|---|---|---|
| macOS arm64 | ✅ Bundled binary | ✅ Prebuild (.dylib) | ✅ Prebuild |
| macOS x64 | ✅ Bundled binary | ✅ Prebuild (.dylib) | ✅ Prebuild |
| Linux x64 | ✅ Bundled glibc/musl binaries | ✅ Prebuild (.so) | ✅ Prebuild |
| Linux arm64 | ✅ Bundled glibc/musl binaries | ✅ Prebuild (.so) | ✅ Prebuild |
| Windows x64 | ✅ Bundled binary | ✅ Prebuild (.dll) | ✅ Prebuild |

better-sqlite3 13.0.3 bundles N-API prebuilds for macOS, Linux glibc, Linux
musl, and Windows on x64 and arm64. Version 13.0.0's Linux arm64 binary required
newer glibc and libstdc++ symbols than Debian Bookworm provides; upstream rebuilt
it on Ubuntu 22.04 for 13.0.3.

### Why upgrade from better-sqlite3 12.8.0

The upgrade primarily improves native-module compatibility and maintenance; codemem
does not need the two new query-inspection APIs yet.

| Area | 12.8.0 | 13.0.3 | Effect on codemem |
|---|---|---|---|
| Native API | V8-version-specific addon | Node-API v10 addon | One bundled binary works across supported Node releases |
| Prebuild delivery | Downloaded by an install script | 8 binaries bundled in the package | Removes better-sqlite3's install-time network lookup and works when npm lifecycle scripts are disabled |
| Bundled SQLite | 3.51.3 | 3.53.4 | Gains SQLite 3.53 features and subsequent fixes |
| Query diagnostics | Prepared `EXPLAIN` statements | Adds `db.explain()` and `Statement#toString()` | Available at runtime for future diagnostics; `@types/better-sqlite3` does not declare them yet |
| Runtime fixes | Baseline | Cross-realm errors and bindings, table-parameter validation, and worker-termination abort fixes | Lower risk in tests, workers, and multi-realm runtimes |
| Unpacked package size | 10.3 MB | 27.3 MB | Adds 17.0 MB because every supported binary ships together |

Version 13 drops Windows x86, Linux armv7, Electron before v35, and Node before
v22. codemem already requires Node 24.15+ and supports x64/arm64, so those removals
do not narrow its documented support. The N-API migration also removes
better-sqlite3's `prebuild-install` dependency, although codemem still receives
that package transitively through Transformers.js and Sharp.

### How each package ships native code

| Package | Native strategy | Build system | Fallback |
|---|---|---|---|
| better-sqlite3 | Bundled N-API binaries selected at runtime | node-gyp (explicit `build-release` only) | Runtime load error at first `new Database()` if the platform has no bundled binary; install still succeeds |
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

**better-sqlite3 bundles its own SQLite** (currently v3.53.4) compiled from the
amalgamation source. It does NOT use a system SQLite.

**sqlite-vec does not conflict.** The sqlite-vec .dylib/.so is loaded via
`db.loadExtension()`, which loads the shared library into the running SQLite
instance managed by better-sqlite3. The extension hooks into the host's SQLite
API — it doesn't bundle or link its own SQLite. No version conflict, no symbol
collision.

The only requirement is that the host SQLite version supports the extension's
required APIs. sqlite-vec uses virtual tables and standard extension entry
points, which have been stable since SQLite 3.9.0 (2015). better-sqlite3's
bundled 3.53.4 is well above this.

## Install Size Budget

| Package | Unpacked size | Notes |
|---|---|---|
| better-sqlite3 | ~27 MB | Includes SQLite amalgamation source + bundled binaries for supported platforms |
| sqlite-vec (per-platform) | ~160 KB | Only the matching platform package is installed |
| onnxruntime-node | **~220 MB** | Ships all platform binaries in one package |
| **Total (with onnxruntime)** | **~247 MB** | Dominated by onnxruntime |
| **Total (without onnxruntime)** | **~27 MB** | Core functionality only |

onnxruntime-node is 95% of the install weight. This is the strongest argument
for making it optional (see §Optional Dependencies below).

## Build Tool Requirements

### When prebuilds are available (most users)

No build tools required. `npm install` uses the bundled better-sqlite3 binary and
obtains prebuilt binaries for the other native packages.

### Why the better-sqlite3 build is denied

better-sqlite3 13 includes `binding.gyp` but has no install script. pnpm 12.2.1
therefore synthesizes `node-gyp rebuild` even though `gypfile` is false and a
matching bundled binary exists. node-gyp checks for Python before the package's
GYP condition can detect the prebuild, so minimal Docker images fail during
installation unnecessarily.

The workspace sets `allowBuilds.better-sqlite3: false` to skip that implicit
lifecycle. This is narrower than disabling all install scripts and ensures the
bundled binary is used. Unsupported operating-system and architecture pairs are
not covered by this policy because they would require a deliberate source-build
toolchain and separate validation.

## CI Matrix

### Proposed minimum test matrix

The repository CI currently covers Linux x64 on Node 24. The other rows are the
target support matrix and require release-gate coverage before their results can
be treated as continuous guarantees.

| Runner | Node | Arch | Purpose |
|---|---|---|---|
| `macos-14` (M1) | 24 | arm64 | Primary dev platform and bundled-binary test |
| `ubuntu-24.04` | 24 | x64 | Linux glibc bundled-binary test |
| `ubuntu-24.04-arm` | 24 | arm64 | Linux arm64 bundled-binary test |

### Extended matrix (lower priority)

| Runner | Node | Arch | Purpose |
|---|---|---|---|
| `macos-13` | 24 | x64 | Intel Mac bundled-binary test |
| `windows-latest` | 24 | x64 | Windows bundled-binary test (if supported) |
| Alpine container | 24 | x64 + arm64 | Linux musl bundled-binary test |

### What each CI job validates

1. `npm install` succeeds without compiling better-sqlite3
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

### 1. better-sqlite3 unsupported native targets
**Risk:** The bundled binaries cover x64 and arm64 on macOS, Windows, Linux glibc,
and Linux musl. Other targets need source compilation, which codemem's denied
better-sqlite3 lifecycle does not permit.
**Mitigation:** Keep the documented platform set aligned with tested bundled
binaries. Treat any new operating-system or architecture pair as a separate
support decision with a native-build test.

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
**Risk:** better-sqlite3 13.0.3's Linux binaries require GLIBC 2.34,
GLIBCXX 3.4.29, and CXXABI 1.3.9. Other native dependencies may impose a higher
floor. Old distributions such as CentOS 7 and Amazon Linux 2 do not satisfy the
better-sqlite3 floor.
**Mitigation:** Use a glibc 2.34+ distribution and test the oldest supported
image. Debian Bookworm's glibc 2.36 and libstdc++ 3.4.30 pass the runtime probe.

### 5. Total install weight with onnxruntime + model files
**Risk:** onnxruntime-node is 220 MB. Embedding models (e.g., all-MiniLM-L6-v2
ONNX) add another 20-80 MB. Total install weight for a user wanting embeddings
could hit 300+ MB.
**Mitigation:** Optional dependency strategy keeps the default install at ~27 MB.
Model files should be downloaded on first use, not at install time.
