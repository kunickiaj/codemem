# Observer Tier Routing Rollout Plan

**Status:** Draft rollout design
**Date:** 2026-04-08
**Depends on:** replay-only tier routing benchmark work in PR #642

## Goal

Roll out observer tier routing in a way that preserves memory-generation quality
without blindly sending most batches to the expensive model.

## Current replay evidence

### Rich-only benchmark

- benchmark: `rich-batch-shape-v1`
- result with replay-only tier routing:
  - shape-quality passes: `5 / 5`
  - shape-quality fails: `0`
  - robustness no-output cases: `1`

### Mixed-complexity benchmark

- benchmark: `mixed-batch-routing-v1`
- result with refined thresholds:
  - shape-quality passes: `8 / 8`
  - shape-quality fails: `0`
  - robustness no-output cases: `1`
  - expected-tier matches: `7 / 9`

### Current routing split on mixed benchmark

- simple tier: `4 / 9`
- rich tier: `5 / 9`

Interpretation:

- the router is no longer a crude “rich for everything” hammer
- truly small/simple batches can stay on the cheap path
- some moderate working batches still escalate intentionally because the cheap
  path under-extracted them

## Current replay-only routing policy

### Simple tier

- provider: `openai`
- model: `gpt-5.4-mini`
- temperature: `0.2`

### Rich tier

- provider: `openai`
- model: `gpt-5.4`
- API mode: Responses
- reasoning: none
- max output tokens: `12000`
- temperature: `0.2`

### Promotion rules

Promote to rich tier when **any** of these are true:

- `eventSpan >= 100`
- `transcriptLength >= 6000`
- `toolCount >= 25`
- `toolCount >= 9 && transcriptLength >= 2000`
- `promptCount >= 3 && toolCount >= 8`

## Recommended live rollout sequence

### Phase 0 — Complete replay-only validation

**Status:** done enough to justify a guarded live rollout.

Requirements already met:

- replay benchmark exists
- rich-only benchmark passes cleanly
- mixed benchmark passes cleanly on shape-quality cases
- no-output robustness failures are tracked separately

### Phase 1 — Live routing behind explicit flag

Add config flag:

- `observer_tier_routing_enabled: false` by default

When disabled:

- preserve current single-model behavior

When enabled:

- compute batch richness signals during ingest
- route observer config through the same tiering decision logic used by replay

### Phase 2 — Instrumentation and visibility

Persist enough metadata to understand live behavior:

- selected tier (`simple` / `rich`)
- selected provider/model
- whether Responses path was used
- routing reasons
- replay/observer no-output failures

Recommended persistence location:

- session post metadata
- observer-created memory metadata
- optional structured maintenance/report output

### Phase 3 — Limited dogfood window

Enable tier routing only for controlled dogfooding first.

Success criteria:

- no increase in no-output failures
- no obvious regression in simple-batch quality
- rich sessions retain or improve durable observation coverage
- observed live routing ratio stays in a sane range (not “rich almost always”)

### Phase 4 — Default-on decision

Only consider default-on when all are true:

- replay benchmarks remain green
- dogfood evidence does not show quality regressions
- routing ratio remains economically sane
- no new systemic robustness failures appear

## Required config surface for live rollout

At minimum:

- `observer_tier_routing_enabled`
- `observer_simple_model`
- `observer_simple_temperature`
- `observer_rich_model`
- `observer_rich_temperature`
- `observer_rich_openai_responses`
- `observer_rich_max_output_tokens`

Optional later:

- `observer_rich_reasoning_effort`
- `observer_rich_reasoning_summary`
- threshold override settings if we need environment-specific tuning

## Risks

### 1. Over-escalation

Risk:

- router silently sends too many batches to the expensive tier

Mitigation:

- keep flag off by default initially
- log tier selections and ratio
- compare live ratios to replay benchmark expectations

### 2. Under-escalation on moderate working batches

Risk:

- cheap tier under-extracts moderate/high-signal batches that did not trip the
  thresholds

Mitigation:

- keep mixed benchmark maintained
- add new failing live examples back into the benchmark set

### 3. Transport divergence

Risk:

- rich tier uses Responses while simple tier may still use the older path,
  causing operational/debugging complexity

Mitigation:

- persist actual selected transport in metadata
- keep benchmark runner able to compare both paths directly

### 4. No-output robustness failures

Risk:

- batches like `18476` still fail due to observer/transport issues unrelated to
  shape quality

Mitigation:

- classify and report no-output separately from shape failures
- do not tune routing thresholds to “solve” transport failures

## Recommendation

Proceed with **Phase 1** next:

- implement live tier-routing behind a flag
- reuse the replay decision function directly
- persist routing metadata for observability
- do not enable by default yet

This is the smallest sane step from replay success to production validation.
