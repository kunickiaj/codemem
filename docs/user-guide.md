# User Guide

## Check for updates

Use the read-only release check to compare the running CLI with the latest stable npm release:

```fish
codemem update check
codemem update check --refresh
codemem update check --json
```

- Results are cached locally for six hours; `--refresh` bypasses a fresh cache.
- `--json` prints one stable status object and uses a non-zero exit code when no validated fresh
  or stale status is available.
- Stale validated cache data remains clearly labeled and may provide guidance when the registry is
  unavailable.
- This command never installs or executes an update. Release installation remains outside this
  read-only check. `codemem update install` is the separate, fail-closed installer: it refreshes
  release status, requires a proven global npm installation and a stable release observed for at
  least 24 hours, installs exact matching `codemem` and `@codemem/embeddings` versions from the
  public npm registry, and verifies the active `codemem` command. It refuses npx, Docker, pinned,
  development, stale, prerelease, downgrade, and unknown installations. Bare `codemem update`
  remains non-mutating. As with a
  manual npm install, npm runs the packages' installation scripts for native CPU dependencies.

## Start or restart the viewer
- `codemem serve` runs the viewer in the foreground.
- `codemem serve start` runs it in the background.
- `codemem serve restart` restarts the background viewer.
- `codemem serve --background` still works as a deprecated alias for `codemem serve start`.

## Viewer trust model

- The viewer and its JSON APIs are designed for **localhost-only** use.
- codemem currently relies on loopback-origin checks and local-process assumptions, not a real login/session auth layer.
- Binding the viewer to `0.0.0.0`, putting it behind a reverse proxy, or exposing it through a tunnel can make local APIs reachable in ways the current trust model was not built for.
- Treat the viewer as a local tool. If you must expose it beyond loopback, add your own auth and network restrictions first.
- This warning applies to the viewer HTTP service, not the separate sync/coordinator listeners documented elsewhere.

## Check local operational status

`codemem status` is the local operational roll-up. It reports database readiness,
viewer state, sync, maintenance, semantic indexing, raw-event ingestion, and the
observer without changing configuration or stored data.

```fish
codemem status
codemem status --json
codemem status --db-path ./codemem.sqlite --config ./codemem.json
```

- `status` answers whether codemem can do useful local work; `stats` reports database inventory and usage.
- Collection is offline and local-only. It does not contact peers, coordinators, registries, update services, or non-loopback viewer hosts.
- A missing database is reported without creating it. Existing databases are opened read-only.
- With no viewer PID record, status probes the configured loopback viewer address; a malformed or non-loopback record reports `unknown` and is not fetched.
- Warnings and errors appear in the bounded `attention` list. A collected report exits `0` even when `ok` is false; collection failures exit `1`, and usage errors exit `2`.
- Terminal raw-event and observer failures affect `ok` for 24 hours; use `codemem db raw-events-gate` for the detailed reliability window.
- Use `codemem sync status` or `codemem sync doctor`, `codemem maintenance status`, and `codemem db raw-events-status` for detailed subsystem diagnostics.

## Seeing UI changes
- The viewer UI is built from `packages/ui/` and served by `packages/viewer-server/`.
- Rebuild UI assets after frontend changes: `pnpm --filter @codemem/ui build`.
- Restart the viewer after updates: `codemem serve restart`.

## Settings modal
- Open via the Settings button in the header.
- Shows effective values (configured or default) to avoid blank/ambiguous fields.
- Persists only changed settings on save (unchanged effective defaults are not rewritten to config).
- Uses task-oriented sections: `Connection`, `Processing`, and `Device Sync`.
- Includes a `Show advanced controls` toggle for technical tuning fields (JSON headers, cache/timeout, tier-routing tuning, network overrides, and pack limits).
- Connection/auth settings map to `claude_command`, `observer_runtime`, `observer_provider`, `observer_model`, `observer_base_url`, `observer_auth_source`, `observer_auth_file`, `observer_auth_command`, `observer_auth_timeout_ms`, `observer_auth_cache_ttl_s`, and `observer_headers`.
- Processing settings include `raw_events_sweeper_interval_s` plus tiered observer routing controls for `observer_tier_routing_enabled`, `observer_simple_model`, `observer_simple_temperature`, `observer_reasoning_effort`, `observer_reasoning_summary`, `observer_rich_model`, `observer_rich_temperature`, `observer_rich_reasoning_effort`, `observer_rich_reasoning_summary`, and `observer_rich_max_output_tokens`.
- When tiered routing is enabled, the Processing tab becomes the primary place for model selection; the Connection tab's base `observer_model` acts as a fallback rather than a competing primary control.
- When you have not made an explicit routing choice, codemem may enable tiered routing automatically for capability-safe paths such as OpenAI/Anthropic over `api_http` and Claude subscription usage over `claude_sidecar`.
- Explicit routing, model, and reasoning settings take precedence over built-in defaults where the selected transport supports them. OpenAI transport behavior has the simple-tier exception described below.
- OpenAI tier routing defaults to `gpt-5.6-luna` for simple batches and `gpt-5.6-terra` for rich batches.
- Rich routing defaults to 12,000 output tokens, while an explicit global `observer_max_output_tokens` setting or benchmark `--max-output-tokens` override applies to both tiers; `observer_rich_max_output_tokens` remains the highest-priority rich-only override.
- Official OpenAI direct API tiers always use Responses and explicitly send reasoning effort `medium` unless you configure a different effort. OAuth `codex_consumer` requests also remain on Responses. `observer_openai_use_responses: false` is only a custom-gateway compatibility setting: it selects chat completions when `observer_base_url` explicitly points to an OpenAI-compatible gateway, and official OpenAI cannot opt out of Responses. Chat-completions requests do not report reasoning effort or summary because those controls are not transmitted.
- OpenAI Responses requests omit temperature whenever active reasoning is configured because GPT-5.1+ accepts sampling controls only with reasoning effort `none`; replay and benchmark metadata report that temperature as not transmitted.
- Configure reasoning shared by both OpenAI Responses tiers with the Processing tab's advanced `Shared reasoning defaults`, the global `observer_reasoning_effort` / `observer_reasoning_summary` file settings, or their `CODEMEM_OBSERVER_REASONING_*` environment variables. The `observer_rich_reasoning_*` settings remain optional rich-specific overrides.
- The 2026-08-07 list rates are Luna at $1.00/M input and $6.00/M output versus GPT-5.4-mini at $0.75/M input and $4.50/M output; Terra and GPT-5.4 are both $2.50/M input and $15.00/M output. Measured extraction cost can rise by more than the list-rate difference when a model produces more output tokens.
- If a selected tier path cannot honor the requested settings, codemem records the requested versus actual provider/model/runtime details and surfaces a visible fallback reason.
- Sync settings can also be updated here (`sync_enabled`, `sync_host`, `sync_port`, `sync_interval_s`, `sync_mdns`).
- Environment variables still override file values.
- Config resolution supports JSON and JSONC with this precedence:
  1. explicit `CODEMEM_CONFIG`
  2. workspace-scoped config derived from `CODEMEM_RUNTIME_ROOT` or `CODEMEM_WORKSPACE_ID`
  3. legacy global config (`~/.config/codemem/config.json` or `~/.config/codemem/config.jsonc`)

## Observer auth configuration

- Runtime choices are `api_http`, `claude_sidecar`, and `codex_sidecar`.
- `claude_sidecar` runs observer calls through the local Claude runtime (subscription/session auth) and does not require `ANTHROPIC_API_KEY`.
- `claude_command` controls how `claude_sidecar` invokes Claude CLI (default `["claude"]`).
  - Wrapper example: `"claude_command": ["wrapper", "claude", "--"]`
- `codex_sidecar` runs observer calls through the local Codex CLI login and does not require `OPENAI_API_KEY`.
- `codex_command` controls how `codex_sidecar` invokes Codex CLI (default `["codex"]`).
- Default model selection:
- `api_http`: `gpt-5.4-mini` unless `observer_model` is set.
- `claude_sidecar`: `claude-4.5-haiku` unless `observer_model` is set.
- `codex_sidecar`: `gpt-5.1-codex-mini` unless `observer_model` is set.
- Tier routing may pick different simple/rich models automatically when the current runtime/provider path is marked capability-safe.
- Anthropic direct API calls use Anthropic's direct model IDs. codemem translates the common shorthand `claude-4.5-haiku` to `claude-haiku-4-5`; if you want a fixed snapshot, set a versioned model like `claude-haiku-4-5-20251001` directly.
- If a configured `observer_model` is unsupported by a sidecar CLI, codemem retries once with that CLI's default model.
- Supported auth sources: `auto`, `env`, `file`, `command`, `none`.
- `observer_auth_command` is argv and must be a JSON string array, not a space-separated string.
  - Config file form: `"observer_auth_command": ["iap-auth", "--audience", "example"]`
  - Env var form (`CODEMEM_OBSERVER_AUTH_COMMAND`): `'["iap-auth","--audience","example"]'`
- Header templates can use `${auth.token}`, `${auth.type}`, and `${auth.source}`.
- Settings are grouped into `Connection`, `Processing`, and `Device Sync` sections with shell-agnostic labels.
- Queue settings include `raw_events_sweeper_interval_s` (seconds), which controls background pending-event drain cadence.
- Tiered routing settings live in the Processing tab. The basic view exposes the tier-routing toggle plus simple/rich model choices, while advanced controls reveal the extra rich-tier tuning knobs.
- To avoid overlapping primary controls, the Connection tab reframes `observer_model` as a fallback whenever tiered routing is enabled.
- Rich-tier OpenAI transport tuning remains visible in Processing. Official OpenAI tiers and OAuth `codex_consumer` always use Responses with reasoning effort `medium` by default. An explicit custom `observer_base_url` may use `observer_openai_use_responses: false` for chat-completions compatibility.

Example command-token gateway config:

```json
{
  "observer_provider": "your-gateway-provider",
  "observer_base_url": "https://gateway.example/v1",
  "observer_runtime": "api_http",
  "observer_auth_source": "command",
  "observer_auth_command": ["iap-auth", "--audience", "example"],
  "observer_auth_timeout_ms": 1500,
  "observer_auth_cache_ttl_s": 300,
  "observer_headers": {
    "Authorization": "Bearer ${auth.token}",
    "X-Auth-Source": "${auth.source}"
  }
}
```

Header template variables:

- `${auth.token}`
- `${auth.type}`
- `${auth.source}`

Command/file token caching notes:

- Successful `file`/`command` token resolutions are cached for `observer_auth_cache_ttl_s`.
- Failed `file`/`command` resolutions are not cached (codemem clears stale cache and retries on the next call).

## Memory persistence
- A session is created per ingest payload.
- Observations and summaries persist when the observer emits meaningful content.
- Low-signal observations are filtered before writing.

## Automatic context injection
- The OpenCode plugin injects a memory pack next to the latest user message by default, keeping older prompt prefixes stable for provider prompt caches.
- Controls:
  - `CODEMEM_INJECT_CONTEXT=0` disables injection.
  - `CODEMEM_INJECT_SURFACE=system` uses the legacy OpenCode system-prompt injection surface.
  - `CODEMEM_INJECT_LIMIT` caps memory items (default 8).
  - `CODEMEM_INJECT_TOKEN_BUDGET` caps pack size (default 800).
- Scope revocation affects newly built packs immediately, but already-injected context in the current OpenCode session is not retroactively scrubbed; start a new session after revoking access if you need a clean prompt history.
- Retrieval, skipped injection, current-request cache reuse, and handoff status are recorded in the local evidence ledger. Records contain bounded memory identity, diagnostic codes, and safe repository-relative working-set paths, never prompt text, pack text, memory content, or absolute paths. Reattaching historical cached context does not create attempts, and ledger failures do not block injection. If post-restart identity repair fails, usable fallback context is still injected without assigning its delivery to a stale or failed ledger attempt.
- Reuse savings estimate discovery work versus pack read size.

## Retrieval attribution diagnostics

Use `codemem stats --attribution` to inspect local, bounded, observational retrieval diagnostics:

```fish
codemem stats --attribution
codemem stats --json --attribution
```

- The report covers the 50 most recent retrieval attempts and at most 100 linked assessments; counts are a recent bounded window, not lifetime totals.
- It includes lifecycle completeness: requested, selected, and handed-off attempts and exposures.
- Evidence completeness distinguishes validated assessed attempts with known or unknown results (insufficient evidence) from unassessed attempts (no valid assessment row was inspected).
- Invalid rows failed current fail-closed validation. Omitted-by-limit rows exceeded the assessment cap; affected attempts are reported with indeterminate status or incomplete assessment details instead of inferred from unvalidated raw rows.
- Findings include counts of stale and harmful assessments.
- It contains no raw transcript, per-memory ROI, or composite productivity score. It makes no causal claim absent a preregistered randomized contrast.

## Semantic recall
- Embeddings are stored via sqlite-vec + fastembed.
- Embeddings are written automatically for new memories.
- Backfill existing memories with: `codemem embed --dry-run` then `codemem embed`.
- If sqlite-vec fails to load, semantic recall is skipped and keyword search remains.

## Distill recurring lessons

Use `codemem distill` to find lessons that keep showing up in memory history.

```fish
codemem distill --explain
codemem distill --all-projects --json
codemem distill --no-judge       # skip the observer-model worthiness judgment
codemem distill --draft          # draft an AGENTS.md rule for the top candidate + diff
codemem distill --draft --apply  # write it after confirmation
```

Candidate mining is deterministic and review-first:

- `project` candidates target that repo's `AGENTS.md`; `user` candidates target global/user context.
- Without `--draft`, the command only emits ranked candidates and evidence (`draft_text` is null).
- Candidates are judged by default: one short observer-model call per candidate drops clusters that are recurring *activity* (release/CI status, review passes with no findings, context lookups) rather than recurring *lessons* — recurrence alone cannot tell these apart. Unjudgeable candidates are kept and marked `unjudged`. When no observer model is configured, the command falls back to unjudged output with a warning; `--no-judge` skips the judgment (and its model calls) entirely.
- `--draft` uses your configured observer model to write one concise rule for the top candidate and prints a unified diff; it does not write anything.
- `--apply` (implies `--draft`) writes the rule into a codemem-managed `## Distilled lessons` block, delimited by `<!-- codemem:distilled:begin/end -->` markers so every distilled edit stays in one place. It prompts before writing (except with `--json`, which is non-interactive — there `--apply` itself is the explicit consent and the write happens immediately) and appends only (never deletes your existing notes).

## Projects, Sharing, Devices, and Health

### Choose a sharing flow

The normal flow is **Projects → Sharing → Devices → Health**, not manual pairing. Inside **Sharing**, open **Teams** when you want to manage ongoing Team membership and inherited Project access:

- **Team onboarding** — create or join a Team when people will collaborate over time.
  - Accepting the Team invitation links the recipient's Identity and device and inherits every current and future Project assigned to that Team.
  - The invitation does not create Project-to-Team assignments. Manage those separately, and review the Team's Projects before sending or accepting the invitation.
- **Direct Project sharing** — once Team sharing is configured, use **Share exact Projects** to invite one Identity to exact Projects without adding the recipient to the Team.
- **Add device** — invite another device for an existing Identity and review the Projects it will inherit from that Identity's direct and Team access.

Team membership organizes people and devices, but it is not permission to every Project—only Projects explicitly assigned to that Team. Project access remains explicit and uses canonical Project identity.

**Advanced → Coordinator Administration** keeps the last successfully loaded coordinator groups, Spaces, join requests, devices, and status visible if a refresh fails. A bounded notice names stale or unavailable sections and provides **Retry**. Mutations that require current coordinator state remain disabled until refresh succeeds; retained rows and counts do not imply deletion, and a section that has never loaded is shown as unavailable rather than empty.

To rename an active Team, open **Sharing → Teams**, choose **Team settings**, and save a human-readable Team name. For Teams completed through legacy setup and still linked to the configured coordinator group, this one action updates both names; local Teams update only their policy metadata. If that exact Team and coordinator group has repeated completed setup records, all of those historical summaries receive the new name while remaining completed. Renaming never changes Team membership, device decisions, or Project access. If the connected service cannot be updated, the local name remains unchanged; retry the same name after the connection recovers.

### Set up an existing Team

If a Team needs device setup, **Sharing** shows a notice and **Continue setup**. The Teams list shows **Needs setup**, **In progress**, or **Ready**.

1. In **Review devices**, confirm a suggested person or choose an existing person. To add a missing person, open **Advanced → Manual device and identity controls**, choose **Create person**, then return to setup. Each confirmed assignment saves immediately and resumes if you leave or reload the page. A suggestion is never selected for you.
2. Still in **Review devices**, include each device with its confirmed person, choose **Exclude**, or clear an earlier choice to review it again. An exclusion applies only to this Team; a confirmed person assignment can be reused by another Team.
3. In **Review Projects**, check every Project. Codemem can recognize some Projects automatically; choose an explicit Project mapping for any it cannot. Unresolved Projects prevent finishing.
4. In the final review, check the server-provided list of people, included and excluded devices, Project mappings, and every access change. Nothing changes while you are reviewing or saving choices.
5. Choose **Finish Team setup** only when the review is correct. The first valid finish becomes the shared result for that Team. Codemem applies the confirmed Team, device decisions, Project mappings, and access changes together. If it cannot complete every change, it applies none.

Setup can become stale when devices, Project mappings, or access change while you are reviewing. Refresh the Team, review the updates, and finish again; new or changed devices need a fresh decision. Your unchanged saved choices remain available for review.

When another upgraded device opens **Sharing**, it automatically applies a completed Team's reviewed policy locally before removing the setup task. The Team then appears normally under **Sharing → Teams**, so you do not need to repeat setup on each device.

If the page closes or the finish response is lost, refresh **Sharing** and open the Team again. Retrying the same finish safely returns the completed result instead of applying access changes again. If setup cannot reach the shared completion service or cannot apply the completed result locally, the task stays visible and offers retry; it never hides an incomplete setup.

Every device that finishes or recovers setup must use a coordinator that supports cross-device Team completion. The device must also list the Team's coordinator group in `sync_coordinator_groups`; scope-backed discovery can show a Team for review but cannot complete its setup. With an older coordinator, Codemem keeps the setup unfinished rather than creating a local-only result; update the coordinator, then retry. A device upgraded after a prior local completion makes that result available when it reconnects, after which other upgraded devices recover it automatically.

### Share exact Projects

For direct sharing, including after Team onboarding:

1. Choose **Create an invitation → Share exact Projects**.
2. Choose an existing **Identity** or enter the teammate's Identity display name.
3. Select the exact projects and review their existing-memory counts.
4. Confirm that the invite shares those existing memories and future activity, then send the one expiring invite.
5. The recipient reviews the invitation, accepts once, and confirms their Identity and device display names. Codemem links the Identity and device, establishes trust and Project access, and starts initial sync.

```text
Brian will receive:
• 436 existing memories and future activity from codemem

No other projects will be shared.
```

Project access uses canonical project identity, not a display name. Selecting `codemem` does not share a similarly named or sibling project in the same Space. **Only me** keeps a memory local, even when its project is shared.

The invite is single-use, expires, and is limited to the reviewed Projects. It names one Identity, not a Team, and the recipient cannot add Projects during acceptance. Existing and future selected-Project memories arrive after setup; unrelated Projects remain absent.

### Add a device for an existing Identity

Create an **Add device** invitation from the existing Identity. Before sending it, review the exact Projects the new device will receive:

- Direct Projects come from access granted to that Identity.
- Team Projects come from the Identity's Team membership.
- Existing Project exclusions remain excluded.
- The invitation cannot silently add unrelated Projects during acceptance.

The recipient accepts on the new device. Codemem links it to the same Identity, establishes the required trust, and starts initial sync for the reviewed Projects.

### Devices, status, and recovery

**Devices** shows every known device and whether its Identity ownership is configured. It does not infer ownership from pairing, coordinator membership, device names, or historical associations. It also does not infer per-device Team access from Identity membership; use Team policy administration when you need to review authoritative device decisions. Both direct and Team access remain limited to exact canonical Projects selected in Sharing.

| Identity setup state | Meaning | What to do |
| --- | --- | --- |
| Configured | One active Identity binding is authoritative. | Nothing, unless you deliberately need to change the Identity. |
| Setup required | The local or paired device has no authoritative Identity. | Choose an existing active Identity, explicitly confirm the device, and review the change. |
| Pairing required | The device is visible through the coordinator but is not paired locally. | Pair it first, then return to Devices. Pairing does not choose an Identity. |
| Review required | Device or ownership evidence conflicts. | Use the Advanced review path; normal setup cannot resolve conflicts. |

For several setup-ready devices, select each device, choose an Identity for each one, and confirm each choice. Codemem never bulk-assigns an Identity from a suggestion. The review step lists every device and target Identity before the atomic commit. A prefilled local or suggested Identity is still unconfirmed until you select the confirmation checkbox.

Changing a configured device's Identity is a separate rebind flow. It shows both the previous and target Identities and requires another reviewed confirmation. If device evidence changes after preview, refresh Devices and review the current information before retrying.

The **Sharing** tab shows an attention notice while device setup, pairing, repair, or coordinator enrollment reconciliation remains. **Review Devices** focuses the authoritative ownership workflow. Devices and Sharing show only a safe affected-enrollment count. Identity setup records ownership only: it does not grant Projects, add Team membership, change recipient policy, or enable sync access. When no policy Teams exist, Sharing opens the Identities view rather than implying that coordinator groups are Teams.

**Availability** tells you whether the device can currently receive work. It does not change ownership or Project access:

| Status | Meaning | What to do |
| --- | --- | --- |
| Waiting for acceptance | The invite has not been accepted. | Copy the invite or cancel it. |
| Setting up project access / Starting first sync | Codemem is establishing trust, access, and initial replication. | Wait. |
| Waiting for device | The recipient device is offline. | Wait; sync continues when it reconnects. |
| Up to date | The selected projects are syncing. | Nothing. |
| Needs attention | A setup step reached a terminal failure. | Use **Retry setup**. |

An offline device is a passive waiting state, not a failure or revocation. It keeps its current access and catches up after reconnecting. Retry only when codemem shows **Needs attention**; retry preserves completed setup work and resumes from the failed step.

Disabling a device enrollment for one coordinator group revokes future delivery only for Projects in that group. The global identity device remains active, stays in **Devices**, and can retain access granted through other groups. Use **Advanced → Coordinator Administration** only to review or re-enable that technical group enrollment. Re-enabling clears the disabled state; the next owner reconciliation pass then restores only the Projects currently authorized through the Identity's direct shares and Team policies for that group. Delivery resumes without a broader re-invite, and unrelated Projects remain absent. A separate global identity-device revocation removes the device from the active list; it is not restored through the group enrollment action. Neither revocation nor disabling can delete memories already copied to a recipient device.

## Advanced operator and compatibility guidance

**Sharing is the primary supported Team experience.** Use **Sharing → Teams** for Team membership, Team names, Identity relationships, and inherited Project access. Use **Projects** to choose exact Project recipients.

**Advanced** is technical administration for compatibility, recovery, diagnostics, and self-hosted coordination. Its coordinator groups and Spaces are discovery and transport boundaries, not policy Teams. Creating, renaming, archiving, or restoring a coordinator group does not safely create, rename, archive, or change access for a Team in Sharing. Archiving a coordinator group stops its coordinator presence, peer discovery, Space grants, legacy invites, and joins, and removes that group from this device's local coordinator configuration. Restoring the remote group does not re-add that local configuration; configure this device separately before expecting presence or discovery here. Policy Team membership and Project access in Sharing remain separate and unchanged.

Use this section for same-person devices, existing integrations, diagnostics, or self-hosted coordination. These controls preserve internal compatibility and recovery capability; they are not required for the normal Projects → Sharing → Devices → Health workflow.

Legacy `#sync` and `#sync/diagnostics` viewer links remain valid Advanced routes. Saved Sync views and coordinator administration remain available through **Advanced**.

### Sync runtime

- `codemem sync enable` generates keys and writes config.
- `codemem serve start|stop|restart` manages the viewer-backed sync runtime.
- `codemem sync status` shows device info and peer health.

### Manual pairing

Use manual pairing for same-person devices, existing integrations, or compatibility—not normal teammate sharing.

1. In **Advanced**, open the Sync panel and scan/copy the QR payload (recommended).
2. Or run `codemem sync pair` and copy the payload.
3. On the other device, run `codemem sync pair --accept '<payload>'`.

Optional legacy filters can narrow an already-authorized peer's data; they cannot grant project access:

- `codemem sync pair --accept '<payload>' --include shared-repo-1,shared-repo-2`
- `codemem sync pair --accept '<payload>' --exclude private-repo`

### Product terms and internal access boundaries

Normal sharing uses product terms:

- A **Team** organizes collaborating people and their devices. Team membership can supply inherited access only to Projects explicitly shared with that Team.
- A **Project** is the exact canonical workspace selected for sharing, not every workspace with a similar display name.
- A **Space** is the user-facing access boundary that groups related Projects.

Advanced screens and diagnostics may call a Space a **Sharing domain**, a coordinator group an administrative container, and the stored boundary a `scope_id`. Those internal terms explain enforcement; users do not need them to share a Project or add a device. Coordinator-group membership alone never grants Project access.

Project filters narrow an already-authorized peer; they never grant Project access.

Use separate Sharing domains for personal, work, client, and OSS data on the
same machine:

| Example project | Recommended Sharing domain | Why |
|---|---|---|
| `personal/finance` | Personal | Private or same-person data should only sync to your own devices. |
| `work/acme-api` | Acme Work | Employer or team data should only sync to devices granted to that domain. |
| `oss/codemem` | OSS codemem | Public/open-source work can be shared with OSS peers without widening work access. |

Safe defaults:

- Unknown projects default to local-only until you map them.
- `Only me` keeps a memory local even if the project normally shares.
- Private same-person sync uses a personal Sharing domain, not a broad work or
  coordinator group grant.
- A peer's project include/exclude list can remove memories from sync, but it
  cannot add memories from a Sharing domain the peer is not authorized for.
- Broad mappings or basename collisions should be reviewed before you rely on
  them. If `codemem` exists under both work and personal paths, map the canonical
  workspace path/remote instead of trusting the basename.

For a mixed personal/work laptop, start conservatively:

1. Create or select one personal Sharing domain and one work/team Sharing
   domain in the Sync settings UI.
2. Map each known project to the smallest correct Sharing domain.
3. Leave unknown projects local-only until reviewed.
4. Pair peers normally, then confirm each peer card shows the expected
   authorized Sharing domains.
5. Use project include/exclude filters only to narrow what an already-authorized
   peer receives.

Do not treat coordinator-group membership as data access. A coordinator group can help discover and administer devices, but a device still needs Project access through a direct recipient or Team policy before it can receive those memories.

### Upgrade maintenance / Sharing-domain backfill

When upgrading an existing database to 0.30, codemem may run a one-time
Sharing-domain backfill. This stamps historical memories and sync bookkeeping
rows with `scope_id` so future sync and retrieval can enforce the new hard
boundary.

The progress total can be larger than the visible memory count because it
includes both `memory_items` and historical `replication_ops`. Large databases
can be CPU-bound while this runs. That is expected upgrade work; successful
completion should make later startups quieter.

Inspect current and completed maintenance jobs with:

```fish
codemem maintenance status
```

### Same-person device recovery

- In **Advanced → Sync**, ownership summaries come from active `identity_devices` bindings. Use the device card's **Set up Identity in Devices** or **Review or rebind in Devices** action to confirm or change ownership.
- A legacy `sync_peers.actor_id` value may appear as a suggested Identity, but it is only a hint. It does not become ownership until you explicitly review and confirm the binding in Devices.
- Identity setup preserves the distinction between ownership, provenance, pairing, and access. Private sync still requires membership in a personal Sharing domain; an Identity binding is not an access grant.
- If a machine is replaced or re-paired, use `Claim old device as mine` to reconnect older synced history to your local actor.

### Advanced actor management

- The Sync panel now has an `Actors` section for creating and renaming non-local actors.
- The same section can merge a duplicate actor into another actor. This immediately moves assigned peers, device bindings, Team memberships, and direct or received Project access to the target Identity, while already-stamped historical memories keep their current provenance until a later follow-on flow changes them.
- Historical actor records and `sync_peers.actor_id` remain available to explain provenance and supply setup suggestions. They do not establish device ownership.
- Create or rename an actor label here when maintaining legacy provenance, then complete any device ownership choice in Devices.
- Non-local peers receive memories only after Sharing-domain authorization succeeds. Their include/exclude filters can narrow that set, but cannot grant access.
- Use `Only me` on a memory when it should stay local and not sync to non-local actors.
- The Sync panel also shows a teammate review card with per-peer counts for memories that will share by default versus memories marked `Only me`, plus a one-click jump into `My memories` in the Feed for review.

### Compatibility, Spaces, grants, and reassignment

Legacy pairing and coordinator invitations remain supported, but do not grant selected-project access by themselves. Manual Space grants and project mappings are Advanced administration.

When selected history may already have replicated, all participating owner devices must support `reassign_scope` before codemem moves it into a project-specific boundary. If any required device lacks support, setup fails closed before partial migration; update that device, then use **Retry setup**. Technical capability details and IDs are available only in diagnostics.

### One-off sync

- `codemem sync once` syncs all peers once.
- `codemem sync once --peer <name-or-device-id>` syncs one peer.

### Autostart

- codemem does not ship a `sync install` helper in the TS CLI.
- Use an OS service manager to run `codemem serve start --foreground` at login/boot.
- Example service templates live in `docs/autostart/launchd/` and `docs/autostart/systemd/`.

### Diagnostics

- `codemem sync doctor` diagnoses sync configuration issues (keys, config, peer reachability).
- `codemem sync bootstrap <peer-device-id>` bootstraps sync state from a peer's snapshot.
- `codemem sync attempts` shows recent sync attempt history per peer.
- A restored peer requires its SQLite database and original signing key together.
  If no matching key exists in `device.key` or the configured platform keychain,
  sync fails closed with a `device_identity_*` diagnostic instead of silently
  replacing the enrolled key.
- The daemon records an `identity_error` state and retries without blocking local
  memory capture. Restore the original key, then restart the service if mDNS
  advertisement also needs to be re-established.
- See [Anchor-peer deployment](anchor-peer-deployment.md#storage-and-backups) for
  the complete backup and restore contract.

### Service helpers

- `codemem sync status` shows sync config and peer health.
- `codemem sync start|stop|restart` are deprecated — use `codemem serve start|stop|restart` instead. The viewer process manages the sync runtime; there is no separate sync-only daemon.

### Coordinator-backed discovery

- Use coordinator-backed discovery when peers are reachable but their addresses change frequently or mDNS does not work across network boundaries such as VPNs.
- Set `sync_coordinator_url` and `sync_coordinator_group` to enable it.
- The Settings UI exposes coordinator URL, group, timeout, and presence TTL fields under Device Sync.
- Use **Share** in Projects for normal teammate sharing. Manual project-to-Space assignment, grants, addresses, fingerprints, filters, epochs, and cursors are operator/compatibility details; Device Sync is for runtime configuration.
- The coordinator is self-hosted/operator-run and only helps peers discover fresh addresses; direct peer-to-peer sync remains the data path.
- See [docs/coordinator-discovery.md](coordinator-discovery.md) for setup, config, and current limitations.
- See [docs/anchor-peer-deployment.md](anchor-peer-deployment.md) if you want an always-on peer as a sync backstop for personal or team Sharing domains.
- Do **not** expose the viewer itself just because the coordinator or sync protocol needs cross-network reachability; those are separate surfaces.

### Keychain (optional)

- `CODEMEM_SYNC_KEY_STORE=keychain` stores the private key in Secret Service (Linux) or Keychain (macOS).
- Falls back to file-based storage if the platform tooling is unavailable.
- On macOS, the Keychain storage uses the `security` CLI and may expose the key in process arguments; use `CODEMEM_SYNC_KEY_STORE=file` if that is a concern.
- Keep the protected `device.key` file as the portable restore artifact even in
  keychain mode; codemem can repopulate the keychain from a matching restored
  file. A matching private key that remains in the platform keychain can also
  authenticate a local installation if `device.key` is missing, corrupt, or
  belongs to another identity. That is not a portable migration: moving a
  keychain-only credential requires platform-supported secure tooling. The
  database and public-key file alone cannot authenticate the original identity.

## Troubleshooting
- If sessions are missing, confirm the viewer and plugin share the same DB path.
- Check `~/.codemem/plugin.log` for plugin errors.
- Sync errors: `codemem sync status` shows the last error per peer.

### Semantic runtime unavailable

Codemem installs its matching optional embedding runtime by default and falls
back to FTS5 keyword retrieval when that runtime is absent. On Linux, set the
CPU-only policy so the installer skips the unused GPU provider:

```fish
env ONNXRUNTIME_NODE_INSTALL=skip npm install -g codemem
```

On Apple silicon macOS and Windows, install normally (no
environment variable, which `env`/`cmd.exe`/PowerShell do not share):

```text
npm install -g codemem
```

Rerun `codemem setup` after upgrading an existing installation. The scoped
`--opencode-only`, `--claude-only`, and `--codex-only` forms work too. Setup
replaces the old managed `npx -y codemem mcp` launcher and codemem MCP entries
detected as UV/UVX-based so both packages resolve in one runtime. Other custom
MCP commands remain unchanged.

For a smaller keyword-only install, use `npm install -g codemem --omit=optional`
and set `CODEMEM_EMBEDDING_DISABLED=1` in every Codemem process. The flag is
required because npm also omits sqlite-vec's optional platform package.

Generated MCP configurations use the durable global `codemem` binary when it is
available, allowing it to resolve the globally installed sibling package.
Setup-managed `npx` launchers instead request `codemem` and
`@codemem/embeddings` together in one temporary environment. After installation,
restart the host you configured — OpenCode, Claude Code, or Codex — plus any
running `codemem serve` process. Each MCP process checks runtime availability
once per lifetime, so a running Claude or Codex MCP host stays lexical-only until
it restarts; restarting `codemem serve` alone does not restart that MCP child.

Codemem runs semantic inference on the CPU. `ONNXRUNTIME_NODE_INSTALL=skip`
prevents ONNX Runtime's Linux installer from downloading unused GPU provider
libraries; the CPU binaries remain available. Apple silicon macOS and Windows
users can omit the environment variable. Intel (x64) Macs have no ONNX Runtime
1.24.3 artifact, so Codemem reports the unavailable semantic runtime and stays on
FTS5 keyword retrieval; installing the runtime there does not enable semantic
search.

The default `Xenova/bge-small-en-v1.5` model is pinned to a tested revision. If
you set `CODEMEM_EMBEDDING_MODEL` to another repository, it must be a
feature-extraction model that emits 384-dimensional embeddings — the
`memory_vectors` table is a fixed `float[384]` column, and the runtime rejects a
client whose dimensions differ. Also set `CODEMEM_EMBEDDING_REVISION` to a
branch, tag, or full 40-character commit SHA. The runtime resolves mutable refs
to their canonical Hugging Face commit before labeling vectors, preventing old
and new embedding spaces from sharing an identity. A custom model without a
revision is rejected; offline or local-model use requires the full commit-style
identity because Codemem cannot resolve a mutable ref without the Hub. Set
`CODEMEM_EMBEDDING_OFFLINE=1` to disable remote model requests and load that
commit only from the Transformers.js cache. Clear the variable before using a
mutable branch or tag so Codemem can resolve it to a canonical commit.
Viewer and OpenCode profile checks include this setting, so clients do not send
prompt content to an already-running viewer configured for online model access.
`CODEMEM_EMBEDDING_REVISION` can also override the default model revision when
an intentional rebuild is required.

The first v4 start rebuilds legacy default-model vectors once in the background.
Measured-compatible legacy vectors continue serving semantic search until the
new corpus is complete; other model or revision changes use FTS5 during the
rebuild. Cutover and stale-vector cleanup happen only after full coverage.
A CPU-only migration of 31,779 memories on an Apple M4 Max took about 30 minutes
and peaked at 3.24 GiB RSS. Runtime varies with text length, corpus size, and
hardware; the rebuild runs outside the viewer process in bounded batches.

ONNX Runtime 1.24.3 has no macOS x64 artifact, so Intel Macs continue using
FTS5 keyword retrieval instead of semantic inference.

### Required SQLite native binding

`better-sqlite3` is required for every codemem storage mode. Viewer startup now
checks its native binding before preparing a database or detaching a background
process; restart checks before stopping a healthy viewer. If the check fails,
copy the exact-version `npm install -g codemem@<version>` repair command from the
diagnostic. Use Node 24.15+ on a supported 64-bit target listed in the [native
install matrix](plans/2026-03-15-install-matrix.md).

`better-sqlite3` 13.0.3 bundles its N-API prebuilds and has no package install
script, so a failed binding check does not by itself mean npm blocked lifecycle
scripts. Semantic installs still carry upstream runtime requirements including
Sharp, ONNX Runtime, protobufjs, and global-agent; ONNX Runtime's postinstall and
roughly 220 MB unpacked weight remain upstream requirements. `sqlite-vec` stays
optional: viewer startup catches its load failure, disables semantic search, and
preserves FTS5 lexical search. Other commands require
`CODEMEM_EMBEDDING_DISABLED=1` when sqlite-vec is unavailable.

### sqlite-vec / `no such module: vec0`

**Symptom:** API errors with `SqliteError: no such module: vec0`, or the viewer logs `sqlite-vec failed to load; retrying viewer startup with embeddings disabled` at startup.

`memory_vectors` is a sqlite-vec virtual table backed by the `vec0` extension module. The module is shipped as a per-platform npm sub-package (`sqlite-vec-darwin-arm64`, `sqlite-vec-linux-arm64`, `sqlite-vec-linux-x64`, `sqlite-vec-windows-x64`, `sqlite-vec-darwin-x64`) and selected automatically by npm's `optionalDependencies` resolution. It usually just works, but a few install layouts can leave the right binary missing.

Diagnose first:

```fish
# Confirm the architecture and the codemem install path
uname -m
which codemem
ls (npm root -g)/codemem/node_modules/ | grep -i sqlite-vec
```

You should see both `sqlite-vec/` (the wrapper) and `sqlite-vec-<platform>/` (the prebuilt binary). If the platform-specific package is missing, that's the bug.

Fixes, in order of preference:

1. **Reinstall codemem with optional deps explicitly included.** npm sometimes drops `optionalDependencies` for global installs:
   ```fish
   npm install -g --include=optional codemem@latest
   ```

2. **Force-install the platform package alongside.** If reinstalling didn't help (sometimes happens with global installs across major Node upgrades), install the matching platform sub-package separately and link it into codemem's tree:
   ```fish
   # 64-bit Pi OS / generic Linux ARM64
   npm install -g sqlite-vec-linux-arm64
   ln -sfn (npm root -g)/sqlite-vec-linux-arm64 \
           (npm root -g)/codemem/node_modules/sqlite-vec-linux-arm64
   # then restart the viewer
   ```
   Substitute `sqlite-vec-linux-x64` for x86_64 Linux. A 32-bit Pi OS
   installation (`uname -m` reports `armv7l`) is not supported because
   better-sqlite3 13 does not ship a Linux armv7 binary; use a 64-bit OS on
   arm64 hardware instead.

3. **Run with embeddings disabled.** Codemem degrades gracefully: keyword search via FTS5 keeps working, the viewer keeps loading, and the only feature you lose is semantic recall via vector similarity:
   ```fish
   set -Ux CODEMEM_EMBEDDING_DISABLED 1
   # then restart the viewer
   ```
   Reverse with `set -e CODEMEM_EMBEDDING_DISABLED`.

The viewer's startup retries automatically with embeddings disabled if the initial load fails (`sqlite-vec failed to load; retrying viewer startup with embeddings disabled` in the banner). If you see API errors with `no such module: vec0` AFTER that retry message, please file an issue — `getSemanticIndexDiagnostics` and other vec-touching code paths should be self-healing on a connection without `vec0`.

### Bootstrap grant failures

**Symptom:** worker bootstrap fails with HTTP 401 / `bootstrap_grant_invalid`.

The wire error is intentionally generic. Check the peer serving the bootstrap snapshot for the specific reason, then work through these:

1. **Is the coordinator reachable from the peer serving bootstrap?** That peer, not the worker, calls the coordinator's admin API to verify the grant. If the coordinator is down or unreachable from that peer, the grant cannot be verified and bootstrap will fail. Check network connectivity and `sync_coordinator_url` config on the serving peer.
2. **Is the grant expired or revoked?** List active grants with `codemem coordinator list-bootstrap-grants <group>` and confirm the grant is still valid.
3. **Does the grant's worker device match the bootstrapping device?** The `worker_device_id` on the grant must match the device ID of the worker attempting bootstrap. A mismatch (e.g., using a grant issued for a different worker) will be rejected.

## Retrieval scope
- New memories are stamped with the Sharing domain resolved from their project mapping; unmapped projects stay local-only.
- Owned feed items expose a visibility control so you can explicitly switch a memory between `Only me` and `Share with peers`.
- Choosing `Only me` keeps the memory local; choosing `Share with peers` keeps it eligible only for peers authorized for the memory's Sharing domain.
- The feed supports `All`, `Mine`, and `Theirs` scopes without splitting memories into separate databases.
- For non-local peers, Sharing-domain membership is the access boundary. Project and per-peer sync filters narrow the eligible set, and `Only me` acts as a per-memory override.

## Advanced Sync panel
- The `Actors` section keeps legacy provenance-label creation and rename controls in one place.
- Peer cards show authoritative Identity ownership from Devices. Legacy actor values remain suggestions or provenance and cannot be saved as ownership from Advanced.
- Feed cards you own include a visibility control so shared/private intent can be changed without editing raw metadata.
- `Redact sensitive details` lives above Recent sync attempts so it is easier to find before you inspect peer addresses and attempt history.
- Recent sync attempts intentionally show only the latest few rows in the viewer; use CLI diagnostics for deeper history if needed.
