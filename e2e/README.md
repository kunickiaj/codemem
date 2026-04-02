# Local E2E harness

This directory holds the first local Docker/Compose-based E2E harness for sync scenarios.

## Current scope

- Docker Compose topology for `coordinator`, `peer-a`, and `peer-b`
- host-run TypeScript runner
- smoke scenario for stack bring-up and coordinator reachability
- automatic artifact capture under `.tmp/e2e-artifacts/`

## Run the smoke scenario

```fish
pnpm run e2e:smoke
```

Or:

```fish
pnpm run e2e -- smoke
```

## Keep the stack around after the run

```fish
set -lx CODEMEM_E2E_KEEP_STACK 1
pnpm run e2e:smoke
```

Set `CODEMEM_E2E_BUILD=1` when you want to force an image rebuild for a run.

Artifacts are written to `.tmp/e2e-artifacts/`, which is intentionally ignored by git.
