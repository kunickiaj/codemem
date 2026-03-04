# Observer Auth Adapter and Runtime Plan

**Bead:** codemem-afm.12  
**Status:** Design  
**Date:** 2026-03-03

## Problem

Observer execution is currently tied to API-key-style auth assumptions and partial OpenCode-specific behavior. This creates gaps for:

- standalone Claude environments where Pro/Max subscription auth is available via host runtime, not API keys
- enterprise gateway environments that require short-lived tokens (for example, IAP) refreshed by a local command or wrapper
- future host runtimes (Codex, Cursor, ChatGPT subscription contexts) with different auth storage and refresh models

At the same time, we do **not** want a second observer pipeline.

## Goal

Add a flexible observer provider/auth adapter layer under the existing observer pipeline, with first-class support for command-based token retrieval, and make it configurable in both:

- config file (`~/.config/codemem/config.json`)
- settings UI (viewer `/api/config` + settings panel)

## Non-goals (for 0.16)

- No full Claude sidecar runtime implementation in this bead
- No full Pro/Max observer-runtime bridge in this bead
- No breaking change to existing API key workflows

## Design

### 1) Keep one observer pipeline

Do not change ingest/parse/persist flow. Only introduce adapter seams at provider/auth resolution.

Current flow remains:

1. Build `ObserverContext`
2. Build prompt
3. Execute observer call
4. Parse XML
5. Persist observations/summary/usage

### 2) Introduce adapter interfaces (minimal)

Add lightweight interfaces in observer modules:

- `ObserverProviderAdapter`: resolves request target/options (`base_url`, model, provider headers)
- `ObserverAuthAdapter`: resolves auth material for each request (`none|api_key|bearer`) with optional cache/refresh

This keeps provider/auth pluggable without changing parser or storage logic.

### 3) Auth source model (0.16 scope)

Add supported auth sources:

- `env` (existing behavior, explicit vars)
- `file` (read token from a local file path)
- `command` (execute command and use stdout as token)

`command` is first-class, not shell interpolation in header strings.

### 4) Header templating

Allow templated headers with adapter variables:

- `${auth.token}`
- `${auth.type}`

Example:

```json
{
  "observer_auth": {
    "source": "command",
    "command": ["iap-auth"],
    "timeout_ms": 1500,
    "cache_ttl_s": 300
  },
  "observer_headers": {
    "Authorization": "Bearer ${auth.token}"
  }
}
```

### 5) Config surface (required)

Add config keys:

- `observer_runtime` (`api_http` default; `claude_sidecar` reserved)
- `observer_auth_source` (`env|file|command|none`)
- `observer_auth_file` (path)
- `observer_auth_command` (array of args)
- `observer_auth_timeout_ms` (int)
- `observer_auth_cache_ttl_s` (int)
- `observer_headers` (map string->string template)

Keep existing keys intact (`observer_provider`, `observer_model`, `observer_api_key`, etc.) for compatibility.

### 6) Settings UI surface (required)

Expose and persist these fields in settings UI and `/api/config` validation:

- runtime selector
- auth source selector
- file path input (when `file`)
- command input (when `command`)
- timeout / ttl numeric inputs
- header template editor (key/value rows)

Validation must reject unsafe/malformed config (for example, non-array command payload).

### 7) Security and reliability

- Never log raw tokens
- Strip trailing newline from command output
- Direct exec (argv list), no shell interpolation
- Timeout command execution
- On 401/403: one forced refresh attempt, then fail with clear auth error
- Cache token by source config hash and TTL

## Future extension (post-0.16)

Implement `claude_sidecar` runtime adapter using same `ObserverContext` request contract, with host-runtime auth (Pro/Max) and session reuse.

This is additive and does not fork the observer pipeline.

## Acceptance criteria

1. Existing API key flows continue working unchanged.
2. Observer can authenticate via `command` token source and templated `Authorization` header.
3. Config file accepts new observer auth/runtime fields with validation.
4. Settings UI can view/edit/save these fields.
5. Tests cover config parsing, command auth, token cache/refresh, and settings API validation.
6. Docs explicitly state current auth support and 0.16 limitations (Pro/Max runtime bridge deferred).

## Bead breakdown

- `codemem-afm.12`: observer auth/runtime adapter architecture and 0.16 delivery gate
- `codemem-afm.13`: implement auth adapters (`env|file|command`) + header templating + retry/refresh behavior
- `codemem-afm.14`: config + settings API + viewer settings UI integration
- `codemem-afm.15`: docs + validation matrix for standalone Claude/work gateway before release tag

## Validation matrix for release gate

Run before tagging `v0.16.0`:

- local OpenCode + API key
- local standalone Claude + API key path
- work gateway + command token source (`iap-auth` style)

All must pass observer flush and produce persisted observations.
