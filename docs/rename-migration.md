# Migrate this repository's former opencode-mem installation

This guide covers this repository's former name, not importing data from `tickernelz/opencode-mem`. The shipped runtime is now the npm `codemem` package; the OpenCode plugin is `@codemem/opencode-plugin`.

## Back up and update

1. Stop the legacy runtime before copying its database. Preserve the database and any SQLite `-wal` and `-shm` sidecars together.
2. Install the current runtime and configure the host:

```text
npm install -g codemem
codemem setup --opencode-only
```

If you configure plugins manually, replace `@kunickiaj/codemem` with `@codemem/opencode-plugin`. If an MCP command still invokes the old runtime, use:

```json
{
  "mcp": {
    "codemem": {
      "type": "local",
      "command": ["codemem", "mcp"],
      "enabled": true
    }
  }
}
```

3. If needed, copy the legacy configuration into `~/.config/codemem/config.json`. Review it against the current [configuration reference](../README.md#configuration); old Python runner settings are not installation guidance for the npm runtime.
4. Restart the agent host and verify:

```text
codemem stats
codemem db raw-events-status
```

## Database migration

The default database is `~/.codemem/mem.sqlite`. When it does not exist, the runtime can migrate `~/.opencode-mem.sqlite` and its SQLite sidecars. If the new default already exists, the legacy database remains untouched; do not overwrite either database to combine histories. Explicit database paths are not a request to migrate the default database.

Confirm that the expected memories appear in the viewer before uninstalling the legacy tool or deleting its files. See [Python-to-TypeScript migration](migration-python-to-ts.md) for runtime history and database compatibility.
