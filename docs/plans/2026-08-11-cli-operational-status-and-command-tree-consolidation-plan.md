# CLI operational status and command-tree consolidation: implementation plan

**Status:** Approved implementation roadmap

**Date:** 2026-08-11

## Stack

```text
main
└─ docs(cli): define operational status and consolidation roadmap
   └─ feat(runtime): add lightweight health endpoint
      └─ feat(cli): add operational status command
         └─ fix(runtime): consolidate viewer health probes
            └─ chore(cli): enforce command-tree parity and deprecation hygiene
```

Each PR is independently useful and keeps existing JSON contracts additive.

## PR 1 — `docs(cli): define operational status and consolidation roadmap`

- **Objective:** Record the approved `codemem status` boundary, health-route
  contract, audit evidence, and delivery sequence.
- **Files:** these two plan documents only.
- **Behavioral work:** None; establishes the implementation contract and
  deferred scope.
- **Focused validation:**
  ```fish
  git diff --check
  ```
- **Safety risks:** Do not document private paths, hosts, or credentials; do not
  imply aliases are removed before their compatibility period.
- **Independent value:** Gives later PRs a reviewed contract and prevents a
  status command from collapsing into stats, doctor, or lifecycle management.

## PR 2 — `feat(runtime): add lightweight health endpoint`

- **Objective:** Add `GET /api/health` for cheap viewer liveness/readiness.
- **Likely files:** new `packages/viewer-server/src/routes/health.ts`,
  `packages/viewer-server/src/index.ts`, `packages/viewer-server/src/index.test.ts`,
  and route-specific tests if split during implementation.
- **Behavioral work:** Return a stable service discriminator, version, PID,
  uptime, readiness, and database reachability. Return HTTP `200` for every
  degraded-but-running viewer, with readiness represented in the body; reserve
  non-2xx for a process that cannot serve the route. Bound failures without
  stats aggregation or outbound requests. Preserve existing
  `/api/stats` and `/api/runtime` contracts; `/api/runtime` stays version-only.
- **Focused validation:**
  ```fish
  pnpm exec vitest run packages/viewer-server/src/index.test.ts
  pnpm run tsc
  ```
- **Safety risks:** The endpoint must not authorize a kill action. Existing
  command-line/listening-PID ownership validation remains the termination gate.
- **Independent value:** Fixes the missing endpoint that current MCP probes
  expect, without changing any client probe behavior.

## PR 3 — `feat(cli): add operational status command`

- **Objective:** Ship top-level `codemem status` as the local operational
  roll-up.
- **Likely files:** `packages/cli/src/commands/status.ts`,
  `packages/cli/src/index.ts`, `packages/cli/src/shared-options.ts`, focused
  command tests, `README.md`, `docs/user-guide.md`, and core exports only if a
  reusable bounded summary is needed.
- **Behavioral work:** Use shared `--db-path`, `--config`, and `--json` options.
  Collect local database readiness, runtime/viewer, sync, maintenance,
  semantic-index, raw-events, and observer summaries plus bounded attention
  items. Derive observer `backoff` only from recent retryable batches persisted
  in the local database; do not call `/api/observer-status` or claim the viewer's
  in-memory auth-backoff timer.
  Emit stable JSON/error objects and `0` for collected degraded status, `2` for
  usage, `1` for collection failure. Allow one bounded loopback
  `/api/health` probe plus a `/api/stats` compatibility fallback only when an
  older viewer returns 404; otherwise use local fallback. Do not call
  registries, the coordinator, non-loopback endpoints, or update discovery.
- **Focused validation:**
  ```fish
  # New test file introduced by this PR.
  pnpm exec vitest run packages/cli/src/commands/status.test.ts
  pnpm run codemem -- status --json
  pnpm run tsc
  ```
- **Safety risks:** Avoid unbounded database scans, leaking operational details
  in errors, or changing existing automation output. Catch action-handler
  failures and retain valid JSON-only stdout in `--json` mode.
- **Independent value:** Answers the operator question while preserving `stats`
  and subsystem commands as focused surfaces.

## PR 4 — `fix(runtime): consolidate viewer health probes`

- **Objective:** Move MCP, plugin, and serve lifecycle checks to `/api/health`.
- **Likely files:** `packages/mcp-server/src/stdio.ts`,
  `packages/opencode-plugin/.opencode/plugins/codemem.js`,
  `packages/cli/src/commands/serve.ts`, and their focused tests.
- **Behavioral work:** Validate the service discriminator and use bounded
  timeouts. When a new client talks to an older viewer without `/api/health`,
  retain legacy endpoint fallback (`/api/stats` or the existing raw-events probe
  as appropriate). Keep MCP viewer startup best-effort/background; it must not
  block MCP stdio startup. Serve lifecycle uses `/api/health` only for the
  liveness discriminator. PID discovery for termination continues to read
  `viewer_pid` from `/api/stats`; `/api/health.pid` is informational and MUST
  NOT become a termination input in this stack. Existing listener-PID and `ps`
  command-ownership gates remain unchanged.
- **Focused validation:**
  ```fish
  pnpm exec vitest run packages/cli/src/commands/serve.test.ts
  # New focused MCP stdio test introduced by this PR.
  pnpm exec vitest run packages/mcp-server/src/stdio.test.ts
  pnpm run tsc
  ```
- **Safety risks:** Do not weaken process-kill safeguards: an HTTP response is
  insufficient without the existing PID/listener/command ownership checks. Do
  not convert transient probe failure into a fatal MCP failure.
- **Independent value:** Eliminates false-unhealthy detection and redundant
  start/poll behavior while preserving old-viewer interoperability.

## PR 5 — `chore(cli): enforce command-tree parity and deprecation hygiene`

- **Objective:** Make the visible command tree, completions, docs, and
  compatibility policy agree.
- **Likely files:** `packages/cli/src/index.ts`, CLI tree/completion tests,
  `README.md`, `docs/user-guide.md`, `docs/coordinator-discovery.md`,
  `docs/coordinator-deployment.md`, `docs/coordinator-e2e-runbook.md`,
  `docs/cloudflare-coordinator-deployment.md`, `docs/anchor-peer-deployment.md`,
  and affected command modules.
- **Behavioral work:** Hide the already-warned `sync coordinator` compatibility
  path. Add warnings to visible `export-memories`/`import-memories`, keep them
  visible and in completion for their first warned release, and record their
  future hide target; do not collapse warning and hiding into one release. Add
  `maintenance` and `status` to completion. Replace `sync start` guidance with
  `serve start`; add required `--effect-id` arguments and replace legacy
  coordinator host/port forms in examples; add a new assembled runtime
  command-tree test for registration, help visibility, and completion parity.
  Do **not** remove aliases.
- **Focused validation:**
  ```fish
  # New assembled command-tree test introduced by this PR.
  pnpm exec vitest run packages/cli/src/command-tree.test.ts
  pnpm run codemem -- --help
  pnpm run tsc; and pnpm run lint; and pnpm run test
  ```
- **Safety risks:** Hidden aliases must preserve arguments, flags, JSON, exit
  codes, and stderr deprecation behavior. Avoid broad memory/evaluation
  reorganization while testing the assembled tree.
- **Independent value:** Reduces discoverability drift and protects automation
  compatibility without a breaking rename.

## Deferred and non-goals

- No automatic remediation or daemon-supervisor rewrite.
- No remote status probing.
- No command rename/removal in this stack.
- No full memory/evaluation surface reorganization.
- No `doctor` promotion; it remains a future diagnostic/gating design.

## Final acceptance

The stack is complete when `status --json` is offline and stable, `/api/health`
is the shared cheap probe with old-viewer fallback, lifecycle kill safeguards are
unchanged, and the assembled command/help/completion tree agrees with the docs.
