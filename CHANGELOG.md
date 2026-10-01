# Changelog

Notable changes to codemem are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

This file starts with the release summaries previously checked into the repository; it is not a complete backfill. Other versions, release announcements, and contributor credits remain in [GitHub Releases](https://github.com/kunickiaj/codemem/releases).

## [Unreleased]

### Changed

- Consolidated release history in this changelog and removed standalone release-note documents. GitHub release announcements remain separate.

## [0.46.2] - 2026-10-01

### Changed

- Organized observer Settings around separate OpenCode account, API key, local Claude, and local Codex connection modes, with actual defaults and clearer save/apply feedback. Existing legacy routing remains unchanged until the connection is explicitly selected. ([#1875], [#1877], [#1879], [#1880])
- Grouped Simple and Rich model settings. OpenAI/Codex defaults use `gpt-6-luna` for Simple and untiered requests and `gpt-5.6-terra` for Rich; saved model choices remain intact. ([#1878], [#1880])

### Fixed

- Prevented API-key mode from using cached subscription credentials and OpenCode-account mode from falling back to a direct API key. ([#1880])
- Preserved Automatic connection choices on save and reconciled active tier routing after a connection draft is reverted without overwriting explicit routing choices or other drafts. ([#1880], [#1882])
- Matched custom provider prefixes case-insensitively while preserving configured provider IDs, model-ID case, and direct-provider model mappings. ([#1882])
- Retried OpenCode 2's exact pre-generation cold-start model-selection rejection without changing the selected provider or model; other errors and uncertain outcomes are not retried by this path. ([#1881])

### Removed

- Removed the misleading observer model check; model suggestions do not guarantee account access. ([#1876])

## [0.46.1] - 2026-09-29

### Added

- Added live application of observer Settings, model suggestions, and an on-demand synthetic model check (removed in 0.46.2).
- Added per-device sync health, selected-peer sync actions, and past-24-hour inbound/outbound operation counts.

### Fixed

- Routed newly captured OpenCode 2 events with implicit credentials through the signed-in service without requiring legacy `auth.json`; older events and explicit connections retain their previous routes.
- Retained queued raw events when observer authentication is missing and recovered eligible historical gaps without rewinding session cursors.
- Finished usage-only windows without observer calls or new memories; missing or invalid events remain failed for diagnosis.
- Reused durable spool entries when repeated event IDs differ only in delivery timestamps, and reported safe failure stages without logging event contents.

**Upgrade notes and limitations:**

- OpenCode 2 stateless generation and local Claude/Codex sessions do not enforce provider-side output-token caps. Wait and response-size limits do not cap upstream generation or charges.
- Restart the viewer and agent host after upgrading packages; a running viewer does not switch builds automatically.

## [0.44.0] - 2026-09-09

### Added

- Added viewer diagnostics with contextual actions and redacted event details, plus local automatic-recall measurements.

### Changed

- Preserved retained OpenCode context, deduplicated unchanged memories, and isolated continuation summaries by requester session. The retained-token ceiling remains off by default.
- Verified matching optional embedding runtimes and semantic retrieval in CLI-only packed installations; keyword fallback remains available when the runtime cannot initialize.

### Fixed

- Refreshed stale Team setup confirmation evidence, counted roster devices and assignments once, and removed setup-owned routing mappings during conflict containment without rewriting user-owned mappings or stored memories.
- Used the SQLite connection's actual in-memory state when deciding whether to enable WAL.

**Upgrade notes and limitations:**

- Session eligibility does not classify every same-session task transition. Dual OpenCode V1/V2 support followed in 0.45.
- Search by meaning remains platform-dependent. Back up the database before upgrading and allow search-index updates to finish; keyword search remains available.
- The npm latest-tag guard remains verify-only and warning-only; skipping an already-published package version does not repair its dist-tags.

[Unreleased]: https://github.com/kunickiaj/codemem/compare/v0.46.2...HEAD
[0.46.2]: https://github.com/kunickiaj/codemem/compare/v0.46.1...v0.46.2
[0.46.1]: https://github.com/kunickiaj/codemem/compare/v0.46.0...v0.46.1
[0.44.0]: https://github.com/kunickiaj/codemem/compare/v0.43.2...v0.44.0
[#1875]: https://github.com/kunickiaj/codemem/pull/1875
[#1876]: https://github.com/kunickiaj/codemem/pull/1876
[#1877]: https://github.com/kunickiaj/codemem/pull/1877
[#1878]: https://github.com/kunickiaj/codemem/pull/1878
[#1879]: https://github.com/kunickiaj/codemem/pull/1879
[#1880]: https://github.com/kunickiaj/codemem/pull/1880
[#1881]: https://github.com/kunickiaj/codemem/pull/1881
[#1882]: https://github.com/kunickiaj/codemem/pull/1882
