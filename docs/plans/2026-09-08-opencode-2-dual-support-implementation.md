# OpenCode 2 dual-support implementation plan

**Design:** [OpenCode 2 dual support](./2026-09-08-opencode-2-dual-support-design.md)
**Tracking epic:** `codemem-5v7c`
**Completed investigation:** `codemem-cwl4`
**Status:** In progress for 0.45; 0.44.0 shipped from `main`
**Date:** 2026-09-08

## Outcome

Codemem 0.45 will ship one `@codemem/opencode-plugin` package that supports
OpenCode 1.18.29+ and a pinned OpenCode 2 beta with equivalent capture, automatic
recall, custom tools, and cleanup behavior.

## Prerequisites

The 0.44.0 release is complete, so the implementation gate is open.

- Tag and publish 0.44 through the existing release process.
- Start 0.45 work from updated `main`, not from the 0.44 release branch.
- Record the exact OpenCode 2 CLI and `@opencode/plugin` beta revisions selected
  by the contract spike.
- Keep the current package name and backend wire contracts.
- Do not mix unrelated viewer, sync, observer, or UI work into this stack.

## Proposed Graphite stack

The stack isolates contract correction, API discovery, shared-code extraction,
and user-facing support so each pull request can fail or roll back independently.

```text
main after 0.44
  <- PR 1: align the OpenCode 1 package baseline
  <- PR 2: correct OpenCode 1 contract drift
  <- PR 3: prove the pinned OpenCode 2 contract
  <- PR 4: extract the shared plugin runtime
  <- PR 5: add the dual package entrypoint
  <- PR 6: add OpenCode 2 capture and lifecycle
  <- PR 7: add OpenCode 2 recall and memory tools
  <- PR 8: ship dual-host setup, CI, and documentation
```

Before implementation, confirm this stack under the repository's Graphite
workflow. Each PR must pass its focused checks and remain independently
reviewable.

## PR 1: Align the OpenCode 1 package baseline

**Bead:** `codemem-5v7c.1`

The first PR creates one tested V1 baseline and documents its compatibility
break before behavior changes.

### Tasks

1. Raise the tested OpenCode 1 floor to 1.18.29.
2. Align the package dependency, nested `.opencode` manifests, lockfile, and
   plugin-smoke CI on that version.
3. Add a real `test` package script so package-scoped test commands cannot pass
   without running tests.
4. Add a smoke test for the repository-root wrapper, which is valid but not
   loaded by the current root configuration.
5. Document the OpenCode 1.18.29 minimum as a breaking 0.45 compatibility change
   in versioning guidance; PR 8 owns the final 0.45 release-note input.
6. Keep the root Dependabot SDK-update job and remove the ineffective job for the
   ignored contributor-runtime manifest.
7. Document a local refresh command for the ignored `.opencode/package.json`
   contributor-runtime manifest; do not add that local file to Git.

### Main files

- `packages/opencode-plugin/package.json`
- `packages/opencode-plugin/.opencode/package.json`
- `packages/cli/.opencode/package.json`
- `packages/opencode-plugin/vite.config.ts`
- Focused package smoke tests
- `.github/workflows/ci.yml`
- `.github/dependabot.yml`
- `pnpm-lock.yaml`
- `.opencode/plugins/codemem.js`
- `docs/versioning.md`

### Validation

```fish
pnpm --filter codemem test:plugin
pnpm --filter @codemem/opencode-plugin test
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm run tsc
pnpm run lint
```

### Exit gate

The package, nested manifests, CI, and lockfile use one V1 SDK version; the
package test command runs real tests; and the compatibility floor is documented.

## PR 2: Correct OpenCode 1 contract drift

**Bead:** `codemem-5v7c.2`

The second PR fixes the existing adapter against the V1 baseline without mixing
those behavior changes into dependency alignment.

### Tasks

1. Replace handwritten session and message identity assumptions with fixtures
   shaped from the SDK declarations.
2. Read session identity from the documented session, message, and part fields.
3. Send `client.app.log` requests through the documented request body.
4. Normalize current assistant token data while retaining intentional legacy
   compatibility only where a fixture proves it.
5. Normalize completed and failed tool results from declared hook variants.
6. Preserve retrieval, capture, update-notification, and raw-event behavior.

### Main files

- `packages/opencode-plugin/.opencode/plugins/codemem.js`
- `packages/cli/.opencode/tests/plugin-transform-hook.test.js`
- Other focused V1 contract fixtures only when needed

### Validation

```fish
pnpm --filter codemem test:plugin
pnpm --filter @codemem/opencode-plugin test
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm run tsc
pnpm run lint
```

### Exit gate

SDK-shaped session creation, deletion, message, usage, logging, and tool-result
fixtures pass without undocumented top-level fields.

## PR 3: Prove the pinned OpenCode 2 contract

**Bead:** `codemem-5v7c.3`

The third PR answers beta API questions with executable contract tests before
shared code is reshaped around assumptions.

### Tasks

1. Pin exact matching revisions of the `opencode-ai` V2 CLI package and
   `@opencode/plugin`; do not depend on moving beta tags.
2. Add a minimal V2 plugin fixture using `Plugin.define({ id, setup })`.
3. Prove package loading from an installed tarball rather than only a workspace
   link.
4. Capture and snapshot generic, session, message, and tool events without
   storing prompt or result content in committed fixtures.
5. Prove `ctx.location` behavior for project identity and determine the worktree
   source separately through the documented VCS or worktree surfaces.
6. Prove `ctx.session.hook("context")` message identity and mutation semantics
   for initial prompts, tool continuations, transient generation, and compaction.
7. Correlate the documented `kind` from adjacent model-request or HTTP hooks with
   context calls, then test concurrency, retries, auxiliary generation, and
   compaction before accepting it as the discriminator.
8. Prove completed and failed `ctx.tool.hook("execute.after")` variants.
9. Confirm the effective IDs produced for hyphenated custom-tool names and retain
   the V1 names unless the V2 API offers a supported equivalent.
10. Prove event-stream abort, registration disposal, reload, package unload,
    `ctx.options`, and `ctx.storage` behavior.
11. Determine whether the public V2 context exposes logging or toast methods. If
    it does not, keep local file logging and treat user notifications as no-ops.
12. Decide whether the dual entrypoint ships TypeScript source or compiled
    JavaScript based on both packed-host smoke tests.

### Main files

- Add focused fixtures under `packages/opencode-plugin/src/` and its tests.
- Update `packages/opencode-plugin/package.json` and `pnpm-lock.yaml`.
- Update `packages/opencode-plugin/scripts/packed-artifact-smoke.mjs` or add a
  dedicated V2 host smoke script.
- Update CI only enough to run the pinned spike contract.

### Validation

```fish
pnpm --filter @codemem/opencode-plugin test
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm run tsc
```

Run the pinned `opencode2` smoke command selected by the spike and document it in
the package scripts so CI and contributors use the same invocation.

### Exit gate

Do not proceed to shared-runtime extraction until the spike proves auxiliary-call
safety, stable turn identity, packed-package loading, and deterministic cleanup.
If the beta API cannot prove those contracts, pin the investigation and report
the upstream API gap instead of guessing around it.

## PR 4: Extract the shared plugin runtime

**Bead:** `codemem-5v7c.4`

The fourth PR separates host translation from Codemem behavior without changing
OpenCode 1 output.

### Tasks

1. Define small host-neutral interfaces for location, event capture, prompt
   context, tool results, logging, optional notifications, and disposal.
2. Move session state, viewer lifecycle, raw-event transport, CLI fallbacks,
   retrieval, recall caching, ledger writes, and update checks behind one runtime
   constructor.
3. Keep V1 event and hook translation in a V1 adapter.
4. Preserve deterministic IDs, raw-event envelopes, injection bytes, token
   budgets, bounded paths, and fallback classifications.
5. Replace cross-file copies with one source of truth; wrappers remain re-exports.
6. Keep SDK imports out of the shared runtime.
7. Verify that `pnpm run release:version` still resolves both managed pins after
   extraction, and update the matcher and tests if generated output changes
   their path or line shape.

### Expected file shape

The spike decides exact extensions and build output, but the logical split is:

```text
packages/opencode-plugin/
  src/
    runtime/
    adapters/v1
    adapters/v2
    entrypoint
```

Generated or compiled artifacts may remain under `.opencode/plugins/` when host
loading requires that location. Generated files must have a drift test and must
not be hand-edited.

### Additional files

- `scripts/release-version.mjs`
- `scripts/release-version.test.mjs`
- `docs/versioning.md` when managed paths change

### Validation

```fish
pnpm --filter codemem test:plugin
pnpm --filter @codemem/opencode-plugin test
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm run test:release
pnpm run tsc
pnpm run lint
```

### Exit gate

The full existing V1 plugin suite passes without expected-output changes, the
shared runtime has no OpenCode SDK import, and release-version rewriting still
finds and updates every managed backend pin.

## PR 5: Add the dual package entrypoint

**Bead:** `codemem-5v7c.5`

The fifth PR changes the package export shape in isolation before V2 behavior is
added.

### Tasks

1. Add the typed V2 definition with a no-behavior `setup()` shell proven by the
   spike.
2. Default-export one documented object containing V1 `server()` and V2
   `id`/`setup()`.
3. Preserve named compatibility exports where useful.
4. Update packed-artifact assertions from a function default to the dual object.
5. Prove V1 calls only `server()` and V2 calls only `setup()` from the installed
   tarball.
6. Cover duplicate loading through configured and checkout-local sources.

### Main files

- `packages/opencode-plugin/index.js` or its spike-selected replacement
- `packages/opencode-plugin/package.json`
- `packages/opencode-plugin/scripts/packed-artifact-smoke.mjs`
- Focused V1 and V2 package-loading fixtures

### Validation

```fish
pnpm --filter @codemem/opencode-plugin test
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm --filter codemem test:plugin
pnpm run tsc
pnpm run lint
```

### Exit gate

Both installed hosts select only their intended entrypoint, and reverting this
PR restores the old export shape without reverting runtime extraction.

## PR 6: Add OpenCode 2 capture and lifecycle

**Bead:** `codemem-5v7c.6`

The sixth PR enables durable V2 capture before automatic recall is enabled.

### Tasks

1. Implement the V2 `setup(ctx)` adapter, map `ctx.location` to shared project
   identity, and resolve the active worktree through the source proved by the
   spike.
2. Subscribe to `ctx.event.subscribe()` with an abortable task.
3. Normalize V2 session, user-message, assistant-message, usage, and lifecycle
   events into the existing raw-event envelope.
4. Register `ctx.tool.hook("execute.after")` and normalize completed and failed
   executions, including safe repository-relative working-set paths.
5. Start, monitor, stop, and restart the viewer through the shared runtime.
6. Dispose subscriptions, hook registrations, timers, health checks, and
   duplicate-registration ownership on unload or partial setup failure.
7. Keep capture failures non-blocking and bounded under the current spool and CLI
   fallback rules.

### Validation

```fish
pnpm --filter @codemem/opencode-plugin test
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm --filter codemem test:plugin
pnpm run tsc
pnpm run lint
```

### Exit gate

A packed plugin run produces equivalent normalized event rows for one V1 and one
V2 session across prompt, successful tool, failed tool, assistant completion,
idle or terminal boundary, and unload flows.

## PR 7: Add OpenCode 2 recall and memory tools

**Bead:** `codemem-5v7c.7`

The seventh PR enables V2's user-visible memory behavior only after capture and
lifecycle cleanup are stable.

### Tasks

1. Register `ctx.session.hook("context")` through the V2 adapter.
2. Build the retrieval query from the same first prompt, latest eligible prompt,
   project, and working-set inputs as V1.
3. Skip transient and compaction requests according to the proved V2
   discriminator; confirm the documented absence of the context hook for title
   requests in the pinned host smoke test.
4. Preserve one fresh retrieval per eligible turn and stable replay across tool
   continuations.
5. Preserve retained-context limits, duplicate filtering, delivery-ledger
   transitions, measurements, and empty-pack behavior.
6. Confirm that injected context affects only outbound model context and is not
   persisted as user-authored history.
7. Register the memory tools with `ctx.tool.transform()`. Keep V1's hyphenated
   names stable and use the V2 effective IDs proved by the spike, expected to be
   `mem_status`, `mem_recent`, and `mem_stats`.
8. Keep retrieval and optional diagnostics fail-open without swallowing host
   contract defects in tests.

### Validation

```fish
pnpm --filter @codemem/opencode-plugin test
pnpm --filter codemem test:plugin
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm run tsc
pnpm run lint
```

Run a packed V2 flow covering prompt, recall injection, tool continuation,
second prompt, compaction, plugin reload, and session deletion.

### Exit gate

The V2 flow matches V1's selected memories, injection budget, duplicate handling,
and delivery-ledger outcome without injecting during compaction or duplicating
context on continuation.

## PR 8: Ship dual-host setup, CI, and documentation

**Bead:** `codemem-5v7c.8`

The eighth and final PR turns the verified adapter into a supported 0.45 feature
and keeps the user migration reversible.

### Tasks

1. Keep `codemem setup --opencode-only` writing configuration accepted by both
   hosts; do not force native V2 config while V1 remains supported.
2. Add setup tests for existing V1 config, V2-translated config, duplicate specs,
   pinned package specs, and repeat runs.
3. Add required CI jobs for the minimum V1 release and pinned V2 beta.
4. Add a scheduled or manually triggered compatibility job against the moving V2
   beta; keep it advisory so upstream beta publication does not randomly block
   Codemem changes.
5. Update `README.md`, `docs/plugin-reference.md`, `docs/architecture.md`, and
   `docs/versioning.md` with installation, support status, host minimums,
   effective V2 memory-tool names, troubleshooting, and rollback.
6. State that OpenCode 2 support is beta while the host API is beta.
7. Run the full release gate and review the complete stack.

### Validation

```fish
pnpm --filter @codemem/opencode-plugin test
pnpm --filter @codemem/opencode-plugin test:packed-artifact
pnpm --filter codemem test:plugin
pnpm run build
pnpm run test:release
pnpm run check
```

### Exit gate

The installed package passes both host smoke tests, setup remains idempotent for
existing users, the published `files` set contains the new artifact layout, all
user-facing docs identify the beta pin and V1 minimum, and the full repository
gate passes.

## Review gates

Review depth increases at the adapter boundaries because a silent capture or
injection regression would corrupt user expectations without necessarily
crashing the host.

- Run CodeReviewer after every behavioral or packaging PR and the full stack.
- Add adversarial review for compaction, duplicate registration, retry/spool
  state, partial setup failure, and unload races.
- Run the pragmatic quality reviewer after shared-runtime extraction to prevent
  the adapter split from becoming a framework inside the plugin.
- Confirm documentation impact in every PR that changes host-visible behavior.

## Release and rollback

The 0.45 release will pin one verified OpenCode 2 beta and retain OpenCode 1.18.29+
support from the same package.

If upstream V2 changes before 0.45 ships, update the pin in an isolated PR and
rerun the V2 contract and packed-host suites. If parity cannot be restored, ship
0.45 without the V2 support claim rather than weakening compaction or replay
guarantees. V1 support and backend storage require no rollback migration.
