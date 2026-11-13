# OpenCode 2 contract

OpenCode 2.0.24 provides the hook separation Codemem uses for safe recall
correlation. Automatic recall runs only through `session.context` and requires a
non-empty, non-whitespace latest user-message ID. The installed schema permits
missing IDs, so missing or blank identities skip safely rather than inferring
identity.

## Pinned test host

The executable contract uses matching exact versions; moving tags and semver
ranges are intentionally unsupported.

- `@opencode/cli@2.0.24`
- `@opencode/plugin@2.0.24`
- CLI identity: `opencode v2.0.24`

Both packages are stable, published releases. Codemem still labels its own
OpenCode 2 integration beta; see the
[adapter support matrix](architecture.md#adapter-support-matrix-and-rollout).

`pnpm --filter @codemem/opencode-plugin test:opencode-v2-contract` packs the
Codemem plugin, installs that tarball in an isolated project, and activates the
fixture from the installed package directory. The smoke uses an isolated home,
a loopback-only provider, bounded waits, and no inherited provider credentials.

The contract-only TypeScript fixture is present in the published-file allowlist
so the smoke can load it from the installed tarball. It is not a supported
consumer API.

## Verified request contract

OpenCode 2.0.24 separates primary context mutation from auxiliary model work:

- `session.context` handles primary agent-loop requests.
- `session.compaction`, `session.generate`, and `session.title` handle auxiliary
  requests without invoking `session.context`.
- Repeated primary-context calls receive fresh mutable `system`, `messages`,
  `options`, and `tools` values. The fixture checks system-marker reuse separately
  from options and tracks incoming and replacement system, message, and tool
  references with per-hook weak sets. The smoke checks auxiliary hooks for mutable
  request fields but invokes each auxiliary hook only once.
- Observed primary histories retain stable IDs on user messages. The message
  schema makes `id` optional, so Codemem keys a coalesced turn by the latest
  user-message ID only when it is a non-empty, non-whitespace string. Missing or
  blank identity skips recall rather than reusing an older user ID or inferring a
  key from timing or adjacency.
- `model.request` identifies `primary`, `compaction`, `title`, and `generate`
  through `kind`. The smoke verifies `primary` identity and header propagation
  through `http.request` and `http.response`; their auxiliary kinds are declared
  by the SDK but not asserted here. Retry hooks expose the attempt and mutable
  decision.

The packed-host smoke triggers a provider retry, tool continuations, transient
generation, host-initiated title generation, and manual compaction. It also holds
a primary provider request until an overlapping steering prompt has been submitted,
then checks that subsequent contexts retain both user IDs and use the newest ID
across continuations.

The smoke requires distinct non-empty prompt IDs and validates every primary
context against its active prompt and newest transcript user ID. It waits for the
generation hook before starting compaction, then asserts hook separation and
fresh primary inputs without contacting a hosted model.

## Historical development-host result behavior

The earlier `0.0.0-dev-19439` probe found that assigning `input.result` in the
compaction and title hooks did not suppress the corresponding model requests.
The 2.0.24 fixture does not test that short-circuit behavior, so its status on the
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

## Session capture isolation

OpenCode subscriptions deliver events across projects. Before translating an event,
capturing a tool result, or injecting recall, Codemem reads `session.get` and checks
the session ID, project ID, exact directory, and optional workspace ID against the
plugin instance. A publication location can reject a foreign event early but cannot
authorize it alone. Positive ownership decisions are never cached. Missing,
deleted, invalid, or unreadable sessions skip capture and recall with the fixed
`v2_session_ownership_unavailable` diagnostic, without recording content.

Delegated sessions use their own location rather than inheriting their parent's.
Nested directories retain separate plugin registrations even when they share a
working-copy root. Capture metadata continues to use that root.

Each raw stream has one extraction scope. Ingestion rejects V2 events that would
change its recorded project or working-copy root, including conflicts inside one
batch. Ingestion skips the conflicting stream's new events, records the count in
`skipped_conflict`, and logs a content-free warning. Existing events and metadata
remain intact, and unrelated streams continue through the queue. After a move between
projects or worktrees, start a new session for capture in the destination. This
check does not rewrite history or recover earlier misattributed captures.

The native-memory-tools host smoke treats wrong attribution and duplicate prompts
as failures. It also verifies exact prompt and assistant counts for two projects
and a nested directory with an isolated provider and database.

## Command capture

During adapter projection, a validated OpenCode `tool_result` with retained V2
host provenance, the exact tool name `shell`, and a nonblank string
`tool_input.command` is normalized to `bash` for observer input and session
context. This preserves command-only batches as processable input and applies
existing bash privacy sanitization, output compaction, deduplication, and budgets
to the adapter result. Raw envelopes remain unchanged. Legacy or unmarked shell
events, non-command inputs, and namespaced shell tools retain their existing
exclusion. Command failures retain sanitized error details.

## Local observer service connection

Observer generation and model discovery use OpenCode's service discovery for
the port and service-owned authentication. A wildcard listener address is not a
client destination: Codemem maps `0.0.0.0` to `127.0.0.1` and `[::]` to `[::1]`
before making requests. Both operations remain HTTP-only and loopback-only;
remote addresses are rejected.

## Automatic recall gate

The 2.0.24 host contract removes the earlier auxiliary-request ambiguity. When the
latest user-message ID is non-empty and non-whitespace, it can identify a
deliberately coalesced model turn across retries and continuations. Dedicated
hooks keep compaction, title, and transient generation away from primary recall
injection.

Codemem translates the 2.0.24 message shape and performs one fresh retrieval per
identified turn. Retries and tool continuations replay retained context
byte-for-byte without another retrieval. The default message surface and legacy
system surface both work; missing or blank latest-user identity skips safely.
