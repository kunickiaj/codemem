# OpenCode Retained Recall

Automatic message recall must preserve retained bytes and derive allowance from the current transform output, not a lifetime counter.

## Lifecycle Contract

The host message list is the evidence for which message IDs remain in context.

- Identify automatic text parts by the existing `codemem-context-` part ID prefix, not by matching prose inside user messages.
- Adopt host-provided parts without changing their text or order, including the latest message after restart. Never retrieve merely to repair a historical ledger identity.
- Replay cached parts only for message IDs present in the current session's transform. Remove cache entries for absent IDs on ordinary transforms. Cache membership alone is not retained usage.
- Count every automatic part in the current hook session's resulting message list using `ceil(text.length / 4)` per full wrapped block. Preserve foreign-session entries, but do not charge them to the current session. This estimates JavaScript string characters, not provider tokens or UTF-8 bytes.
- A compaction notification skips new recall for one transform, but neither clears replay state nor releases allowance. Only the next ordinary message list can demonstrate reclamation.
- Preserve host blocks even when their total exceeds a lowered ceiling, or their count exceeds the old replay-cache message limit. No eviction or truncation of present blocks is permitted.
- Missing session/message identity disables durable replay association. Count visible blocks anyway; absent synthetic bytes after a restart cannot be recovered from the evidence ledger, which deliberately contains no pack text.
- New retrieval and failed attachment do not consume retained allowance. Repeated transforms and reconstructed historical blocks are not newly delivered tokens.
- The ceiling applies only to the message surface. The legacy system surface keeps its per-pack budget; explicit MCP recall and explicit pack CLI semantics remain unchanged.

## Source Evidence

The canonical plugin already exposes the required part identity and replay boundary, but its old normalization rules do not satisfy this contract.

`isCodememContextPart`, `resolveEntryMessageId`, and `resolveEntrySessionID` provide structured part/message association. The replay-cache comment explains that synthetic parts may be absent on subsequent transforms. The former `normalizeInjectedMessageParts` stripped host parts, and the reconstructed-latest branch rebuilt or deleted them; both must change. `experimental.session.compacting` is only a notification, not evidence that messages were removed. `session.deleted` owns session cache cleanup. Regression fixtures model these observable hook inputs; they do not claim that every OpenCode release persists synthetic parts.

## Budget Policy

New blocks fit the lesser of the per-pack cap and remaining retained allowance.

`CODEMEM_INJECT_RETAINED_TOKEN_BUDGET` is off by default for real-world testing. Only an explicit positive safe integer enables the ceiling (for example `8000`); unset, invalid, zero, and negative values mean no retained cap. When enabled, subtract full retained block estimates, take the minimum with `CODEMEM_INJECT_TOKEN_BUDGET` (default 800), then reserve the context prefix before either Viewer or CLI transport. Never forward zero as a pack budget. Automatic explicit-recall prompts still obey an enabled ceiling; explicit MCP calls do not.

Generic pack calls keep their `null`/`0` unlimited semantics. A positive generic-pack budget now accounts for the whole rendered pack—headings, separators, and footer—so it can select fewer items. This applies to Core consumers (Claude, Codex, MCP, and CLI); it does not change explicit-recall semantics.

## Incremental Items

Automatic recall omits unchanged retained items using renderer metadata, never Markdown parsing.

The core pack response adds `rendered_items`: memory IDs, content/rendering fingerprints, and exact character spans produced while rendering. The OpenCode plugin removes all spans for a duplicate, preserving new items and changed fingerprints. A fully duplicate pack injects nothing. Part metadata binds retained fingerprints to the exact wrapped text with a digest; it is replayed with the block and reconstructed only when that binding remains valid. Metadata is not logged. Legacy packs or reconstructed parts without valid metadata remain eligible rather than risking false suppression.

For OpenCode v1.18.29, user text-part mapping forwards `text` only, not part metadata ([source](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/message-v2.ts#L176-L181)). This addresses metadata-overhead concerns for user blocks; it makes no claim about assistant mappings, which handle metadata differently.

## Continuations

Only an exact continuation allowlist with unchanged working context can receive the `continuation_only` skip reason.

The allowlist is `continue`, `proceed`, `go on`, and `keep going`, case-insensitive with an optional trailing period or exclamation mark. The previous user message must contain valid recall metadata whose working-context digest matches current file/tool context. Explicit recall, substantive short prompts, and ambiguous replies such as `yes` remain normally eligible. Retrieval still runs to classify already-deduplicated output and check current content fingerprints: without an authoritative memory-revision signal, skipping it could hide changed facts. Only a fully unchanged result skips injection as continuation-only; new or changed facts are delivered normally subject to the automatic ceiling. `continuation_only` is not a retrieval or cost-saving claim.

## Local Measurements

Health's collapsed **Automatic recall (advanced)** panel summarizes durable local fresh-evaluation measurements without copying sensitive content.

The `automatic_recall` field on `/api/stats` covers the previous 30 days, with explicit inclusive `periodStart` and `periodEnd` timestamps. It scans at most the newest 1,000 successful/no-result OpenCode automatic prompt-pack attempts before checking current visibility. It excludes cache-reuse records, failed retrievals, and policy skips; an opted-in ceiling can prevent evaluation entirely, so ceiling skips are not zero-result evaluations or savings. All projects are included regardless of the UI project selector. Attempts with any selected memory now unavailable (including revoked scopes, deletion, or incomplete exposure coverage) are omitted in full.

| Field | Definition |
|---|---|
| `freshEvaluations` | First accepted measurement per session/message/surface/query/artifact evaluation key in the retained ledger. Without stable host session/message IDs, a local discriminator, prompt counter, and message position distinguish turns. The discriminator rotates on each `session.created` event alongside the counter reset, separating anonymous sessions within one plugin instance. Transport retries and repeated empty-result transforms within the same turn do not increase this denominator; changed retrieval artifacts do. Replay and reconstruction do not create measurements. |
| `evaluationsWithDuplicates` | Measured evaluations omitting at least one unchanged retained item. Hit rate is this numerator divided by `freshEvaluations`, including measured empty results. |
| `candidateItems`, `duplicatesOmitted` | Selected pack items before filtering and the subset omitted by retained-item deduplication; not all retrieval search candidates. |
| `beforeTokens`, `afterTokens`, `estimatedTokensAvoided` | Sums of complete wrapped injection estimates before/after duplicate filtering and their difference, using `ceil(JavaScript string length / 4)`. Empty selections count zero, even if Core renders empty headings. |
| `missingRetainedMetadata`, `invalidRetainedMetadata` | Counts of measured evaluations encountering at least one retained block with missing or unusable metadata, after valid cache metadata recovery. They count evaluations, not blocks, and may overlap. |
| `packMetadataGaps` | Measured evaluations whose nonempty candidate pack lacks usable renderer metadata. No dedup savings are credited for these packs. |
| `unmeasuredAttempts` | Visible eligible ledger rows without a valid measurement, including old clients, recording failures, and unsupported bounds. A durable duplicate marker is omitted only when its accepted measurement is also visible in the same bounded window; otherwise it remains unknown rather than crossing a scope or time boundary. This is not a second fresh-evaluation denominator. |
| `availability` | `available` requires at least one recorded evaluation; `no_data` means savings are unknown; `unavailable` means the aggregate could not be read. A recorded zero savings is distinct from no data. |
| `captureVersion` | `opencode-retained-v1` identifies the plugin measurement contract. It is not the installed package version, host version, or checkout hash; mixed-release attribution within this contract is unavailable. |

The plugin attaches measurements to existing delivery ledger requests; empty results use a count-only `recall` action on the same endpoint/CLI fallback. An additive pair of nullable ledger columns stores one bounded object and a hashed evaluation key, with a unique index for cross-retry deduplication. A duplicate attempt stores a bounded marker so Health can remove it from unknown coverage only beside the visible accepted sample. Recording updates only existing OpenCode automatic attempts, validates allowlisted fields and integer bounds against server-owned selected counts and output-token estimates, and preserves the first accepted sample. Delivery still succeeds when optional diagnostics are malformed, rejected, or unavailable; the explicit `recall` action remains strict. No new endpoint, authentication rule, remote telemetry, or log parser is introduced. Existing ledger retention (90 days by default), privacy deletion, and scope checks apply.

Limits: these are client-reported filtering estimates, not proof of host/provider consumption, provider cost, or answer usefulness. Failed attachment or a later budget rejection can still have a filtering measurement. Stable evaluation identity collapses same-artifact retries but counts changed retrieval artifacts separately. Without host IDs, retry identity cannot survive a plugin restart, a reported session creation, or a change in message position; indistinguishable turns with the same prompt counter and position cannot be separated when the host omits session-boundary events. The bounded window can leave a retry marker unknown when its accepted sample is older or not currently visible. Older plugins do not report this contract, and unsupported/failed capture is never interpreted as zero savings.

If an older CLI fallback rejects optional measurement fields, the plugin retries the original delivery receipt without them. A compatible but stale Viewer that specifically returns `viewer_contract_unsupported` gets the same one-time bare receipt retry on Viewer; policy/auth and other request rejections remain fail-closed. Measurement capture requires a compatible local backend; lack of capture does not disable recall.

Optional plugin logs remain per-transform snapshots rather than the durable Health source.

When `CODEMEM_PLUGIN_LOG` enables local logging, `inject.recall` lines contain a JSON object with only `new_tokens`, `retained_tokens`, `duplicates_omitted`, and `reason`. `new_tokens` counts newly attached wrapped blocks; replay, reconstruction, duplicate-only output, and failed attachment report zero. `retained_tokens` is the current hook session's wrapped-block sum, not a lifetime total or a sum across foreign-session entries. Do not sum retained snapshots across turns. Compaction snapshots describe only their supplied output and never reset replay state. These are hook handoff estimates, not proof that a provider consumed the request.

Reasons are `delivered`, `replay`, `allowance_exhausted`, `unchanged_memories`, `continuation_only`, `budget_rejected`, `delivery_failed`, `no_context`, `compaction_skipped`, `injection_disabled`, `missing_history`, and `missing_user`. No prompts, text, paths, memory IDs, fingerprints, or session IDs enter these measurement objects. Recording errors are best-effort and cannot block recall. Existing retrieval-ledger records still describe retrieval, not the post-dedup delivered item set; policy skip repeats are memoized for the latest request per session in a bounded map.

## Evaluation Interface

Deterministic local tests exercise lifecycle and transport behavior without paid provider calls.

Run `pnpm --filter codemem test:plugin` for all plugin regressions, or add `.opencode/tests/plugin-retained-recall.test.js` to select the lifecycle/measurement fixtures. `plugin-transform-hook.test.js` includes real hook tests for Viewer and CLI fallback budgets, changed facts, continuation skips, restart byte stability, and log reconciliation. Run `pnpm exec vitest run packages/core/src/pack.test.ts` for standard/compact renderer spans and budget checks. From `packages/cli`, run the comparative fixtures with:

```fish
env CODEMEM_RECALL_EVAL_REPORT=1 pnpm exec vitest run --config .opencode/vitest.config.ts .opencode/tests/retained-recall-comparison.eval.test.js
```

`pnpm script --` does not filter this eval. The comparison is a simulated stage-1 baseline, not a historical plugin. It uses constructed fixtures and the real hook with a mock Viewer; when a whole pack exceeds the ceiling, that mock returns an empty pack rather than Core trimming it. Token figures estimate `chars / 4`, not provider quality, usage, or cost.

| Fixture | Baseline → actual new tokens | Coverage | Duplicates |
|---|---:|---:|---:|
| Repeated | 72 → 24 | 1/1 → 1/1 | 2 → 0 |
| Changed + explicit | 70 → 45 | 2/2 → 2/2; new 1/1 → 1/1 | 1 → 0 |
| Pressure | 8280 → 7590 | 12/12 → 11/12 | — |
| Compaction | 81 → 53 | new 1/1 → 1/1 | — |
| Missing metadata restart | 52 → 52 | — | 1 → 1 |

The pressure fixture misses `CEILING_FACT_12` because the deliberately constructed mock cannot fit the next entire pack. Compaction's final retained estimate falls from 56 to 28. There are zero false dedup or continuation skips across fixtures, excluding the deliberate ceiling miss.

Limits: dedup operates on the selected pack and does not refill freed space with lower-ranked candidates. The cache is bounded by retained host blocks, not a simple count. After restart, missing metadata favors eligibility and can repeat facts. A restart or eviction from the replay cache cannot restore synthetic bytes that the host no longer supplies; the ledger intentionally cannot reconstruct text. Current retained host blocks are always counted and preserved, including when already above the ceiling. claude-mem's compact discovery plus explicit expansion informed the product shape, not these budget or cache results. No live-provider usefulness or cost claims follow from the local fixtures.
