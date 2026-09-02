# PR 1590 Runtime Health and Auto-Update Review Fixes

## Decision

The review fixes will expose process-local embedding runtime failures through existing semantic diagnostics and make the OpenCode plugin execute its existing paired-package auto-update plan.

## Runtime health

The core embedding loader will track whether the runtime is uninitialized, ready, disabled, or unavailable. It will expose only a sanitized failure category, not exception text.

Semantic diagnostics will report `degraded` and `keyword_only` after the current process observes a load or initialization failure. A failed migration remains higher priority, and a fresh process does not probe or load the model merely to answer a status request.

## Plugin auto-update

Both compatibility-floor and release-update paths will execute `resolveAutoUpdatePlan().command` directly after the CLI reports the release eligible. This closes the bootstrap gap where a pre-split CLI updates only `codemem` and omits `@codemem/embeddings`.

The scoped fix pins the validated release version and both public npm registry settings. It intentionally does not add a second plugin-owned implementation of CLI updater locking or Windows npm-shim handling; plugin-owned auto-update remains disabled on Windows.

## Tests

Core tests will cover runtime state transitions, degraded semantic diagnostics with existing vectors, and maintenance-failure precedence. Plugin tests will assert that both auto-update paths spawn the paired npm command and never delegate installation to `codemem update install`.
