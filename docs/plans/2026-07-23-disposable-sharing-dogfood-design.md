# Disposable sharing dogfood harness design

**Date:** 2026-07-23
**Status:** approved
**Scope:** local interactive validation of Project-recipient sharing

## Goal

Provide a safe, repeatable Docker sandbox for manually exercising the real sharing UI without touching a developer's normal codemem database, config, keys, coordinator, or projects.

The harness complements the automated `projectSharing` E2E scenario. It does not replace that promotion gate and does not automate invitation creation or acceptance, because those are the user journeys being dogfooded.

## Chosen approach

Extend the existing TypeScript E2E infrastructure with a separate persistent dogfood runner. Reuse Compose orchestration, fixture conventions, coordinator helpers, and artifact capture while keeping the harness out of the production CLI.

Rejected alternatives:

- Shell scripts would duplicate orchestration and error handling and be less portable.
- Product-level `codemem dogfood` commands would expose test infrastructure as a supported CLI surface.
- Fully API-driven or direct-database onboarding would bypass the UI workflows under evaluation.

## Topology

Run one fixed Compose project, `codemem-dogfood`, with isolated named volumes:

- `coordinator`: local coordinator, reachable only inside Compose;
- `peer-a`: owner profile, viewer at `http://127.0.0.1:38881`;
- `peer-b`: teammate profile, viewer at `http://127.0.0.1:38882`;
- `peer-c`: the teammate's fresh second-device profile, viewer at `http://127.0.0.1:38883`.

The dogfood Compose override publishes only loopback viewer ports. Peer sync and coordinator traffic remain on the Compose network.

## Initial state

`setup` creates a deterministic baseline:

- all three peers have separate databases, configs, and key directories;
- the owner has one selected Project and one unrelated Project with recognizable synthetic memories;
- the owner has an active local Identity and one test policy Team;
- the teammate and second-device profiles are fresh;
- the coordinator group exists and the owner is enrolled;
- no invitation has been created or accepted;
- no recipient has received Project access.

The setup prints the three viewer URLs and an ordered checklist.

## Manual journey

The checklist guides the operator through the real UI:

1. Assign the selected Project to the test Team.
2. Create an exact-Project invitation on the owner and accept it on the teammate.
3. Create a Team invitation and accept it on that same teammate profile.
4. Create an add-device invitation for the teammate Identity and accept it on the fresh second-device profile.
5. Add future selected and unrelated memories and verify exact delivery and isolation.
6. Take the teammate offline, revoke access, observe a safe waiting state, restore it, and verify convergence.
7. Restart recipient profiles and verify Identity and coordinator configuration persistence.

The harness may seed infrastructure, identities, the empty Team, projects, and memories. It must not create, inspect, accept, or commit recipient invitations on the operator's behalf.

## Commands

The intended interface is:

```text
pnpm run dogfood -- setup [--build] [--reset]
pnpm run dogfood -- status
pnpm run dogfood -- add-future selected|unrelated
pnpm run dogfood -- offline teammate|second-device
pnpm run dogfood -- online teammate|second-device
pnpm run dogfood -- restart teammate|second-device
pnpm run dogfood -- snapshot
pnpm run dogfood -- logs
pnpm run dogfood -- cleanup
```

`status` reports container health, viewer URLs, and safe high-level state. `snapshot` writes diagnostic API responses and database copies under `.tmp/dogfood/` without printing secrets.

## State and safety

- Store harness metadata and artifacts only under ignored `.tmp/dogfood/`.
- Never discover or use the normal user database, config, or key paths.
- Use only synthetic names, remotes, projects, and memory text.
- Bind viewer ports to `127.0.0.1`.
- Use the existing test-only coordinator secret; never persist or print real credentials.
- `setup` fails if the fixed sandbox is already running unless `--reset` is explicit.
- `cleanup` is idempotent and can remove only the fixed `codemem-dogfood` Compose project and its named volumes.
- Do not accept arbitrary Compose project names or deletion paths.
- Preserve diagnostics on failure instead of broad cleanup outside the sandbox.

## Error handling

Commands fail with a concise next action:

- missing Docker or unavailable ports: report the prerequisite or conflicting port;
- missing sandbox state: instruct the operator to run `setup`;
- invalid lifecycle transition: leave the environment unchanged and print current status;
- failed peer restart: capture Compose logs and preserve volumes;
- failed fixture action: record command output under `.tmp/dogfood/` and do not mutate unrelated profiles.

## Validation

- Unit tests cover argument parsing, fixed-project guards, lifecycle state, generated checklist, and target validation.
- Fixture tests prove selected and unrelated Project data remain distinct.
- A local smoke runs `setup`, `status`, `snapshot`, and `cleanup` against Docker.
- Existing E2E scenarios remain unchanged and continue to pass.
- Normal TypeScript, Biome, and targeted Vitest checks cover touched code.

## Non-goals

- Production deployment or hosted coordinator validation.
- Browser automation of invitation workflows.
- Supporting arbitrary peer counts or Compose project names.
- Importing real user exports or credentials.
- Fixing dogfood findings inside the harness PR.
