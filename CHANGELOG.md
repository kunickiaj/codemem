# Changelog

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

## [0.46.0] - 2026-09-27

### Added

- Added Pi coding-agent support through setup, lifecycle capture, native memory tools, and memory-pack injection on the request copy without changing the system prompt. ([#1788], [#1778], [#1831])
- Added exact-Project sharing actions, first-run guidance, source-device information, and device renaming from the Devices view. ([#1770], [#1786], [#1773], [#1846])

### Changed

- Grouped related repository worktrees in Projects and devices by Identity, and made Feed cards show more useful content. ([#1835], [#1780], [#1843])
- Reduced repeated reads in Projects, sharing summaries, and sync status on large stores. ([#1857], [#1746], [#1860])
- Added safe sync failure categories and clearer explanations in Health and diagnostics. ([#1851], [#1848])

### Fixed

- Avoided taking a write lock when opening an unchanged database. ([#1849])
- Stopped completed backfill workers, included rows arriving during backfills, and retried temporary database-busy failures. ([#1850], [#1853])
- Reported disabled embeddings and compatible legacy semantic vectors accurately; keyword search remains available when semantic search is off. ([#1852])

**Upgrade notes and limitations:**

- Restart the agent host after upgrading and run `codemem setup` to add Pi. Existing databases update automatically; background maintenance may continue after upgrade.
- Pi does not persist recalled memory pastes in its session file, so restarting Pi does not restore earlier injection decisions. First loads of Health and coordinator administration can still be slow on large stores.
- Revoking a shared Space stops new delivery but cannot erase copies already received by another device.

[Unreleased]: https://github.com/kunickiaj/codemem/compare/v0.46.2...HEAD
[0.46.2]: https://github.com/kunickiaj/codemem/compare/v0.46.1...v0.46.2
[0.46.1]: https://github.com/kunickiaj/codemem/compare/v0.46.0...v0.46.1
[0.46.0]: https://github.com/kunickiaj/codemem/compare/v0.45.0...v0.46.0
[#1746]: https://github.com/kunickiaj/codemem/pull/1746
[#1770]: https://github.com/kunickiaj/codemem/pull/1770
[#1773]: https://github.com/kunickiaj/codemem/pull/1773
[#1778]: https://github.com/kunickiaj/codemem/pull/1778
[#1780]: https://github.com/kunickiaj/codemem/pull/1780
[#1786]: https://github.com/kunickiaj/codemem/pull/1786
[#1788]: https://github.com/kunickiaj/codemem/pull/1788
[#1831]: https://github.com/kunickiaj/codemem/pull/1831
[#1835]: https://github.com/kunickiaj/codemem/pull/1835
[#1843]: https://github.com/kunickiaj/codemem/pull/1843
[#1846]: https://github.com/kunickiaj/codemem/pull/1846
[#1848]: https://github.com/kunickiaj/codemem/pull/1848
[#1849]: https://github.com/kunickiaj/codemem/pull/1849
[#1850]: https://github.com/kunickiaj/codemem/pull/1850
[#1851]: https://github.com/kunickiaj/codemem/pull/1851
[#1852]: https://github.com/kunickiaj/codemem/pull/1852
[#1853]: https://github.com/kunickiaj/codemem/pull/1853
[#1857]: https://github.com/kunickiaj/codemem/pull/1857
[#1860]: https://github.com/kunickiaj/codemem/pull/1860
[#1875]: https://github.com/kunickiaj/codemem/pull/1875
[#1876]: https://github.com/kunickiaj/codemem/pull/1876
[#1877]: https://github.com/kunickiaj/codemem/pull/1877
[#1878]: https://github.com/kunickiaj/codemem/pull/1878
[#1879]: https://github.com/kunickiaj/codemem/pull/1879
[#1880]: https://github.com/kunickiaj/codemem/pull/1880
[#1881]: https://github.com/kunickiaj/codemem/pull/1881
[#1882]: https://github.com/kunickiaj/codemem/pull/1882
