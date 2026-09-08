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

## Automatic recall transport regression

The deterministic incident harness runs the canonical plugin message-transform
hook against a real foreground Viewer and a real source CLI fallback, comparing
the immutable `ad50a6a4` policy with the working candidate. It reuses the
prompt-path transport setup and historical baseline runner; no pack renderer,
selector, HTTP response, or CLI result is mocked.
For CLI cases only, fetch rejects requests to that case's Viewer origin to force
network unavailability without a port-reuse race. CLI child execution and
completion assertions remain real; healthy Viewer cases use real HTTP routes.

```fish
node --import ./scripts/eval/automatic-recall-clock.mjs --import tsx --conditions source scripts/eval/automatic-recall-transport.ts
pnpm run eval:pack:typecheck
```

Run the first command twice and compare the JSON reports. Each run first requires
the frozen historical suite to pass, verifies the fixture bytes against
`5de04daf`, recomputes the recursively key-sorted canonical fixture hash and
asserts the manifest digest, and checks historical source blobs. It exercises mapped, unmapped,
and missing requester identity on both transports, plus uninstrumented CLI
controls for explicit retrieval and generic `Continue`. The baseline must
reproduce the unwanted summary; the candidate must exclude it while keeping the
durable fact. An additional control changes only the requester to the fixture's
summary owner: the summary must remain eligible and the other session's durable
fact must survive. This catches blanket summary suppression or lost identity.
Both explicit controls must remain identical across policies.

Reports include per-case selected fixture keys, useful-fact and wrongful-summary
counts with denominators, missed updates, estimated new/retained tokens, child
counts, effective compression mode, source and harness hashes, runtime versions,
and a Git-status-derived `candidate_dirty` flag beside `candidate_head`.
Token estimates use `Math.ceil(text.length / 4)`: automatic cases include the
actual plugin-injected wrapper; explicit cases measure bare CLI output and are
not directly comparable. The configured budget is 800 and the harness asserts
that its wrapper-inclusive estimate fits, but this is neither a provider token
count nor a guarantee about production reserved-budget accounting. Reports
contain no raw prompts, memory bodies, or database paths. Each run writes an
ignored report copy and `automatic-recall-transport-latest.json` under `.tmp/`;
temporary synthetic databases and historical snapshots remain there for review.

Limits: `CODEMEM_PACK_COMPRESSION=off` is pinned in every case and its children,
overriding ambient compression settings. `CODEMEM_EMBEDDING_DISABLED=1` is set in the harness and its children;
this intentionally measures lexical search and empty-search fallbacks without
provider calls, not semantic retrieval or a full-suite gate. JavaScript Date is
frozen across processes; SQLite's clock is not. Installed dependencies are reused,
not freshly installed. The frozen fixture contains no updates or retained history,
so their denominators are zero. The summary-owner control has no forbidden
summary, so its wrongful-summary denominator is also zero. System-hook fallback, compaction, restart,
and multi-task authority remain outside this transport slice.
