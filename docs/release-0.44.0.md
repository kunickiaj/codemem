# Codemem 0.44.0 Release Notes

This local stable candidate combines semantic installation, safer automatic recall, and Team setup corrections; it is not yet published.

## Included Changes

The candidate includes the beta release and the following improvements on top of it.

- Automatic OpenCode recall checks requester-session eligibility before retrieval and fallback, and isolates delta baselines by requester continuity. Missing session mapping blocks continuity summaries without excluding useful historical facts.
- Automatic recall preserves retained context and deduplicates unchanged items. The retained-token ceiling remains off by default; Health reports bounded injection measurements rather than provider token usage or answer quality.
- Viewer diagnostics provide contextual actions and redacted event details. Observer output follows provider capabilities, with deterministic envelope and forced-tool evaluation coverage.
- Team setup retries refresh stale confirmation evidence and require renewed confirmation. Readiness counts roster devices and persisted assignments once, while still bounding unrelated assignment work.
- Team conflict containment removes setup-owned routing mappings on the affected coordinator group's active and retired scopes in the same transaction, including mappings left by older containment. Already-contained policy is not reactivated or rewritten. User-owned mappings and other coordinator groups remain unchanged; stored memories are not rewritten.
- SQLite uses the connection's actual in-memory state when deciding whether to enable WAL, so disk filenames resembling memory URIs retain WAL behavior.
- The CLI-only packed install verifies the matching optional embedding runtime, real inference, and semantic retrieval. Lexical fallback remains available when the runtime cannot initialize.

## Limits And Follow-Ups

Session eligibility is not task classification, and this candidate does not claim to solve every same-session task transition.

Remaining recall stages and expanded evaluation move to 0.45+, preserving the completed incident baseline. Source-window provenance supersedes the earlier mandatory task-classification proposal; no new source-window suppression ships here. Dual OpenCode V1/V2 support remains planned for 0.45.

The npm latest-tag guard remains verify-only and warning-only. Stable publication uses `--tag latest`; publishing a new stable embeddings version can advance its tag naturally, but skipping an already-published version does not repair tags. No registry mutation is part of this preparation.

Independent review and the release task's upgrade, supported-platform, and workload evidence must be reconciled before publication. Tagging remains restricted to the merged, clean main commit under [the versioning policy](versioning.md).
