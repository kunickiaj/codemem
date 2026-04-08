# Rich Session Under-Extraction Eval Case

**Status:** Draft evaluation artifact
**Date:** 2026-04-07
**Related bead:** `codemem-31ha`
**Related Track 3 eval bead:** `codemem-24q2`

## Why this case matters

This case is a strong candidate regression / evaluation scenario for Track 3.

It demonstrates a session where the raw-event pipeline appears to work
structurally:

- the session is correctly linked
- the relevant flush batch completed successfully
- there is no persisted observer/provider/auth failure on that batch

But semantically the output is weak:

- only one narrow `discovery` memory and one narrow `session_summary`
- despite a rich, high-signal event tail that covered multiple substantive
  planning and product-quality threads

This suggests that the problem is not "garbage raw events" but likely:

- memory-generation prompt / extraction policy weakness
- long-batch shaping weakness
- or summary-vs-observation persistence policy that is too lossy

## Session identity

- **stream / opencode session id:** `ses_29b51abf5ffefPNFnFBKCHdiF2`
- **local session id:** `166405`

## Session-level context

Session row summary at inspection time:

- `started_at`: `2026-04-06T21:23:59.631Z`
- `ended_at`: `2026-04-07T06:13:45.667Z`
- `prompt_count`: `24`
- `tool_count`: `84`
- `duration_ms`: `1392062`

This is not a tiny or trivial session. It is a long, high-signal working session.

## Completed flush batch under evaluation

From `raw_event_flush_batches`:

- **batch id:** `18503`
- **range:** `1204–1356`
- **status:** `completed`
- **attempt_count:** `1`
- **error_message:** `null`

The batch completed cleanly, which makes the resulting semantic under-extraction
more significant.

## Pending tail observed during investigation

After the completed batch, the live session continued accumulating events.

At inspection time:

- `last_received_event_seq`: `1398`
- `last_flushed_event_seq`: `1356`
- pending gap: `42` events

The pending tail was not low-value noise. Event-type counts for the tail after
`1356` were:

- `tool.execute.after`: `20`
- `assistant_message`: `12`
- `user_prompt`: `11`

## Observed persisted outputs from the completed batch

Latest active memories on the session after the completed flush were:

1. **Memory `13597`**
   - kind: `session_summary`
   - title: `Investigate a regression causing many under-one-minute sessions and unmapped summaries; determine whether the issue originated in the Python-to-TypeScript migration or later raw-event/sessionization changes.`

2. **Memory `13596`**
   - kind: `discovery`
   - title: `Micro-session regression timeline narrowed to raw-event/sessionization changes, not TS migration alone`

These two memories are coherent, but they are too narrow relative to the volume
and richness of the batch.

## Why the raw events appear high-signal

Inspection of the completed range `1204–1356` shows discussion and work around:

- starting and narrowing the `codemem-qd7h` regression investigation
- deciding the root cause had already been identified/fixed and closing `qd7h`
- release readiness / preparing `0.23.0`
- reframing Track 3 around injection-first policy
- graph / progressive disclosure future direction
- release-vs-quality tradeoff discussion
- evaluation methodology and whether under-extraction should block release

This is the opposite of a junk batch.

## Expected output (roughly)

Even if only one final session summary were emitted, a stronger output would
likely have included multiple durable typed observations, such as:

- release-readiness / urgency reasoning for `0.23.0`
- Track 3 reframing to injection-first / reduce rediscovery and scouting effort
- graph / progressive disclosure future-direction insight
- closure of the `qd7h` root-cause investigation

The session summary also should likely have been broader and more representative
of the major shifts in the batch, rather than focusing mostly on the regression
timeline thread.

## Preliminary diagnosis

This case currently points more strongly to semantic under-extraction than to raw
event quality issues.

Most plausible explanations:

1. **Observer prompt / schema is too weak for long, multi-thread session tails**
2. **Long-batch shaping causes the model to over-focus on a narrow recent thread**
3. **Summary-vs-observation persistence policy is too lossy**
4. **Filtering/suppression may be removing useful typed output**

Least plausible explanation:

- the raw events were low-value or mostly junk

## How to use this case

This should be used as a Track 3 evaluation artifact to answer questions like:

- Does codemem reduce rediscovery and scouting effort on long, rich sessions?
- Does a structurally successful flush yield enough durable observations?
- Does summary output adequately reflect the breadth of meaningful work in the
  batch?
- Does the system over-compress long sessions into a single recap plus one typed
  memory?

## Suggested future eval harness expectations

For this scenario class, track:

- number of durable typed observations emitted from a rich batch
- summary breadth / coverage across major subthreads
- whether key decision/outcome/location context survives the flush
- whether resulting memory set would materially reduce future scouting and
  rediscovery effort

## Formal benchmark set (current)

This case is now part of a formal replay benchmark profile:

- **benchmark id:** `rich-batch-shape-v1`
- **generic shape scenario:** `rich-batch-shape`
- **content-specific scenario for this batch:** `rich-session-under-extraction`

### Shape-quality benchmark batches

These batches should be used when comparing observer models or replay shaping
changes for output quality:

- `18503` — flagship under-extraction batch (this case)
- `18502` — adjacent earlier rich batch from the same session
- `18506` — adjacent later rich batch from the same session
- `18432` — large snapshot batch from another session
- `18446` — hard failing snapshot batch from another session

### Replay-robustness bucket

These should **not** be counted as extraction-shape failures when the observer
returns no output:

- `18476` — stored extraction already passes shape, but replay can return
  `raw = null`; treat this as observer/replay robustness, not under-extraction

## Current model comparison conclusion

Current benchmark findings:

- **benchmark truth model:** `openai / gpt-5.4`
  - best overall consistency on the current shape-quality batch set
- **cheaper candidate worth tracking:** `openai / gpt-5.4-mini @ temperature 0.2`
  - can pass some hard batches
  - remains less reliable than full `gpt-5.4`
- **opencode / claude-sonnet-4-5**
  - promising on several hard batches
  - still mixed enough that it should be treated as a candidate, not the current
    truth baseline

The main cost-conscious takeaway is that cheaper/faster models should be judged
against this benchmark set, not assumed sufficient by default.

## Current routing conclusion

The current replay-only quality-first routing result is stronger than any
single-model cheap configuration tested so far.

### Replay-only tier routing (current best)

- **simple tier:** `openai / gpt-5.4-mini @ temperature 0.2`
- **rich tier:** `openai / gpt-5.4` via Responses API, no reasoning, `max_output_tokens = 12000`

### Current benchmark outcome

On `rich-batch-shape-v1`, replay-only tier routing currently yields:

- shape-quality passes: `5 / 5`
- shape-quality fails: `0`
- replay robustness no-output cases: `1` (`18476`)

All shape-quality benchmark batches currently route to the rich tier under the
initial thresholds, which is acceptable for this benchmark because the set is
explicitly composed of hard rich-batch cases. The next question is whether live
routing should use the same thresholds or introduce a broader mixed-complexity
benchmark before rollout.

## Mixed-complexity routing follow-up

A second benchmark profile now checks whether replay-only tier routing can stay
cheap on genuinely simple batches while still escalating the harder ones.

- **benchmark id:** `mixed-batch-routing-v1`

### Current mixed benchmark result

After refining both the benchmark candidates and the routing thresholds, the
current replay-only router yields:

- shape-quality passes: `8 / 8`
- shape-quality fails: `0`
- replay robustness no-output cases: `1` (`18476`)
- expected-tier matches: `7 / 9`

### Current routing split

- **simple tier:** `4` batches
- **rich tier:** `5` batches

On the current mixed benchmark, this is no longer a "rich for everything"
router. Two moderate working batches (`18524`, `18525`) now intentionally route
to the rich tier because the cheap tier under-extracted them; that is a quality-
first tradeoff, not accidental over-escalation.

### Current threshold summary

The current replay-only rich-tier promotion rules are:

- `eventSpan >= 100`
- `transcriptLength >= 6000`
- `toolCount >= 25`
- `toolCount >= 9 && transcriptLength >= 2000`
- `promptCount >= 3 && toolCount >= 8`

This threshold set currently preserves quality on both the rich-only benchmark
and the refined mixed benchmark better than the earlier, more aggressive
transcript-heavy version.

## Notes

This case should not be interpreted as a repeat of the old structural
session-linking failure. The batch completed and the session linkage appears
correct. The concern here is quality of extracted memory, not basic ingestion
correctness.
