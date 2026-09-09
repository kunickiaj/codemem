# OpenCode 2 beta contract

The pinned OpenCode 2 beta can load a TypeScript plugin fixture from Codemem's
packed npm artifact, but its context-mutation hook cannot identify the request
kind that caused each call. Codemem must therefore keep automatic recall
disabled in the V2 adapter until the host exposes an unambiguous request identity
or adds `kind` to that hook.

## Pinned test host

The executable contract uses matching exact versions; moving beta tags and
semver ranges are intentionally unsupported.

- `@opencode/cli@0.0.0-beta-19296`
- `@opencode/plugin@0.0.0-beta-19296`
- CLI identity: `opencode2 v0.0.0-beta-19296`

`pnpm --filter @codemem/opencode-plugin test:opencode-v2-contract` packs the
Codemem plugin, installs that tarball in an isolated project, and asks the pinned
host to activate the fixture from the installed package directory. OpenCode 2
requires configured local plugin targets to be directories, so the packed
fixture has its own package entrypoint under `v2-contract-fixture/`.

Those contract-only TypeScript fixture files are intentionally present in this
spike's published-file allowlist because the smoke must load them from the
installed Codemem tarball. They are not exported as a supported consumer API.
The production V2 entrypoint replaces this temporary package content in the
later adapter PR.

## Verified surfaces

The fixture and its type-level tests verify these beta-19296 contracts:

- `Plugin.define({ id, setup })` returns a plugin whose cleanup runs on host
  shutdown.
- `context.location.directory` identifies the active directory, while
  `context.location.project` carries canonical project identity. Worktree and
  VCS operations are separate context domains.
- `context.options` exposes configured plugin options, and `context.storage`
  supports set/get/remove round trips.
- Event subscriptions accept an abort signal and stop during plugin cleanup. All
  hook and transform registrations are disposed on cleanup. The fixture records
  only event family and type, never message, prompt, argument, result, or error
  content.
- Session context is mutable through `system`, `messages`, `tools`, `generation`,
  and `providerOptions`. Prompt hooks carry `sessionID` and `messageID`; context
  hooks carry `sessionID`, agent, and model but no message or request ID.
- Model-request and HTTP hooks carry `kind` values `primary`, `compaction`,
  `title`, and `generate`. A model-request hook can stamp the mutable request
  headers for downstream HTTP hooks. Retry hooks carry an attempt and mutable
  decision but no `kind` or request ID.
- Tool completion hooks distinguish `completed` results from `error` outcomes
  and carry call, message, session, agent, tool, and input identity.
- The packed-host smoke verifies that the fixture can declare the hyphenated
  tool name `mem-status`. The transform API neither accepts an explicit custom
  ID nor exposes the host-generated effective ID while adding the tool.
- The promise-plugin context used by Codemem exposes neither logging nor toast
  methods. The separate TUI plugin API exposes `ui.toast`, but that is not the
  adapter surface under test. The V2 promise adapter must retain local file
  logging and treat user notifications as unavailable through its context.
- Tool, VCS, and worktree reload methods are confirmed by the exact package
  types. Invoking those state-mutating operations is outside this activation
  smoke; host shutdown exercises unload and cleanup behavior.

## Automatic recall gate

The context hook is Codemem's recall-injection point, but it identifies a request
with only the tuple of session, agent, and model. Concurrent primary and
auxiliary requests can share that tuple. The later model-request and HTTP hooks
carry `kind`, and headers can preserve it downstream, but that cannot
retroactively classify an earlier context mutation. Retry hooks also omit both
request kind and request ID. Adjacency or timing cannot resolve the context-hook
ambiguity without race conditions.

The V2 adapter may capture events and expose manual memory tools, but it must not
inject automatic recall until a later pinned host contract passes concurrency,
retry, auxiliary-generation, and compaction correlation tests.
