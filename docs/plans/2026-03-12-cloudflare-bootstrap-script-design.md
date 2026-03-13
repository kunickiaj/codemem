# Cloudflare Coordinator Bootstrap Script Design

**Bead:** `codemem-iw3`  
**Status:** Design  
**Date:** 2026-03-12

## Goal

Provide a user-friendly bootstrap flow for the Cloudflare coordinator example that is:

- easy to run manually
- pleasant and guided when interactive
- fully scriptable for automation

## Recommended shape

Implement this as a standalone Python helper in:

- `examples/cloudflare-coordinator/bootstrap.py`

Do **not** bake it into the main `codemem` CLI yet.

## Why script-first

- Cloudflare bootstrap is deployment-specific, not core product behavior
- it depends on operator workflow and external tooling like `wrangler`
- the built-in coordinator service belongs in the main CLI; Cloudflare bootstrap does not need to yet

## Dependency choice

Recommended stack:

- `Typer` for command/flag handling
- `rich` for formatted output
- `questionary` for interactive prompts

Fallback if we want fewer dependencies:

- `Typer` + `rich.prompt`

Recommendation:

- start with `Typer` + `rich` + `questionary`

This gives us a nice interactive experience without sacrificing scriptability.

## Modes

### Interactive mode (default)

Running without enough flags should walk the operator through setup.

The script should:

1. detect local codemem identity (`device_id`, fingerprint, public key)
2. check that `wrangler` is installed and authenticated
3. ask for the coordinator group name
4. create the D1 database if needed
5. create or patch `wrangler.toml`
6. apply the schema
7. optionally deploy the Worker
8. show or confirm the resulting Worker URL
9. apply or print the D1 enrollment SQL for the local device
10. optionally write or print a config snippet for `config.json`
11. optionally run the existing smoke check

### Scriptable mode

All required inputs must be passable as flags.

Recommended flags:

- `--group`
- `--worker-url`
- `--db-path`
- `--keys-dir`
- `--config-path`
- `--create-d1`
- `--apply-schema`
- `--deploy`
- `--enroll-local`
- `--print-sql`
- `--print-config`
- `--run-smoke-check`
- `--dry-run`
- `--non-interactive`
- `--format text|json`

Behavior:

- no prompts when `--non-interactive` is set
- machine-readable output when `--format json` is requested
- non-zero exit on validation or smoke-check failure

## First implementation scope

The first version should automate most of the operator workflow once `wrangler login` is already complete.

It should:

- read local identity information from the codemem DB and key store
- verify `wrangler` is available
- create D1 and apply schema when requested
- write or patch `wrangler.toml` from the example when requested
- deploy the Worker when requested
- generate and optionally apply enrollment SQL for the local device
- generate optional config snippets pointing codemem at the Worker
- optionally run the existing smoke-check script

It should **not** try to:

- mutate D1 directly unless we explicitly decide to shell out to `wrangler`
- enroll multiple devices in one run
- become a generic Cloudflare deployment framework

`--dry-run` should remain available so operators can see exactly what would be executed before the script mutates any
Cloudflare resources.

## Output design

Interactive mode should present:

- detected identity summary
- generated SQL block
- generated config snippet
- next-step checklist

Scriptable mode should be able to emit JSON like:

```json
{
  "group": "team-alpha",
  "device_id": "...",
  "fingerprint": "SHA256:...",
  "public_key_file": "...",
  "enrollment_sql": "...",
  "config_snippet": {
    "sync_coordinator_url": "https://...",
    "sync_coordinator_group": "team-alpha"
  }
}
```

## Nice-to-have follow-ons

- optional shell-out helpers for `wrangler d1 execute`
- optional Terraform example for Worker + D1 infra
- multi-device enrollment bundle generation

## Acceptance criteria

This design is successful when:

1. The bootstrap flow is clearly script-first, not main-CLI-first.
2. Interactive and non-interactive modes are both defined.
3. Dependency choices are pragmatic and lightweight.
4. The first implementation scope stays focused on local device bootstrap and verification.
