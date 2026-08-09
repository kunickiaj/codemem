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
- Validate pack-eval changes with `pnpm run eval:pack:typecheck`. Root tests and
  lint include the release-evaluation tooling; CI also runs its standalone
  typecheck.

## Observer release evaluation

The standalone observer release evaluator compares prompt behavior from exact
historical commits while scoring every response with the evaluator checked out
in the current worktree. It is not a product CLI command and does not change
observer runtime behavior. Detailed output always stays under the ignored
`.tmp/eval-results/release/` tree; optional in-repository output is a strictly
allowlisted aggregate summary and remains explicitly `partial`.

Run the deterministic, credential-free public fixture:

```fish
pnpm run eval:release -- synthetic
```

The fixture covers required durable-fact recall, routine silence, malformed XML
repair, and model fallback for both an approved stable subject and a versioned
candidate. It performs no network requests or model calls.

Run an operator-supplied canonical projected corpus:

```fish
pnpm run eval:release -- run --manifest /path/to/release-manifest.json
pnpm run eval:release -- run --manifest /path/to/release-manifest.json --output scripts/eval/baselines/release/candidate-observer.json
```

The manifest binds the evaluator commit and full transport configuration, each
corpus tier and logical SHA-256 digest, every requested subject ref and semantic
version, repetition count, and the committed evaluator component file set. The
runner resolves all refs to immutable commits before creating the observer
client. It also rejects tracked or untracked evaluator-worktree changes so the
recorded commit and evaluator component digest describe one reproducible tree.
Historical worktrees receive only a version-neutral prompt driver; all parsing
and scoring uses current evaluator code.

Private projected corpora, prompts, transcripts, raw output, local paths, and
credentials must never be committed. Sanitized summaries include only structured
version identities, immutable commits and digests, completeness counters, and
aggregate metric IDs. Observer-only summaries cannot be release attestations.
Explicit `--output` paths must be JSON files below `scripts/eval/baselines/release/` or
`.tmp/eval-results/release/`; path traversal and symlink escapes are rejected.

Validate changes with:

```fish
pnpm run eval:release:typecheck
pnpm run eval:release:test
pnpm run tsc
pnpm run test
```
