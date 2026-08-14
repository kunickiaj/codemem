# @codemem/opencode-plugin

Persistent memory plugin for [OpenCode](https://opencode.ai).

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

`CodememPlugin` is the canonical named export and the package default export.
`OpencodeMemPlugin` remains available as a deprecated, reference-identical alias
for compatibility with integrations created before the Codemem rename. No removal
version is currently scheduled.

## Documentation

- Repository: https://github.com/kunickiaj/codemem
- Full README: https://github.com/kunickiaj/codemem#readme
- User guide: https://github.com/kunickiaj/codemem/blob/main/docs/user-guide.md
- Architecture: https://github.com/kunickiaj/codemem/blob/main/docs/architecture.md
