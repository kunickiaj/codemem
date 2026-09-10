# @codemem/opencode-plugin

Persistent memory plugin for [OpenCode](https://opencode.ai).

Requires OpenCode 1.18.29 or newer.

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

## Exports

The package default export is one dual-host object. OpenCode 1 calls its
`server()` function, while OpenCode 2 calls its `setup()` function. The OpenCode 2
setup captures conversation, tool, usage, and lifecycle activity and disposes its
host registrations on unload. It does not yet inject automatic recall or expose
memory tools.

`CodememPlugin` remains the canonical named OpenCode 1 function export.
`OpencodeMemPlugin` remains available as a deprecated, reference-identical alias
for integrations created before the Codemem rename. No removal version is
currently scheduled.

## Documentation

- Repository: https://github.com/kunickiaj/codemem
- Full README: https://github.com/kunickiaj/codemem#readme
- User guide: https://github.com/kunickiaj/codemem/blob/main/docs/user-guide.md
- Architecture: https://github.com/kunickiaj/codemem/blob/main/docs/architecture.md
