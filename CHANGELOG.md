# Changelog

## [Unreleased]

### Added

- The pinned-peer check reply also reports, for the key each device was sent with, whether that key is removed or still enabled under the same device ID. It covers only devices that share a group with the asking device, now or through a removal there, and says nothing about blocked devices. Older clients ignore it.

### Changed

- Retrieval history keeps the candidates an attempt did not select (trimmed, dropped or deduplicated) for 14 days instead of 90. The attempt and the candidates it selected are still kept for 90 days by default, and pinned evaluation attempts keep every candidate. Every candidate is still recorded. While the Viewer runs, the maintenance worker removes the older unselected candidates in the same short batches as the rest of retrieval history; `codemem maintenance database prune-retrieval-ledger` removes them at once, and its dry run and `codemem memory stats` show how many are past the 14 days. A cached memory context reused after its unselected candidates are gone is no longer recorded as a copy of the original attempt.
- The Devices tab no longer shows a **Service devices** section. Relay health probes and other devices the coordinator runs are listed in a collapsed **Coordinator services** list at the bottom of the tab. On the Advanced tab, they no longer appear under **Devices waiting for review** or trigger **Pairing needed**.
- The Advanced tab titles the Project access row **Project access needs review** and counts every Project that needs review. The **Needs attention** label appears only above a list of attention items.
- The observer sends its configured reasoning effort on the **OpenCode account** connection, as the model variant. Before, these requests always ran at the service's default effort. If you configured an effort, extraction now runs at it, which can change cost and latency. A model that does not offer the effort keeps the service default, and a request whose effort the service rejects is retried once at the default. Observer status, replay and benchmark output report the fallback, per tier when tier routing is on, and Settings shows the requested effort next to the one applied. Replay and benchmark output also report temperature and output-token limits as not transmitted on this connection.
- The OpenAI rich-tier default is now `gpt-6.1-terra`, replacing `gpt-5.6-terra`, for tier routing, API-key and Codex session tiers, and Settings placeholders. A model you chose keeps precedence. In a small benchmark of 11 labelled batches with three repetitions, it recalled more required facts on rich batches than `gpt-5.6-terra` and costs half as much per input token at list prices. Benchmark cost estimates use list rates recorded on 2026-11-26, which correct the GPT-5.6 rates and add GPT-6 and Claude models. `diagnostics extraction benchmark` now records a batch whose observer call fails, finishes the other batches and exits with status 1, where before one failed call stopped the run and lost the finished batches.
- The default `observer_max_chars` is now 24,000 characters, up from 12,000, so the observer sees about 13,100 characters of each batch instead of 3,000. A value you set is kept. Input per batch rises by about 80 percent on rich batches and 50 percent on simple ones. Estimated from measured prompt sizes on 18 benchmark batches at about 4 characters per token, input costs about $0.0060 per rich batch on `gpt-6.1-terra`, up from $0.0034, and about $0.0005 per simple batch on `gpt-6-luna`, up from $0.0003, at list prices. These figures cover input only, because the connection used for the measurement reports no token usage. The observer instructions now say that a batch with only routine activity gets no summary at any budget. With more of a batch visible, the old wording led the observer to summarize batches it should skip.
- The user guide recommends observer models and reasoning effort per tier: `gpt-6.1-terra` at `medium` for rich batches and `gpt-6-luna` at `low` or `medium` for simple ones, based on a small benchmark run on 2026-11-26. It also explains how to set effort per tier.

### Fixed

- When a Project's memories move to another Space, the cleanup notice for the Space they left goes only to devices that could have received them there: devices with a membership record in that Space, or, for memories that were not in a Space, devices the older Project sharing rules would have sent them to. Before, every paired device received the notice, including one paired later that never had the memories, and learned the memory and Space ids. When a memory that was not in a Space moves into one, a device outside the new Space now receives a cleanup notice that removes its copy, instead of the move, which named the new Space. Devices in the new Space still receive the move.
- A synced update can no longer change which device a stored memory names as its creator. It can still fill in a missing or `local` origin, as when a device claims a memory it wrote before sync was set up. Before, a member with write access could relabel another device's memory as its own and later remove everyone's copies of it with a cleanup notice. A cleanup notice now removes a copy only when it comes from the device that created the memory: the device named in the memory's id or in its verified source record, and, for older memories whose id names no device, the stored origin.
- A sync push that is already under way stops sending a Project's changes to a peer when this device loses access to the Project: its membership is revoked or denied, or its stored coordinator proof no longer matches this device's signing key. This includes a move that would remove the peer's copy from the Project. Before each request, the push checked only the peer's access, so this device kept sending until the pass ended and only the peer's own check could refuse them.
- An inbound sync operation of a type this version cannot apply is no longer recorded as applied. Before, a peer that knew the id of a future operation could send it early under an unknown type and stop the real operation from ever applying here.
- A peer that is refused a scope now gets the same answer whether this device does not know the scope, holds it inactive or at an older membership epoch, or has a local scope with that id. A refused push also no longer names the scope where this device stores a copy of the memory, unless the peer named that scope itself. The precise reason stays in this device's log and scope-rejection history.
- On the **OpenCode account** connection, a requested reasoning effort was sometimes dropped to the service default for about a minute, reported as `variant_not_listed`, although the model offers it. While the service loads its providers it can answer the model list with an empty or partial list, and codemem cached that answer. Codemem no longer caches an empty list, and fetches the list once more when a cached or partial list misses the effort. An effort the model really does not offer still falls back once, and observer status reports the reason.
- Sync attempt history no longer grows without limit. Each sync pass records one row per peer, and nothing removed them: one store held about 400,000 rows. While the Viewer runs, its maintenance worker now deletes attempts older than 7 days in short batches, with the same time limit and retries as retrieval history retention. Older attempts are kept when the Viewer, sync status or the sync pass still use them: each peer's 10 newest attempts, its latest success and its latest failure of each kind, and the 500 newest attempts overall. A removed peer's history follows the same rule. `codemem sync attempts` and the technical history in diagnostics now reach back 7 days plus those kept rows. The database file keeps its size until it is vacuumed.
- Retrieval history and outcome evidence are now deleted 90 days after they are recorded, as their retention dates always said. Nothing removed them before, so stores grew without limit. After upgrading, the Viewer's maintenance worker removes an existing backlog gradually, a few seconds of work at a time, so capture and search stay responsive; `codemem maintenance database prune-retrieval-ledger` removes it at once. The database file keeps its size until it is vacuumed.
- Projects shared through an older scope that holds several Projects no longer show as **Project access needs review** on the Advanced tab. They are listed as **Shared scope controls access**, nothing is required, and they no longer raise **Needs attention** or count in it. Codemem also stops checking them every few minutes and checks again only when their scope mapping or the scope's Projects change.
- The Projects list shows one row for entries with the same name, Space and repository, so years of old folders for one repository no longer fill the list. Folders with the same name in different Spaces or repositories stay separate and are the only ones that ask for a name review. Staying on this device is no longer reported as a warning, and entries named after an error message or an internal placeholder move to a **No usable name** filter. Nothing about how memories are assigned or shared changes.
- The observer no longer cuts its extraction instructions to fit `observer_max_chars`. At the default budget, the last 1,419 characters of the summary instructions were dropped, including one of the rules for skipping a low-signal summary. Only the observed content is clipped now, and observer status, replay and benchmark output report the budget and the lengths before and after clipping, per section. Instructions longer than the whole budget are reported as a configuration error and still sent in full.
- `observer_max_chars` has a minimum of 2,000. A lower value is raised to 2,000 with a warning.
- Over-budget observer content is cut by section instead of keeping only its beginning, so the end of the transcript, the tool events and the summary context are no longer the first to be lost. Each cut is marked with `[...]`. Content within its budget is sent unchanged. A custom `observer_max_chars` now also sets how much transcript and tool output is prepared for each batch, which before always used the default of 12,000.
- Text inside `<private>` blocks in a user prompt, the last assistant message, a delegated brief or a tool event no longer reaches the observer when events are passed directly to `ingest()`. Raw events received by the viewer were already stripped when stored.
- Text inside `<private>` blocks could still be stored and sent to the observer in four cases: nested blocks, where the text between the inner and outer closing tags survived; opening tags with attributes or extra spaces, which were not recognized; working directories, tool names, timestamps, object keys and session metadata, which were copied without being cleaned; and the repair request, which resent the previous response with any private text it quoted. All four are now removed before anything is stored or sent, and the OpenCode, Claude Code, Codex and Pi integrations remove them before writing to their retry spools or session hints. A block now protects text only within the message or tool field where it is written. See the user guide for the rules. Text stored before this release is not changed.
- The Claude Code and Codex plugins on the default branch pin the latest stable release again. Preparing a prerelease had moved them onto the beta, and plugin installs failed where only stable versions are available.

## [0.50.0-beta.2] - 2026-11-25

### Added

- Memory search returns a compact, ranked index across MCP, the Viewer and Pi, with full details available by exact ID. MCP and native OpenCode callers can opt in to compact batch hydration. ([#2933])
- OpenCode Code Mode on supported 2.x hosts shows the codemem search and batch fetch signatures up front. The full tool catalog stays discoverable. ([#2934])
- The Projects list leaves out Projects that have no memories. A **No memories** filter shows them, and nothing is deleted. ([#2926])

### Changed

- Scopes with `manual` or `invite` authority no longer sync with other devices. Their memories stay visible and searchable on the device that holds them. Coordinator, personal and local scopes are unchanged. ([#2936])
- The People action is named **Remove from all sharing** and explains that it ends direct shares and access through every Team. Device removal confirmations say that Team membership stays the same. ([#2917])
- The Projects table shows one row per Project and readable names for path-only and unnamed Projects. Search finds unnamed Projects by "No project". ([#2919], [#2920], [#2925])

### Fixed

- Removing a device now ends its cached scope access on this device, and a scope permission refresh that began before the removal cannot restore it. ([#2929])
- A push to a peer rechecks the peer's pairing and scope access before every batch. ([#2930])
- A completed Team stays active when a device missing from its roster has a verified coordinator removal, and the removed device's access on this device ends first. The Team also stays unchanged when removal records cannot be read. ([#2918], [#2928], [#2931])
- Operations and snapshots pulled from a peer need the sender's coordinator proof for every scope they change, whatever sync capability the peer reports. A memory created on this device in a local scope is never changed by a peer. ([#2937], [#2938])
- A snapshot checks the pairing again before it writes, so a device removed during a download leaves sync state unchanged. ([#2938])
- OpenCode and Pi keep nested tool calls in captured sessions. ([#2932])
- The Viewer explains why a device removal preview was refused, lays out removed devices in rows, notes Projects shared through a group, and shows a **Team needs recovery** card for a disabled Team. ([#2914], [#2916], [#2927])
- Relay health probes stay under Service devices after coordinator discovery adds a peer record, instead of asking for pairing. ([#2915])

**Upgrade notes and limitations:**

- This is an opt-in beta on npm's `beta` channel. Restart the Viewer and agent hosts after upgrading.
- No coordinator database migration is needed since `0.50.0-beta.1`. Cloudflare operators should redeploy the Worker to pick up the current code.
- A device that still holds a `manual` or `invite` scope cached from before 0.46 stops syncing that scope.
- A removed device can still retract replicas of memories it created.

## [0.50.0-beta.1] - 2026-11-24

### Added

- Share Projects with Teams or individual people from the Viewer. Create a Team, review the Projects an invitation grants, and add another device without manually pairing it.
- Devices offers **Remove device** and **Block device permanently**. An eligible removed device can return with a fresh invitation or, when linked to a Google account, `codemem sync rejoin`. Permanent Block prevents that device ID and key from returning.
- Stop and resume a received Project on this device without changing access on your other devices.
- OpenCode 2.2.6 and later can share one `codemem mcp` process across all projects instead of starting one per project directory. Run `codemem setup --opencode-only --opencode-mcp pooled` to opt in, and the same command with `--opencode-mcp stdio` to go back. Searches, writes, and sharing scopes still follow the project each call came from. Every project must load the codemem plugin, and the default is unchanged. See [Shared MCP server](docs/plugin-reference.md#shared-mcp-server-on-opencode-2-opt-in). ([#2765], [#2766], [#2768])
- MCP clients can use `memory_session_search` to search stored Pi user/assistant transcripts with the same bounded results and project/session filters as Pi's existing native tool. Pi tool-mode defaults and OpenCode's native tool catalog are unchanged.

### Changed

- `codemem coordinator invitation create` now creates Team or add-device invitations from a Team admin's own device and no longer creates connection-only codes. Run it with `--team <name>` or `--add-device` and `--review` to see the Projects the invitation shares, then again with `--reviewed-onboarding-digest <digest>` to create it. The old `invitation create <group>` form fails with that guidance. To connect a device without sharing Projects, use `codemem coordinator device enroll`. Older connection-only codes can still be imported in 0.50, and 0.51 stops accepting them. See [Invite-driven enrollment](docs/coordinator-deployment.md#invite-driven-enrollment-recommended).

**Upgrade notes and limitations:**

- This is an opt-in beta on npm's `beta` channel. Restart the Viewer and agent hosts after upgrading.
- Upgrade the coordinator before using Google sign-in rejoin. Cloudflare operators must apply pending D1 migrations through `0051_add_device_rejoin.sql` before deploying the Worker. Back up the database and follow [Apply the D1 migrations](docs/cloudflare-coordinator-deployment.md#5-apply-the-d1-migrations).
- Older peers may retain direct pairings after coordinator-wide Remove. Update those peers or unpair the removed device manually.
- Remove and Block do not erase memories already copied to a device. Previously shared imports without a known author may remain on recipients after Project access is revoked.

## [0.49.1] - 2026-11-15

### Fixed

- The OpenCode plugin no longer opens a visible console window on Windows for each child process it starts during plugin load and use. ([#2745])
- OpenCode capture pauses after the Viewer rejects events with `viewer_identity_mismatch` instead of retrying forever. Saved events are kept, and OpenCode shows one warning explaining how to align the Viewer and OpenCode environments. Restart both after fixing the environment. ([#2744])
- Health shows offline or sleeping devices as "Waiting for devices" instead of reporting failed receives. Transfer errors and trust, scope, or version rejections still need attention. Receive errors stored before the upgrade clear after the next successful receive. ([#2746])
- Long runs of quote characters in distill rules or judge verdicts, and long plugin source strings, no longer cause slow regular-expression matching. Plugin event IDs always use `crypto.randomUUID()`. ([#2748])

## [0.49.0] - 2026-11-14

### Added

- `codemem memory context <task>` retrieves task-relevant memories, and `codemem memory context trace <task>` explains which memories were selected. ([#2630])
- MCP supports the 2026-07-28 discovery protocol alongside legacy `initialize` clients over stdio and HTTP. ([#2599])
- My Account offers **Connect this device** when a linked device needs its ownership recorded and a fresh Google sign-in can complete it for the same Identity. ([#2667], [#2677])

### Changed

- **Breaking: grouped CLI commands.** Commands now use `memory`, `session`, `service`, `maintenance`, and `diagnostics` groups. Use `codemem memory search` instead of `codemem search`, `codemem diagnostics capture status` instead of `codemem db raw-events-status`, and `codemem service status` instead of `codemem sync status`. See [Command migration](docs/cli-reference.md#command-migration). Hidden compatibility entrypoints remain for installed integrations. ([#2630], [#2632])
- The Viewer Feed loads pages without discarding older results on refresh. Project assignment previews stream their rows, and status and Project lists use indexed queries. ([#2608], [#2609], [#2619], [#2624], [#2661], [#2662])

### Fixed

- Linked devices can finish ownership setup from existing verified account claims and controller reviews. Devices under the same coordinator Identity can then sync without an invitation. ([#2664], [#2666], [#2669], [#2675], [#2676], [#2727], [#2728])
- Account status, device setup, account changes, and ownership recovery work on coordinators running SQLite 3.54.0 or 3.54.1. ([#2680], [#2682], [#2716])
- OpenCode 2 captures conversations in the correct project when one host serves multiple projects. Moving a session preserves the project and sharing scope of its earlier activity. ([#2731])
- Capture retains rejected payloads for inspection and explicit recovery so later queued activity can proceed. Failed extraction retries keep their original event range, and capture reports the stage where a failure occurred. ([#2581], [#2612], [#2613], [#2647], [#2655])
- Local memory writes and redaction durably schedule vector repair. Obsolete source snapshots and stale pending vectors no longer affect semantic ranking. ([#2587], [#2592], [#2593], [#2596], [#2605])
- Relayed sync accepts valid requests that arrive before the receiving device finishes preparing to read them, avoiding a timing-dependent disconnect. ([#2739])
- Relay health readiness refreshes after successful coordinator requests, preventing an expired published stamp from rejecting an otherwise healthy exchange. ([#2740])
- Background sync revalidates expired Space permissions before selecting a peer's relay route, including after slow earlier exchanges. ([#2741])

**Upgrade notes and limitations:**

- Restart the Viewer and agent hosts after upgrading. Update scripts to use the [grouped CLI commands](docs/cli-reference.md#command-migration).
- Self-hosted Cloudflare coordinators must apply migration `0044_add_rebind_start_authority.sql` before deploying the new Worker. See [Cloudflare coordinator deployment](docs/cloudflare-coordinator-deployment.md).
- Devices without a coordinator admin secret do not run automatic enrollment maintenance.
- Relay sync can still fail intermittently with `relay_aborted`. The cause remains under investigation.
- Native Pi saved-cutoff HTTP recovery is unsupported. Native Windows retained-capture recovery has not completed validation. Existing failed capture batches require explicit recovery.

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

[Unreleased]: https://github.com/kunickiaj/codemem/compare/v0.50.0-beta.2...HEAD
[0.50.0-beta.2]: https://github.com/kunickiaj/codemem/compare/v0.50.0-beta.1...v0.50.0-beta.2
[0.50.0-beta.1]: https://github.com/kunickiaj/codemem/compare/v0.49.1...v0.50.0-beta.1
[0.49.1]: https://github.com/kunickiaj/codemem/compare/v0.49.0...v0.49.1
[0.49.0]: https://github.com/kunickiaj/codemem/compare/v0.48.1...v0.49.0
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
[#2682]: https://github.com/kunickiaj/codemem/pull/2682
[#2716]: https://github.com/kunickiaj/codemem/pull/2716
[#2727]: https://github.com/kunickiaj/codemem/pull/2727
[#2728]: https://github.com/kunickiaj/codemem/pull/2728
[#2730]: https://github.com/kunickiaj/codemem/pull/2730
[#2731]: https://github.com/kunickiaj/codemem/pull/2731
[#2735]: https://github.com/kunickiaj/codemem/pull/2735
[#2737]: https://github.com/kunickiaj/codemem/pull/2737
[#2739]: https://github.com/kunickiaj/codemem/pull/2739
[#2740]: https://github.com/kunickiaj/codemem/pull/2740
[#2741]: https://github.com/kunickiaj/codemem/pull/2741
[#2744]: https://github.com/kunickiaj/codemem/pull/2744
[#2745]: https://github.com/kunickiaj/codemem/pull/2745
[#2746]: https://github.com/kunickiaj/codemem/pull/2746
[#2748]: https://github.com/kunickiaj/codemem/pull/2748
[#2765]: https://github.com/kunickiaj/codemem/pull/2765
[#2766]: https://github.com/kunickiaj/codemem/pull/2766
[#2768]: https://github.com/kunickiaj/codemem/pull/2768
[#2914]: https://github.com/kunickiaj/codemem/pull/2914
[#2915]: https://github.com/kunickiaj/codemem/pull/2915
[#2916]: https://github.com/kunickiaj/codemem/pull/2916
[#2917]: https://github.com/kunickiaj/codemem/pull/2917
[#2918]: https://github.com/kunickiaj/codemem/pull/2918
[#2919]: https://github.com/kunickiaj/codemem/pull/2919
[#2920]: https://github.com/kunickiaj/codemem/pull/2920
[#2925]: https://github.com/kunickiaj/codemem/pull/2925
[#2926]: https://github.com/kunickiaj/codemem/pull/2926
[#2927]: https://github.com/kunickiaj/codemem/pull/2927
[#2928]: https://github.com/kunickiaj/codemem/pull/2928
[#2929]: https://github.com/kunickiaj/codemem/pull/2929
[#2930]: https://github.com/kunickiaj/codemem/pull/2930
[#2931]: https://github.com/kunickiaj/codemem/pull/2931
[#2932]: https://github.com/kunickiaj/codemem/pull/2932
[#2933]: https://github.com/kunickiaj/codemem/pull/2933
[#2934]: https://github.com/kunickiaj/codemem/pull/2934
[#2936]: https://github.com/kunickiaj/codemem/pull/2936
[#2937]: https://github.com/kunickiaj/codemem/pull/2937
[#2938]: https://github.com/kunickiaj/codemem/pull/2938
