# CLI operational status and command-tree consolidation

**Status:** Approved design

**Date:** 2026-08-11

**Decision:** Add top-level `codemem status` and a cheap viewer `GET /api/health`.

## Problem

Operators cannot currently ask one reliable question—“is codemem running and
healthy?”—without assembling several commands and endpoint-specific probes.
`stats` is inventory/usage, not an operational assessment; the detailed
subsystem commands are necessary but do not provide an overall answer.

## Audit evidence

The current assembled CLI has **29 root commands**, **25 visible roots**, and
roughly **125 command nodes** when compatibility duplication is included. These
counts include Commander's implicit `help` root, hidden commands, and the full
duplicated `sync coordinator` compatibility subtree. The tree has these
confirmed gaps:

- Operational health is split across `stats`, `sync status`/`sync doctor`,
  `maintenance status`, and `db raw-events-status`; there is no general
  `status` command.
- Deprecated `export-memories`/`import-memories` and legacy sync/coordinator
  paths remain visible in parts of the surface; compatibility duplication makes
  the tree harder to discover.
- Completion omits `maintenance`; completion and registered-command parity is
  not tested as an assembled tree.
- README and user-guide material still recommends `sync start`; coordinator
  discovery and anchor-peer deployment examples omit required `--effect-id`
  arguments for membership changes and retain legacy coordinator host/port
  forms despite the top-level `coordinator` command.
- `config workspace` overlaps `sync enable`/`disable`/`connect`, memory CRUD and
  evaluation-oriented commands share one group, and JSON support is uneven
  across neighboring sync and database mutation commands.

The endpoint audit also found three incompatible viewer probes:

| Caller | Probe |
| --- | --- |
| MCP stdio | `GET /api/health` |
| Serve lifecycle | `GET /api/stats` |
| OpenCode plugin | `GET /api/raw-events/status?limit=1` |

`/api/health` is not currently registered. Consequently MCP `ensureViewer`
misclassifies a healthy viewer as unhealthy and performs redundant detached
start/poll attempts. This is **not** an MCP startup blocker: `ensureViewer` is
best-effort/background, and MCP continues with its own store and stdio server.

Evidence sources: `packages/cli/src/index.ts`, `commands/serve.ts`,
`commands/stats.ts`, `commands/sync.ts`, `commands/maintenance.ts`,
`commands/db.ts`, `packages/mcp-server/src/stdio.ts`, the OpenCode plugin,
viewer stats routes, README, user guide, and coordinator documentation.

## Chosen command model

| Alternative | Result |
| --- | --- |
| `codemem status` | **Chosen.** A frequent, cross-subsystem operational question is a top-level action, produces a stable automation contract, and does not imply lifecycle mutation. |
| `codemem serve status` | Rejected. `serve` owns viewer lifecycle; database, sync, ingestion, and observer state exceed that process boundary. |
| `codemem health` | Rejected. Ambiguous with the HTTP liveness endpoint and less familiar as an operator roll-up. `status` can report degraded detail rather than only pass/fail. |

Boundaries remain explicit:

- **`status`**: operational roll-up—can codemem do useful local work now?
- **`stats`**: database inventory and usage, not health.
- **Subsystem commands**: `sync status`, `sync doctor`, `maintenance status`,
  and `db raw-events-status` remain the detailed source of truth. Release
  discovery remains a separate concern and is not part of this status contract.
- **Future `doctor`**: a diagnostic/gating workflow, not a renamed status
  command. It is not promoted in this stack.

## `codemem status` contract

`codemem status` is offline-capable: it reads local configuration, store state,
PID metadata, and bounded local checks. It probes the host/port in the trusted
viewer PID record, falling back to configured loopback defaults when no record
exists. It may make one short loopback-only request to `/api/health`. On a 404
from an older running viewer it may make one compatibility request to
`/api/stats` before using local evidence; connection failure or timeout maps to
`unreachable`, not `stopped`. It makes no registry, coordinator, non-loopback,
or other external network request. It uses the shared `--db-path`, `--config`,
and `--json` option helpers.

Initial JSON is additive-only and contains bounded summaries, not unbounded
rows or logs:

```json
{
  "checked_at": "2026-08-11T12:00:00.000Z",
  "ok": true,
  "version": "0.40.2",
  "database": { "state": "ready" },
  "runtime": { "viewer": "running", "pid": 1234 },
  "sync": { "state": "disabled" },
  "maintenance": { "state": "idle" },
  "semantic_index": { "state": "healthy" },
  "raw_events": { "state": "backlogged", "pending": 3 },
  "observer": { "state": "unconfigured" },
  "attention": [{ "code": "raw_events_backlogged", "severity": "warning", "message": "3 raw events pending" }]
}
```

Required fields are `checked_at`, `ok`, `version`, database state,
runtime/viewer state, sync summary, maintenance summary, semantic-index
summary, raw-events summary, observer summary, and bounded `attention` items.
Subobjects may gain fields; existing names and meanings do not change without a
major release. Human output presents the same assessment plus the next relevant
detailed command.

Initial state values are:

- `runtime.viewer`: `running | stopped | unreachable | unknown`
- `database.state`: `ready | missing | unavailable | unknown`
- `sync.state`: `healthy | degraded | disabled | error | unknown`
- `maintenance.state`: `idle | running | failed | unknown`
- `semantic_index.state`: `healthy | pending | degraded | failed | unknown`
- `raw_events.state`: `healthy | backlogged | failing | unknown`
- `observer.state`: `healthy | idle | backoff | failed | unconfigured | unknown`

For this offline roll-up, observer `backoff` means the local database contains
recent retryable observer batches. It does not claim to expose the viewer's
in-memory authentication-backoff timer from `/api/observer-status`; that remains
a detailed viewer diagnostic outside this command's bounded `/api/health` probe.

Consumers must handle future state values as `unknown`/degraded. New values are
additive; existing meanings remain stable. `attention` contains at most 20
items, each with `severity: warning | error`, a code of at most 64 characters,
and a message of at most 500 characters. `ok` is false when any attention item
has `severity: error`; warnings remain visible without falsifying `ok`. A
successfully collected report exits zero regardless of `ok`.

Release discovery is deliberately excluded. It has registry/cache semantics;
including it would violate the offline, predictable status contract.

### Exit behavior

| Condition | Exit |
| --- | --- |
| Status collected, including degraded state | `0` |
| Usage error | `2` |
| Status could not be collected | `1` |

Degradation belongs in `ok` and `attention`, not in a surprising non-zero exit.
A future explicit `--fail-on` policy may gate automation after its thresholds
are designed. In `--json` mode, success is one JSON object on stdout; failure is
`{"error":"…","message":"…"}` on stdout, with no incidental stdout text.

```fish
pnpm run codemem -- status --json
pnpm run codemem -- status --db-path ./codemem.sqlite
```

## Viewer health endpoint

Add `GET /api/health` as a cheap local liveness/readiness probe:

```json
{
  "service": "codemem-viewer",
  "version": "0.40.2",
  "pid": 1234,
  "uptime_ms": 42000,
  "ready": true,
  "database": { "reachable": true }
}
```

The stable service discriminator prevents treating an arbitrary HTTP service as
the viewer. The route returns HTTP `200` whenever the viewer process can serve
requests, including when the database is unreachable. HTTP status plus the
service discriminator represent liveness; `ready` and `database.reachable`
represent readiness. A degraded-but-running viewer therefore returns `200`
with `ready: false` instead of triggering redundant starts, refused stops, or
restart loops in clients that gate on `response.ok`.

The route performs no expensive stats scans, external egress, or authorization
of process termination. Existing command-line and listening-PID ownership
verification remains mandatory before any kill action. The `pid` field is
informational in this stack and is not a termination input.

Keep the existing `/api/stats` contract and keep `GET /api/runtime`
version-only. A richer runtime route can be evaluated later only if real
duplication emerges.

## Compatibility, safety, and failure handling

- Additive JSON only; retain existing endpoints and legacy CLI aliases in this
  stack.
- New clients probing an older viewer must fall back to the legacy probe when
  `/api/health` is absent. Old clients continue to use their current routes.
  The fallback retains today's weaker endpoint identification and does not gain
  the new service discriminator.
- Treat probe timeouts, malformed responses, and database failures as bounded
  unavailable/degraded observations; do not crash command handlers or block MCP
  startup.
- Health checks are loopback-safe and cheap. They are evidence of a responding
  viewer, never authority to kill a PID.
- Status collection uses bounded queries and summaries to avoid turning routine
  checks into database-wide scans.

## Documentation and testing

The status-command PR updates README and the user guide with the new command.
The final hygiene PR repairs existing lifecycle/coordinator documentation,
command help, completion, and deprecation drift. Tests cover the JSON and exit
contract, unavailable and degraded states, no-egress behavior, health response
and database failure, new-to-old endpoint fallback, and assembled
registered/help/completion command-tree parity. Run focused Vitest tests per PR;
the final integration gate is:

```fish
pnpm run tsc; and pnpm run lint; and pnpm run test
```

## Non-goals

- Automatic remediation or a daemon-supervisor rewrite.
- Remote status probing.
- Alias rename/removal in this stack.
- Full memory/evaluation command reorganization.
- Promotion of `doctor` to a general health command.
