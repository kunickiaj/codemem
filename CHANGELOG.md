# Changelog

## [Unreleased]

### Fixed

- Relayed sync accepts valid requests that arrive before the receiving device finishes preparing to read them, avoiding a timing-dependent disconnect.
- Relay health readiness refreshes after successful coordinator requests, preventing an expired published stamp from rejecting an otherwise healthy exchange.

## [0.49.0-beta.7] - 2026-11-13

### Fixed

- Saving a memory waits for an active database writer before reading its source identity, avoiding immediate database-lock failures during concurrent background work. ([#2737])

## [0.49.0-beta.6] - 2026-11-13

### Fixed

- The Viewer's **Sync now** action refreshes stale Space permissions before choosing relay, so manual retries do not have to wait for the next background refresh. A failed refresh is attempted only once per all-peers request. ([#2735])

## [0.49.0-beta.5] - 2026-11-13

### Fixed

- OpenCode 2 captures each conversation once in the correct project when one host serves multiple projects. Sessions can move between projects and worktrees while earlier activity keeps its original project and sharing scope. ([#2731])
- Exhausted capture batches containing only brief acknowledgements complete without false failure warnings. ([#2730])
- Capture failures include more detail about why generated memories were rejected. Existing failed batches remain available for review and explicit recovery. ([#2730])

## [0.49.0-beta.2] - 2026-11-10

### Added

- My Account offers **Connect this device** when a linked device still needs its ownership recorded and the coordinator can complete it with a fresh Google sign-in for the same Identity. ([#2667], [#2677])

### Changed

- Space-assignment previews stream their rows, and the Projects list finds visible Projects through indexed checks. ([#2661], [#2662])
- Enrollment issue details show the coordinator and group, so two issues for the same device can be told apart. ([#2654])
- Grouped Project entries open directly below their group, before Advanced Space assignment. ([#2657])
- Sharing review shows saved coverage separately from requested additions, and a fully covered recipient cannot be added again. ([#2658])

### Fixed

- **Linked devices finish setup without manual repair.** A device that was enrolled before account linking, or linked before ownership was recorded, could stay out of sync with a repeating enrollment error. Background maintenance now records its ownership with the coordinator when the device's own committed account claim proves it, and first account linking records ownership in the same step. Two devices that the coordinator lists under the same Identity can then publish to each other and sync without an invitation. Sharing settings, exclusions, keys, other devices, and memory history are unchanged. ([#2664], [#2666], [#2669], [#2675], [#2676])
- Enrollment maintenance keeps running against a coordinator that is older, has account sign-in turned off, or uses a URL the signed setup request cannot use, such as plain HTTP. ([#2678], [#2679])
- Signed device setup works on a Cloudflare D1 coordinator that runs SQLite 3.54.0 or 3.54.1. ([#2680])
- `codemem status --json` and `codemem service status --json` now report recent observer batch failures as `observer.state: degraded` with attention code `observer_recent_failures`, replacing `backoff` and `observer_backoff`. Historical failures no longer trigger that warning. The CLI health probe cannot confirm the worker's active backoff timer. ([#2656])
- Saving a Project Space assignment no longer fails with `Invalid string length` when unrelated session metadata makes the confirmation fingerprint too large to serialize at once. ([#2660])
- Capture failures are reported at the stage where they happened, and input with nothing to process no longer reads as an observer failure. ([#2655])
- OpenCode V2 `shell` command results are kept during capture instead of failing as unprocessable input. ([#2659])

**Upgrade notes and limitations:**

- This is an opt-in beta on npm's `beta` channel. Restart the Viewer and agent hosts after upgrading.
- Automatic setup completion needs a coordinator with these changes. Self-hosted Cloudflare coordinators must apply migration `0044_add_rebind_start_authority.sql` before deploying the new Worker. See [Cloudflare coordinator deployment](docs/cloudflare-coordinator-deployment.md).
- A device without a coordinator admin secret does not run enrollment maintenance, so it does not complete setup automatically.
- On a Cloudflare D1 that runs SQLite 3.54.0 or 3.54.1, account status in My Account, **Connect this device**, account connection changes, and legacy owner resolution answer 503 until D1 runs a fixed SQLite. Device setup completion and sync are not affected.

## [0.49.0-beta.1] - 2026-11-09

### Added

- `memory context <task>` and `memory context trace <task>` provide the public manual-retrieval and selection-explanation commands. ([#2630])
- MCP supports both the 2026-07-28 discovery protocol and legacy `initialize` clients over its existing stdio and HTTP entrypoints. ([#2599])
- The Viewer Feed loads scoped projections and cursor-paged results, retains older pages when it refreshes, and loads hidden event context on disclosure. ([#2619], [#2624])

### Changed

- **Breaking: grouped CLI commands.** Commands now use `memory`, `session`, `service`, `maintenance`, and `diagnostics` groups. Use `codemem memory search` instead of `codemem search`, and `codemem diagnostics capture status` instead of `codemem db raw-events-status`. Replace `sync status` with `service status` for overall health or `sync peers` for peer details. Coordinator actions also move into resource groups, including `coordinator account link`, `coordinator device list`, and `coordinator schema diagnose-team`. See [Command migration](docs/cli-reference.md#command-migration). Hidden compatibility entrypoints remain for installed integrations, including `codemem serve` and selected older coordinator instructions. ([#2630], [#2632])
- Viewer status uses indexed counts and shares simultaneous reads. Refreshes avoid nonessential capture-backlog scans. ([#2608], [#2609])
- An MCP request for an unknown tool now returns JSON-RPC error `-32602`. Registered-tool validation and execution errors keep their existing result behavior. ([#2599])

### Fixed

- Failed extraction retries keep their event range stable when new events arrive. Rejected capture receipts can be inspected and explicitly recovered through the Viewer HTTP route. `--keep-receipt` preserves the receipt after an acknowledgement when content under an event ID is uncertain. ([#2581], [#2612])
- OpenCode and native Claude, Codex, and Pi capture retain verified payload rejections so later queued events can proceed. Retention preserves saved bytes and stops draining on failure. Claude keeps its current boundary fallback, and Pi keeps saved cutoffs and unfinished boundary work retryable. Older queued Claude boundaries can require explicit recovery. ([#2613], [#2647])
- Duplicate-only capture replay can fill missing session context without replacing populated fields. Mixed batches derive updates from newly inserted events. Runtime-context retries reuse the first valid saved envelope, and size rejections apply only to the posted copy. ([#2644], [#2646])
- Local writes and redaction durably enqueue vector repair. Maintenance rejects obsolete source snapshots and stale job generations, and stale pending vectors no longer affect semantic ranking. ([#2587], [#2592], [#2593], [#2596], [#2605])

**Upgrade notes and limitations:**

- This is an opt-in beta. Install it from npm's `beta` channel. The `latest` stable channel remains unchanged.
- Restart the Viewer and agent hosts after upgrading so they load the new backend and UI.
- Update scripts and user-facing instructions to the grouped CLI commands in the [CLI reference](docs/cli-reference.md#command-migration). Existing hidden compatibility entrypoints are for installed integrations, not new automation.
- MCP protocol compatibility does not enable cross-project pooling. Callers still need their directory for search scope, write-session paths, and project context.
- Historical completed-vector coverage reconciliation remains deferred. The new coverage helpers preserve forgotten vectors. ([#2607])
- Native Pi saved-cutoff HTTP recovery is unsupported. Native Windows retention has not completed validation. Unsafe permissions or unsupported filesystem synchronization stop retention or draining and produce an inspection warning. The commands do not change permissions.
- Concurrent scoped reset and late-response behavior has not completed beta qualification.

## [0.48.0] - 2026-11-06

### Added

- **Relay sync.** When two devices cannot reach each other directly, sync goes through an encrypted relay hosted by the coordinator. Each pass tries a direct connection first and uses the relay only when that fails. Sync returns to direct on its own once the direct path works again. The relay sees only ciphertext and frame sizes, and it stores nothing: a peer that is offline is unreachable until it comes back. Relay is on for every device whose coordinator offers it. To turn it off on one device, set `sync_relay_enabled: false` (or `CODEMEM_SYNC_RELAY_ENABLED=0`) and restart `codemem serve`. Self-hosted Cloudflare coordinators enable it per group; see [Relay](docs/relay.md). ([#2480], [#2482], [#2483], [#2484], [#2485], [#2487], [#2492], [#2494], [#2498], [#2500], [#2502], [#2505], [#2506], [#2507], [#2508], [#2510], [#2512], [#2513], [#2515], [#2520], [#2523], [#2529], [#2532], [#2535], [#2536], [#2543], [#2544], [#2545], [#2546], [#2547], [#2557])
- `codemem sync relay-keys` lists and approves the relay service key that each coordinator advertises. ([#2514])
- **Headless account linking.** `codemem coordinator link-account <group> --headless` links a device with no browser, such as a container or a server reached over SSH, to a Google account. The terminal shows a URL and code, waits while someone approves in a browser, then asks for confirmation before linking. Devices cannot be moved or enrolled into a headless-linked account. See [Link a device without a browser](docs/user-guide.md#link-a-device-without-a-browser). ([#2572], [#2574], [#2575])
- **OpenCode memory tools in the plugin.** The OpenCode plugin can register `codemem_memory_*` tools itself, behind a flag, so a thin host no longer needs the per-project MCP entry. Once the tools are on, setup stops installing that entry. ([#2503], [#2504], [#2517], [#2521], [#2524], [#2527], [#2533])
- The Viewer's sync activity shows send health and receive health separately, with the evidence behind each. ([#2475], [#2476], [#2477], [#2481])

### Changed

- **Breaking:** `@codemem/pi-extension` now declares Pi `>=1.1.0 <2`; upgrade an older host with `pi update` before installing. Native tools remain the setup default (15 `memory_*` tools), and the explicit `native` / `mcp-adapter` modes are unchanged. See [Pi host compatibility](docs/versioning.md#pi-host-compatibility). ([#2438])
- Sync pull and snapshot pages are capped at 1 MiB so they fit through the relay route. ([#2520])
- The shared Viewer keeps running, and every OpenCode project that uses it checks its health. ([#2518])
- Downloaded embedding models are stored in `~/.codemem/models`. A model load that fails is retried. ([#2561], [#2562])

### Fixed

- Hosted Gemini OAuth callbacks are accepted, including web user-bound ones. ([#2519], [#2548])
- Raw-event capture serializes flush claims per stream and persists their generations, so concurrent flushes no longer lose or duplicate work. ([#2555], [#2556], [#2565], [#2567])
- Sync keeps a receive failure visible until every scope has been checked. ([#2573])
- Vector catch-up maintenance keeps moving and reports worker errors. ([#2576])
- Maintenance releases can be cut from an isolated release line. ([#2530])

**Upgrade notes and limitations:**

- Restart the Viewer and agent host after upgrading packages so the new backend loads.
- Self-hosted Cloudflare coordinators must apply migration `0043` before deploying this Worker; headless linking needs it. Coordinators that want relay must also apply `0041` and `0042`, set the relay secrets, deploy, and then run the relay admission setup for each group. A coordinator that skips the relay steps keeps working and its devices stay on direct sync. See [the deployment guide](docs/cloudflare-coordinator-deployment.md).
- Relay works between two devices on 0.48. A 0.48 device syncs directly with 0.47 peers and does not try to relay to them.
- Coordinator-assisted NAT traversal (hole punching) is not in this release.

## [0.47.3] - 2026-10-28

### Added

- `codemem coordinator diagnose-team-setup` checks a coordinator's completed legacy Team setup against a private temporary database copy and names the check that fails. It works before opening the Team in the Viewer and leaves the original database unchanged. The Viewer also logs the original failing check when a setup request fails. ([#2422], [#2426])

### Changed

- Packaged-artifact tests now exercise Team recovery through installed CLI, core, and Viewer packages, including a new device that has only its signed-in person's record. They also cover repeated recovery, Space membership controls, and rejection of disabled or rekeyed devices. ([#2428])

### Fixed

- A new device can now recover a completed Team without already having person records for every teammate. Recovery creates missing non-local records from the validated completion and preserves existing identities and ownership evidence. ([#2427])
- Opening a saved stale Team review now revalidates it once instead of requiring an initial Retry click. A failed automatic refresh remains visible for review. ([#2425])
- Team setup lists now report recovery blockers instead of offering a migration that cannot load. Recovery also preserves verified matching sharing policy when a local Project scan limit prevents applying a coordinator completion after a publication conflict. Failed completion reads no longer trigger publication of an older local setup. ([#2424])
- Leaving one of a completed Team's Spaces, or losing access to all of them, no longer makes that device treat the Team as needing setup again. Space refreshes also stop re-archiving Spaces that were already archived. ([#2423])
- A legacy Team completed on another device now applies on a device that is not a member of every Space the Team maps Projects into. Previously, opening Team setup on that device failed on every load, and a failed apply could turn off the Team's sharing on that device. The device shares only the Projects in Spaces it belongs to and adds the others if it joins those Spaces later. ([#2421])

**Upgrade notes:**

- Restart the Viewer and agent host after upgrading so the new backend and UI load. No coordinator schema migration is required.
- Newly recovered people may appear as **Team member** because the completed setup does not include person names. Recovery does not merge existing people or verify account ownership.
- The diagnosis command needs temporary disk space for a full database copy. It removes the copy afterward.

## [0.47.2] - 2026-10-28

### Changed

- Peer discovery and project-invite checks use more targeted coordinator database queries. ([#2412])
- Adding a device to an existing Google-linked Identity uses fewer coordinator database calls during confirmation. ([#2416])
- Observer instructions require unsupported claims to be omitted rather than qualified with comments about missing context or unmeasured results. ([#2415])
- Recovery snapshot assertions and mocked retry tests run faster, and TypeScript-source scanning avoids repeated full-prefix searches. ([#2418], [#2419])

### Fixed

- **Sign in with Google** is available after recovering a linked account owner even when this device's old Identity still needs review. Sign-in uses the existing coordinator checks and Google verification before asking you to confirm an Identity switch. ([#2413])
- Account ownership reviews collect the twelve evidence categories in one database snapshot instead of twelve separate reads. This removes 11 database calls per preview and 22 per confirmation while retaining schema validation and atomic freshness checks. ([#2414])

**Upgrade notes and limitations:**

- Restart the Viewer and agent host after upgrading so the new backend loads.
- Redeploy a self-hosted Cloudflare coordinator to use the coordinator query optimizations. Installations already upgraded to the 0.47.0 schema need no new migration.
- Headless sign-in still needs a supported callback route. Forwarding only the Viewer port is insufficient.

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

[Unreleased]: https://github.com/kunickiaj/codemem/compare/v0.49.0-beta.7...HEAD
[0.49.0-beta.7]: https://github.com/kunickiaj/codemem/compare/v0.49.0-beta.6...v0.49.0-beta.7
[0.49.0-beta.6]: https://github.com/kunickiaj/codemem/compare/v0.49.0-beta.5...v0.49.0-beta.6
[0.49.0-beta.5]: https://github.com/kunickiaj/codemem/compare/v0.49.0-beta.4...v0.49.0-beta.5
[0.49.0-beta.2]: https://github.com/kunickiaj/codemem/compare/v0.49.0-beta.1...v0.49.0-beta.2
[0.49.0-beta.1]: https://github.com/kunickiaj/codemem/compare/v0.48.1...v0.49.0-beta.1
[0.48.0]: https://github.com/kunickiaj/codemem/compare/v0.47.3...v0.48.0
[0.47.3]: https://github.com/kunickiaj/codemem/compare/v0.47.2...v0.47.3
[0.47.2]: https://github.com/kunickiaj/codemem/compare/v0.47.1...v0.47.2
[0.47.1]: https://github.com/kunickiaj/codemem/compare/v0.47.0...v0.47.1
[0.47.0]: https://github.com/kunickiaj/codemem/compare/v0.47.0-beta.4...v0.47.0
[0.47.0-beta.4]: https://github.com/kunickiaj/codemem/compare/v0.47.0-beta.3...v0.47.0-beta.4
[0.47.0-beta.3]: https://github.com/kunickiaj/codemem/compare/v0.47.0-beta.2...v0.47.0-beta.3
[0.47.0-beta.2]: https://github.com/kunickiaj/codemem/compare/v0.46.2...v0.47.0-beta.2
[0.46.2]: https://github.com/kunickiaj/codemem/compare/v0.46.1...v0.46.2
[0.46.1]: https://github.com/kunickiaj/codemem/compare/v0.46.0...v0.46.1
[0.46.0]: https://github.com/kunickiaj/codemem/compare/v0.45.0...v0.46.0
[#2438]: https://github.com/kunickiaj/codemem/pull/2438
[#2475]: https://github.com/kunickiaj/codemem/pull/2475
[#2476]: https://github.com/kunickiaj/codemem/pull/2476
[#2477]: https://github.com/kunickiaj/codemem/pull/2477
[#2480]: https://github.com/kunickiaj/codemem/pull/2480
[#2481]: https://github.com/kunickiaj/codemem/pull/2481
[#2482]: https://github.com/kunickiaj/codemem/pull/2482
[#2483]: https://github.com/kunickiaj/codemem/pull/2483
[#2484]: https://github.com/kunickiaj/codemem/pull/2484
[#2485]: https://github.com/kunickiaj/codemem/pull/2485
[#2487]: https://github.com/kunickiaj/codemem/pull/2487
[#2492]: https://github.com/kunickiaj/codemem/pull/2492
[#2494]: https://github.com/kunickiaj/codemem/pull/2494
[#2498]: https://github.com/kunickiaj/codemem/pull/2498
[#2500]: https://github.com/kunickiaj/codemem/pull/2500
[#2502]: https://github.com/kunickiaj/codemem/pull/2502
[#2503]: https://github.com/kunickiaj/codemem/pull/2503
[#2504]: https://github.com/kunickiaj/codemem/pull/2504
[#2505]: https://github.com/kunickiaj/codemem/pull/2505
[#2506]: https://github.com/kunickiaj/codemem/pull/2506
[#2507]: https://github.com/kunickiaj/codemem/pull/2507
[#2508]: https://github.com/kunickiaj/codemem/pull/2508
[#2510]: https://github.com/kunickiaj/codemem/pull/2510
[#2512]: https://github.com/kunickiaj/codemem/pull/2512
[#2513]: https://github.com/kunickiaj/codemem/pull/2513
[#2514]: https://github.com/kunickiaj/codemem/pull/2514
[#2515]: https://github.com/kunickiaj/codemem/pull/2515
[#2517]: https://github.com/kunickiaj/codemem/pull/2517
[#2518]: https://github.com/kunickiaj/codemem/pull/2518
[#2519]: https://github.com/kunickiaj/codemem/pull/2519
[#2520]: https://github.com/kunickiaj/codemem/pull/2520
[#2521]: https://github.com/kunickiaj/codemem/pull/2521
[#2523]: https://github.com/kunickiaj/codemem/pull/2523
[#2524]: https://github.com/kunickiaj/codemem/pull/2524
[#2527]: https://github.com/kunickiaj/codemem/pull/2527
[#2529]: https://github.com/kunickiaj/codemem/pull/2529
[#2530]: https://github.com/kunickiaj/codemem/pull/2530
[#2532]: https://github.com/kunickiaj/codemem/pull/2532
[#2533]: https://github.com/kunickiaj/codemem/pull/2533
[#2535]: https://github.com/kunickiaj/codemem/pull/2535
[#2536]: https://github.com/kunickiaj/codemem/pull/2536
[#2543]: https://github.com/kunickiaj/codemem/pull/2543
[#2544]: https://github.com/kunickiaj/codemem/pull/2544
[#2545]: https://github.com/kunickiaj/codemem/pull/2545
[#2546]: https://github.com/kunickiaj/codemem/pull/2546
[#2547]: https://github.com/kunickiaj/codemem/pull/2547
[#2548]: https://github.com/kunickiaj/codemem/pull/2548
[#2555]: https://github.com/kunickiaj/codemem/pull/2555
[#2556]: https://github.com/kunickiaj/codemem/pull/2556
[#2557]: https://github.com/kunickiaj/codemem/pull/2557
[#2561]: https://github.com/kunickiaj/codemem/pull/2561
[#2562]: https://github.com/kunickiaj/codemem/pull/2562
[#2565]: https://github.com/kunickiaj/codemem/pull/2565
[#2567]: https://github.com/kunickiaj/codemem/pull/2567
[#2572]: https://github.com/kunickiaj/codemem/pull/2572
[#2573]: https://github.com/kunickiaj/codemem/pull/2573
[#2574]: https://github.com/kunickiaj/codemem/pull/2574
[#2575]: https://github.com/kunickiaj/codemem/pull/2575
[#2576]: https://github.com/kunickiaj/codemem/pull/2576
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
[#2412]: https://github.com/kunickiaj/codemem/pull/2412
[#2413]: https://github.com/kunickiaj/codemem/pull/2413
[#2414]: https://github.com/kunickiaj/codemem/pull/2414
[#2415]: https://github.com/kunickiaj/codemem/pull/2415
[#2416]: https://github.com/kunickiaj/codemem/pull/2416
[#2418]: https://github.com/kunickiaj/codemem/pull/2418
[#2419]: https://github.com/kunickiaj/codemem/pull/2419
[#2421]: https://github.com/kunickiaj/codemem/pull/2421
[#2422]: https://github.com/kunickiaj/codemem/pull/2422
[#2423]: https://github.com/kunickiaj/codemem/pull/2423
[#2424]: https://github.com/kunickiaj/codemem/pull/2424
[#2425]: https://github.com/kunickiaj/codemem/pull/2425
[#2426]: https://github.com/kunickiaj/codemem/pull/2426
[#2427]: https://github.com/kunickiaj/codemem/pull/2427
[#2428]: https://github.com/kunickiaj/codemem/pull/2428
[#2581]: https://github.com/kunickiaj/codemem/pull/2581
[#2587]: https://github.com/kunickiaj/codemem/pull/2587
[#2592]: https://github.com/kunickiaj/codemem/pull/2592
[#2593]: https://github.com/kunickiaj/codemem/pull/2593
[#2596]: https://github.com/kunickiaj/codemem/pull/2596
[#2599]: https://github.com/kunickiaj/codemem/pull/2599
[#2605]: https://github.com/kunickiaj/codemem/pull/2605
[#2607]: https://github.com/kunickiaj/codemem/pull/2607
[#2608]: https://github.com/kunickiaj/codemem/pull/2608
[#2609]: https://github.com/kunickiaj/codemem/pull/2609
[#2612]: https://github.com/kunickiaj/codemem/pull/2612
[#2613]: https://github.com/kunickiaj/codemem/pull/2613
[#2619]: https://github.com/kunickiaj/codemem/pull/2619
[#2624]: https://github.com/kunickiaj/codemem/pull/2624
[#2630]: https://github.com/kunickiaj/codemem/pull/2630
[#2632]: https://github.com/kunickiaj/codemem/pull/2632
[#2644]: https://github.com/kunickiaj/codemem/pull/2644
[#2646]: https://github.com/kunickiaj/codemem/pull/2646
[#2647]: https://github.com/kunickiaj/codemem/pull/2647
[#2654]: https://github.com/kunickiaj/codemem/pull/2654
[#2655]: https://github.com/kunickiaj/codemem/pull/2655
[#2656]: https://github.com/kunickiaj/codemem/pull/2656
[#2657]: https://github.com/kunickiaj/codemem/pull/2657
[#2658]: https://github.com/kunickiaj/codemem/pull/2658
[#2659]: https://github.com/kunickiaj/codemem/pull/2659
[#2660]: https://github.com/kunickiaj/codemem/pull/2660
[#2661]: https://github.com/kunickiaj/codemem/pull/2661
[#2662]: https://github.com/kunickiaj/codemem/pull/2662
[#2664]: https://github.com/kunickiaj/codemem/pull/2664
[#2666]: https://github.com/kunickiaj/codemem/pull/2666
[#2667]: https://github.com/kunickiaj/codemem/pull/2667
[#2669]: https://github.com/kunickiaj/codemem/pull/2669
[#2675]: https://github.com/kunickiaj/codemem/pull/2675
[#2676]: https://github.com/kunickiaj/codemem/pull/2676
[#2677]: https://github.com/kunickiaj/codemem/pull/2677
[#2678]: https://github.com/kunickiaj/codemem/pull/2678
[#2679]: https://github.com/kunickiaj/codemem/pull/2679
[#2680]: https://github.com/kunickiaj/codemem/pull/2680
[#2730]: https://github.com/kunickiaj/codemem/pull/2730
[#2731]: https://github.com/kunickiaj/codemem/pull/2731
[#2735]: https://github.com/kunickiaj/codemem/pull/2735
[#2737]: https://github.com/kunickiaj/codemem/pull/2737
