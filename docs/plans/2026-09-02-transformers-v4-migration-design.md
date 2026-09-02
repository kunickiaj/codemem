# Transformers.js v4 Migration

**Status:** Approved

**Date:** 2026-09-02

**Tracking:** `codemem-jnd6.8`

## Decision

The migration will separate performance, packaging, and runtime changes so each can be measured and reviewed independently.

1. Add bounded batch inference while retaining `@xenova/transformers` 2.17.2, fp32 inference, and `Xenova/bge-small-en-v1.5`.
2. Move the heavyweight embedding runtime behind an explicit package boundary so lexical-only installs do not include Transformers.js or ONNX Runtime.
3. Migrate the isolated runtime to `@huggingface/transformers` 4.2.0 using fp32 CPU inference and the existing model.

Quantization, replacement models, and WebGPU are later product experiments. They are not part of this migration stack.

## Why the Work Is Split

The existing task combined unrelated risks, which made a package rename appear to require a model migration and GPU decision.

- Batching is already supported by Transformers.js v2; Codemem's adapter serializes each text.
- The v4 package changes installation cost and native-runtime behavior even when the model stays unchanged.
- Changing model or dtype changes vector identity and retrieval behavior; changing the JavaScript runtime in fp32 does not have the same cost.

Keeping these changes separate gives each pull request one rollback boundary and prevents performance results from being attributed to the wrong change.

## Current State

Codemem currently declares `@xenova/transformers` as a normal `@codemem/core` dependency. The adapter dynamically imports it, but users cannot omit the package during a normal install.

`EmbeddingClient.embed()` accepts multiple texts, yet the Xenova implementation invokes the extractor once per text. `backfillVectors()` also processes one memory at a time and queries existing vector hashes separately for every memory.

Stored vectors use the model repository string as their identity. That is enough for the current single fp32 implementation but cannot distinguish model revision, dtype, or a future incompatible embedding space.

Earlier decisions in `2026-03-15-embedding-packaging.md`, `2026-03-15-install-matrix.md`, and `2026-03-15-runtime-topology-decision.md` proposed a separate embedding package and isolated inference. Those boundaries were not implemented, and their ONNX Runtime packaging details no longer match the packages currently published.

## Measured Baseline

The local probes used Node 24.20.0 on Apple Silicon and the current fp32 `Xenova/bge-small-en-v1.5` model. Timings are directional and will become a checked benchmark before performance claims are shipped.

| Workload | v2 sequential | v2 one batch | v4 sequential | v4 one batch |
|---|---:|---:|---:|---:|
| 32 × 64-character chunks | 83 ms | 47 ms | 63 ms | 18 ms |
| 32 × 1,200-character chunks | 898 ms | 754 ms | 393 ms | 526 ms |

One large batch is not always fastest for long inputs, so batching must use a bounded size rather than sending an entire backfill to the model.

For four representative text probes, v2 and v4 fp32 output had cosine similarity `1.0`. Maximum absolute component differences ranged from `7.9e-8` to `1.14e-7`. Despite that numerical compatibility, legacy rows record only the model repository and cannot prove which revision produced them. The v4 rollout therefore performs one controlled full reindex under the revision-aware identity.

## Installation and Security Findings

The v4 migration improves dependency health but does not produce an audit-clean tree.

| Published consumer | Critical | High | Clean install size |
|---|---:|---:|---:|
| `@xenova/transformers` 2.17.2 | 1 | 4 | 261 MB |
| `@huggingface/transformers` 4.2.0 | 0 | 4 | 381 MB |

The v2 critical finding comes through the old `onnxruntime-web` and `protobufjs` path. Repository overrides can mask that result locally but do not protect downstream npm consumers.

Transformers.js 4.2.0 hard-pins `onnxruntime-node` 1.24.3 and permits Sharp 0.34.x. Its remaining high-severity findings are:

- `adm-zip` below 0.6 through ONNX Runtime's install helper;
- Sharp below 0.35 through the image-processing dependency.

ONNX Runtime 1.29.0 uses `adm-zip` 0.6, but Transformers.js 4.2.0 does not permit that version. Repository-level overrides are not a downstream-consumer fix.

### Linux CUDA behavior

`onnxruntime-node` 1.24.3 is 86 MB compressed and 220 MB unpacked. On Linux x64, its postinstall metadata defaults to `cuda12` and requests `Microsoft.ML.OnnxRuntime.Gpu.Linux` 1.24.3 from NuGet. That archive is 205,523,493 bytes.

Setting `ONNXRUNTIME_NODE_INSTALL=skip` skips the CUDA download while retaining the CPU binary bundled in the npm package. npm 11.19 blocks dependency install scripts until approval, and pnpm can deny the lifecycle explicitly. Codemem cannot impose either policy on consumers using package managers that execute dependency scripts automatically.

The package boundary therefore needs an explicit install contract. Lexical-only users must not receive ONNX Runtime, while embedding users must get CPU-safe installation guidance and validation.

## Stack Design

### PR 1: Bounded batching on v2

This PR changes only inference scheduling and backfill data access.

- Preserve the current model, fp32 vectors, dimensions, and public API.
- Convert a batched tensor into one owned `Float32Array` per input in stable order.
- Use bounded batches for backfill work and avoid one existing-hash query per memory.
- Keep single-query search latency and FTS fallback behavior unchanged.
- Add deterministic adapter tests and a repeatable benchmark harness.

### PR 2: Embedding package boundary

This PR makes installation cost explicit without changing inference output.

- Remove the Transformers runtime from the lexical-only dependency graph.
- Add an embedding runtime package with a narrow factory contract consumed by core.
- Preserve graceful FTS fallback when the runtime is absent.
- Make missing-runtime diagnostics actionable instead of silently swallowing every load error.
- Validate packed lexical-only and embedding-enabled consumers separately.

Worker-thread isolation may be added here only if the existing runtime topology can adopt it without expanding the public contract. Otherwise it remains separately tracked work.

### PR 3: fp32 CPU migration to v4

This PR changes the runtime package but not the embedding model or precision.

- Replace the Xenova import with `@huggingface/transformers`.
- Set `device: "cpu"` and `dtype: "fp32"` explicitly.
- Record model repository, pinned revision, dtype, dimensions, and runtime generation in the vector identity contract.
- Verify supported Node 24 platforms, including packed Windows x64 inference and a Linux x64 CPU-only consumer install.
- Record downstream audit and package-size results in the pull request.
- Preserve FTS fallback if initialization fails.

## Error Handling

Embedding failures remain non-fatal to retrieval, but they must be observable.

- Lexical-only installs report that semantic search is unavailable and name the package needed to enable it.
- Runtime initialization failures retain the cause in diagnostics while search falls back to FTS.
- Batched output with the wrong row count, dimensions, or non-finite values is rejected before any vector is stored.
- WebGPU is not selected automatically; a future WebGPU path must fall back to CPU after a visible initialization failure.

## Vector Compatibility

Runtime version alone will not force later reindexes when the model revision, dtype, dimensions, pooling, and normalization contract remain compatible. This migration is the exception because legacy vectors lack that provenance.

The implementation will define a stable identity containing those fields. The existing maintenance child process builds the new corpus in bounded cross-memory batches and cuts over only after full coverage. Before cleanup, it must merge incremental work queued during inference, drain that delta, and recheck current content hashes so concurrent sync writes cannot be overwritten by stale job metadata or stale target vectors. After cutover, completed-job polling must continue detecting bare-model vectors written by already-running legacy processes; finding one restarts target coverage and cleanup so upgraded readers do not leave those memories lexical-only. Only the measured-compatible legacy default bare-model corpus remains active during this one pinned-v4 rebuild; every other source/target change uses FTS until cutover. New memories written under the target identity during that rebuild use FTS rather than semantic retrieval until cutover. For changed memories, current text likewise relies on FTS while semantic search may still match the pre-change legacy vector. This bounded mixed-mode gap, including temporary stale legacy matches, is accepted to avoid dual-writing under an identity the new runtime did not produce or combining indexes with different provenance; migration progress remains visible, and coverage-gated cutover removes the legacy corpus. Any later q8, fp16, model, pooling, normalization, or revision change at 384 dimensions gets a distinct identity and uses the same controlled path. A dimension change cannot use this side-by-side migration because `memory_vectors` has a fixed `float[384]` column; it requires a separate replacement-table and schema-swap design. Incompatible vectors must never share search results under one model label.

Before release, run that migration against a disposable database backup from a representative installation. Record elapsed time, vectors per second, memory use, batch settings, and corpus size; never benchmark by mutating the source database. GPU results are reported only when a supported backend exists and are not a release dependency.

## Validation

Each pull request must pass its focused package tests and the repository's normal TypeScript, lint, and test gates.

The final stack also requires:

- packed lexical-only consumer installation with no Transformers or ONNX packages;
- packed embedding-enabled installation and real fp32 inference;
- Linux x64 CPU installation without an unexpected CUDA download;
- supported macOS, Linux, and Windows x64 native-runtime probes;
- retrieval-fixture comparison between v2 and v4 fp32;
- clean shutdown after repeated inference to catch ONNX Runtime lifecycle hangs.

## Non-Goals

This stack does not select a new embedding model, change vector dimensions, adopt quantized vectors, promise WebGPU acceleration, or make the dependency tree audit-clean through downstream-only overrides.

Those decisions require their own retrieval-quality, migration-cost, and packaging evidence after the v4 CPU baseline ships.
