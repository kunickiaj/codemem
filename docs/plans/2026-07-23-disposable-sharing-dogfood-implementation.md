# Disposable sharing dogfood harness implementation plan

**Date:** 2026-07-23
**Design:** `docs/plans/2026-07-23-disposable-sharing-dogfood-design.md`

## Delivery shape

One focused PR adds the local harness, tests, and usage documentation. It does not modify recipient-policy production behavior.

## 1. Compose support

- Add a dogfood Compose override that publishes the three viewer ports on loopback.
- Extend `ComposeManager` minimally to support multiple Compose files, the existing `bootstrap` profile, and bounded service lifecycle operations needed by `offline`, `online`, and `restart`.
- Preserve all existing E2E call sites and defaults.

Validation:

- Unit-test generated Compose arguments and fixed project/profile behavior.
- Run existing smoke and project-sharing scenarios after the compatibility change.

## 2. Deterministic dogfood fixture

- Add a fixture script that initializes peers, seeds the owner's selected/unrelated Projects and memories, and creates the empty test Team.
- Add actions for selected/unrelated future memories and safe summaries.
- Keep invitation and recipient edge mutations out of fixture actions.

Validation:

- Prove fixture actions are idempotent where expected.
- Assert Project remotes, titles, and memory sets remain separated.

## 3. Persistent runner

- Add a TypeScript runner with strict parsing for `setup`, `status`, `add-future`, `offline`, `online`, `restart`, `snapshot`, `logs`, and `cleanup`.
- Use the fixed `codemem-dogfood` Compose project and ignored `.tmp/dogfood/state.json` metadata.
- During setup, initialize all peers, configure coordinator connectivity, enroll only the owner, start all viewers, wait for readiness, and print URLs/checklist.
- Make setup refuse an active environment without `--reset`.
- Make cleanup idempotent and fixed-target only.

Validation:

- Unit-test parser and lifecycle guards without Docker.
- Test status/checklist output using injected command and filesystem dependencies.

## 4. Diagnostics and operator workflow

- Implement safe status summaries, API snapshots, database artifact copies, and Compose log capture.
- Never include the coordinator admin secret or private host paths in normal output.
- Add `package.json` scripts and document the workflow in `e2e/README.md`.

Validation:

- Run a Docker smoke: setup → status → add-future → snapshot → restart → cleanup.
- Confirm cleanup removes only dogfood containers and volumes.
- Confirm the normal local profile remains untouched.

## 5. Final gates

- `pnpm run tsc`
- `pnpm run lint`
- targeted dogfood/Compose tests
- `CODEMEM_E2E_BUILD=1 CODEMEM_E2E_JSON=1 pnpm run e2e:smoke -- --json`
- `CODEMEM_E2E_BUILD=1 CODEMEM_E2E_JSON=1 pnpm run e2e:project-sharing -- --json`
- manual browser check that all three viewer URLs load and invitation actions remain operator-driven
