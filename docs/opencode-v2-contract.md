# OpenCode 2 beta contract

The pinned OpenCode 2 beta can load a TypeScript plugin fixture from Codemem's
packed npm artifact, but its context-mutation hook cannot identify the request
that caused each call. A later development host separates primary context from
auxiliary generation hooks and preserves IDs on the messages passed to each
primary context call. Codemem must keep automatic recall disabled against the
pinned beta, but a supported host with the development contract can correlate
recall without a new top-level request ID once the correlation tests pass.

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

## Development host evaluation

Development build `0.0.0-dev-19439`, produced from upstream commit
`3edbc8822520e51dca9954b73e2712ecf2884443`, improves hook separation but does
not replace the exact beta versions pinned by the repository. It is probe-only,
not a supported production target.

The disposable packed-host probe found:

- `session.context` runs once for each primary model request, including an
  accepted retry and a tool continuation. Each call receives a fresh mutable
  request; a system marker added by one call does not appear in later calls.
- Compaction, generation, and title use their dedicated session hooks rather
  than `session.context`.
- The runner intentionally combines overlapping steering prompts into one model
  continuation. The context transcript retains a stable ID on every user
  message, including the latest message used to key the turn. Retries and tool
  continuations repeat that latest ID, which gives Codemem the stable replay key
  it needs.
- Setting `input.result` in the compaction and title hooks does not suppress the
  corresponding model requests in this build. This does not match the documented
  result short-circuit behavior.

The source and tests confirm that prompt coalescing is intentional rather than a
lost-identity defect. Codemem can treat the coalesced prompt set as one model
turn, build new recall for its latest user-message ID, and replay that result
when the same ID appears on retries or tool continuations. The V2 adapter still
needs to translate the new message shape and remove assumptions tied to the V1
prompt counter, but it does not need another host identity field for correctness.

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
- The packed-host smoke verifies that `tool.transform` with `codemode: false`
  preserves the hyphenated `mem-status`, `mem-recent`, and `mem-stats` IDs. The
  transform API neither accepts an explicit custom ID nor exposes the effective
  ID while adding the tool.
- The promise-plugin context used by Codemem exposes neither logging nor toast
  methods. The separate TUI plugin API exposes `ui.toast`, but that is not the
  adapter surface under test. The V2 promise adapter must retain local file
  logging and treat user notifications as unavailable through its context.
- Tool, VCS, and worktree reload methods are confirmed by the exact package
  types. Invoking those state-mutating operations is outside this activation
  smoke; host shutdown exercises unload and cleanup behavior.

## Automatic recall gate

The context hook is Codemem's recall-injection point, but the pinned beta
identifies a request with only the tuple of session, agent, and model. Concurrent
primary and auxiliary requests can share that tuple. The later model-request
and HTTP hooks carry `kind`, and headers can preserve it downstream, but that
cannot retroactively classify an earlier context mutation. Retry hooks also omit
both request kind and request ID. Adjacency or timing cannot resolve the
context-hook ambiguity without race conditions.

The development host removes the auxiliary-request ambiguity by adding separate
session hooks. Although `session.context` has no top-level request ID, each
history-derived user message carries its own ID. That message identity is enough
to correlate retrieval and replay because overlapping prompts are deliberately
processed as one model turn.

The V2 adapter may capture events and expose manual memory tools, but it must not
inject automatic recall against the current pinned beta. Recall can proceed once
a supported pinned host exposes the split session hooks and passes concurrency,
retry, auxiliary-generation, and compaction correlation tests.
