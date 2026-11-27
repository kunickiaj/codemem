# Changelog

## [Unreleased]

### Added

- A Team that was turned off after devices were removed from its coordinator group can be recovered. On a device that holds the coordinator admin secret, **View recovery details** now offers **Recover this Team**: **Review recovery** lists the people, devices and Projects that come back and what stays out, and **Recover Team** turns the Team back on. Removed devices and people stay out, including a removed device that is enrolled again later. Recovery reads the coordinator again after it saves, and the Team shares nothing until that read confirms it. A Team whose recovery could not be confirmed keeps showing **Needs recovery** and can be reviewed again. Before, such a Team stayed off, and setting it up again failed. The Viewer routes are `POST /api/sync/recipient-policy/v1/teams/:teamId/recovery/preview` and `.../recovery/commit`.

### Changed

- **Start review** in the older shared memories dialog now opens the review inside the dialog, so nobody has to open **Advanced → Sync** to assign each project a destination. Before, it switched to Advanced and scrolled to the review. The review is the same list with the same previews and confirmations. The dialog's **Manage all projects** button still opens Projects.
- **Devices** lists the devices that ask to join a coordinator group under **Join requests**, with **Approve** and **Deny**, on a Viewer that holds the coordinator admin secret. **Advanced → Coordinator administration** no longer has a **Join requests** tab, and its summary no longer counts join requests. Approval works as before. It calls the same coordinator routes, needs the same admin secret, and still grants the group's default access when the group has one, and the result says so when that grant fails. Devices reads join requests when you open it, after each approval or denial, and from **Refresh join requests**. The five-second Devices refresh does not read them, because reading every group can take longer than that.
- **Retire device** is gone from **Devices**, and the Viewer no longer serves `POST /api/sync/devices/:device_id/retire/preview` or `POST /api/sync/devices/:device_id/retire`. Only the Devices page in the Viewer called them. Open a device's menu and choose **Remove device** to stop sharing with it and allow it to rejoin, or **Block device permanently** for a lost or compromised device. A Viewer whose host does not offer Remove now shows no removal action at all. Before, it fell back to Retire. The Devices and Advanced copy for a device the coordinator revoked now says "blocked" instead of "retired".
- Coordinators can encrypt invitation tokens at rest. Once an operator records that no earlier Worker or codemem release serves the database, each new token is kept as its SHA-256 digest, which acceptance looks up, and as AES-GCM ciphertext under `CODEMEM_INVITE_TOKEN_KEY`, which **Copy invite** and create retries decrypt to rebuild the same link. The stored token becomes a random placeholder, and accepting an invitation drops its ciphertext in the same write. Until the floor is recorded, the coordinator stores tokens as before. Once it is, creating an invitation or copying its link without the key answers `503 invite_token_key_unavailable`, and accepting an invitation keeps working. Links are unchanged, so 0.50.0-beta.3 clients keep working. Cloudflare deployments apply migration `0055`, set the `CODEMEM_INVITE_TOKEN_KEY` secret, deploy, and run `POST /v1/admin/invite-tokens/seal` until it reports no plaintext and no spent ciphertext left. `CODEMEM_INVITE_TOKEN_KEY_PREVIOUS` keeps links of the previous key readable during a rotation. A self-hosted coordinator starts encrypting after `codemem coordinator invitation record-floor 1`, run while no process has its database open, which also encrypts the tokens it stored before. Without a configured key, the coordinator creates one in a mode-600 file next to its database. The command checks the key, or creates that file, before it records the floor, and records nothing when it cannot, such as on a filesystem without hard links, where it asks for a configured key. The Viewer's settings never return either key.

### Fixed

- `codemem service stop` and `codemem service restart` no longer stop another database's service. They picked the process to signal from the service answering at the port, or from the PID record that databases in one folder share, and checked only that its command line looked like a codemem service. A stop for one database could therefore end another database's service, and a restart then started the wrong database on its port. They now signal a service only when it is the process listening on its port and either the database's lock record names it with its current start time and the lock is held, or, for a service from 0.50.0-beta.3 or earlier, which records no lock, its prompt-pack profile reports this database and `lsof` shows it has the database file or its write-ahead log open. On macOS and Linux they refuse when `lsof` cannot run and say why. Otherwise they report the service as unconfirmed with the reason, stop nothing and exit with an error. Right before SIGTERM and before SIGKILL they run the same check again and require the process's start time and command line to match what was confirmed, so a reused PID is never signalled.
- A device that refuses a sync request for a scope the sender may not use no longer tells the sender about its default sync stream. Refused pushes, and refused reads of status, operations or a snapshot for such a scope, carried that stream's generation, snapshot id and cursors, on direct and relayed requests alike. The refusal now has only the error, the reason, the sync capability and the scope the sender named. A reset after the scope is authorized still carries that scope's boundary. Senders read only the error and reason from a refusal, so syncing between versions is unchanged.
- Assigning a device to a person, and adding or renaming a person, now need the coordinator admin secret, like the other changes to who receives a Project. Any device could bind a device to a person in Devices or through the older peer assignment route, which changed the Projects that device received, and any device could add or rename people. These routes now refuse a device without a coordinator and its admin secret, and check again just before they write. The one-time conversion of older device assignments also writes nothing if the coordinator settings change while it reads the coordinator, and the recipient-policy migration checks the admin secret again before it writes. Devices shows Identity setup and **Change Identity** disabled on those devices, and Sharing and the Advanced people list hide or disable renaming and adding people, each saying why. Pairing, removing a device and sync work as before without a coordinator.
- Changes to who receives a Project check the coordinator admin secret again just before they write. Recipient edge commits, review decisions, moving held-back memories into a shared scope, and Project mapping saves and removals checked it only when the request arrived, then waited for the request body or another change before writing. A device that lost the secret in that time could still apply the change. These now answer like the access check instead. A mapping save that only narrows access is still accepted on any device. Project mapping saves, removals and the bulk preview now act only for the one device identity the Viewer already uses: if this device has none yet they ask you to open Devices first, and if the database holds more than one they refuse, so they no longer create a device identity or analyze one device and write for another.
- Semantic search reads only the store file the store opened. Its worker identified the file when the first semantic search ran, so a file put at the store's path after the store opened would have been searched as the store. The worker now uses the identity the store took when it opened its connection, write-ahead log included, and checks it before and after it opens the file. A search that finds the path replaced is refused.
- The Viewer no longer stops answering for about half a second after each observer batch on stores with Project mappings and many sessions. Storing a memory, `/api/sync/status` and the sharing settings each mapped checkout folders to repositories by reading every session and parsing its metadata, 70-95 ms per read on a store with 27,000 sessions, several times per request. The maintenance worker now stores each session's recorded repository identity in an indexed column, so these reads take 1.5-3 ms; until its first pass, about 10 seconds after start, they parse metadata as before. The identity is computed by the same parser as before, and a session whose metadata changes is parsed again until the worker updates it.
- The Viewer no longer stops answering while it asks git for the origin remote of each workspace. Coordinator maintenance, the recipient-policy checks, several Sharing pages and every raw-event flush with Project mappings worked out which repository each session workspace belongs to, and ran `git config` as a child process for every workspace with a live repository and no recorded identity, again every 5 seconds. On a store with 195 workspaces that was 19 child processes and about 150 ms with every request blocked, each time. The answer is now kept per repository config file and reused while the file reads the same, so a changed remote is still seen at once. A config file that includes another is asked about every time, as before.
- The Viewer keeps answering while it builds a prompt pack. It assembled each pack on its event loop, which stopped every other request for about 200 ms per pack on a 12 GB store. The Viewer now assembles packs in a worker thread that opens the store read-only and reads as the Identity the request names. Before a pack is delivered, the Viewer checks that its Identity has not changed and that every memory in the pack is visible to it. If the worker fails, the pack is assembled as before.

## [0.50.0-beta.4] - 2026-11-27

### Added

- **Sharing → Teams** can remove a person from one Team. On a device that holds the coordinator admin secret, **Remove member** reviews the devices that stop receiving the Team's Projects and the Team's pending invitations, revokes the invitations you keep selected, and offers **Retry revoking** for any that failed. A Team whose coordinator group is unclear shows a warning on its card. ([#2980], [#2981], [#2985])
- Coordinators record each Team's group, so a Team member removal applies only in the group the Team belongs to. The first Team invitation for a Team binds it to the inviting group, and a Team invitation for the same Team from another group is refused with `409 team_bound_to_other_group`. Admin devices read bindings with `GET /v1/admin/team-group-bindings`. Cloudflare deployments need migration `0053` before the new Worker mints any Team invitation. It binds existing Teams whose invitations all came from one group. A Team that more than one group invited to stays unbound, and its Team invitations are refused with `409 team_binding_conflict` until an admin binds it with `POST /v1/admin/team-group-bindings`. A SQLite coordinator adds the storage when it starts. ([#2982])

### Changed

- Coordinators match a presented invitation token by its SHA-256 digest only, no longer also by the stored token, and a lookup that matches nothing writes nothing. Join requests keep only the digest of their invitation token. Approving a join request refuses it with `404 invite_invalid` when its invitation cannot be resolved, so an approval never skips the check that the inviter was not removed. **Copy invite** and create retries answer `409 invite_link_unavailable` instead of handing out a stored value that is not a bearer token. Migration `0054` adds a `coordinator_metadata` table, where the Worker records its invitation token lookup version during the admin's digest backfill and floor requests, never during an anonymous lookup, and an operator records, with `POST /v1/admin/invite-tokens/lookup-floor`, that no earlier Worker serves the database. Earlier Workers approve the join requests this one stores without checking whether the inviter was removed, so Cloudflare deployments pause join approvals and deploy this Worker as a full cutover, never a gradual rollout, then run `POST /v1/admin/invite-tokens/digests` until it reports no rows left, to give invitations from before token digests their digest. This Worker is the rollback floor for later changes to invitation token storage. A SQLite coordinator fills the digests and records its lookup version when it starts. ([#3006])
- The Team setup list on the Devices, Sharing and Projects pages no longer waits for the coordinator. The Viewer checks Team setup completions with the coordinator in the background: at start, every 5 minutes, after coordinator settings change, and when the list is more than 30 seconds old. The list shows that check's results and says when it is out of date or has not run yet. Before, every read waited for the coordinator, which took 3 to 7 seconds on one store. A setup that another admin device finished differently on the coordinator is now switched off within 5 minutes even when nobody opens Team setup. Before, that happened only when someone opened it. Finishing setup still checks with the coordinator first. Showing the list never changes setup or access: drafts and setup recipient repairs happen in the check, only after it has read the coordinator's roster, completions and removals. Before it restores a completed Team's setup recipient, the check records the Team member removals it read, so a removed person's devices stay refused. It waits while this machine still pairs with or binds a device the coordinator removed from the group, and a failed removal read stops the repair and shows the Team as needing attention. ([#2996])
- `codemem service start` refuses to start a second local service on a database that another one is already using, even on a different port or through a symlinked path, and exits with an error. Before, two services could run on one database, and Team setup could interleave one service's draft change with the other's Finish. A background start also reported success before the service had started, and a start that lost could overwrite the running service's PID record. The running service holds a lock file next to the database until it exits. `codemem service restart` waits for the old service to release the database before it starts the new one. A refused start names the process recorded as holding the database, as an unverified hint, and `codemem service stop` reports a database that is still locked instead of "No background viewer found". Start and stop also find a running service from an earlier release that recorded itself beside a symlinked database path. ([#2998])
- A Team member removal applies only in the Team's own coordinator group: the group its setup came from, the group an admin device created it for, or the group the coordinator bound it to. Each enrollment check reads the bindings of the Teams it handles, and an accepted invitation is never taken as evidence of a Team's group. An accepted invitation grants its Team only when the Team's group is the invitation's group. A Team the coordinator has not bound yet, with nothing else naming a group, keeps its current access, but no removal applies to it and its invitations grant nothing. When the sources disagree, or the coordinator reports Team invitations for a Team from more than one group and nothing else names its group, no new removal applies to that Team, its invitations grant nothing, the removal step refuses it, and the devices of its current and former members are refused the scopes that hold its Projects until the Team's group is resolved. Removals already enforced keep applying, and devices of the admin device's own person keep their access. A Team invitation goes only through the Team's known group, and the Viewer refuses one through another group with `409 team_group_mismatch`. If the removal list or the bindings cannot be read, the check grants no Team access from invitations until it can. A removal list that was read still applies to Teams whose group is already known. ([#2983])

### Fixed

- Viewer reads of People and recipient-policy review, and the device inventory, no longer take the database write lock on every request. They checked this device's actor row by running its repair in a write transaction even when nothing needed repair, so another writer, such as the maintenance worker, could hold each read for up to the 5-second busy timeout and block other Viewer requests meanwhile. The reads now check the row first and write only when it needs repair or local capture awaits adoption. ([#2989])
- Memories that ended up without vectors now get them. The maintenance worker checks every 10 minutes for active memories that have no vectors under the current embedding model and indexes them, up to 500 at a time. Before, a memory whose queued vector work was lost, for example when a sync pass committed memories but failed to record their vector work, stayed out of semantic search, and status reported the semantic index as `pending` indefinitely. Status now says how many memories have no vectors yet. The job a new or changed memory starts is titled "Indexing memories" and says "Queued vectors for new or changed memories", instead of "Re-indexing memories", which read as a full re-index after every upgrade. ([#2987])
- `codemem status` reports the current state of sync and the observer. Sync no longer reports `error` when the sync daemon's last error came from other daemon work, such as coordinator maintenance, and peers have synced since. It reports a warning that says when the error happened and when a peer last synced. Peers whose last sync attempt failed, such as offline devices, are counted in a warning. The observer warning says how many batches failed in the last 24 hours and how long ago the most recent one failed, instead of only "failed recently". ([#2988])
- The sync daemon no longer ends a paired device's access when the coordinator removed an older key of that device but still has the key this device pinned enabled under the same device ID. It uses the coordinator's per-key removal evidence for that. Without that evidence, as from an older coordinator, it removes the device as before. ([#2984])
- Team setup reconciliation in the Viewer no longer creates or repairs this device's signing keys when it asks the coordinator which paired devices were removed. Without an existing usable identity, it reports the check as unavailable and keeps every pairing. ([#2984])
- Before an admin device applies a Team setup that another admin device completed, the Viewer reads the group's Team member removals, so a removal recorded on another admin device is honored first. When it cannot read them, it applies nothing in that pass and leaves the Team as it is. ([#2979])
- Building a prompt pack stops the Viewer from answering for about a third less time. One pack asked SQLite about 8,000 times whether a table or column exists, which took about 85 ms. The answers are now kept per connection until the schema changes. On a 12 GB store a pack build blocked the Viewer for 270 to 300 ms and now blocks it for about 190 to 200 ms. ([#3000])
- The sync daemon no longer stops the Viewer from answering while it checks which memories still need a sync record. Every sync pass read every memory for that check, on the Viewer's event loop. On a 12 GB store it blocked every request for about a second every two minutes, and for up to 17 seconds when the pages were not in memory. The check now reads only memories that are new or changed since the last pass. The first full check of an existing store starts with the first sync pass, continues in the maintenance worker and shows on the Health tab as **Preparing memories for sync** until it finishes. The first start after upgrading builds one index, which takes a few seconds on a large store. ([#2990], [#2995], [#2997])
- Two more periodic jobs no longer stop the Viewer from answering. The sync daemon's cleanup of rows received from each peer read every memory twice per peer, and the raw-event sweeper read every stored event and every flush batch on each tick to find sessions to flush. On a 12 GB store these blocked every request for 0.1 to 0.5 seconds each time and for several seconds when the pages were not in memory. Both now read only the rows with work, through indexes. The first start after upgrading builds three more indexes. ([#2991])
- `GET /api/health` answers without reading the database, so a busy or locked database can no longer delay it or make `codemem status` report that the Viewer did not answer. `database.reachable` now means the Viewer holds an open database connection. ([#2991])
- Legacy import keys that cannot be rewritten, because another memory already has the device-scoped key, are tried once and reported once in a warning. Before, every sync pass read them again. ([#2990])
- The Devices, Sharing and Projects pages load faster. `GET /api/sync/status` no longer waits for the coordinator. It answers from the last coordinator status it fetched, gives that status's age, and fetches a new one in the background. Before, every read could wait on several coordinator requests and a database write, which took up to tens of seconds on a large store and held up other Viewer requests, including its health check. Semantic-index counts are read from the vector index's own row counts instead of scanning stored vectors. The read also no longer writes to the database. On a store with 66,000 memories, the work that stays on the request went from about 0.8–1.0 s to about 0.15 s. ([#2986])

### Internal

- Core can plan which devices and Projects a recovery of a disabled Team restores, and preview that recovery. Nothing in the Viewer uses it yet. ([#2992], [#2993], [#2994])
- The reads that decide memory visibility moved into shared functions, with no change in behavior. ([#3001])
- CI: the Node 26 job only builds and runs the smoke tests when most of the suite is affected, and the Legacy Team Migration scenario waits for peer-b's background Team setup check before it checks the completion. ([#2978], [#2999])

**Upgrade notes and limitations:**

- This is an opt-in beta on npm's `beta` channel. Restart the Viewer and agent hosts after upgrading.
- Self-hosted Cloudflare coordinator operators must apply D1 migrations `0053_add_team_group_bindings.sql` and `0054_add_coordinator_metadata.sql` before deploying the Worker. Both add new objects, and a Worker from `0.50.0-beta.3` keeps working with them applied. 0053 also binds each existing Team whose Team invitations all came from one group, and it fails without being recorded if it cannot, so a later `migrations apply` runs it again. A SQLite coordinator applies both when it opens its file. See [Team group bindings (0053)](docs/cloudflare-coordinator-deployment.md#team-group-bindings-0053).
- The Worker in this release stores only the digest of invitation tokens, and earlier Workers would approve the join requests it stores without checking whether the inviter was removed. Roll it out exactly as [Invitation token digests (rollback floor)](docs/cloudflare-coordinator-deployment.md#invitation-token-digests-rollback-floor) describes:
  1. Back up the database and apply the migrations.
  2. Pause join approvals.
  3. Deploy as a full cutover with `wrangler deploy`, never a gradual percentage, and wait until only this version serves every Worker bound to the database.
  4. Run `POST /v1/admin/invite-tokens/digests` until both remaining counts are `0`, then resume join approvals. Until then, invitations from before token digests cannot be accepted or approved.
  5. Once no earlier Worker serves the database, record the floor with `POST /v1/admin/invite-tokens/lookup-floor`.

  This Worker is the rollback floor for invitation tokens: after recording the floor, roll back only to this Worker or a later one. If you ever roll back below it, pause join approvals until this Worker serves the database again.
- Only one local service runs per database. Its lock file, `mem.sqlite.viewer-lock`, sits next to the database and must be on a local filesystem, so mounting only the database file into a container is unsupported. A second `codemem serve` on the same database is refused, even on another port or through a symlinked path.
- Upgrade every admin device of a group before removing a person from a Team. Admin devices on `0.50.0-beta.2` or earlier do not read Team member removals, and admin devices on `0.50.0-beta.3` do not know which coordinator group a Team belongs to.
- The Team setup list shows the Viewer's last background check with the coordinator. After another device finishes a Team setup, this device's list can be up to 30 seconds behind while you are reading it, and up to 5 minutes when nobody reads it. Finish always checks with the coordinator first.

## [0.50.0-beta.3] - 2026-11-26

### Added

- Admin devices can revoke a Team invitation that nobody has accepted with `POST /v1/admin/invites/revoke`. A revoked invitation can no longer be accepted. An accepted one is refused and left as it is, and other kinds of invitation are refused with `409 invite_kind_unsupported`. ([#2973])
- Coordinators can store that a person was removed from one Team, so every admin device of the group can honor it. Admin devices record and list removals with `/v1/admin/team-member-removals`. A removal is permanent for that identity, and the person comes back only through a new Team invitation, under a new identity. Cloudflare deployments need migration `0052` before the new Worker records any. A SQLite coordinator adds the storage when it starts. ([#2966], [#2976])
- Admin devices keep a person removed from a Team removed. On each enrollment check, the Viewer reads the group's removals from the coordinator and revokes each removed membership in the same step. From then on, the device refuses that person's devices every scope that holds one of the Team's Projects, while scopes they reach through a direct share or another Team stay open. Applying a Team setup again, accepting an older Team invitation or reconciling accepted invitations no longer makes that person a member. A removal applies only to a Team that its own coordinator group set up. If the removal list cannot be read, including from a coordinator without removal support, the check grants no Team access from invitations until it can. Admin devices on 0.50.0-beta.2 or earlier do not read removals, so upgrade every admin device before relying on them. ([#2974], [#2975], [#2976])
- The pinned-peer check reply also reports, for the key each device was sent with, whether that key is removed or still enabled under the same device ID. It covers only devices that share a group with the asking device, now or through a removal there, and says nothing about blocked devices. Older clients ignore it. ([#2958])

### Changed

- Retrieval history keeps the candidates an attempt did not select (trimmed, dropped or deduplicated) for 14 days instead of 90. The attempt and the candidates it selected are still kept for 90 days by default, and pinned evaluation attempts keep every candidate. Every candidate is still recorded. While the Viewer runs, the maintenance worker removes the older unselected candidates in the same short batches as the rest of retrieval history; `codemem maintenance database prune-retrieval-ledger` removes them at once, and its dry run and `codemem memory stats` show how many are past the 14 days. A cached memory context reused after its unselected candidates are gone is no longer recorded as a copy of the original attempt. ([#2961])
- The Devices tab no longer shows a **Service devices** section. Relay health probes and other devices the coordinator runs are listed in a collapsed **Coordinator services** list at the bottom of the tab. On the Advanced tab, they no longer appear under **Devices waiting for review** or trigger **Pairing needed**. ([#2945])
- The Advanced tab titles the Project access row **Project access needs review** and counts every Project that needs review. The **Needs attention** label appears only above a list of attention items. ([#2945])
- The observer sends its configured reasoning effort on the **OpenCode account** connection, as the model variant. Before, these requests always ran at the service's default effort. If you configured an effort, extraction now runs at it, which can change cost and latency. A model that does not offer the effort keeps the service default, and a request whose effort the service rejects is retried once at the default. Observer status, replay and benchmark output report the fallback, per tier when tier routing is on, and Settings shows the requested effort next to the one applied. Replay and benchmark output also report temperature and output-token limits as not transmitted on this connection. ([#2949])
- The OpenAI rich-tier default is now `gpt-6.1-terra`, replacing `gpt-5.6-terra`, for tier routing, API-key and Codex session tiers, and Settings placeholders. A model you chose keeps precedence. In a small benchmark of 11 labelled batches with three repetitions, it recalled more required facts on rich batches than `gpt-5.6-terra` and costs half as much per input token at list prices. Benchmark cost estimates use list rates recorded on 2026-11-26, which correct the GPT-5.6 rates and add GPT-6 and Claude models. `diagnostics extraction benchmark` now records a batch whose observer call fails, finishes the other batches and exits with status 1, where before one failed call stopped the run and lost the finished batches. ([#2952])
- The default `observer_max_chars` is now 24,000 characters, up from 12,000, so the observer sees about 13,100 characters of each batch instead of 3,000. A value you set is kept. Input per batch rises by about 80 percent on rich batches and 50 percent on simple ones. Estimated from measured prompt sizes on 18 benchmark batches at about 4 characters per token, input costs about $0.0060 per rich batch on `gpt-6.1-terra`, up from $0.0034, and about $0.0005 per simple batch on `gpt-6-luna`, up from $0.0003, at list prices. These figures cover input only, because the connection used for the measurement reports no token usage. The observer instructions now say that a batch with only routine activity gets no summary at any budget. With more of a batch visible, the old wording led the observer to summarize batches it should skip. ([#2953])
- The user guide recommends observer models and reasoning effort per tier: `gpt-6.1-terra` at `medium` for rich batches and `gpt-6-luna` at `low` or `medium` for simple ones, based on a small benchmark run on 2026-11-26. It also explains how to set effort per tier. ([#2957])

### Fixed

- When a reviewed Team setup is disabled because it no longer matches the coordinator, the Team's devices stop being served the scopes that hold its Projects, from that moment and whatever a later membership refresh caches. Before, the Team was disabled but a device that was still paired and still cached as a member, such as one removed from the coordinator, could keep receiving the Team's scopes until codemem revoked its membership later. A Team device is one bound to a Team member, or reviewed in the Team's setup. A scope holds a Team Project when setup put the Project there, when a current mapping routes it there, including a mapping edited in the Viewer, or when it still stores the Project's memories. Devices with no tie to the Team, and Team devices in scopes without the Team's Projects, keep their access. Once the Team is set up again, the devices its setup includes are served again. For an active reviewed Team, a Team device outside its reviewed device list is now refused the Team's Project scopes at once, which is the access codemem's background reconciliation would give it after a delay. Such a device that also has a direct share of one of those Projects is refused that Project's scope too, until it is added to the Team. Stored memories are matched to a Project by their session's git remote or folder, so memories whose Project is known only another way count only through setup and mappings. ([#2969])
- The Devices inventory no longer counts a pairing made by accepting an invitation as one a person made, until that pairing finishes its first sync. Such a device shows as **Pairing needed** instead of ready for Identity setup, unless someone paired the same key with Pair or claimed it as their own. ([#2971])
- The **Local Claude session** observer connection sends the prompt on stdin instead of as one command-line argument, which at the 24,000-character default came close to the Windows command-line limit. Each call now runs from an empty folder codemem owns, without saving a Claude Code session and without loading your CLAUDE.md files, plugins, hooks, MCP servers or tools. Before, every observer call added a session to your Claude Code history and read your project instructions. A configured reasoning effort is now passed to the CLI, falling back once if the CLI refuses it, and observer status reports the fallback. Token usage from the CLI is kept for cost reporting. An expired CLI login now shows "Claude CLI is not signed in; run `claude auth login`" instead of a generic authentication error. ([#2972])
- When a Project's memories move to another Space, the cleanup notice for the Space they left goes only to devices with a membership record in that Space, which every device that could have received them there has. Before, every paired device received the notice, including one paired later that never had the memories, and learned the memory and Space ids. A notice for memories that were not in a Space still goes to every device, because nothing records which devices received them. When a memory that was not in a Space moves into one, a device outside the new Space now receives a cleanup notice that removes its copy, instead of the move, which named the new Space. Devices in the new Space still receive the move. ([#2968])
- When a provider refuses an **OpenCode account** request, observer status and replay output now show the reason the OpenCode service reported, the upstream status and the provider, for example `rate_limit` with status 429 from `anthropic`. Before, they showed only `request_failed`. The provider's own message text is not kept. The user guide also notes that Claude subscriptions provided through an OpenCode login plugin do not currently work on this connection, and suggests the API-key connection or an OpenAI model instead. ([#2970])
- A synced update can no longer change which device a stored memory names as its creator. It can still fill in a missing or `local` origin, as when a device claims a memory it wrote before sync was set up. Before, a member with write access could relabel another device's memory as its own and later remove everyone's copies of it with a cleanup notice. A cleanup notice now removes a copy only when it comes from the device that created the memory: the device named in the memory's id or in its verified source record, and, for older memories whose id names no device, the stored origin. ([#2967])
- A sync push that is already under way stops sending a Project's changes to a peer when this device loses access to the Project: its membership is revoked or denied, or its stored coordinator proof no longer matches this device's signing key. This includes a move that would remove the peer's copy from the Project. Before each request, the push checked only the peer's access, so this device kept sending until the pass ended and only the peer's own check could refuse them. ([#2965])
- An inbound sync operation of a type this version cannot apply is no longer recorded as applied. Before, a peer that knew the id of a future operation could send it early under an unknown type and stop the real operation from ever applying here. ([#2960])
- A peer that is refused a scope now gets the same answer whether this device does not know the scope, holds it inactive or at an older membership epoch, or has a local scope with that id. A refused push also no longer names the scope where this device stores a copy of the memory, unless the peer named that scope itself. The precise reason stays in this device's log and scope-rejection history. ([#2960])
- On the **OpenCode account** connection, a requested reasoning effort was sometimes dropped to the service default for about a minute, reported as `variant_not_listed`, although the model offers it. While the service loads its providers it can answer the model list with an empty or partial list, and codemem cached that answer. Codemem no longer caches an empty list, and fetches the list once more when a cached or partial list misses the effort. An effort the model really does not offer still falls back once, and observer status reports the reason. ([#2959])
- Sync attempt history no longer grows without limit. Each sync pass records one row per peer, and nothing removed them: one store held about 400,000 rows. While the Viewer runs, its maintenance worker now deletes attempts older than 7 days in short batches, with the same time limit and retries as retrieval history retention. Older attempts are kept when the Viewer, sync status or the sync pass still use them: each peer's 10 newest attempts, its latest success and its latest failure of each kind, and the 500 newest attempts overall. A removed peer's history follows the same rule. `codemem sync attempts` and the technical history in diagnostics now reach back 7 days plus those kept rows. The database file keeps its size until it is vacuumed. ([#2955])
- Retrieval history and outcome evidence are now deleted 90 days after they are recorded, as their retention dates always said. Nothing removed them before, so stores grew without limit. After upgrading, the Viewer's maintenance worker removes an existing backlog gradually, a few seconds of work at a time, so capture and search stay responsive; `codemem maintenance database prune-retrieval-ledger` removes it at once. The database file keeps its size until it is vacuumed. ([#2946])
- Projects shared through an older scope that holds several Projects no longer show as **Project access needs review** on the Advanced tab. They are listed as **Shared scope controls access**, nothing is required, and they no longer raise **Needs attention** or count in it. Codemem also stops checking them every few minutes and checks again only when their scope mapping or the scope's Projects change. ([#2947])
- The Projects list shows one row for entries with the same name, Space and repository, so years of old folders for one repository no longer fill the list. Folders with the same name in different Spaces or repositories stay separate and are the only ones that ask for a name review. Staying on this device is no longer reported as a warning, and entries named after an error message or an internal placeholder move to a **No usable name** filter. Nothing about how memories are assigned or shared changes. ([#2948])
- The observer no longer cuts its extraction instructions to fit `observer_max_chars`. At the default budget, the last 1,419 characters of the summary instructions were dropped, including one of the rules for skipping a low-signal summary. Only the observed content is clipped now, and observer status, replay and benchmark output report the budget and the lengths before and after clipping, per section. Instructions longer than the whole budget are reported as a configuration error and still sent in full. ([#2951])
- `observer_max_chars` has a minimum of 2,000. A lower value is raised to 2,000 with a warning. ([#2951])
- Over-budget observer content is cut by section instead of keeping only its beginning, so the end of the transcript, the tool events and the summary context are no longer the first to be lost. Each cut is marked with `[...]`. Content within its budget is sent unchanged. A custom `observer_max_chars` now also sets how much transcript and tool output is prepared for each batch, which before always used the default of 12,000. ([#2951])
- Text inside `<private>` blocks in a user prompt, the last assistant message, a delegated brief or a tool event no longer reaches the observer when events are passed directly to `ingest()`. Raw events received by the viewer were already stripped when stored. ([#2950])
- Text inside `<private>` blocks could still be stored and sent to the observer in four cases: nested blocks, where the text between the inner and outer closing tags survived; opening tags with attributes or extra spaces, which were not recognized; working directories, tool names, timestamps, object keys and session metadata, which were copied without being cleaned; and the repair request, which resent the previous response with any private text it quoted. All four are now removed before anything is stored or sent, and the OpenCode, Claude Code, Codex and Pi integrations remove them before writing to their retry spools or session hints. A block now protects text only within the message or tool field where it is written. See the user guide for the rules. Text stored before this release is not changed. ([#2950])
- The Claude Code and Codex plugins on the default branch pin the latest stable release again. Preparing a prerelease had moved them onto the beta, and plugin installs failed where only stable versions are available. ([#2940], [#2942])
- A move pushed by a peer needs the same scope access as a move it pulls: the old side needs the scope the memory leaves, and the new side the scope it enters. ([#2956])

**Upgrade notes and limitations:**

- This is an opt-in beta on npm's `beta` channel. Restart the Viewer and agent hosts after upgrading.
- Cloudflare operators must apply D1 migration `0052_add_team_member_removals.sql` before deploying the Worker. It only adds new objects, and a Worker from `0.50.0-beta.2` keeps working with it applied. Back up the database first, as described in the deployment guide.
- Admin devices on `0.50.0-beta.2` or earlier do not read Team member removals. Upgrade every admin device of a group before relying on them.
- The observer defaults change unless you set your own values: the OpenAI rich tier moves to `gpt-6.1-terra`, and `observer_max_chars` doubles to 24,000, which raises input per batch.
- A Team device outside an active Team's reviewed device list is refused the Team's Project scopes right away. Such a device that also has a direct share of one of those Projects is refused that scope until it is added to the Team.

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

[Unreleased]: https://github.com/kunickiaj/codemem/compare/v0.50.0-beta.4...HEAD
[0.50.0-beta.4]: https://github.com/kunickiaj/codemem/compare/v0.50.0-beta.3...v0.50.0-beta.4
[0.50.0-beta.3]: https://github.com/kunickiaj/codemem/compare/v0.50.0-beta.2...v0.50.0-beta.3
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
[#2940]: https://github.com/kunickiaj/codemem/pull/2940
[#2942]: https://github.com/kunickiaj/codemem/pull/2942
[#2945]: https://github.com/kunickiaj/codemem/pull/2945
[#2946]: https://github.com/kunickiaj/codemem/pull/2946
[#2947]: https://github.com/kunickiaj/codemem/pull/2947
[#2948]: https://github.com/kunickiaj/codemem/pull/2948
[#2949]: https://github.com/kunickiaj/codemem/pull/2949
[#2950]: https://github.com/kunickiaj/codemem/pull/2950
[#2951]: https://github.com/kunickiaj/codemem/pull/2951
[#2952]: https://github.com/kunickiaj/codemem/pull/2952
[#2953]: https://github.com/kunickiaj/codemem/pull/2953
[#2955]: https://github.com/kunickiaj/codemem/pull/2955
[#2956]: https://github.com/kunickiaj/codemem/pull/2956
[#2957]: https://github.com/kunickiaj/codemem/pull/2957
[#2958]: https://github.com/kunickiaj/codemem/pull/2958
[#2959]: https://github.com/kunickiaj/codemem/pull/2959
[#2960]: https://github.com/kunickiaj/codemem/pull/2960
[#2961]: https://github.com/kunickiaj/codemem/pull/2961
[#2965]: https://github.com/kunickiaj/codemem/pull/2965
[#2966]: https://github.com/kunickiaj/codemem/pull/2966
[#2967]: https://github.com/kunickiaj/codemem/pull/2967
[#2968]: https://github.com/kunickiaj/codemem/pull/2968
[#2969]: https://github.com/kunickiaj/codemem/pull/2969
[#2970]: https://github.com/kunickiaj/codemem/pull/2970
[#2971]: https://github.com/kunickiaj/codemem/pull/2971
[#2972]: https://github.com/kunickiaj/codemem/pull/2972
[#2973]: https://github.com/kunickiaj/codemem/pull/2973
[#2974]: https://github.com/kunickiaj/codemem/pull/2974
[#2975]: https://github.com/kunickiaj/codemem/pull/2975
[#2976]: https://github.com/kunickiaj/codemem/pull/2976
[#2978]: https://github.com/kunickiaj/codemem/pull/2978
[#2979]: https://github.com/kunickiaj/codemem/pull/2979
[#2980]: https://github.com/kunickiaj/codemem/pull/2980
[#2981]: https://github.com/kunickiaj/codemem/pull/2981
[#2982]: https://github.com/kunickiaj/codemem/pull/2982
[#2983]: https://github.com/kunickiaj/codemem/pull/2983
[#2984]: https://github.com/kunickiaj/codemem/pull/2984
[#2985]: https://github.com/kunickiaj/codemem/pull/2985
[#2986]: https://github.com/kunickiaj/codemem/pull/2986
[#2987]: https://github.com/kunickiaj/codemem/pull/2987
[#2988]: https://github.com/kunickiaj/codemem/pull/2988
[#2989]: https://github.com/kunickiaj/codemem/pull/2989
[#2990]: https://github.com/kunickiaj/codemem/pull/2990
[#2991]: https://github.com/kunickiaj/codemem/pull/2991
[#2992]: https://github.com/kunickiaj/codemem/pull/2992
[#2993]: https://github.com/kunickiaj/codemem/pull/2993
[#2994]: https://github.com/kunickiaj/codemem/pull/2994
[#2995]: https://github.com/kunickiaj/codemem/pull/2995
[#2996]: https://github.com/kunickiaj/codemem/pull/2996
[#2997]: https://github.com/kunickiaj/codemem/pull/2997
[#2998]: https://github.com/kunickiaj/codemem/pull/2998
[#2999]: https://github.com/kunickiaj/codemem/pull/2999
[#3000]: https://github.com/kunickiaj/codemem/pull/3000
[#3001]: https://github.com/kunickiaj/codemem/pull/3001
[#3006]: https://github.com/kunickiaj/codemem/pull/3006
