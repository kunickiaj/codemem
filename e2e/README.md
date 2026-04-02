# Local E2E harness

This directory holds the first local Docker/Compose-based E2E harness for sync scenarios.

## Current scope

- Docker Compose topology for `coordinator`, `peer-a`, and `peer-b`
- host-run TypeScript runner
- smoke scenario for stack bring-up and coordinator reachability
- fleet spec and Compose fleet-smoke proving scenario
- coordinator invite/join/approval/discovery scenario
- direct peer sync scenario with data-plane assertions
- bootstrap scenario plus dirty-local refusal validation
- seed modes: `empty`, `fixture-small`, `fixture-large`, `local-import`
- automatic artifact capture under `.tmp/e2e-artifacts/`

## Run the smoke scenario

```fish
pnpm run e2e:smoke
```

Or:

```fish
pnpm run e2e -- smoke
```

## Run the coordinator scenario

```fish
pnpm run e2e:coordinator
```

## Run the direct sync scenario

```fish
pnpm run e2e:direct-sync
```

## Run the fleet smoke scenario

```fish
pnpm run e2e:fleet-smoke
```

Set `CODEMEM_E2E_FLEET_SPEC` to point at a different fleet spec file.

## Run the fleet ready scenario

```fish
pnpm run e2e:fleet-ready
```

This scenario materializes swarm groups from the fleet spec, joins workers, bootstraps them from the shared seed peer, and records a readiness snapshot.

## Run the fleet cleanup scenario

```fish
pnpm run e2e:fleet-cleanup
```

This scenario proves ephemeral worker peers can be removed from coordinator and local peer state while protecting the shared seed peer.

## Run the bootstrap scenario

```fish
pnpm run e2e:bootstrap
```

## Local import seed mode

When you want to use a local export payload instead of synthetic fixtures for a run:

```fish
set -lx CODEMEM_E2E_LOCAL_IMPORT /absolute/path/to/export.json
```

## Keep the stack around after the run

```fish
set -lx CODEMEM_E2E_KEEP_STACK 1
pnpm run e2e:smoke
```

Set `CODEMEM_E2E_BUILD=1` when you want to force an image rebuild for a run.

Artifacts are written to `.tmp/e2e-artifacts/`, which is intentionally ignored by git.

Set `CODEMEM_E2E_ARTIFACTS_DIR` to override the artifact root for CI or scripted runs.

For machine-readable runner status, pass `--json` or set `CODEMEM_E2E_JSON=1`.
