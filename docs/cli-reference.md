# Command reference

Run `codemem --help` for the current human-facing command list and append `--help` to a group or command for its options. See the [User guide](user-guide.md#check-local-operational-status) for diagnosing local state and [CLI conventions](cli-design-conventions.md) when adding commands.

| Group | Command | Description |
|-------|---------|-------------|
| **Core** | `codemem status` | Local operational roll-up (`--json` supported) |
| | `codemem stats` | Database statistics |
| | `codemem stats --attribution` | Local retrieval-attribution diagnostics (`--json` supported) |
| | `codemem recent` | Recent memories |
| | `codemem search <query>` | Search memories |
| | `codemem pack <context>` | Build a context-aware memory pack |
| | `codemem pack trace <context>` | Inspect retrieval and pack assembly for a manual query |
| | `codemem distill` | Mine recurring memories into reviewable context candidates |
| | `codemem embed` | Backfill semantic embeddings |
| **Memory** | `codemem memory show <id>` | Print a memory item as JSON |
| | `codemem memory forget <id>` | Deactivate a memory item |
| | `codemem memory remember` | Manually add a memory |
| | `codemem memory inject <context>` | Raw pack text for prompt injection |
| | `codemem memory export <output>` | Export memories by project |
| | `codemem memory import <file>` | Import memories (idempotent) |
| **Viewer** | `codemem serve [start\|stop\|restart]` | Launch / manage the web viewer |
| **Sync** | `codemem sync enable\|disable` | Enable or disable peer-to-peer sync |
| | `codemem sync status` | Device info and peer health |
| | `codemem sync pair` | Advanced/legacy device pairing |
| | `codemem sync once` | Run one immediate sync pass |
| | `codemem sync doctor` | Diagnose sync configuration issues |
| | `codemem sync bootstrap` | Bootstrap sync from a peer snapshot |
| **Updates** | `codemem update install` | Install an eligible release from the installed channel |
| | `codemem update check` | Check npm for a newer release on the installed channel (`--json` and `--refresh` supported) |
| **Coordinator** | `codemem coordinator` | Self-hosted coordinator admin (groups, devices, invites) |
| **Database** | `codemem db prune-memories` | Deactivate low-signal memories (`--dry-run` to preview) |
| | `codemem db prune-observations` | Deactivate low-signal observations |
| | `codemem db backfill-tags` | Populate missing `tags_text` values |
| | `codemem db raw-events-status` | Show raw-event queue status |
| **Config** | `codemem config` | View or update configuration |
| | `codemem setup` | Interactive first-run setup |
| **Plumbing** | `codemem mcp` | MCP stdio server; best-effort starts the local viewer unless `CODEMEM_VIEWER=0` or `CODEMEM_VIEWER_AUTO=0` is set |
| | `codemem mcp http` | Local Streamable HTTP MCP server (`POST /mcp`, loopback-only by default) |

Adapter plumbing commands (`claude-hook-*`, `codex-hook-*`, `pi-hook-*`, `enqueue-raw-event`, and `prompt-pack-ledger`) remain executable for packaged-plugin and stale-client compatibility but are hidden from help and shell completion. `show`, `forget`, and `remember` remain hidden top-level aliases. Deprecated `export-memories` and `import-memories` warn on stderr; use `codemem memory export` and `codemem memory import` instead.

### Memory export visibility

Exports include only memories readable under the device's current Sharing domain authority and exclude sessions with no exportable memories. If any memory in a session is inaccessible, including inactive or deleted history, exports omit that session's prompts, summaries, and metadata and retain only a numeric ID, an opaque stable session key, and a redaction marker so readable memories can still be imported. Project, date, and activity filters do not reduce authority for otherwise readable session records.

New-format full and redacted session exports share the same deterministic `export_session_key`; repeated imports and restored authority do not create another session. Redacted imports leave source time blank and source user and working directory unset rather than copying the receiving machine's values.

Older payloads without the key retain the legacy import-key behavior. Importing a current full export upgrades an existing legacy session key for later redacted imports. An older full import followed directly by a new redacted export can create a separate session if that upgrade has not happened.

Redacted imports preserve projects carried by readable memory rows; an explicit project remap wins. A session gets a project only when all its readable memories agree on one; otherwise each memory keeps its own project for retrieval and feed filtering, without copying the hidden session's project.

### Pi setup

`codemem setup --pi-only` configures only Pi. A fresh setup adds the `@codemem/pi-extension` npm pin to Pi's `packages` list (honors `PI_CODING_AGENT_DIR`); an existing configured dev path may be retained. It defaults to native tools on a fresh setup. It preserves an existing `tools_mode`. `--pi-mcp` opts into the legacy third-party `pi-mcp-adapter` surface when that adapter is detected. It keeps an existing codemem MCP entry unless `--force` is supplied, and does not configure Pi's native MCP. `--pi-extension-path <path>` writes a local-path `packages` entry instead of the npm pin (dev). See [Pi extension](plugin-reference.md#pi-extension).
