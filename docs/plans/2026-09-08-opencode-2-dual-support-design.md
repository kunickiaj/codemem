# OpenCode 2 dual-support design

**Status:** Approved
**Date:** 2026-09-08
**Tracking:** `codemem-cwl4`
**Target release:** Codemem 0.45

## Decision

Codemem 0.45 will make OpenCode 2 support its primary release feature while
preserving OpenCode 1 support in the existing `@codemem/opencode-plugin`
package.

The 0.44 release will finish without OpenCode 2 implementation work. Existing
OpenCode 1 contract corrections discovered during this investigation move to
the first 0.45 milestone so late compatibility work does not expand the 0.44
release scope.

## Why this matters

OpenCode 2 replaces the plugin API that Codemem uses for capture, automatic
recall, custom tools, and plugin lifecycle management.

OpenCode 2 has replacements for those capabilities, but they use an imperative
`setup(ctx)` model instead of the OpenCode 1 function that returns a hook map.
Supporting both hosts from one package preserves the current installation path
and gives users a side-by-side migration path while OpenCode 2 remains beta.

## Release boundary

The release boundary keeps 0.44 focused and gives 0.45 an explicit compatibility
contract.

| Release | Included | Excluded |
| --- | --- | --- |
| 0.44 | Current release completion and existing release gates | OpenCode 2 dependencies, adapters, setup changes, or support claims |
| 0.45 | OpenCode 1.18.29+ contract baseline, shared adapter boundary, OpenCode 2 support, dual-host tests, and migration docs | Removing all OpenCode 1 support or silently reducing recall behavior |

Raising the V1 floor from the older versions accepted by the current function
entrypoint to 1.18.29 is a breaking compatibility change. The 0.45 release notes,
versioning policy, and plugin reference will state that requirement before users
upgrade.

## Current integration

An adapter is the host-specific code that translates OpenCode events and hooks
into Codemem's capture, retrieval, and viewer lifecycle behavior.

The current adapter is a single JavaScript module at
`packages/opencode-plugin/.opencode/plugins/codemem.js`. It depends on these
OpenCode 1 surfaces:

- plugin factory inputs: `project`, `client`, `directory`, and `worktree`;
- returned hooks: `event`, `tool.execute.after`,
  `experimental.session.compacting`,
  `experimental.chat.messages.transform`, and
  `experimental.chat.system.transform`;
- returned custom tools: `mem-status`, `mem-recent`, and `mem-stats`;
- client methods: `client.app.log` and `client.tui.showToast`;
- cleanup through the returned `dispose` callback.

The module also owns host-neutral behavior: viewer startup and health checks,
raw-event delivery and spooling, CLI fallbacks, retrieval, injection caching,
delivery-ledger writes, retained-recall measurements, and backend update checks.
That mixture makes a second set of inline host conditionals unsafe.

## Confirmed baseline defects

The 0.45 baseline milestone will correct known OpenCode 1 contract drift before
introducing a second adapter.

- Session events expose identity through nested event data that current fixtures
  do not model consistently.
- Message events can carry session identity in message or part data rather than
  the top-level property the current extractor expects.
- `client.app.log` requires the current SDK request body shape.
- Assistant token usage uses the current nested token structure rather than only
  the legacy snake-case structure.
- Tool completion and failure should use declared hook fields instead of probing
  undocumented alternatives.
- At planning start, the package depended on `@opencode-ai/plugin` 1.18.25,
  checked-in nested plugin manifests and CI installed 1.2.27, and the ignored
  contributor-runtime manifest could retain a separate local version such as
  1.4.3. PR 1 aligns the checked-in and CI surfaces to the 1.18.29 floor.
- At planning start, the repository-root plugin wrapper was not exercised by the
  root configuration. PR 1 adds direct wrapper smoke coverage.

These are existing OpenCode 1 issues, not reasons to reopen the 0.44 feature
scope.

## OpenCode 2 mapping

OpenCode 2 provides direct replacements for most current behavior through the
new `@opencode/plugin` API.

| Codemem behavior | OpenCode 1 | OpenCode 2 |
| --- | --- | --- |
| Plugin activation | exported async function | `Plugin.define({ id, setup })` |
| Workspace metadata | factory arguments | `ctx.location` |
| Public events | returned `event` hook | `ctx.event.subscribe()` |
| Prompt injection | experimental message/system transforms | `ctx.session.hook("context")` |
| Tool capture | returned `tool.execute.after` hook | `ctx.tool.hook("execute.after")` |
| Custom tools | returned `tool` map | `ctx.tool.transform()` |
| Cleanup | returned `dispose` hook | cleanup function returned by `setup` |
| Plugin configuration | `plugin` | native `plugins`; V1 syntax is translated by V2 |

OpenCode 2 documentation explicitly supports one package entrypoint with a V1
`server()` function and a V2 `setup()` function. OpenCode 1 supports that object
form starting with 1.18.29, so Codemem will raise its OpenCode 1 compatibility
floor to that release for the dual package.

## Architecture

The 0.45 implementation will use thin host adapters around one shared plugin
runtime.

```text
package entrypoint
  ├── server(v1 context) -> OpenCode 1 adapter
  └── setup(v2 context)  -> OpenCode 2 adapter
                              │
                              ▼
                   shared Codemem plugin runtime
                   - normalized host events
                   - session state and working set
                   - viewer lifecycle and transport
                   - retrieval and delivery ledger
                   - recall cache and measurements
                   - backend compatibility checks
```

The package entrypoint will export one object containing both contracts. Named
compatibility exports may remain, but OpenCode host loading must use the default
dual entrypoint.

Host adapters will normalize these values before calling shared behavior:

- location, project identity, and a separately resolved worktree;
- session and message identity;
- user and assistant message content;
- assistant token usage;
- completed and failed tool executions;
- session lifecycle and compaction signals;
- outbound context messages and system parts;
- host logging and optional user-notification methods.

The shared runtime will not import either OpenCode SDK. This keeps beta API
changes at the adapter edge and lets both host contracts exercise the same
transport and state tests.

## Injection contract

OpenCode 2 support will not be declared complete until automatic recall preserves
Codemem's delivery and replay guarantees.

The V2 adapter must:

1. retrieve at most one fresh pack for a new eligible user turn;
2. avoid injecting into transient generation and compaction;
3. preserve stable prior recall blocks across tool continuations;
4. retain session and message identity when the host exposes it;
5. keep token budgets, duplicate filtering, delivery receipts, and fail-open
   retrieval behavior aligned with OpenCode 1;
6. inject only into outbound model context, which OpenCode 2 documents as
   separate from persisted history and configuration.

The documented V2 `context` hook runs for normal model calls, tool continuations,
transient generation, and compaction. Its current public shape does not expose a
documented request `kind`, but adjacent `model.request` and HTTP hooks identify
`primary`, `compaction`, `title`, and `generate` calls. The first V2 spike must
prove that Codemem can safely correlate that signal with context calls despite
concurrency and retries. If it cannot, V2 automatic recall stays disabled and the
0.45 support claim remains beta or incomplete.

## Capture contract

OpenCode 2 capture will produce the same normalized raw-event envelope used by
OpenCode 1.

The V2 event subscription and tool hook must preserve source, session identity,
event identity, ordering, bounded payloads, repository-relative working-set
paths, and existing retry/spool behavior. Host-specific event schemas must not
leak into viewer routes or storage.

Event subscription will use an `AbortController`. Plugin cleanup will abort the
stream, stop health monitoring, release duplicate-registration ownership, and
dispose every V2 hook or transform registration.

## Packaging and configuration

The existing npm package and setup command remain the user-facing installation
surface.

Codemem setup will initially continue writing the V1 `plugin` key because
OpenCode 2 translates supported V1 configuration and OpenCode 1 requires it.
Native `plugins` output can follow after OpenCode 1 support ends or after setup
can safely detect and target one host without breaking the other.

The package will pin exact `opencode-ai` and `@opencode/plugin` beta revisions. A
moving beta tag is not suitable for release builds or required CI. The
implementation spike will choose whether typed TypeScript source can be shipped
directly to both hosts or must be compiled to JavaScript; the packed artifact,
not only the workspace copy, decides that outcome.

At approval, the plan expected OpenCode 2 to normalize unsupported tool-name
characters to underscores. The pinned packed-host result instead verifies that
`tool.transform` with `codemode: false` preserves Codemem's hyphenated
`mem-status`, `mem-recent`, and `mem-stats` IDs.

## Failure handling

Host API failures must not break prompt execution unless OpenCode itself defines
the intercepted operation as fail-closed.

- Retrieval, viewer health, local logging, and capture delivery retain their
  current bounded fallback behavior.
- V2 notifications are optional. If the public plugin context has no toast API,
  Codemem records the same bounded local diagnostic and skips the toast.
- V2 event-stream termination is logged without content and does not restart in
  an unbounded loop.
- Failed V2 setup disposes completed registrations before returning the error.
- Unknown event variants are ignored and covered by bounded diagnostics.
- API-shape mismatches fail contract tests instead of being hidden behind broad
  property probing.

## Verification and release gate

The release gate requires contract tests and real packed-host smoke tests for
both OpenCode generations.

Required coverage includes:

- SDK-shaped unit fixtures for the minimum supported OpenCode 1 release;
- typed V2 adapter tests against the exact pinned beta SDK;
- packed-package loading under the `opencode` and `opencode2` binaries;
- prompt, tool call, tool continuation, compaction, session deletion, and plugin
  reload flows;
- raw-event transport failure and spool replay;
- automatic recall delivery, byte-stable replay, retained budget, duplicate
  filtering, and ledger recording;
- custom memory tools and cleanup of every registration;
- the repository's normal TypeScript, lint, test, and packed-artifact gates.

Codemem may label OpenCode 2 support beta while OpenCode 2 itself is beta. It
must not call the integration feature-complete while capture, compaction safety,
or automatic recall parity is knowingly missing.

## Rollback

The dual entrypoint makes rollback a host-edge change rather than a transport or
storage rollback.

If a pinned OpenCode 2 beta breaks the adapter, Codemem can disable the V2
`setup()` path or pin the last verified beta while leaving V1 `server()` behavior
and all shared backend contracts intact. No database migration is required for
OpenCode 2 support.

## Sources

The design uses the current official OpenCode 2 beta documentation:

- [Build plugins](https://opencode.ai/v2/docs/build/plugins)
- [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1)
