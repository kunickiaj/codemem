# Observer Extraction Model Evaluation Design

**Status:** Approved
**Date:** 2026-07-10
**Tracking:** `codemem-h67n`

## Problem

The current `rich-batch-shape` benchmark still treats two to four observations as
a correctness requirement. That conflicts with the observer worthiness policy
introduced in PR #1308, where zero or one observation can be correct when only
that many durable facts clear the worthiness bar. The stale minimum also triggers
a repair call that pressures models to manufacture additional observations.

As a result, the benchmark rewards observation count even when the additional
records are redundant or contain routine process narration. It also combines
initial quality with repair behavior and does not expose content lost because a
model used unsupported XML fields or invalid nesting.

## Goals

- Judge durable memory quality rather than raw observation count.
- Keep observation cardinality as descriptive telemetry.
- Score initial output independently from repaired output.
- Detect invalid XML structure, unsupported fields, and parser data loss.
- Label required, optional, and forbidden durable facts for reviewed batches.
- Report quality, latency, token usage, repair frequency, and estimated cost.
- Produce output that supports blinded human review.

## Non-goals

- Changing production observer defaults in the evaluation implementation.
- Replacing provider-aware strict structured output work.
- Treating a model judge as authoritative without labelled fixtures or review.
- Requiring every rich batch to produce multiple observations.

## Design

### Worthiness-aligned evaluation

Routine scenarios may continue to enforce zero observations because that is a
specific behavioural contract. Rich and working scenarios will not fail solely
because their observation count is below a fixed minimum. A rich result fails
only when labelled durable content is omitted, forbidden/noisy content is emitted,
the summary is unusable, or the response cannot be safely parsed.

Replay will preserve the initial response and its evaluation. Repair will be a
separate recovery measurement. Cardinality alone will not trigger rich-session
repair.

### Structural diagnostics

Evaluation will inspect the raw XML before relying on the permissive parser. It
will report illegal nesting, unknown summary fields, multiple summary blocks,
unsupported observation kinds, and generated content discarded by parsing.
These diagnostics remain evaluation-only until strict structured extraction is
available for each provider.

### Durable-fact labels

Reviewed benchmark batches may define:

- `required`: durable facts whose omission is a recall failure;
- `optional`: useful facts that add value but are not required;
- `forbidden`: telemetry, routine process narration, unsupported claims, or
  known redundant framings that should not become durable observations.

Labels use grounded keywords plus reviewer notes. Automated matching provides a
repeatable first pass; the report retains raw outputs for human adjudication.

### Scoring

The model comparison reports independent dimensions:

- required durable-fact recall;
- worthiness precision;
- factual grounding;
- segmentation and non-redundancy;
- summary breadth;
- schema compliance and parser retention.

No single observation-count gate determines the result. Aggregate scores remain
review aids rather than substitutes for inspecting close comparisons.

### Cost and performance

Each run reports elapsed time, initial and repair call counts, available provider
usage fields, and estimated cost from an explicit pricing table. Unknown usage is
reported as unknown rather than inferred from string length.

## Rollout

1. Align replay and existing scenarios with the worthiness policy and add
   structural diagnostics.
2. Add labelled durable-fact scoring, usage/cost reporting, and review output.
3. Calibrate GPT-5.4-mini, GPT-5.4, GPT-5.5, and GPT-5.6 Terra on a small diverse
   set, then repeat finalists on a larger reviewed set.
4. Consider changing the rich-tier model only after repeated quality and
   downstream retrieval results support the change.

## Validation

- Unit tests cover zero/one-observation rich outputs, invalid nesting, unknown
  fields, parser loss, and initial-versus-repair reporting.
- Existing routine-session zero-observation behavior remains protected.
- Targeted typecheck, lint, and tests pass for each stacked PR.
- Calibration results include raw outputs and reviewer-readable dimension scores.

## Initial Model Recommendation

Keep GPT-5.4-mini as the simple-tier default and GPT-5.4 as the rich-tier
default. Treat GPT-5.6 Terra as the leading cost-matched rich-tier challenger
and GPT-5.5 as the higher-cost quality ceiling. Existing reviewed samples show
Terra is competitive, but two batches are not enough evidence for a production
default change. Use reasoning effort `none` for this extraction workload unless
the corrected evaluation demonstrates a repeatable gain from additional
reasoning.
