# Feed Global Search Implementation Plan

1. Extend the Viewer memory-list filtering contract with a normalized optional
   query, a deterministic Unicode-casefold SQL function, a 256-code-unit cap,
   and a SQL predicate covering canonical exact IDs and Feed-visible stored fields.
2. Pass `q` through observation and summary API clients and compose SQL search,
   authorization, and summary classification before `LIMIT`/`OFFSET`.
3. Replace immediate loaded-row filtering with debounced server reloads,
   effective-query comparison, query-aware pagination state, and stale-request
   guards in the Feed controller. Keep server-matched short observations visible
   and block scroll pagination while debounce or primary loading is active.
4. Correct the persisted tag field contract used by Feed cards.
5. Add server and UI regression tests for completeness, ID matching, structured
   fields, filters, pagination, and query reset behavior.
6. Run targeted tests, TypeScript, lint, the full suite, build, and release smoke
   checks before submitting one Graphite hotfix PR.
