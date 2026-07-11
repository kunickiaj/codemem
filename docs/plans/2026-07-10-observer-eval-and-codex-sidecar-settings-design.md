# Observer evaluation and Codex sidecar settings design

## Problem

The current observer benchmark is too small and internally inconsistent to
support close model-selection decisions. Only two rich batches have durable-fact
labels, one label cannot be satisfied from the replay input, low-signal skips can
be counted as shape failures even when the production prompt asks for them, and
the scoreboard does not preserve raw responses for review.

The settings surface also omits the supported `codex_sidecar` runtime. Core can
auto-select and run it, but the viewer dropdown does not expose it and the viewer
config API rejects it. The viewer exposes the protected Claude command but not
the equivalent Codex command.

## Goals

- Make `codex_sidecar` selectable, saveable, and understandable in Settings.
- Keep protected command configuration read-only while showing both Claude and
  Codex command values.
- Repair benchmark semantics before using results to change defaults.
- Expand the corpus to balanced simple, working, and rich cases.
- Keep model selection separate by transport: direct API, Codex sidecar, and
  OpenCode.
- Preserve enough evidence for human factual-grounding review.
- Measure stability with repeated finalist runs instead of trusting one sample.

## Non-goals

- Do not change production observer defaults in this work.
- Do not claim sidecar latency or subscription usage is directly comparable to
  metered API latency and token cost.
- Do not introduce an LLM-as-judge dependency as the source of benchmark truth.
- Do not silently treat a transport fallback as a successful requested-model run.

## Settings design

Settings > Connection adds **Local Codex session** alongside Direct API and
Local Claude session. Supporting text explains that sidecars use the respective
local CLI login and ignore API credential settings.

The viewer config route accepts `codex_sidecar`, includes `codex_command` as a
protected key, and returns the default `['codex']` command. The advanced settings
area shows read-only Claude and Codex argv fields using the existing protected
configuration pattern.

Model inference and status labels recognize the Codex runtime explicitly. With
no configured model, the UI reports the current Codex-sidecar default,
`gpt-5.1-codex-mini`. This work documents the current behavior but does not
change it.

## Benchmark architecture

One shared corpus feeds three transport-specific leaderboards:

1. Direct API: cheap/simple candidates and rich candidates are compared within
   the metered API transport.
2. Codex sidecar: Luna and the current Codex default are compared within the
   local Codex CLI transport.
3. OpenCode: OpenCode-accessible candidates are compared independently as they
   become available.

Cross-transport quality results may be shown for context, but latency and cost
rankings never mix transports.

The target corpus contains 18 reviewed shape cases:

- 6 simple
- 6 working
- 6 rich

Replay/no-output and malformed-output cases remain a separate robustness set so
they cannot distort extraction-quality counts.

Every shape case records an expected summary disposition:

- `required`: meaningful work must produce one summary.
- `optional`: either a grounded summary or a valid low-signal skip is acceptable.
- `skip`: a valid low-signal skip is the desired result.

Each reviewed durable-fact label includes a human-readable claim, disposition,
source-evidence notes, and conservative matching aliases. Labels must be
satisfiable from the exact replay input. Tests enforce that reviewed labels have
evidence notes and that impossible or empty reviews cannot enter the benchmark.

## Scoring

The report keeps dimensions separate:

- requested-model and transport availability
- recognized/valid output rate
- schema compliance and parser data loss
- summary-disposition correctness
- required and optional durable-fact recall
- forbidden/noise avoidance and worthiness precision
- summary breadth
- redundancy and segmentation
- factual grounding from human review
- latency and same-transport cost
- run-to-run stability

The composite quality score remains secondary. A model cannot be recommended
unless it passes minimum gates for availability, schema/data-loss rate, summary
disposition, factual grounding, and repeated-run reliability. Missing dimensions
stay missing rather than being silently reweighted into an apparently strong
score.

Benchmark JSON preserves initial and repaired raw output, parsed diagnostics,
usage, latency, requested model, resolved model when known, and fallback status.
This makes every aggregate auditable.

## Evaluation workflow

1. Run each candidate once across all reviewed cases for screening.
2. Inspect raw outputs and complete factual-grounding review.
3. Select finalists per transport and tier.
4. Run finalists three times on a balanced representative/challenge subset.
5. Recommend defaults only from repeated results that clear all gates.

Terra remains a rich API finalist because its latency advantage is material and
its only observed shape miss passed on repetition. Luna remains a Codex-sidecar
finalist; it is not treated as an API or OpenCode replacement until available on
those routes.

## Error handling

- Valid `low-signal` skips are classified by expected disposition, not as generic
  no-output failures.
- Empty output, malformed XML, unavailable requested models, and fallback-model
  output remain distinct statuses.
- Sidecar runs with missing usage report usage as unavailable; they do not invent
  token cost.
- Benchmark reports retain partial run evidence when another case fails.

## Testing

- Viewer route tests cover accepting `codex_sidecar`, rejecting unknown runtimes,
  and protecting `codex_command`.
- Settings helper/component tests cover runtime options, model hints, auth/status
  text, and Codex command form state.
- Benchmark tests cover disposition classification, raw-output preservation,
  reviewed-label evidence requirements, separate robustness accounting, and
  non-reweighting of missing quality dimensions.
- Focused Vitest files run first, followed by `pnpm run tsc`, `pnpm run lint`, and
  `pnpm run test`.

## Rollout

The settings support can ship without changing runtime defaults. The repaired
benchmark and expanded annotations ship as evaluation infrastructure. Any future
default change is a separate decision backed by repeated transport-specific
results.
