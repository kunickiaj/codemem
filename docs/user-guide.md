# User Guide

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
- Processing settings include `raw_events_sweeper_interval_s` plus tiered observer routing controls for `observer_tier_routing_enabled`, `observer_simple_model`, `observer_simple_temperature`, `observer_rich_model`, `observer_rich_temperature`, `observer_rich_reasoning_effort`, `observer_rich_reasoning_summary`, and `observer_rich_max_output_tokens`.
- When tiered routing is enabled, the Processing tab becomes the primary place for model selection; the Connection tab's base `observer_model` acts as a fallback rather than a competing primary control.
- When you have not made an explicit routing choice, codemem may enable tiered routing automatically for capability-safe paths such as OpenAI/Anthropic over `api_http` and Claude subscription usage over `claude_sidecar`.
- Explicit config still wins. If you set routing or transport values yourself, codemem honors them instead of replacing them with built-in defaults.
- For OpenAI `api_http` paths, codemem now treats Responses as the default transport instead of chat-completions-style behavior.
- If a selected tier path cannot honor the requested settings, codemem records the requested versus actual provider/model/runtime details and surfaces a visible fallback reason.
- Sync settings can also be updated here (`sync_enabled`, `sync_host`, `sync_port`, `sync_interval_s`, `sync_mdns`).
- Environment variables still override file values.
- Config resolution supports JSON and JSONC with this precedence:
  1. explicit `CODEMEM_CONFIG`
  2. workspace-scoped config derived from `CODEMEM_RUNTIME_ROOT` or `CODEMEM_WORKSPACE_ID`
  3. legacy global config (`~/.config/codemem/config.json` or `~/.config/codemem/config.jsonc`)

## Observer auth configuration

- Runtime choices are `api_http` and `claude_sidecar`.
- `claude_sidecar` runs observer calls through the local Claude runtime (subscription/session auth) and does not require `ANTHROPIC_API_KEY`.
- `claude_command` controls how `claude_sidecar` invokes Claude CLI (default `["claude"]`).
  - Wrapper example: `"claude_command": ["wrapper", "claude", "--"]`
- Default model selection:
- `api_http`: `gpt-5.1-codex-mini` unless `observer_model` is set.
- `claude_sidecar`: `claude-4.5-haiku` unless `observer_model` is set.
- Tier routing may pick different simple/rich models automatically when the current runtime/provider path is marked capability-safe.
- Anthropic direct API calls use Anthropic's direct model IDs. codemem translates the common shorthand `claude-4.5-haiku` to `claude-haiku-4-5`; if you want a fixed snapshot, set a versioned model like `claude-haiku-4-5-20251001` directly.
- If a configured `observer_model` is unsupported by Claude CLI, codemem retries once with Claude's default model.
- Supported auth sources: `auto`, `env`, `file`, `command`, `none`.
- `observer_auth_command` is argv and must be a JSON string array, not a space-separated string.
  - Config file form: `"observer_auth_command": ["iap-auth", "--audience", "example"]`
  - Env var form (`CODEMEM_OBSERVER_AUTH_COMMAND`): `'["iap-auth","--audience","example"]'`
- Header templates can use `${auth.token}`, `${auth.type}`, and `${auth.source}`.
- Settings are grouped into `Connection`, `Processing`, and `Device Sync` sections with shell-agnostic labels.
- Queue settings include `raw_events_sweeper_interval_s` (seconds), which controls background pending-event drain cadence.
- Tiered routing settings live in the Processing tab. The basic view exposes the tier-routing toggle plus simple/rich model choices, while advanced controls reveal the extra rich-tier tuning knobs.
- To avoid overlapping primary controls, the Connection tab reframes `observer_model` as a fallback whenever tiered routing is enabled.
- Rich-tier OpenAI transport tuning remains visible in Processing, but OpenAI API paths are Responses-first by default.

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
- The plugin can inject a memory pack into the system prompt.
- Controls:
  - `CODEMEM_INJECT_CONTEXT=0` disables injection.
  - `CODEMEM_INJECT_LIMIT` caps memory items (default 8).
  - `CODEMEM_INJECT_TOKEN_BUDGET` caps pack size (default 800).
- Reuse savings estimate discovery work versus pack read size.

## Semantic recall
- Embeddings are stored via sqlite-vec + fastembed.
- Embeddings are written automatically for new memories.
- Backfill existing memories with: `codemem embed --dry-run` then `codemem embed`.
- If sqlite-vec fails to load, semantic recall is skipped and keyword search remains.

## Sync

### Enable + run

- `codemem sync enable` generates keys and writes config.
- `codemem sync start` starts the viewer-backed sync runtime.
- `codemem sync status` shows device info and peer health.

### Pair devices

1. In the viewer, open the Sync panel and scan/copy the QR payload (recommended).
2. Or run `codemem sync pair` and copy the payload.
3. On the other device, run `codemem sync pair --accept '<payload>'`.

Optional (recommended for coworker sync): set a per-peer project filter at accept time:

- `codemem sync pair --accept '<payload>' --include shared-repo-1,shared-repo-2`
- `codemem sync pair --accept '<payload>' --exclude private-repo`

### Claim your own devices

- In the Sync panel, use `Assigned actor` to map a peer to your local actor when that machine should count as part of your identity.
- Peers assigned to your local actor stay on the same-person continuity path, including private sync.
- If a machine is replaced or re-paired, use `Claim old device as mine` to reconnect older synced history to your local actor.

### Manage actors

- The Sync panel now has an `Actors` section for creating and renaming non-local actors.
- The same section can merge a duplicate actor into another actor; this immediately moves assigned peers, while already-stamped historical memories keep their current provenance until a later follow-on flow changes them.
- Assign each paired peer below to `Unassigned actor`, your local actor, or a named actor.
- Assigning a peer changes how older synced memories from that peer are attributed.
- Assigning a peer to a non-local actor keeps that peer's history shared; assigning it to your local actor keeps it personal/private.
- Non-local actors receive memories from projects allowed by their include/exclude filters by default.
- Use `Only me` on a memory when it should stay local and not sync to non-local actors.
- The Sync panel also shows a teammate review card with per-peer counts for memories that will share by default versus memories marked `Only me`, plus a one-click jump into `My memories` in the Feed for review.

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

### Service helpers

- `codemem sync status` shows sync config and peer health.
- `codemem sync start|stop|restart` are deprecated — use `codemem serve start|stop|restart` instead. The viewer process manages the sync runtime; there is no separate sync-only daemon.

### Coordinator-backed discovery

- Use coordinator-backed discovery when peers are reachable but their addresses change frequently or mDNS does not work across network boundaries such as VPNs.
- Set `sync_coordinator_url` and `sync_coordinator_group` to enable it.
- The Settings UI exposes coordinator URL, group, timeout, and presence TTL fields under the Sync tab.
- The coordinator is self-hosted/operator-run and only helps peers discover fresh addresses; direct peer-to-peer sync remains the data path.
- See [docs/coordinator-discovery.md](coordinator-discovery.md) for setup, config, and current limitations.
- Do **not** expose the viewer itself just because the coordinator or sync protocol needs cross-network reachability; those are separate surfaces.

### Keychain (optional)

- `sync_key_store=keychain` (or `CODEMEM_SYNC_KEY_STORE=keychain`) stores the private key in Secret Service (Linux) or Keychain (macOS).
- Falls back to file-based storage if the platform tooling is unavailable.
- On macOS, the Keychain storage uses the `security` CLI and may expose the key in process arguments; use `sync_key_store=file` if that is a concern.

## Troubleshooting
- If sessions are missing, confirm the viewer and plugin share the same DB path.
- Check `~/.codemem/plugin.log` for plugin errors.
- Sync errors: `codemem sync status` shows the last error per peer.

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
   Substitute the right platform: `sqlite-vec-linux-arm` for 32-bit Pi OS (`uname -m` reports `armv7l`), `sqlite-vec-linux-x64` for x86_64 Linux.

3. **Run with embeddings disabled.** Codemem degrades gracefully: keyword search via FTS5 keeps working, the viewer keeps loading, and the only feature you lose is semantic recall via vector similarity:
   ```fish
   set -Ux CODEMEM_EMBEDDING_DISABLED 1
   # then restart the viewer
   ```
   Reverse with `set -e CODEMEM_EMBEDDING_DISABLED`.

The viewer's startup retries automatically with embeddings disabled if the initial load fails (`sqlite-vec failed to load; retrying viewer startup with embeddings disabled` in the banner). If you see API errors with `no such module: vec0` AFTER that retry message, please file an issue — `getSemanticIndexDiagnostics` and other vec-touching code paths should be self-healing on a connection without `vec0`.

### Bootstrap grant failures

**Symptom:** worker bootstrap fails with HTTP 401 / `bootstrap_grant_invalid`.

The wire error is intentionally generic. Check the seed peer's server logs for the specific reason, then work through these:

1. **Is the coordinator reachable from the seed peer?** The seed must call the coordinator's admin API to verify the grant. If the coordinator is down or unreachable, the grant cannot be verified and bootstrap will fail. Check network connectivity and `sync_coordinator_url` config on the seed.
2. **Is the grant expired or revoked?** List active grants with `codemem coordinator list-bootstrap-grants <group>` and confirm the grant is still valid.
3. **Does the grant's worker device match the bootstrapping device?** The `worker_device_id` on the grant must match the device ID of the worker attempting bootstrap. A mismatch (e.g., using a grant issued for a different worker) will be rejected.

## Retrieval scope
- New memories default to the shared path for projects allowed by sync filters.
- Owned feed items expose a visibility control so you can explicitly switch a memory between `Only me` and `Share with peers`.
- Choosing `Only me` keeps the memory local and restores personal workspace scope; choosing `Share with peers` keeps it eligible for allowed-project sync and shared workspace scope.
- The feed supports `All`, `Mine`, and `Theirs` scopes without splitting memories into separate databases.
- For non-local peers, project and per-peer sync filters define the default eligible sync set, and `Only me` acts as a per-memory override.

## Viewer sync panel
- The `Actors` section gives actor creation/rename one home, while peer cards keep assignment close to the peer being changed.
- `Assigned actor` replaces the older `Belongs to me` language in the peer cards.
- Feed cards you own include a visibility control so shared/private intent can be changed without editing raw metadata.
- `Redact sensitive details` lives above Recent sync attempts so it is easier to find before you inspect peer addresses and attempt history.
- Recent sync attempts intentionally show only the latest few rows in the viewer; use CLI diagnostics for deeper history if needed.
