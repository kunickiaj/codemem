# Plugin-native memory tools for OpenCode

**Status:** Approved direction. Reviewed twice on 2026-11-04; this revision
incorporates the correction review's findings.

**Date:** 2026-11-04

**Decision:** The OpenCode plugin registers codemem's memory tools itself and
serves them over the viewer's HTTP routes, with the CLI as fallback. `codemem
setup` stops installing the per-project `codemem mcp` MCP entry for OpenCode.
The stdio MCP server stays for every other host.

## Problem

Every OpenCode project directory that has the global `codemem` MCP entry gets
its own `codemem mcp` stdio process. Each process loads `@codemem/core`, opens
its own better-sqlite3 connection to the same database, and may load the
embeddings runtime. On a machine with several worktrees open this is a few
hundred MiB of duplicated memory for identical servers.

Measured on 2026-11-04 (OpenCode 2.2.5, codemem 0.47.3, one OpenCode server):

| Spawner | Processes | RSS each | Working directory per process |
| --- | --- | --- | --- |
| OpenCode `serve` | 5 × `codemem mcp` | 48–55 MiB | `~/.config/opencode`, `~/workspace/codemem`, `~/workspace/codemem-relay-foundations`, `~/workspace/backstage-plugin-catalog-module-history`, `~` |
| Claude Desktop | 2 × (`npx` → `npm exec` → `codemem mcp`) | ~38 MiB per chain | `/` |

Total for the `codemem mcp` family: 11 processes, ~363 MiB RSS. OpenCode
spawns one per **project directory**, not per session (upstream
`packages/core/src/mcp/index.ts` creates one connection per Location
directory). Sessions and subagents in the same directory share a process.
Each new worktree opened in OpenCode adds another ~50 MiB plus a SQLite
connection and, when embeddings are used, another copy of the model runtime.

The figures are RSS and include shared pages, so the reclaimable memory is
somewhat lower than the sum. It is still the dominant per-worktree cost
codemem adds to a developer machine.

## Why the plugin, not a shared MCP server

The first draft proposed hosting `/mcp` inside the viewer and pointing
OpenCode at it as a remote server. Architecture review on 2026-11-04 found
that design needs a session-context registry keyed on OpenCode's
`_meta["ai.opencode/sessionID"]`, with three registration paths and a viewer
generation handshake to survive restarts, plus plugin ownership of the MCP
entry to force reconnects, because OpenCode retries a failed MCP connection
for only ~1.25 s and then marks it `failed` until the user reconnects from
`/mcps` (upstream `mcp/client.ts:203-215`, `mcp/index.ts:71-72`). The
plugin already knows the project, directory, and session at the moment a
tool runs, so a plugin-native tool needs none of that state.

The supporting facts:

- The viewer (`codemem serve`) is already a per-database singleton with
  pidfile ownership, `start`/`stop`/`restart`, and a runtime-conflict check
  (`packages/cli/src/commands/serve.ts`, `runServeInvocation`).
- The viewer already serves HTTP twins of the memory tools
  (`packages/viewer-server/src/routes/memory-tools.ts` and the older
  `/api/memory`, `/api/memories/forget` routes). That file deliberately
  refuses to default project from the server's cwd: "the server process cwd
  is not a reliable client project signal."
- The pi extension already implements all fourteen memory tools plus
  `memory_session_search` over those routes, with a CLI fallback when the
  viewer is unreachable (`packages/pi-extension/src/tools.ts`,
  `httpOrCli`). This design reuses that work rather than duplicating it.
- The OpenCode plugin already registers tools on V1 (`codemem.js:131-162`,
  Zod schemas via `tool.schema`) and V2 (`opencode-v2-adapter.js:692-695`,
  `ctx.tool.transform` with JSON Schema input). Today it supports only
  number arguments (`createV2Tool` throws otherwise); that builder has to
  grow.
- The OpenCode V2 tool API supports a `namespace` and `codemode: true`, so
  Code Mode callers keep writing `tools.codemem.memory_search(...)`.
- The stdio MCP server uses `process.cwd()` in three places that a shared
  server could not satisfy: read scoping (`project-scope.ts:8-10`), the
  `sessions.cwd` on writes, which decides sharing-scope resolution
  (`memory-access.ts:68,79`, `core/src/scope-resolution.ts:134-168`), and
  distill's `AGENTS.md` lookup (`tools/distill.ts:64,89,95`). A plugin tool
  passes its own directory for all three.

## Goals

1. Zero codemem child processes per OpenCode project. One viewer per
   database serves every project.
2. Calls keep their current scoping. A search from worktree B defaults to
   project B. A write from B records B's directory and resolves B's sharing
   scope. Nothing defaults from the viewer's working directory.
3. The model sees the same tool names, argument shapes, descriptions, and
   result shapes it sees from the MCP server today, under the same Code Mode
   namespace.
4. Tools keep working when the viewer is down, through the CLI fallback the
   pi extension already uses.
5. Hosts that keep the stdio MCP command (Claude Desktop, Codex, custom
   launchers) are unchanged.

## Non-goals

- Removing or changing `codemem mcp` / `codemem mcp http`.
- Changing the public/remote MCP deployment (`docs/remote-mcp-oauth.md`).
- Reducing the memory of the viewer process itself.
- Migrating Claude Desktop or Codex off stdio.

## Design

```
OpenCode server (one process)
├─ plugin instance A (project A, dir A) ── tools codemem.memory_* ──┐
├─ plugin instance B (project B, dir B) ── tools codemem.memory_* ──┤
└─ (no codemem MCP server entry)                                    │
                                                                    ▼
                         codemem serve (viewer, one per database)
                         ├─ MemoryStore (one connection)
                         └─ /api/memory, /api/memories/*  ←── CLI fallback
                                                               when unreachable
```

### Shared tool module

A new module both hosts consume (working name `@codemem/memory-tools`; final
name decided at implementation) exports, per tool: `name`, `description`,
JSON Schema `input`, and an `execute(args, context)` where `context` carries
`project`, `directory`, `sessionID`, `callID` (when the host has one), an
HTTP client for the viewer, a CLI runner, and an `AbortSignal`.

What is extracted from the pi extension is the transport and fallback layer
only: `httpJson`, `proveViewerTarget`, `httpOrCli`, `parseCliJson`, and the
pure `resolveProject` copy (`client.ts:434`). The pi tool bodies are **not**
reused, because they diverge from the MCP contracts in ways Goal 3 forbids:
their input schemas accept only `kind` and `project` instead of the full
filter set (`tools.ts:22-27` vs `search.ts:10-58`), pi's `memory_search`
composes `search_index` + `expand` and returns observation rows rather than
the MCP `{id, title, kind, body, confidence, score, ...}` shape, pi's
`memory_pack` drops `compact` and `compression_mode`, and pi's `memory_get` /
`memory_get_observations` add the client's project by default where MCP
deliberately does not (`items.ts:59,93`). The tool bodies are written from
`packages/mcp-server/src/tools/*`. The pi extension then becomes a thin
adapter over the shared module and inherits the MCP-faithful behavior.

Parity is pinned by a test that runs every tool through the MCP server and
through the shared module against the same fixture database and compares
names, descriptions, input schemas, **and result payloads**. Drift fails CI.

Packaging: the OpenCode plugin ships plain JS from `.opencode/lib/` with no
build step and depends only on the OpenCode plugin packages. The module must
not import `@codemem/core`, because that would load the native SQLite stack
into OpenCode's process. Delivery is a build step that copies the module into
`.opencode/lib/` (preferred, keeps the plugin dependency-free) or a published
runtime dependency; decided in step 1.

The OpenCode V2 adapter maps the JSON Schema straight into `editor.add`; the
V1 adapter converts it to Zod through `tool.schema`. Both current builders
accept only number arguments (`createV1Tool`, `codemem.js:64-66`;
`createV2Tool`, `opencode-v2-adapter.js:356-381`) and are replaced.

### Tool naming

Tool keys on both V1 and V2 must produce effective names that start with
`codemem_memory_`. The ingest filter drops tool events whose name starts
with that prefix (`core/src/ingest-events.ts:36-38`), and the plugin captures
every other tool result as a raw event (`runtime.js:4738-4746`). Flat
`memory_*` names would feed every memory lookup and its output back into
capture, and the observer would then distill retrieved memories into new
ones. Existing agent permission rules and prompts that reference `codemem_*`
also keep matching.

- V1: tool keys are free-form, so register them as `codemem_memory_search`
  and so on directly.
- V2: register under namespace `codemem` with `codemode: true`. Confirm in
  implementation which name `execute.after` reports for inner Code Mode calls
  (`tools.codemem.memory_search(...)`); if it is not the prefixed form, the
  plugin's capture path gets an explicit exclusion for its own tools.

### Context at call time

Each plugin instance already has `createRuntimeLocation({ project, directory,
worktree })`. The tool executor passes:

- `project`: explicit argument if the model gave one, else the plugin's
  project label. Sent on every read except `memory_get`,
  `memory_get_observations`, and `memory_forget`, which are ID-addressed and
  unscoped in MCP. `memory_distill_candidates` with `all_projects: true` also
  gets no default project, because MCP (`buildDistillFilters` in
  `packages/mcp-server/src/tools/distill.ts`) and the viewer route reject
  `all_projects` combined with a project. The pi extension's
  `buildDistillBody` already makes the same exception.
- `directory`: `context.directory` from the tool execution context (V1
  `ToolContext.directory`, V2 location), **not** the runtime's `cwd`, which
  prefers the worktree (`runtime.js:2292`). Stdio users today run with
  OpenCode's directory as cwd, and sharing-scope patterns match exact paths.
  Sent on `memory_remember` and `memory_distill_candidates`.
- `sessionID`: from the tool execution context on both V1 and V2, used as
  the retrieval ledger's source session.
- `callID`: V2 `Tool.Context.id`, used as the ledger request ID. V1 has no
  call ID, so V1 calls get a random attempt ID and lose only retry
  deduplication.
- `signal`: V1 `abort`, V2 `signal`. The CLI fallback must honor it;
  `runCli` today takes no signal (`runtime.js:2818-2824`), so a cancelled
  `memory_remember` could still write. The shared module's CLI runner
  kills the child on abort.

The project label rule is pinned: `resolveProject(directory)` with
`CODEMEM_PROJECT` override, which is what stdio MCP users get today. The
plugin cannot import core, so it uses the pure copy the pi extension already
carries, with a test that checks it against core's implementation. The
plugin's `resolveProjectName` (OpenCode `project.name` first,
`runtime.js:2005-2010`) stays for capture and is not used for tool scoping.
A test covers a worktree whose OpenCode project name differs from its
git-anchor basename.

### Viewer route changes

Route coverage today is 13 of 14 tools. Gaps and changes:

- **`memory_search` has no route that returns bodies.** Add one (or an
  `include_body` flag on `/api/memories/search_index`) that returns the MCP
  result shape.
- **`GET /api/memory`** (backs `memory_recent`) accepts only `kind` and
  `project` (`memory.ts:719-724`). Extend it to the full filter set.
- **`POST /api/pack`** (backs `memory_pack`) has a strict schema with no
  `compression_mode` (`pack.ts:141-150`). Add it. Tools call it without
  `attempt`, because `attempt` metadata records automatic-recall rows meant
  for prompt injection (`pack.ts:561-585`).
- **`directory` on remember and distill.** Today `/api/memories/remember`
  writes `sessions.cwd = process.cwd()` of the viewer (`memory-tools.ts:228,239`)
  and distill reads `AGENTS.md` from the viewer's directory (`:278-303`).
  Both routes change to: use `directory` when present; when absent, record
  `cwd = null` and skip filesystem project context. The viewer stops
  substituting its own cwd. The pi extension starts sending `directory`.
- **Capability advertisement.** The viewer is a long-lived detached process
  and the plugin updates on OpenCode restart, so a new plugin can reach an
  old viewer that returns 200 and ignores `directory`, landing writes in the
  viewer-starter's sharing scope. The viewer advertises
  `capabilities: ["tool_directory", "retrieval_ledger"]` in
  `/api/prompt-pack-profile`. The plugin requires `tool_directory` for
  `remember` and `distill` and otherwise uses the CLI fallback, which runs in
  the plugin's directory. `proveViewerTarget` today checks only database
  path and identity (`pi tools.ts:296-306`).
- **Retrieval ledger.** `RetrievalSurface` is a closed set of `mcp_*` values
  plus `prompt_pack`, `file_context`, `evaluation_replay`
  (`core/src/retrieval-ledger.ts:19-31`), validated on write. The client
  sends `ledger: { surface: "mcp_<tool>", request_id, source_session_id }` on
  exactly one request per tool call (so a composed call does not record
  twice, and `memory_get` is not mislabeled as `expand`). Routes validate the
  surface against the existing set and reuse the stateless identity logic
  from `withMcpRetrieval`. `memory_pack` records `mcp_pack`. Without this,
  `codemem stats` retrieval figures would drop to zero for OpenCode users.
- Distill's fallback to the viewer process's `CODEMEM_PROJECT`
  (`memory-tools.ts:702-705`) is removed along with the cwd default.

### Fallback and lifecycle

- When the viewer is unreachable the executor runs the equivalent `codemem`
  CLI command, as the pi extension does. The fallback is slower (one process
  per call) and loses ledger capture, and the tool result says so in a
  trailing note so the user can see the viewer is down.
- **Fallback coverage is not complete today.** pi's `memory_explain`,
  `memory_timeline`, and `memory_expand` have no CLI path and return
  "requires the codemem viewer server" (`tools.ts:474-479, 838-842, 873-877`).
  Stdio MCP serves all three without a viewer. Step 1 adds `codemem explain`,
  `codemem timeline`, and `codemem expand` (or `--json` modes on existing
  commands) so Goal 4 holds for every tool.
- The plugin already auto-starts the viewer (`startViewer`) and the health
  check restarts it. Three changes are needed because the viewer becomes
  load-bearing for every project:
  - Stop calling `stopViewer()` on `session.deleted` (`runtime.js:4683-4703`,
    gated by `CODEMEM_VIEWER_AUTO_STOP`, default on). One session ending in
    project A must not stop memory for project B. Default the option to off.
  - Run the health check in every plugin instance, not only the one that
    spawned the viewer (`isActive` requires `viewerStarted`, `runtime.js:3822`).
  - Change the health check's recovery command from `codemem serve restart`
    (`runtime.js:3823`) to `codemem serve start`. `start` is a no-op when the
    port is already open (`serve.ts:687-690`), so several instances probing a
    slow viewer cannot stop each other's freshly started process. `restart`
    from many instances could.
- Auto-update restarts the viewer (`runtime.js:3122`). Tools fall back to the
  CLI for the seconds it is down and resume on the next call. No state is
  lost because there is none.
- If sqlite-vec fails at viewer startup, embeddings are disabled for every
  project at once (`serve.ts:945-955`). `codemem status` reports it and the
  plugin toasts it once per viewer generation.

### Setup and migration

- `codemem setup` for the OpenCode target no longer writes `mcp.codemem`.
- `migrateLegacyOpencodeMcp` currently recognizes uv/uvx,
  `["npx","-y","codemem","mcp"]`, and `["npx","codemem","mcp"]`
  (`setup.ts:121-130`). It is extended to also recognize `["codemem","mcp"]`
  and the current npx launcher
  `["npx","-y","--package","codemem","--package","@codemem/embeddings","codemem","mcp"]`.
  Recognized managed entries are **removed**, with a backup as today.
  Entries with an `environment` block or any other command are left alone.
- A leftover entry means both the MCP tools and the plugin tools are
  present. The plugin warns once per instance, naming the config path, as
  the pi extension does for the same situation. OpenCode's "later valid
  registration overrides the same effective tool name" rule does not apply
  across MCP and plugin tools, so both would be visible.
- `--opencode-mcp stdio` keeps writing the old entry for users who want the
  MCP surface (for example per-project databases via `CODEMEM_DB`), and
  suppresses the duplicate warning when the plugin sees that flag's marker
  in the entry.

### What changes for the model and the user

- Tool IDs stay `codemem_memory_*` on both V1 and V2 (see "Tool naming").
  The parity test pins the effective IDs.
- MCP `annotations` and `outputSchema` are not carried by the OpenCode plugin
  tool API (V2 docs, `ToolInfo`: `name`, `description`, `input`, `options`,
  `execute`). OpenCode does not surface them to the model today either, so
  nothing changes in prompts. Result payloads are the same JSON the MCP
  tools return.
- The `/mcps` view no longer lists codemem for OpenCode. `codemem status`
  and the plugin's `mem-status` tool show tool availability instead.
- Server instructions: the MCP server's `instructions` text (shown under
  `<mcp_instructions>`) is lost. The plugin already injects guidance through
  `transformSystem`; the relevant lines move there.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Tool definitions drift between MCP and plugin | Different behavior per host | Shared module plus parity test against MCP registrations |
| Viewer down at first call | Slower CLI path, no ledger | Fallback plus trailing note; plugin auto-start already runs before first prompt |
| Retrieval stats regress for OpenCode users | `codemem stats` undercounts | Ledger capture in routes ships in the same step as the switch |
| Project label changes for users whose OpenCode project name differs from git basename | Scoped searches return different results | Rule pinned to the MCP behavior they have today; documented |
| Leftover MCP entry after upgrade | Duplicate tools and the old process keeps running | Setup removes recognized entries; plugin warns on leftovers |
| Plugin tool results captured as raw events | Retrieved memories re-distilled into new memories in a loop | Tool keys start with `codemem_memory_` on V1 and V2; capture-path exclusion if Code Mode reports a different name |
| New plugin reaches an old viewer | Writes recorded under the viewer-starter's directory and sharing scope | Capability advertisement; plugin uses CLI fallback for remember/distill until the viewer is upgraded |
| Cancelled tool still runs the CLI fallback | A cancelled `memory_remember` writes anyway | Shared CLI runner honors the abort signal |
| Many instances run the health check | Competing `restart` calls stop each other's viewer | Recovery uses `serve start`, which is a no-op when the port is open |

## Rollout

Each step is independently shippable and within the ~1,000-line guideline.

1. **Shared tool module.** Extract transport/fallback from the pi extension;
   write tool bodies from the MCP contracts; add the missing CLI commands for
   explain/timeline/expand; decide packaging. Parity test (names, schemas,
   results) against the MCP server. pi adapter becomes thin. No OpenCode
   change yet.
2. **Viewer routes.** `memory_search` route; full filters on `/api/memory`;
   `compression_mode` on pack; `directory` on remember/distill with
   `cwd = null` when absent; capability advertisement; ledger capture with
   client-supplied surface; `codemem status` reports embeddings state. Tests
   for sharing-scope resolution from a supplied directory, for the absent
   case, and for ledger rows per surface.
3. **Viewer lifecycle.** Auto-stop default off; health check in every
   instance using `serve start`; one-time embeddings toast.
4. **OpenCode plugin tools.** V1 and V2 adapters register the shared tools
   with call-time context and CLI fallback; duplicate-entry warning.
   Behind `CODEMEM_OPENCODE_NATIVE_TOOLS=1` for one release so it can be
   dogfooded alongside the MCP entry.
5. **Setup and docs.** Remove the managed entry, extend the migration
   matcher, add `--opencode-mcp stdio`, update `plugin-reference.md`,
   `cli-reference.md`, `user-guide.md`, README. Flip the flag default.
6. **Dogfood check.** On this machine: OpenCode-spawned `codemem mcp`
   processes drop from 5 to 0; searches and writes from two worktrees land
   in their own projects and sharing scopes; `codemem stats` retrieval
   counts keep increasing.

## Alternatives rejected

| Alternative | Why not |
| --- | --- |
| Viewer hosts `/mcp`; OpenCode connects as a remote MCP client | Needs a session registry with three registration paths and a generation handshake, plugin ownership of the MCP entry for reconnects, and still leaves a manual-reconnect gap on V1. Would use the SDK's web-standard transport on Hono (the Express `mcp http` app cannot be mounted). Kept as the path if OpenCode ever needs the MCP surface specifically. |
| Thin stdio shim per project proxying to the viewer | Still one Node process per project (~30 MiB baseline); saves under half the cost. |
| Separate `codemem mcp http` daemon beside the viewer | Same cwd problem, duplicated lifecycle. |
| Remote MCP entry with no context, rely on explicit `project` args | `buildFilters(args, null)` applies no project filter when the model omits `project`; silent all-projects reads. |
| Inject `project` into MCP calls from `execute.before` | Does not reach calls made inside Code Mode `execute` blocks. |
| MCP roots | Legacy protocol only, deprecated upstream, unusable with stateless requests. |
| Shrink per-process memory | Worth doing independently; does not change the O(worktrees) shape. |
