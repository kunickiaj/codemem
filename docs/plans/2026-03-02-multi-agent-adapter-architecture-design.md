# Multi-Agent Adapter Architecture (OpenCode, Codex, Claude, Windsurf, Cursor)

Related bead: `codemem-afm`

## Goal

Support multiple agent shells through a shared adapter contract, while keeping `codemem` core ingestion/retrieval logic shell-agnostic.

Priority order:

1. Preserve OpenCode behavior via adapter boundary.
2. Add Claude Code CLI as first non-OpenCode adapter.
3. Expand to other shells (Codex, Windsurf, Cursor) on the same contract.

## Product alignment decisions

- OpenCode is one adapter, not the system boundary.
- Multi-adapter operation is expected (OpenCode + Claude enabled by default).
- Project scoping is unified by normalized project label; shell identity stays in `source`.
- Generic bash/zsh/fish shell-hook wrapper strategy is out of scope.

## Adapter event schema v1 direction (`codemem-afm.1`)

Canonical v1 event types:

- `prompt`
- `assistant`
- `tool_call`
- `tool_result`
- `session_start`
- `session_end`
- `error`

v1 scope is conversation and tool lifecycle only.

Required envelope fields:

- `schema_version`
- `source`
- `session_id`
- `event_id`
- `event_type`
- `ts`
- `payload`

Ordering and identity:

- `seq` should be emitted when available.
- Missing `seq` is accepted for sources that cannot emit monotonic sequence yet, with `ordering_confidence=low`.
- For sources without native IDs, generate deterministic `event_id` hashes.

Safety:

- Redaction policy is soft redact (`[REDACTED]`) while preserving payload shape.

## OpenCode adapter boundary (`codemem-afm.2`)

- Refactor current OpenCode event mapping into `OpenCode -> AdapterEventV1 -> ingest`.
- Keep current flush/retry/backoff semantics unchanged.
- Validate parity against current behavior using regression tests.

## Claude adapter MVP (`codemem-afm.3`)

Ingestion model:

- Hook event stream is the MVP ingestion path.
- Use official Claude hooks payloads as source-of-truth for event mapping.
- Transcript fallback is out of scope for MVP (no fallback path shipped).
- Hook payloads are enqueued through the shared raw-event queue path (same queue family used by OpenCode stream ingestion).

Hook scope for MVP:

- In scope hook events: `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionEnd`.
- Out of scope in MVP: `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `PreCompact`.
- Deferred in template: `PreToolUse` (mapped in schema, but not emitted by default until tool-call persistence is enabled end-to-end).

Exact Claude hook -> AdapterEventV1 mapping (MVP):

- `SessionStart` -> `session_start`
  - `payload.source` <- hook `source` (`startup|resume|clear|compact`)
  - `meta.hook_event_name` <- `SessionStart`
- `UserPromptSubmit` -> `prompt`
  - `payload.text` <- hook `prompt`
  - `meta.hook_event_name` <- `UserPromptSubmit`
- `PreToolUse` -> `tool_call` (deferred in default template)
  - `payload.tool_name` <- hook `tool_name`
  - `payload.tool_input` <- hook `tool_input`
  - `meta.tool_use_id` <- hook `tool_use_id` (when present)
- `PostToolUse` -> `tool_result`
  - `payload.tool_name` <- hook `tool_name`
  - `payload.status` <- `ok`
  - `payload.tool_output` <- hook `tool_response`/result payload (normalized string or object)
  - `meta.tool_use_id` <- hook `tool_use_id` (when present)
- `PostToolUseFailure` -> `tool_result`
  - `payload.tool_name` <- hook `tool_name`
  - `payload.status` <- `error`
  - `payload.error` <- hook error/failure payload
  - `meta.tool_use_id` <- hook `tool_use_id` (when present)
- `Stop` -> `assistant`
  - `payload.text` <- assistant response text available at stop time
  - `meta.hook_event_name` <- `Stop`
- `SessionEnd` -> `session_end`
  - `payload.reason` <- hook `reason`
  - `meta.hook_event_name` <- `SessionEnd`

Ordering and identity notes for Claude hooks:

- Use hook-provided sequence/order fields when present; otherwise compute deterministic `event_id` from `(session_id, hook_event_name, ts, tool_use_id?, content hash)`.
- Set `ordering_confidence=high` when explicit ordering is present, else `ordering_confidence=low`.
- Tool lifecycle correlation uses `meta.tool_use_id` when available.

Activation and defaults:

- Hybrid activation: explicit commands plus optional auto-detect.
- Default for installed users: Claude adapter enabled and auto-detect enabled for known safe paths.
- First-run summary with clear opt-out.

Packaging:

- Ship Claude integration via official plugin packaging and hooks configuration.
- Keep hook scripts/pathing rooted in `${CLAUDE_PLUGIN_ROOT}`.

Plugin packaging/install checklist (MVP):

- `hooks/hooks.json` is packaged and registers only MVP in-scope events.
- Hook commands resolve from `${CLAUDE_PLUGIN_ROOT}` (no absolute user-specific paths).
- Installer enables plugin + hook config in one step and prints disable/uninstall commands.
- Post-install validation confirms hooks load in Claude and emit JSON payloads to adapter ingress.

Reliability checklist (MVP):

- Hook handler failures are non-fatal to Claude sessions; adapter swallows and logs mapping/IO errors.
- Raw payload ingestion preserves flush/retry/backoff semantics already used by OpenCode ingestion.
- Idempotency/dedupe is enforced by deterministic `event_id` generation.
- Redaction remains soft (`[REDACTED]`) and preserves payload shape.
- Backpressure behavior is documented (bounded queue + retry path) before rollout.

## Support matrix and rollout (`codemem-afm.4`)

Support tiers:

- `supported`
- `partial`
- `experimental`

Rollout gates:

1. Schema v1 stable.
2. OpenCode adapter parity validated.
3. Claude MVP validated.
4. Add additional adapters with tiered support documentation.

## Open questions to validate in implementation

- Safe default auto-detect paths across environments.
- Which optional metadata fields are stable enough for cross-shell normalization in v1.x.

Reference docs:

- `https://code.claude.com/docs/en/hooks`
- `https://code.claude.com/docs/en/plugins-reference`

Non-authoritative pattern references (optional):

- `../claude-mem`

## Draft schema artifacts

- `docs/plans/adapter-event-v1.schema.json`
- `docs/plans/adapter-event-v1.fixtures.json`
