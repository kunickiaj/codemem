# Claude Stop hook timeout alignment

## Context

Claude command hooks default to a 60-second host timeout. Codemem's opt-in `Stop` boundary flush intentionally allows 125 seconds for observer extraction and fallback handling, so Claude can terminate the hook before Codemem reaches its own deadline.

## Design

- Preserve the existing 125-second internal `Stop` boundary budget.
- Set the packaged Claude `Stop` command-hook timeout to 130 seconds, leaving five seconds for process startup and shutdown outside Codemem's measured execution window.
- Keep `Stop` boundary flushing opt-in through `CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP=1`.
- Add a contract test that reads the packaged manifest and verifies the host timeout remains five seconds above the runtime budget.
- Document both the internal budget and host timeout together.

## Consequences

Normal `Stop` ingestion remains fast and boundary extraction remains opt-in. When enabled, Claude now permits the documented extraction budget to complete instead of applying its shorter implicit default.
