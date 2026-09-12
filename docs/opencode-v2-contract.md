# OpenCode 2 contract

OpenCode 2.0.2 provides the hook separation Codemem needs for safe recall
correlation. Tested primary histories carry stable user-message IDs, but the
installed message schema permits missing IDs. Production automatic recall remains
disabled until the V2 adapter can degrade safely when identity is absent.

## Pinned test host

The executable contract uses matching exact versions; moving tags and semver
ranges are intentionally unsupported.

- `@opencode/cli@2.0.2`
- `@opencode/plugin@2.0.2`
- CLI identity: `opencode v2.0.2`

`pnpm --filter @codemem/opencode-plugin test:opencode-v2-contract` packs the
Codemem plugin, installs that tarball in an isolated project, and activates the
fixture from the installed package directory. The smoke uses an isolated home,
a loopback-only provider, bounded waits, and no inherited provider credentials.

The contract-only TypeScript fixture is present in the published-file allowlist
so the smoke can load it from the installed tarball. It is not a supported
consumer API.

## Verified request contract

OpenCode 2.0.2 separates primary context mutation from auxiliary model work:

- `session.context` handles primary agent-loop requests.
- `session.compaction`, `session.generate`, and `session.title` handle auxiliary
  requests without invoking `session.context`.
- Repeated primary-context calls receive fresh mutable `system`, `messages`,
  `options`, and `tools` values. The smoke checks auxiliary hooks for mutable
  request fields but invokes each auxiliary hook only once.
- Observed primary histories retain stable IDs on user messages. The message
  schema makes `id` optional, so Codemem may key a coalesced turn by the latest
  user-message ID only when it is present. Missing identity must skip unsafe
  recall rather than infer a key from timing or adjacency.
- `model.request` identifies `primary`, `compaction`, `title`, and `generate`
  through `kind`. The smoke verifies `primary` identity and header propagation
  through `http.request` and `http.response`; their auxiliary kinds are declared
  by the SDK but not asserted here. Retry hooks expose the attempt and mutable
  decision.

The packed-host smoke triggers a provider retry, tool continuations, transient
generation, host-initiated title generation, and manual compaction. It waits for
the generation hook before starting compaction, then asserts hook separation,
fresh primary inputs, and repeated stable user-message IDs without contacting a
hosted model.

## Historical development-host result behavior

The earlier `0.0.0-dev-19439` probe found that assigning `input.result` in the
compaction and title hooks did not suppress the corresponding model requests.
The 2.0.2 fixture does not test that short-circuit behavior, so its status on the
pinned release remains unverified.

## Other verified surfaces

- `Plugin.define({ id, setup })` returns a plugin whose cleanup runs on shutdown.
- `context.location.directory` identifies the active directory, while
  `context.location.project` carries worktree and canonical project identity.
- `context.options` exposes plugin options, and `context.storage` supports
  set/get/remove round trips.
- Event subscriptions accept an abort signal and stop during cleanup. The
  fixture records event family and type, never prompt, argument, result, or error
  content.
- Prompt hooks carry `sessionID` and `messageID`. Tool completion hooks distinguish
  completed and error outcomes and retain call, message, session, agent, tool,
  and input identity.
- `tool.transform` preserves the hyphenated `mem-status`, `mem-recent`, and
  `mem-stats` IDs with `codemode: false`.
- The promise-plugin context exposes neither logging nor toast methods, so the V2
  adapter retains local diagnostics and treats user notifications as unavailable.

## Automatic recall gate

The 2.0.2 host contract removes the earlier auxiliary-request ambiguity. When the
latest user-message ID is present, it can identify a deliberately coalesced model
turn across retries and continuations. Dedicated hooks keep compaction, title,
and transient generation away from primary recall injection.

Codemem's V2 entrypoint may continue capture and manual memory tools, but it must
not inject automatic recall until the V2 adapter translates the 2.0.2 message
shape, declines unsafe injection when the latest user ID is absent, and passes
its concurrency, retry, continuation, and auxiliary-request tests.
