# Sync provenance

This document describes which provenance fields cross peer boundaries when codemem syncs memories, and which stay device-local. The goal is to make the trust and privacy model explicit so future changes don't accidentally leak information that should remain on the originating machine.

## Design statement

**Memories are portable. Session context is device-local by design.**

When a memory is created on device A and replicated to device B, the *memory* — its content, kind, scope membership, actor identity, originating device id, and the human-meaningful project it belongs to — travels with the operation. The *workspace it was created in* — the filesystem path, the git remote URL, the git branch, the wall-clock time the session started — does not. Those fields describe device-local context that is meaningful only on the machine that produced them.

This is a trust and privacy decision, not a gap. The home-directory path that holds a project on a developer's laptop is not useful on the NAS that received the memory hours later, and replicating it would expand the privacy surface of every Space without serving a concrete cross-device workflow.

## What replicates

These fields ride on every replicated `memory_item` op and are persisted on the receiver:

| Field | Source | Reason it crosses peers |
|---|---|---|
| `kind`, `title`, `subtitle`, `body_text`, `confidence`, `tags_text` | memory content | The memory itself |
| `actor_id`, `actor_display_name`, `origin_device_id` | provenance | Attribution survives so receivers know who created the memory and on what machine |
| `visibility`, `workspace_id`, `workspace_kind`, `scope_id` | sharing scope | Required to apply the scope rules on the receiver |
| `trust_state`, `origin_source` | trust metadata | Required for downstream filtering and review |
| `created_at`, `updated_at`, `rev` | clock | Required for ordering and conflict resolution |
| `import_key`, `dedup_key` | identity | Cross-device dedup |
| `metadata_json`, `narrative`, `facts`, `concepts`, `files_read`, `files_modified`, `user_prompt_id`, `prompt_number` | extracted artifacts | Render fidelity on the receiver |
| `project` | originating session | Allows the receiver's Projects tab to surface the memory under its real project identity instead of an opaque placeholder. This is the **only** session-level field that crosses peers. |

## What does NOT replicate

These fields exist only on the originating device and are NEVER written to a replication op payload or snapshot page:

| Field | Why it stays local |
|---|---|
| `sessions.cwd` | Filesystem path on the originating device; meaningless on a peer that may not have that path |
| `sessions.git_remote` | May carry private hostnames or internal SSH URLs |
| `sessions.git_branch` | Branch state at the moment of the session; rapidly stale; not useful out of context |
| `sessions.started_at`, `sessions.ended_at` | Wall-clock time of the local session; the memory's own `created_at` is the cross-device timestamp |
| `sessions.metadata_json` | Free-form local runtime state |
| `sessions.tool_version`, `sessions.user` | Origin-only diagnostics |
| `artifacts.*` | High-volume; intended to be regenerated or referenced via the memory's denormalized fields |
| `raw_events.*` | High-volume observer telemetry; never useful on a peer |
| `user_prompts.*` | The originating user's prompts; sensitive |
| `session_summaries.*` | Derived from the above; same constraint |
| `usage_events.*` | Per-device telemetry |
| `actors.is_local` | Per-device truth; the receiver's local actor is whoever owns the local device, not the sender |

## Synthetic sessions on receivers

When a memory arrives on a device that has never observed its originating session, the receiver creates a *synthetic placeholder session* (`sessions.cwd = "__sync_bootstrap__:<project>"`) just to satisfy the NOT NULL foreign key on `memory_items.session_id`. These placeholders are internal scaffolding and are filtered out of the Projects tab read model. They never carry any of the device-local fields above — only the `project` value that was carried on the wire.

The shared prefix is exported as `SYNC_BOOTSTRAP_CWD_PREFIX` from `packages/core/src/sync-bootstrap.ts`; readers and writers reference the same constant.

## How `memory_items.project` works

`memory_items.project` is a denormalized copy of the originating `sessions.project` at the time the memory was inserted (locally) or applied (from a sync op). It exists so:

1. The Projects tab read model can surface cross-device memories under their real project name without joining through `sessions` (whose `cwd` is device-local and whose synthetic-placeholder rows would otherwise pollute the inventory).
2. Older databases get the column backfilled from `sessions.project` on the first `ensureAdditiveSchemaCompatibility` pass — see `packages/core/src/db.ts`.

Receivers tolerate inbound ops from older codemem versions that omit `project` on the wire: the field is optional, and the local row falls back to whatever `sessions.project` resolves to on the receiver (usually the placeholder bootstrap session's project, since that itself is set from the wire payload).

## Future evolution

If a concrete cross-device workflow ever needs to surface `cwd`, `git_remote`, or `git_branch` on a non-originating device, that's an *additive* change to this contract: ship the new fields on the op payload, persist them, and amend this document to call out which Spaces opt into the wider exposure. Until that workflow appears, the floor stays at "memories portable; session context device-local."
