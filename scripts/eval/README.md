# codemem retrieval eval tooling

Standalone, committed tooling for measuring retrieval/packing quality. **Not** a
`codemem` CLI surface and **not** published — it imports `@codemem/core` and
exercises the same pack ranking path the product uses without recording pack
usage rows.

Why separate: the `codemem memory` command group already carries too much
dev/eval tooling (`role-report`, `role-compare`, `extraction-*`, etc.). New evals
live here instead of polluting the product CLI.

## Pack-eval corpus-quality gate

Runs a probe battery through the pack trace path **once** on a DB and reports the
artifact-bucket shares per retrieval mode. Under the refocused dual-artifact
model `derived_fact` is an in-place role (not a materialized row and not a
ranking boost), so there is no A/B flag to toggle — this is a single-snapshot
corpus-quality measurement gated against a committed baseline. Trace mode avoids
memory/usage-row writes, but the normal `MemoryStore` open path may still apply
SQLite pragmas, planner stats, or additive schema compatibility. For a strict
no-touch run, point `--db` at a copy.

```fish
# from repo root
pnpm run eval:pack -- --db /path/to/codemem.sqlite
pnpm run eval:pack -- --db /path/to/codemem.sqlite --json
pnpm run eval:pack -- --db /path/to/codemem.sqlite --top 5

# freeze a real-corpus baseline, then gate future runs against it
pnpm run eval:pack -- --db /path/to.sqlite --write-baseline scripts/eval/baselines/main.json
pnpm run eval:pack -- --db /path/to.sqlite --baseline scripts/eval/baselines/main.json
```

Exit code is non-zero if the absolute gate fails or the snapshot regressed
against `--baseline`, so it can run in CI.

> **Order matters.** The harness reconstructs the FINAL user-visible pack order
> from `trace.assembly.sections`, not from `trace.retrieval.candidates[].rank`.
> Candidate rank is the raw retrieval order assigned *before*
> `prioritizeDefaultResults` reorders the pack, so scoring by rank would hide the
> effect of relevance-first ordering. Read final order via the section arrays.

### Documented result (relevance-first default ranking)

Before/after on a real-corpus DB copy, identical harness, measuring final pack
order (15-probe battery, top-5):

| metric (non-recap) | overlap-last (old) | relevance-first (new) |
|---|---|---|
| durable share | 73.8% | **76.9%** (+3.1pp) |
| telemetry share | 7.7% | **4.6%** (−3.1pp) |
| summary share | 18.5% | 18.5% (flat) |
| recap summary-first | 100% | 100% (flat) |

Relevance-first moved ~3% of top results from telemetry noise to durable
knowledge with no regression to explicit recap. Modest and corpus-specific;
re-measure when the probe battery or corpus changes.

### What it measures

- **Non-recap retrieval (default/task/debug):** durable share (want high),
  summary share (want low), telemetry share (want low), and stored
  `derived_fact` marker share (diagnostic only — markers do not affect ranking).
- **Explicit recap:** summary share and summary-first rate (want high — ranking
  must not displace summaries in catch-up queries).
- **Routing sanity (absolute gate):** recap-labeled probes must actually route
  through recall mode.

Buckets use the in-place `metadata.derivation.artifact_class` marker (read via
`readArtifactClass`) first, then fall back to the worthiness classifier for
legacy rows. `stored_derived_fact_share` is reported separately as a diagnostic
because classifier fallback can make legacy rows look like derived facts even
when they carry no in-place marker.

Baseline comparison flags drift: summary/telemetry share rising or durable share
falling in non-recap, recap summary-first rate falling, or recap route
mismatches rising are reported as `WORSE` and fail the run.

### Caveats

- Most corpora carry no in-place `derived_fact` markers, so durable content
  surfaces via the `durable_other` bucket and the classifier fallback. That's
  expected: the snapshot measures real corpus quality, not marker coverage.
- Probes live in `scenarios.ts`; extend the battery there.
- `baselines/` holds committed **metrics** (JSON), never corpus data.
- Validate script changes with `pnpm run eval:pack:typecheck`; root `tsc` and
  `lint` primarily cover `packages/`.

## Prompt-path performance benchmark

The development-only prompt-path harness compares the real source CLI with the
canonical `CodememPlugin` using both a healthy foreground viewer and classified
viewer-unavailable CLI fallback. It creates and removes an isolated three-memory
synthetic database, discards one warm-up per path, and measures 30 repetitions by
default:

```fish
pnpm exec tsx --conditions source scripts/eval/prompt-path.ts

# lifecycle smoke only; not eligible for the release gate
pnpm exec tsx --conditions source scripts/eval/prompt-path.ts --repetitions 1
```

The JSON report contains aggregate median/p95 latency, sorted unlabelled timing
samples, failure counts by class, and started pack, ledger, other, and failed
subprocess counts. The median averages the middle pair and p95 uses nearest rank.
The harness never emits fixture text, prompts, memory IDs, database paths, or
per-query results.

This source-tree benchmark intentionally includes an instrumentation shim process
plus the `pnpm exec tsx` startup used by both direct CLI and fallback paths. The
shim records subprocess starts and exits; its overhead is part of those timings.
The comparison validates the benefit of avoiding development CLI process startup,
but its absolute latency and improvement ratio do not represent an installed built
CLI. The small fixture emphasizes startup and transport cost rather than retrieval
cost at realistic corpus size.

The release gate requires a lower healthy-viewer median, a healthy-viewer p95 no
higher than direct CLI, zero healthy pack/ledger subprocesses, and no failed
repetitions. The zero-subprocess check includes a bounded two-second
post-measurement observation window; work that starts or completes in that window
invalidates the run without affecting measured latency. Any other healthy-path CLI
command also invalidates the run. If p95 regresses, repeat the complete 30-run
comparison once; a second regression fails the gate. Fallback latency excludes
asynchronous ledger settlement and is reported separately rather than gating the
performance claim.

Validate harness changes explicitly; this tooling remains outside the product
test command and root CLI scripts:

```fish
pnpm run eval:pack:typecheck
node --import tsx --test scripts/eval/prompt-path-lib.test.ts
```
