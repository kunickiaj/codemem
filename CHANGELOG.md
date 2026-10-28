# Changelog

## [Unreleased]

### Fixed

- **Sign in with Google** is available after recovering a linked account owner even when this device's old Identity still needs review. Sign-in uses the existing coordinator checks and Google verification before asking you to confirm an Identity switch.
- Account ownership reviews collect the twelve evidence categories in one database snapshot instead of twelve separate reads. This removes 11 database calls per preview and 22 per confirmation while retaining schema validation and atomic freshness checks.

## [0.47.1] - 2026-10-27

### Fixed

- **Review account ownership** waits at least 10 seconds for the coordinator, or longer when `sync_coordinator_timeout_s` is higher. Owner reviews read the full Team history and confirming sends two requests, so the 3-second default made previews fail intermittently and made Confirm report every group as `unknown` without saving anything on the coordinator. ([#2410])
- When `~/.codemem` is writable by your group or other users, as some managed workspaces create it, account ownership review names the folder and the `chmod` command that fixes it instead of reporting that the coordinator didn't answer. ([#2410])
- The account ownership dialog wraps long fingerprints and IDs, shows the coordinator once, clears earlier results when you preview again, says why **Confirm account ownership** is disabled (including a preview that expired after 5 minutes), and explains that only one ownership request runs at a time. ([#2410])

**Upgrade notes:**

- Restart the Viewer after upgrading so the new backend loads. No coordinator migration is needed.

## [0.47.0] - 2026-10-27

First stable 0.47 release. It includes everything in the 0.47.0 betas below.

### Added

- **Sign in with Google** in **My Account** sets this device's Identity from your Google account. If the account belongs to another Identity, the browser shows both Identities and the Teams this device would lose, and the device switches after you confirm. If the account is already linked to this device's Identity from another device, signing in gives this device its own proof so it can refresh or unlink the account. Memberships and Project grants never move, and memories keep their original author. See [Sign in with Google on a device](docs/user-guide.md#sign-in-with-google-on-a-device). ([#2390], [#2395], [#2396], [#2398], [#2399], [#2400], [#2401], [#2402], [#2403], [#2405], [#2406])
- A device bound to an Identity through an ownership binding can refresh and unlink that Identity's Google account. ([#2397])

### Changed

- Google account details appear only on a device with its own proof for the Identity; other devices show **Linked on another device**. ([#2394])
- Guessed labels from older migrations no longer count as device ownership, and Team setup suggests only this device's own Identity. ([#2392], [#2393])
- Account ownership review suggests recorded owners, explains blocked and empty states, and keeps admin review capacity for owner suggestions. ([#2387], [#2388], [#2389])
- The Viewer lets you choose which coordinator group My Account checks, and names the owner-only account state. ([#2391])

### Fixed

- Devices that hand out Project access move a device that switched Identities to its new Identity, instead of revoking it from every shared Project. They do this only when the coordinator's ownership binding names the new Identity, the pinned key still matches, and the new Identity is already known. ([#2407])
- Device ownership bindings can no longer be replaced through SQLite rowid updates. ([#2404])

**Upgrade notes and limitations:**

- Restart the Viewer and agent host after upgrading packages so the new backend loads.
- Self-hosted Cloudflare coordinators must apply migrations `0038`, `0039`, and `0040` before deploying this Worker. See [the deployment guide](docs/cloudflare-coordinator-deployment.md). SQLite coordinators upgrade when they open.
- A device can switch or bind its Identity only once. Teams the old Identity belonged to are not requested automatically for the new Identity yet, and switching shows no follow-up notice yet.

## [0.47.0-beta.4] - 2026-10-25

### Added

- Reviewed account-owner recovery: **My Account** offers **Review account ownership** for review-required, conflicting, or mismatched account states. It previews the full retained history, requires a fresh scoped confirmation, and displays the confirmed owner separately from the Memory author and sharing Identity. See [Repair a reviewed account owner](docs/user-guide.md#repair-a-reviewed-account-owner).
- Explicit coordinator owner-resolution schema upgrade and retained, immutable owner-resolution receipts, verified with existing device keys.
- Packaged worker-based semantic retrieval for installed CLI and plugin runtimes.
- Native Pi session search (`memory_session_search`) with a CLI fallback.

### Changed

- Semantic retrieval uses a bounded queue: cancellation removes queued work, and shutdown drains started work before SQLite closes.
- Validated vector generations and catalogs during audit, maintenance, and rebuilds; semantic search uses validated vectors while keyword retrieval remains available during repair.
- Upgraded vector layouts transactionally before requests, preserving existing memories and vector identities.
- Projects review treats local Identity suggestions as optional, records only applicable review responses, and keeps Sharing and Devices actions separate from review decisions.
- Manual **Sync now** keeps a visible pending status and result in the Viewer header across tabs.

### Fixed

- New Team setup records reject conflicting Identity assignments for the same device or signing key; existing records/replays and exclusions unchanged.
- Kept retained owner consistency through controller creation, claims, enrollment, and future Team completion.
- Skipped cancelled jobs before semantic preparation, and started semantic workers correctly when a store uses a relative database path.

**Upgrade notes and limitations:**

- Restart the Viewer and agent host after upgrading packages so the new backend loads.
- Applications that own an asynchronous semantic store should await `closeAsync()` during shutdown so workers stop before SQLite closes.
- Account-owner recovery needs a coordinator with the owner-resolution schema upgrade. Coordinator upgrades and live recovery rollout remain separate operator steps; this release does not change any coordinator.

## [0.47.0-beta.3] - 2026-10-22

### Changed

- Materialized authorized semantic-search candidates and reused indexed vector metadata snapshots instead of repeating metadata reads.
- Paged vector coverage in rowid order and used indexed, visibility-preserving Viewer aggregates.
- Reduced polling in unfocused Viewer tabs and throttled detailed health refreshes.
- Deferred Claude file-context work to an HTTP-first pre-read hook, with CLI fallback, and reused verified CLI invocations instead of repeating availability probes.

### Fixed

- Applied file-context visibility rules before result limits and shared Claude file selection and injection tracking across transports.
- Validated vector rebuild cutovers against exact vector catalogs and corpus epochs, with exact-identity batch cleanup and race-safe completion.
- Accepted queued Claude ingest acknowledgements and reported transport fallback diagnostics without exposing event contents.
- Rejected empty file-context transport input before parsing it.

**Upgrade notes and limitations:**

- Restart the Viewer and agent host after upgrading packages so the new hooks and backend load together.
- Ownership reconciliation remains under beta investigation and is not fixed by this release.

## [0.47.0-beta.2] - 2026-10-21

Supersedes the beta.1 candidate, which was tagged but not published to npm.

### Changed

- Consolidated release history in this changelog and removed standalone release-note documents. GitHub release announcements remain separate.
- Managed-peer refresh now rejects a revoked device ID or signing key. If a refresh fails or the coordinator is offline, the peer keeps its last applied policy.

### Added

- Added reviewed Team and add-device onboarding that shows the Projects a recipient device will inherit before acceptance. Adding a device keeps the existing Identity and signing keys; it does not create extra Project grants.
- Added optional Google account linking in the Viewer for an eligible enrolled Identity. Linking an account does not add Team membership, Project access, or a new coordinator grant.
- Added account-backed owner enrollment for a fresh profile when the coordinator has a configured identity provider, operator bootstrap or qualification, and trusted Identity-group grants. A normal account sign-in is not enough to enroll an owner or grant Project access.
- Added operator-only coordinator-wide device revocation by device ID and canonical signing key. A refreshed managed peer denies a device that reuses either value; revocation stops future delivery but cannot delete memories already copied to that device.

### Fixed

- Added the missing CLI handoff for recipient invitation review and acceptance: use `coordinator import-invite --review`, then pass the returned digest with `--reviewed-onboarding-digest`.
- Rejected invitation inspection and join redirects so invitation tokens are not forwarded to another endpoint.
- Pinned the bundled Claude and Codex MCP launchers to the plugin's exact release, so prerelease plugins do not start the previous stable backend.
- Raised the MCP SDK minimum to 1.32.0 to exclude versions affected by CVE-2026-111767 and CVE-2026-111769; the lockfile resolves 1.32.1.
- Updated the release-only sharing-domain test fixture to supply valid keys and enrollment evidence without changing production access rules or expected visibility.

**Upgrade notes and limitations:**

- Restart the Viewer and agent host after upgrading packages. Use a separate fresh profile for an owner's new device; do not replace the existing device's keys or profile.
- Google account linking requires a browser and the Viewer on the same host. It does not provide an SSH callback workaround.
- Live headless checks covered operator-reviewed add-device enrollment, local Viewer API capture, non-interactive process restart, and signed coordinator requests. Automatic cross-device sync, OS-reboot persistence, and agent-hook capture were not verified in that live test.
- Relay is not included. Exceptional account recovery is not included.

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

[Unreleased]: https://github.com/kunickiaj/codemem/compare/v0.47.1...HEAD
[0.47.1]: https://github.com/kunickiaj/codemem/compare/v0.47.0...v0.47.1
[0.47.0]: https://github.com/kunickiaj/codemem/compare/v0.47.0-beta.4...v0.47.0
[0.47.0-beta.4]: https://github.com/kunickiaj/codemem/compare/v0.47.0-beta.3...v0.47.0-beta.4
[0.47.0-beta.3]: https://github.com/kunickiaj/codemem/compare/v0.47.0-beta.2...v0.47.0-beta.3
[0.47.0-beta.2]: https://github.com/kunickiaj/codemem/compare/v0.46.2...v0.47.0-beta.2
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
[#2387]: https://github.com/kunickiaj/codemem/pull/2387
[#2388]: https://github.com/kunickiaj/codemem/pull/2388
[#2389]: https://github.com/kunickiaj/codemem/pull/2389
[#2390]: https://github.com/kunickiaj/codemem/pull/2390
[#2391]: https://github.com/kunickiaj/codemem/pull/2391
[#2392]: https://github.com/kunickiaj/codemem/pull/2392
[#2393]: https://github.com/kunickiaj/codemem/pull/2393
[#2394]: https://github.com/kunickiaj/codemem/pull/2394
[#2395]: https://github.com/kunickiaj/codemem/pull/2395
[#2396]: https://github.com/kunickiaj/codemem/pull/2396
[#2397]: https://github.com/kunickiaj/codemem/pull/2397
[#2398]: https://github.com/kunickiaj/codemem/pull/2398
[#2399]: https://github.com/kunickiaj/codemem/pull/2399
[#2400]: https://github.com/kunickiaj/codemem/pull/2400
[#2401]: https://github.com/kunickiaj/codemem/pull/2401
[#2402]: https://github.com/kunickiaj/codemem/pull/2402
[#2403]: https://github.com/kunickiaj/codemem/pull/2403
[#2404]: https://github.com/kunickiaj/codemem/pull/2404
[#2405]: https://github.com/kunickiaj/codemem/pull/2405
[#2406]: https://github.com/kunickiaj/codemem/pull/2406
[#2407]: https://github.com/kunickiaj/codemem/pull/2407
[#2410]: https://github.com/kunickiaj/codemem/pull/2410
