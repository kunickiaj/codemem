# Command reference

Run `codemem --help` for the human-facing command list and append `--help` to a group or command for its options. See the [User guide](user-guide.md#check-local-operational-status) for local diagnosis and [CLI conventions](cli-design-conventions.md) when adding commands.

## Command tree

The visible roots are `memory`, `session`, `service`, `status`, `sync`,
`coordinator`, `maintenance`, `diagnostics`, `config`, `setup`, `update`, and
`mcp`. `status` is an alias for `service status`.

| Group | Commands | Purpose |
|---|---|---|
| `memory` | `list`, `search <query>`, `context <task>`, `context trace <task>`, `stats`, `distill`, `show <id>`, `forget <id>`, `remember`, `export <output>`, `import <file>` | Browse, retrieve, create, and transfer memories. |
| `session` | `import`, `search <query>` | Import and search Pi session history. |
| `service` | `start`, `stop`, `restart`, `status` | Run and inspect the local viewer, sync, ingestion, and maintenance service. |
| `status` | — | Alias for `service status`. |
| `sync` | `enable`, `disable`, `peers`, `peers remove`, `pair`, `once`, `attempts`, `doctor`, `relay-keys`, `approve-relay-key`, `bootstrap`, `connect` | Configure and diagnose peer-to-peer sync. |
| `coordinator` | `account link`; `owner enroll`, `review`, `qualify`; `group grant-identity`, `create`, `list`; `device revoke`, `enroll`, `list`, `rename`, `disable`, `remove`; `domain list`, `create`, `update`, `members`, `grant`, `revoke`; `grant list`, `revoke`; `invitation create`, `accept`; `request list`, `approve`, `deny`; `schema diagnose-team`, `upgrade-auth`, `upgrade-account`; `serve` | Administer a self-hosted coordinator. |
| `maintenance` | `database init`, `vacuum`, `stats`, `prune-events`, `prune-history`; `memory prune`, `deduplicate`, `redact-secrets`; `project rename <old> <new>`, `normalize`; `embeddings`; `backfill tags`, `dedup-keys`, `narrative`, `structured`; `status` | Run storage, memory, embedding, project, and backfill maintenance. |
| `diagnostics` | `memory roles`, `compare`, `artifacts`, `relink`, `relink-plan`; `extraction report`, `replay`, `benchmark`; `capture status`, `retry`, `check`, `list-rejected`, `show-rejected`, `recover-rejected` | Inspect retrieval, extraction, and capture state. |
| `config` | `workspace`, `where` | Update workspace configuration or show the configuration file path. |
| `setup` | — | Run first-time integration setup. |
| `update` | `check`, `install` | Check for or install an eligible release. |
| `mcp` | `http` | Start the stdio server or local Streamable HTTP MCP server. |

`memory forget` and `maintenance memory prune` deactivate rows. They do not delete
the stored record. Operations that delete rows identify that consequence in their
own help text. `memory distill`, `maintenance embeddings`, extraction benchmarks,
and other observer-backed operations can consume configured model usage or incur
model costs.

### Prune memories

`maintenance memory prune` deactivates low-signal memories. Without `--dry-run`,
it changes stored memory state. Its default kinds preserve the previous
`db prune-memories` selection: `observation`, `discovery`, `change`, `feature`,
`bugfix`, `refactor`, `decision`, `note`, `entities`, and `session_summary`.

Use repeatable `--kind <kind>` or comma-separated `--kinds <csv>` to replace that
default selection. If both flags are supplied, their kinds are combined.

```text
codemem maintenance memory prune --kind discovery --dry-run
codemem maintenance memory prune --kinds discovery,decision --dry-run
```

### Command migration

| Previous command | Use now |
|---|---|
| `sync status` | `service status` for overall health, `sync peers` for peer details |
| `recent` | `memory list` |
| `search <query>` | `memory search <query>` |
| `pack <context>` | `memory context <task>` |
| `pack trace <context>` | `memory context trace <task>` |
| `stats` | `memory stats` |
| `distill` | `memory distill` |
| `memory inject <context>` | `memory context <task>` |
| `embed` | `maintenance embeddings` |
| `pi-import-sessions` | `session import` |
| `pi-session-search <query>` | `session search <query>` |
| `db init\|vacuum` | `maintenance database init\|vacuum` |
| `db size-report` | `maintenance database stats` |
| `db prune-raw-events\|prune-replication-ops` | `maintenance database prune-events\|prune-history` |
| `db raw-events-status\|retry\|gate` | `diagnostics capture status\|retry\|check` |
| `capture list-rejected\|show-rejected\|recover-rejected` | `diagnostics capture list-rejected\|show-rejected\|recover-rejected` |
| `db prune-memories` | `maintenance memory prune` |
| `db prune-observations` | `maintenance memory prune --kinds observation,bugfix,feature,refactor,change,discovery,decision,exploration` |
| `memory pack <context>` | `memory context <task>` |
| `memory pack trace <context>` | `memory context trace <task>` |
| `db dedup-memories\|scan-secrets` | `maintenance memory deduplicate\|redact-secrets` |
| `db rename-project <old> <new>` | `maintenance project rename <old> <new>` |
| `db normalize-projects` | `maintenance project normalize` |
| `db backfill-tags\|dedup-keys\|narrative\|ai-backfill-structured` | `maintenance backfill tags\|dedup-keys\|narrative\|structured` |
| `export-memories\|import-memories` | `memory export\|import` |

When replacing `sync status --json`, use `service status --json` for overall
health and `sync peers --json` for peer progress. These reports have different
JSON shapes from the removed sync-status report.

`memory pack`, root `pack`, and root `pack trace` remain executable compatibility
entrypoints for installed integrations and Pi callers. They are hidden from help and
shell completion. They keep report-style terminal output and the existing JSON
response schema.
Use `memory context` in user-facing instructions. Other root-level compatibility
aliases, adapter plumbing commands, and integration-only commands follow the same
hidden-registration rule. `--version` reports the installed CLI version.

### Inspect and recover rejected capture events

Use `diagnostics capture` to inspect retained rejected OpenCode events. Listing reads
metadata without loading private event text. `--raw` includes the saved text as an
escaped JSON string.

```text
codemem diagnostics capture list-rejected --json
codemem diagnostics capture show-rejected '<receipt>' --json
codemem diagnostics capture recover-rejected '<receipt>' --db-path '~/.codemem/mem.sqlite' -y
```

The original target is unknown. `--db-path` selects the current database and runtime
identity, and `-y` confirms that target. Recovery sends the retained bytes to the
loopback Viewer and removes the receipt only after a recognized acknowledgement and
an unchanged-file check. A duplicate acknowledgement does not compare stored event
content. Add `--keep-receipt` when an event ID might refer to different content.

Native Claude, Codex, and Pi receipts use the `native-hook-v1` format:

```text
codemem diagnostics capture list-rejected --format native-hook-v1 --provider claude --json
codemem diagnostics capture show-rejected '<receipt>' --format native-hook-v1 --provider claude --raw
codemem diagnostics capture recover-rejected '<receipt>' --format native-hook-v1 --provider claude --db-path '~/.codemem/mem.sqlite' -y
```

Replace `claude` with `codex` or `pi`. Native inspection reads retained receipts,
not the active hook backlog. Recovery verifies the current Viewer target and uses
the provider's HTTP route without redirects or a SQLite fallback. It requires
`--db-path` and `-y` and supports `--keep-receipt`. Native skip responses leave the
receipt intact. Pi receipts with saved extraction cutoffs are rejected before POST,
and other Pi boundary receipts require a durable queued acknowledgement.
Native delivery creates retained receipts for exact invalid-session rejections and
verified oversized requests. Claude preserves the local fallback for the current
boundary event. Older queued Claude boundaries can be retained, and explicit
recovery requests their boundary flush. Pi keeps saved cutoffs and pending boundary
work in the active retry queue.
Successful retention permits later queue entries to proceed. Retention failures
stop draining and require inspection. Retained receipts require explicit recovery.

### Get context for a task

`memory context <task>` is the public manual-retrieval command. It writes the
selected memory text to standard output, ready to add to a prompt. `--json` writes
the structured pack response instead, including its selection and size metrics.

```text
codemem memory context "Investigate the retry regression"
codemem memory context "Investigate the retry regression" --compact
codemem memory context "Investigate the retry regression" --compression-mode compact
codemem memory context "Investigate the retry regression" --json
```

`context` accepts the pack retrieval and rendering flags, including project scope,
working-set hints, limits, token budget, `--compact`, and
`--compression-mode off|compact|ids`. Use `ids` only when the caller can retrieve
the referenced observations.

`memory context trace <task>` explains why context was selected. Its human and
`--json` output follow the existing trace contracts.

```text
codemem memory context trace "Investigate the retry regression"
codemem memory context trace "Investigate the retry regression" --json
```

### Maintain project labels

Project-label maintenance previews changes by default. Add `--apply` to write the
reviewed change.

```text
codemem maintenance project rename old-project new-project
codemem maintenance project rename old-project new-project --apply
codemem maintenance project normalize
codemem maintenance project normalize --apply
```

The coordinator also accepts hidden account-linking and schema-upgrade aliases
used in messages from older deployed coordinators. New instructions use the
grouped `coordinator account` and `coordinator schema` commands.

`codemem serve` remains a compatibility entrypoint. Existing `serve` invocations
continue to work, and bare `codemem serve` runs the local service in the foreground.

### MCP protocol compatibility

Starting in 0.49, both `codemem mcp` and `codemem mcp http` support MCP
2026-07-28 discovery and legacy `initialize` clients. Clients choose the
protocol. Existing stdio commands and HTTP endpoint URLs stay the same.
Calling an unknown tool returns a JSON-RPC error with code `-32602` rather
than a tool execution result. See the [MCP result contract](plugin-reference.md#mcp-result-and-annotation-contract).

Protocol support alone does not make cross-project pooling safe. Codemem
still needs each caller's directory to scope searches, assign write-session
paths, and read project context. Keep OpenCode pooling disabled until that
caller-context integration is available.

### Memory export visibility

Exports include only memories readable under the device's current Sharing domain authority and exclude sessions with no exportable memories. If any memory in a session is inaccessible, including inactive or deleted history, exports omit that session's prompts, summaries, and metadata and retain only a numeric ID, an opaque stable session key, and a redaction marker so readable memories can still be imported. Project, date, and activity filters do not reduce authority for otherwise readable session records.

New-format full and redacted session exports share the same deterministic `export_session_key`; repeated imports and restored authority do not create another session. Native sessions receive an immutable UUID when started. Older keyless sessions use an existing memory import key from their history, without writing during export or inferring ownership from the current device. Enrollment and project moves do not change these keys. Export fails with `session_identity_unavailable` if a keyless session has no immutable memory key; it does not invent or backfill one.

Redacted imports leave source time blank and source user and working directory unset rather than copying the receiving machine's values. For these placeholders, `--since` selects sessions with a readable memory created on or after the requested date that also matches the project and activity filters. Full sessions continue to use their session start time; export and import timestamps never substitute for source dates.

A later full payload with the same canonical key fills only a recognized redacted placeholder, inside the import transaction. Already-full sessions remain unchanged, and subsequent redacted payloads never erase source context. Re-exported placeholders remain redacted. Session keys are duplicate-tracking identifiers, not authorization proofs.

A later full canonical import also restores a missing prompt link on an already-imported memory only when the memory and prompt belong to the same mapped session. Existing links, memory content, and revisions remain unchanged. Project-filtered exports, file/concept recall, and vector/tag backfills use the session project first and fall back to the memory project only when the session project is unset.

Import skips prompts and summaries attached to an incoming redacted session, even if its stored session is already full. Placeholder project attribution uses all currently readable memories accumulated for that session: a single project labels the placeholder, while mixed projects leave it unset. Imports recompute that label only while it still matches the last computed attribution. A user project move, including clearing the project, survives redacted reimports and full restoration. Explicit project remaps apply to computed attribution and imported records, not later user moves; redacted imports never relabel full sessions.

Older payloads without the key retain the legacy import-key behavior. Importing a current full export upgrades an existing legacy session key for later redacted imports. An older full import followed directly by a new redacted export can create a separate session if that upgrade has not happened.

Redacted imports preserve projects carried by readable memory rows; an explicit project remap wins. A session gets a project only when all its readable memories agree on one; otherwise each memory keeps its own project for retrieval and feed filtering, without copying the hidden session's project.

### Pi setup

`codemem setup --opencode-only` configures only OpenCode: it adds `@codemem/opencode-plugin` to the plugin list and writes the `codemem` stdio MCP entry. `--opencode-mcp stdio`, the default and currently the only mode, writes the per-project MCP entry.

`codemem setup --pi-only` configures only Pi. A fresh setup adds the `@codemem/pi-extension` npm pin to Pi's `packages` list (honors `PI_CODING_AGENT_DIR`); an existing configured dev path may be retained. It defaults to native tools on a fresh setup. It preserves an existing `tools_mode`. `--pi-mcp` opts into the legacy third-party `pi-mcp-adapter` surface when that adapter is detected. It keeps an existing codemem MCP entry unless `--force` is supplied, and does not configure Pi's native MCP. `--pi-extension-path <path>` writes a local-path `packages` entry instead of the npm pin (dev). Requires Pi 1.1.0 or newer, below 2.0; upgrade an older host with `pi update`. See [Pi extension](plugin-reference.md#pi-extension).
