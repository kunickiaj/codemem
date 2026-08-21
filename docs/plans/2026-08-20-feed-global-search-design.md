# Feed Global Search Design

**Status:** Approved
**Release:** 0.42.0

## Problem

The Feed search box filters only the pages already loaded in the browser. Older
eligible memories remain invisible until scrolling loads them, numeric memory IDs
are not searchable, and several fields rendered by cards are absent from the
local search haystack. Persisted tags also use `tags_text`, while the client
expects `tags`.

## Decision

Move Feed text matching to the Viewer server and apply it before pagination.
Keep the Feed chronological rather than reusing semantic retrieval, which has
different ranking and result-limit semantics.

Both observation and summary list endpoints accept an optional `q` parameter.
The query is intersected in SQL with the existing active-memory, sharing-domain,
project, ownership, and observation-versus-summary predicates before one
chronologically ordered `LIMIT`/`OFFSET` query is executed per endpoint.

Search uses deterministic JavaScript Unicode lowercasing through a registered
SQLite scalar function, preserving arbitrary substring matching across the
stored text that can appear in Feed cards: title, body, kind, tags, facts,
subtitle, narrative, and
the summary metadata fields `request`, `subtitle`, `narrative`, `facts`, and
`summary`. Other metadata is not part of the search haystack. A positive integer
query in canonical decimal form also matches the exact memory ID; signed and
zero-padded forms remain text queries. Normalized queries are capped at 256 code
units before execution.
Numeric queries may still match textual fields; exact ID support does not turn
the input into an ID-only mode.

No schema migration or semantic ranking is introduced in this release hotfix.

## Performance check

A synthetic 100,000-row in-memory SQLite benchmark on the release development
machine measured a rare-term full scan at 77 ms median across five warm runs.
A common term at offset 400 measured 0.35 ms median because SQLite could stop
after filling the requested page. The benchmark included the five allowlisted
JSON metadata extractions but excluded authorization joins, so it is a local
hotfix guardrail rather than a production latency guarantee. FTS remains a
follow-up option, but its token matching does not preserve this hotfix's
arbitrary-substring contract.

## UI behavior

The Feed debounces query changes, resets both pagination streams, and reloads
observations and summaries with `q`. Local loaded-row filtering is removed so
the visible result set and `has_more` state come from one server-side contract.
Whitespace-only edits preserve the controlled input but do not reset or refetch,
and scroll pagination pauses while a query debounce is pending. Server-matched
observations bypass the normal low-signal suppression so exact-ID and short-text
matches remain visible; unfiltered Feed loading keeps that suppression. Scroll
pagination also pauses while the primary Feed page is loading, preventing a
duplicate offset-zero request. Feed loading/result metadata is exposed as a
polite status region.
Changing project, ownership scope, type, or query cannot widen authorization.

## Validation

Regression coverage must prove:

- a match beyond the first unfiltered page is returned;
- an exact numeric memory ID is returned without relying on text coincidence;
- tags and structured card fields are searchable;
- project, ownership, sharing-domain, active-state, and type boundaries remain
  enforced;
- matching rows paginate without duplicates or omissions; and
- query changes reset and debounce Feed loading.
