# @codemem/opencode-plugin

Persistent memory plugin for [OpenCode](https://opencode.ai).

Requires OpenCode 1.18.29 or newer. The same package also runs on OpenCode 2,
validated against the exact stable `@opencode/cli@2.0.2` and
`@opencode/plugin@2.0.2` releases. Codemem's OpenCode 2 integration is beta.

## Install

Recommended:

```text
npx -y codemem setup --opencode-only
```

Manual config also works. Add the package name to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@codemem/opencode-plugin"]
}
```

OpenCode installs npm plugins automatically with Bun at startup.

Setup keeps the singular `plugin` key because OpenCode 1 requires it and
OpenCode 2 translates it into its native `plugins` configuration. Keep one Codemem
entry: if OpenCode loads Codemem twice for one project (for example a configured
npm plugin plus a checkout-local `.opencode/plugins/` copy), the first
registration wins and later copies skip their hooks with a warning in
`~/.codemem/plugin.log`.

## Troubleshooting and rollback

- No automatic recall on OpenCode 2: recall requires a non-empty latest
  user-message ID in `session.context`. When the ID is missing or blank, the
  turn skips recall instead of guessing. Capture and the manual tools still work.
- Duplicate registration warning: remove either the configured npm entry or the
  project-local copy so only one Codemem plugin loads.
- Stop the OpenCode 2 path: set `CODEMEM_PLUGIN_IGNORE=1` in the environment that
  launches OpenCode 2, or remove the plugin entry from that host's config.
  OpenCode 1 keeps working from the same package.
- Return to OpenCode 1: both hosts share one raw-event stream and SQLite
  database, so switching hosts needs no storage migration.

## Exports

The package default export is one dual-host object. OpenCode 1 calls its
`server()` function, while OpenCode 2 calls its `setup()` function. The OpenCode 2
setup captures conversation, tool, usage, and lifecycle activity and disposes its
host registrations on unload. It exposes the manual `mem-status`, `mem-recent`,
and `mem-stats` tools through `tool.transform` with `codemode: false`, keeping
the hyphenated IDs. OpenCode 2.0.2 automatic recall runs through
`session.context` when the latest user message has a non-empty ID. Each identified turn performs one fresh retrieval, while
retries and tool continuations replay retained context. Missing or blank identity
skips recall safely, and auxiliary hooks remain isolated.

`CodememPlugin` remains the canonical named OpenCode 1 function export.
`OpencodeMemPlugin` remains available as a deprecated, reference-identical alias
for integrations created before the Codemem rename. No removal version is
currently scheduled.

## Documentation

- Repository: https://github.com/kunickiaj/codemem
- Full README: https://github.com/kunickiaj/codemem#readme
- User guide: https://github.com/kunickiaj/codemem/blob/main/docs/user-guide.md
- Architecture: https://github.com/kunickiaj/codemem/blob/main/docs/architecture.md
