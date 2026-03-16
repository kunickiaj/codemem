# Embedding Model Packaging

**Status:** Decision
**Date:** 2026-03-15

## Model Selection

| Property | Value |
|---|---|
| Model | `BAAI/bge-small-en-v1.5` |
| Dimensions | 384 |
| Max tokens | 512 |
| License | MIT |
| Parameters | 33.4M |

Same model as the Python runtime (via `fastembed`). Both runtimes produce identical 384-dim vectors, so they can share a `memory_vectors` table without reindexing.

The `@huggingface/transformers` library uses the community-maintained ONNX conversion at `Xenova/bge-small-en-v1.5`, which provides multiple quantization variants:

| Variant | File | Size | Notes |
|---|---|---|---|
| fp32 | `model.onnx` | 133 MB | Full precision, matches fastembed output exactly |
| fp16 | `model_fp16.onnx` | 67 MB | Half precision, negligible quality loss |
| int8 (quantized) | `model_quantized.onnx` | 34 MB | Default for transformers.js, good quality/size tradeoff |
| q4 | `model_q4.onnx` | 61 MB | 4-bit quantization |

**Decision: Use `model_quantized.onnx` (int8, 34 MB).** This is what `@huggingface/transformers` downloads by default with `dtype: 'q8'`. The quality difference vs fp32 is negligible for codemem's use case (memory search, not benchmark-competitive retrieval). The 4x size reduction matters for first-run download.

The vectors produced by int8 quantized inference will differ slightly from fastembed's fp32 vectors. This is acceptable — search quality is comparable, and each runtime embeds consistently with itself. Cross-runtime vector mixing is already handled by the DB coexistence contract (both runtimes populate the same `memory_vectors` table; stale vectors are detected via `backfill_vectors`).

## Version Pinning

Pin to an exact HuggingFace commit hash to prevent silent model drift.

```typescript
const MODEL_ID = 'Xenova/bge-small-en-v1.5';
const MODEL_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';

const extractor = await pipeline('feature-extraction', MODEL_ID, {
  revision: MODEL_REVISION,
  dtype: 'q8',
});
```

The `revision` parameter is passed through to HuggingFace Hub API calls. It locks to a specific commit, preventing upstream changes from altering model behavior or file layout.

**Upstream model (BAAI) revision:** `5c38ec7c405ec4b44b94cc5a9bb96e735b38267a` (last modified 2024-02-22). The Xenova conversion is derived from this. If BAAI publishes a new version, we'd need to verify the Xenova conversion is updated and re-pin.

**Update process:** Bump `MODEL_REVISION` in source, run the embedding test suite to verify vector output hasn't regressed, and release a new version. No automatic updates.

## Cache Strategy

### Where models live

`@huggingface/transformers` in Node.js caches downloaded models to the filesystem. The default location is `~/.cache/huggingface/transformers/` — the library uses a `FileCache` implementation that stores blobs keyed by URL.

We override the cache directory to keep all codemem data colocated:

```typescript
import { env } from '@huggingface/transformers';

env.cacheDir = path.join(codememDataDir, 'models');
// e.g., ~/.codemem/models/
```

This keeps the model cache next to the SQLite DB and avoids polluting the global HuggingFace cache (which may be cleaned by other tools).

### Cache structure

The library stores files as:
```
~/.codemem/models/
  Xenova/bge-small-en-v1.5/
    onnx/model_quantized.onnx   (34 MB)
    tokenizer.json               (~700 KB)
    tokenizer_config.json
    config.json
```

Total cached size: ~35 MB.

### Cache invalidation

No automatic invalidation. The pinned revision ensures the same files are always fetched. Cache is invalidated only when:
1. User deletes `~/.codemem/models/` manually
2. We bump `MODEL_REVISION` in a new release (new revision → new cache key → re-download)

## First-Run Experience

### What happens

1. User runs a command that needs embeddings (e.g., `codemem embed`, or the viewer+sync process computes vectors for new memories)
2. The embedding worker thread is lazy-started (per runtime topology decision)
3. Worker calls `pipeline('feature-extraction', MODEL_ID, { revision, dtype })` 
4. `@huggingface/transformers` checks the local cache
5. **Cache miss (first run):** downloads ~35 MB from HuggingFace Hub
6. Model loads into onnxruntime session (~1-3s on modern hardware)
7. First embedding is computed

### Latency budget (first run)

| Phase | Estimate |
|---|---|
| Download (35 MB, broadband) | 3-10s |
| Download (35 MB, slow connection) | 30-60s |
| ONNX session initialization | 1-3s |
| First inference (warm-up) | 50-200ms |
| **Total (broadband)** | **5-15s** |

### Progress indication

`@huggingface/transformers` accepts a `progress_callback` option:

```typescript
const extractor = await pipeline('feature-extraction', MODEL_ID, {
  revision: MODEL_REVISION,
  dtype: 'q8',
  progress_callback: (progress) => {
    // progress.status: 'download' | 'progress' | 'done'
    // progress.file: filename being downloaded
    // progress.progress: 0-100 percentage
    // progress.loaded / progress.total: bytes
  },
});
```

The worker thread forwards progress events to the main process via `postMessage`. The main process can:
- Log to stderr for CLI commands (`Downloading embedding model... 45%`)
- Emit via the viewer HTTP API for UI display
- Suppress entirely for MCP (MCP doesn't compute embeddings)

### Offline behavior (no internet on first run)

If the model is not cached and there's no internet:
- `@huggingface/transformers` throws a fetch error
- The embedding worker catches it and reports failure to the main process
- codemem continues operating without embeddings (same as Python: `get_embedding_client()` returns `None` on failure)
- Semantic search falls back to FTS or returns empty results
- Next run with internet will retry the download

The `local_files_only: true` option can be used to skip network attempts entirely (useful for air-gapped environments where models are pre-seeded).

## Bundle vs Download

### Option A: Download on demand (chosen)

Model files are downloaded from HuggingFace Hub on first use and cached locally.

**Pros:**
- npm package stays small (~2-5 MB without model weights)
- Users who disable embeddings (`CODEMEM_EMBEDDING_DISABLED=1`) never download the model
- Model updates don't require a new npm release
- Standard pattern for ML-in-JS tools

**Cons:**
- First-run requires internet access
- Download adds 5-15s latency on first use
- HuggingFace Hub availability is a dependency

### Option B: Bundle in npm package

Ship `model_quantized.onnx` + tokenizer files inside the npm package.

**Pros:**
- Works offline immediately
- No first-run download delay
- No HuggingFace Hub dependency

**Cons:**
- npm package balloons from ~2 MB to ~37 MB
- Every `npm install` downloads 37 MB even if embeddings are disabled
- npm has a 2 GB package size limit but discourages large packages (registry bandwidth costs)
- Model updates require a new npm release
- Users who already have the model cached download it again in the package

### Option C: Separate `@codemem/model-bge-small` package

Ship the model as a separate optional dependency.

**Pros:**
- Main package stays small
- Opt-in: only installed when embeddings are wanted
- Works offline once installed

**Cons:**
- Extra package to manage and version
- Users must know to install it
- npm registry still carries the bandwidth cost
- Complicates the install story

**Decision: Option A (download on demand).** This matches the Python runtime's behavior (fastembed downloads models on first use) and keeps the package small. The 5-15s first-run delay is a one-time cost with clear progress indication.

### Pre-seeding for offline environments

For air-gapped or CI environments, document a pre-seed command:

```bash
codemem model download    # downloads model to ~/.codemem/models/
```

This runs the pipeline initialization once, populating the cache. Subsequent runs work offline with `local_files_only: true` (auto-detected when cache is warm).

## Per-Platform Packaging

### ONNX models are platform-neutral

The `model_quantized.onnx` file is a serialized computation graph. It runs identically on macOS, Linux, and Windows. No per-platform model variants needed.

### onnxruntime-node is platform-specific

`onnxruntime-node` ships native binaries per platform+arch. npm handles this via `optionalDependencies` with platform-specific packages:

```
@onnxruntime/node-darwin-arm64
@onnxruntime/node-darwin-x64
@onnxruntime/node-linux-arm64
@onnxruntime/node-linux-x64
@onnxruntime/node-win32-x64
```

npm's `os`/`cpu` fields in each sub-package ensure only the relevant binary is installed. No action needed from codemem — this is handled by the onnxruntime-node package itself.

### Platform matrix

| Platform | ONNX model | onnxruntime binary | Status |
|---|---|---|---|
| macOS arm64 (Apple Silicon) | Same | `darwin-arm64` | Primary target |
| macOS x64 | Same | `darwin-x64` | Supported |
| Linux x64 | Same | `linux-x64` | Supported (CI, servers) |
| Linux arm64 | Same | `linux-arm64` | Supported |
| Windows x64 | Same | `win32-x64` | Supported |

### GPU acceleration

Not in scope. codemem's embedding workload (short text chunks, batch sizes <100) doesn't benefit meaningfully from GPU acceleration. CPU inference at 10-50ms per item is fast enough. The onnxruntime CPU backend is the default and requires no additional setup.

## Compatibility with Python

### Can both runtimes share cached model files?

No, and they shouldn't try.

| Aspect | Python (fastembed) | TS (@huggingface/transformers) |
|---|---|---|
| Cache location | `~/.cache/fastembed/` | `~/.codemem/models/` |
| Model format | ONNX (fastembed's own download) | ONNX (from HuggingFace Hub) |
| Quantization | fastembed default (varies) | int8 (`model_quantized.onnx`) |
| File layout | fastembed-specific directory structure | HuggingFace Hub cache structure |

The cache formats are incompatible. Each runtime manages its own model download and cache independently. This is fine — the 35 MB duplication is negligible, and coupling cache formats across runtimes would be fragile.

### Can both runtimes share computed vectors?

Yes. Both runtimes write to the same `memory_vectors` table (per the DB coexistence contract). Vectors are 384-dim floats regardless of runtime. The slight numerical differences between fp32 (fastembed) and int8-quantized (TS) inference don't affect search quality — cosine similarity rankings are stable across these precision levels.

If a user switches runtimes, stale vectors from the old runtime remain valid. The `backfill_vectors` process detects memories without vectors and computes them, but it doesn't re-embed memories that already have vectors.

## Open Risks

1. **HuggingFace Hub availability.** First-run depends on HuggingFace Hub being reachable. Mitigation: clear error message, retry logic, and `codemem model download` for pre-seeding. The Xenova repo has been stable for 2+ years.

2. **Xenova repo maintenance.** The `Xenova/bge-small-en-v1.5` conversion is community-maintained. If it disappears, we'd need to host our own ONNX conversion or switch to the BAAI repo's ONNX (which lacks quantized variants). Mitigation: pinned revision means cached copies keep working indefinitely.

3. **onnxruntime-node binary compatibility.** New Node.js major versions or OS updates could break onnxruntime-node. Mitigation: pin onnxruntime-node version, test across supported platforms in CI.

4. **int8 vs fp32 vector drift.** If a user's DB has a mix of fp32 (Python) and int8 (TS) vectors, search results may be slightly inconsistent. Mitigation: this is a known acceptable tradeoff (documented above). A future `codemem embed --recompute` command could normalize all vectors to a single precision.

5. **Model size growth.** If we later need a larger/better model (e.g., `bge-base-en-v1.5` at 768-dim), the download grows to ~130 MB and the vector table size doubles. This is a future concern, not a current blocker — model selection is a one-way door for existing vector data.
