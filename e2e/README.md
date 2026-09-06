# Local E2E harness

This directory holds the first local Docker/Compose-based E2E harness for sync scenarios.

## Current scope

- Docker Compose topology for `coordinator`, `peer-a`, and `peer-b`
- host-run TypeScript runner
- smoke scenario for stack bring-up and coordinator reachability
- fleet spec and Compose fleet-smoke proving scenario
- coordinator invite/join/approval/discovery scenario
- direct peer sync scenario with data-plane assertions
- project-sharing scenario covering exact-project replication and recipient-policy promotion gates
- sharing-domain scenario covering Personal/Work/OSS boundaries and hostile/legacy peers
- bootstrap scenario plus dirty-local refusal validation
- seed modes: `empty`, `fixture-small`, `fixture-large`, `local-import`
- automatic artifact capture under `.tmp/e2e-artifacts/`
- disposable three-peer sharing dogfood sandbox

## Disposable sharing dogfood sandbox

Use the test-only runner to exercise the real sharing UI. It uses only synthetic, isolated state under `.tmp/dogfood/`; it never reads or changes a normal user database, config, keys, coordinator, or Projects. Invitations remain operator-driven: the fixture never creates, inspects, accepts, or commits them.

Prerequisites: Docker Engine with the Compose plugin, available loopback ports `38881`–`38883`, and built images when using `--build`. Check Docker and a conflicting port with:

```fish
docker compose version
lsof -nP -iTCP:38881 -sTCP:LISTEN
```

Set up the fixed `codemem-dogfood` sandbox:

```fish
pnpm run dogfood -- setup --build
```

Setup refuses existing dogfood state. Reset only that fixed sandbox when you intend to discard it:

```fish
pnpm run dogfood -- setup --reset
```

View the isolated peers at fixed loopback URLs:

- Owner A: `http://127.0.0.1:38881`
- Teammate B: `http://127.0.0.1:38882`
- Second device C: `http://127.0.0.1:38883`

Follow this order in the UI:

1. Assign the selected Project to the test Team in the Owner A UI (`38881`).
2. In the Owner A UI (`38881`), choose **Create an invitation → Invite Team member**. Do not choose **Share exact Projects** at this step. Accept it in the Teammate B UI (`38882`).
3. If the teammate UI reports that restart is required, run `pnpm run dogfood -- restart teammate` before continuing.
4. In the Owner A UI (`38881`), choose **Create an invitation → Share exact Projects**; accept it on that same Teammate B profile (`38882`).
5. In the Teammate B UI (`38882`), choose **Create an invitation → Add a device** for that Identity, then accept it in the Second device C UI (`38883`).
6. Run `pnpm run dogfood -- restart second-device` after add-device acceptance.
7. Add selected and unrelated future memories, then verify delivery, isolation, offline revocation, recovery, and restart persistence.

| Command | Use |
| --- | --- |
| `pnpm run dogfood -- status` | Show sandbox status and viewer URLs. |
| `pnpm run dogfood -- add-future selected` | Add a synthetic future memory to the selected Project. |
| `pnpm run dogfood -- add-future unrelated` | Add one to the unrelated Project. |
| `pnpm run dogfood -- offline teammate` | Stop the teammate. |
| `pnpm run dogfood -- online teammate` | Start the teammate. |
| `pnpm run dogfood -- restart teammate` | Restart the teammate. |
| `pnpm run dogfood -- offline second-device` | Stop the second device. |
| `pnpm run dogfood -- online second-device` | Start the second device. |
| `pnpm run dogfood -- restart second-device` | Restart the second device. |
| `pnpm run dogfood -- snapshot` | Save redacted summaries and database copies. |
| `pnpm run dogfood -- logs` | Capture Compose logs. |
| `pnpm run dogfood -- cleanup` | Remove only `codemem-dogfood` containers, volumes, and `.tmp/dogfood/`. |

Snapshots, copied databases, state, and logs stay under ignored `.tmp/dogfood/`. `cleanup` is idempotent and fixed-target only; it does not discover or delete normal local state.

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

## Run the project-sharing scenario

```fish
set -lx CODEMEM_E2E_BUILD 1
set -lx CODEMEM_E2E_JSON 1
pnpm run e2e:project-sharing -- --json
```

This scenario reuses one two-peer setup to prove:

- direct Identity access without Team membership
- Team access inherited by existing and future members
- add-device inheritance for an Identity's existing Projects
- group-scoped add-device enrollment revocation and future-data isolation
- Personal/Work and unrelated-Project isolation
- existing and future memory replication for the selected Project
- stale preview rejection without intent mutation
- revocation plus offline waiting and resume
- unsupported old-peer rejection before coordinator mutations
- durable ambiguous-migration `Keep current` decisions
- rollback visibility through the safe reconciliation API

## Run the Team setup scenario

```fish
pnpm run e2e:legacy-team-migration -- --json
```

This scenario proves that reviewed Team setup:

- keeps existing access unchanged until **Finish Team setup**;
- persists device choices, supports shared assignments across Teams, and keeps a Team-specific exclusion scoped to that Team;
- blocks incomplete, stale, conflicting, or unmapped Project reviews without changing access;
- applies confirmed device decisions, Project mappings, and access changes together at finish;
- keeps a later unreviewed device ineligible;
- returns the same completed result when a finish response is lost and retried; and
- makes the first valid completion authoritative across upgraded devices: another device applies the same policy locally and no longer shows the setup task.

## Run the sharing-domain scenario

```fish
set -lx CODEMEM_E2E_BUILD 1
set -lx CODEMEM_E2E_JSON 1
pnpm run e2e:sharing-domains -- --json
```

This scenario verifies hard sharing-domain boundaries, Project filters that only narrow access, coordinator group membership that grants no data access, legacy-peer default deny, revocation, and hostile-row rejection.

## CI execution

Normal CI runs `smoke` on pull requests, pushes to `main`, and release `workflow_call` runs. It also runs the specialized `legacy-team-migration`, `project-sharing`, and `sharing-domains` matrix on `main` and release runs, preserving all four scenarios outside pull requests.

The dedicated `Full E2E` workflow runs all four scenarios on its daily `03:17 UTC` schedule and on manual dispatch. On pull requests it skips its duplicate smoke job and runs the three specialized scenarios only while the existing `ci:full` label is present. Opening, reopening, updating, labeling, or unlabeling a pull request reevaluates that policy; the newest run cancels older `Full E2E` runs for the same pull request so label removal cannot leave stale work running.

`Full E2E Legacy Team Migration`, `Full E2E Project Sharing`, and `Full E2E Sharing Domains` are advisory pull request checks and must not be configured as required checks. Normal CI keeps its regular `E2E Smoke` check and does not rerun required jobs when contributors request specialized coverage. Each E2E lane uploads its `.tmp/e2e-artifacts/` directory on failure, and the Cloudflare Worker integration job remains separate.

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
