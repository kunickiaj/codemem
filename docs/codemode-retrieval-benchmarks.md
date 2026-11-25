# OpenCode Code Mode retrieval benchmarks

Pinning two common retrieval signatures removed all 12 discovery-only calls in
a live comparison with OpenCode 2.4.1. It reduced model input without lowering
answer accuracy on these tasks. The benchmark did not show a latency advantage
over direct tool calls.

Each arm ran 12 tasks against the same 31 synthetic memories using GPT-6.2 Sol,
the full 15-tool codemem catalog, and compact batch hydration. Fresh sessions
ran in rotating order. The tasks covered project resume, decision rationale,
recurring bugs, project scope, conflicting drafts, superseded records, broad
filtering, and two unsupported claims. The prompts did not ask the model to
combine calls.

| Mode | Factual answers | Exact citations | Discovery-only calls | Model requests | Total input | Uncached input | Median time |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Direct | 12/12 | 11/12 | 0 | 37 | 153,172 | 71,508 | 6.53 s |
| Code Mode, unpinned | 12/12 | 12/12 | 12 | 47 | 283,161 | 102,425 | 8.22 s |
| Code Mode, pinned | 12/12 | 11/12 | 0 | 36 | 86,795 | 47,883 | 6.93 s |

Total input includes cache reads. The direct and pinned modes missed the same
exact-citation check: both gave the correct next steps and cited an extra older
note to explain why it no longer applied. All modes correctly abstained on
unsupported claims. The scores reflect a review of the saved answers where a
wording check missed a valid refusal.

The two pins let the model call the search index and exact-ID batch fetch
without looking up their signatures. The model can still choose separate
calls when selection requires judgment. On one matched task with a known
project and kind filter, a single program finished correctly in two requests
versus three for direct calls. In an earlier fuzzy-filter test, a generated
program instead hydrated backlog notes and missed both requested blockers.

For one pair of checklist records, compact batch hydration reduced the result
from 2,266 to 290 bytes while keeping the full body text. The compact response
is opt-in. These measurements are one run per task and mode, with uncontrolled
provider cache state. They do not estimate latency or cost across other models,
catalog sizes, or real memory corpora.

The [offline fixture](../packages/opencode-plugin/scripts/offline-retrieval-accounting.md)
checks the transport payloads, selected IDs, and ledger behavior without
calling a provider. Its scripted transcripts are separate from the live
measurements above.
