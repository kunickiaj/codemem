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
