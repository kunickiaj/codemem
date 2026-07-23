# Exact-Project Local-Default Isolation Implementation Plan

**Date:** 2026-07-23  
**Design:** `2026-07-23-exact-project-local-default-isolation-design.md`  
**Bead:** `codemem-l72f`

## Goal

Make null and `local-default` regular memory data non-replicable at every sync boundary, recover already received rows only when remote ownership is proven, and reproduce the exact acceptance/restart/delayed-provisioning order from dogfood.

## 1. Lock the core boundary with failing tests

Update `packages/core/src/sync-replication.test.ts` and `packages/core/src/sync-bootstrap.test.ts` first.

Add behavior coverage proving:

- broad project filters cannot make null or `local-default` regular ops outbound-eligible;
- targeted `access_cleanup` and valid old-side `reassign_scope` remain eligible;
- regular null scope rejects as `missing_scope` even when broader legacy validation is disabled;
- regular `local-default` rejects as `scope_mismatch` even when broader legacy validation is disabled;
- unscoped snapshot serving omits null and `local-default` rows;
- bootstrap apply and merge reject local-only rows before any deletion or insertion;
- stale-row reconciliation deletes remote-origin null/default rows for the syncing peer;
- reconciliation retains local-owned and ambiguous-origin rows, clears references, reports vector deletion work, and is idempotent.

Run:

```sh
pnpm exec vitest run packages/core/src/sync-replication.test.ts packages/core/src/sync-bootstrap.test.ts
```

The new tests must fail for the intended boundary before implementation.

## 2. Enforce serving, sending, and receiving

Update `packages/core/src/sync-replication.ts` and `packages/core/src/sync-bootstrap.ts`.

### Outbound

- Deny regular memory ops whose effective scope is null or `local-default` before project or legacy compatibility filtering.
- Preserve only targeted cleanup and valid old-side reassignment as retracting control exceptions.
- Make unscoped snapshot queries exclude null and `local-default` rows while retaining authorized explicit scopes.

### Inbound

- Add an unconditional local-only admission guard before optional legacy scope validation.
- Reject null regular memory scope as `missing_scope`.
- Reject explicit `local-default` regular memory scope as `scope_mismatch`.
- Validate complete snapshot input before mutating the database so a bad row cannot cause partial replacement.

Rerun the focused tests from step 1.

## 3. Add conservative recovery before exchange

Update `reconcileStalePeerReceivedRowsInternal()` in `packages/core/src/sync-replication.ts`:

- when `origin_device_id` matches a remote peer and effective scope is null or `local-default`, remove the row;
- always retain rows owned by the local device;
- retain rows with missing origin and report them as ambiguous;
- retain existing scoped authorization and revocation behavior;
- clear memory references and return deleted IDs for vector maintenance.

Update `syncOnce()` in `packages/core/src/sync-pass.ts` to run peer-specific reconciliation after authenticated peer identity verification and before bootstrap, pull, or push. Reuse the existing vector queue and fallback behavior. Keep post-apply reconciliation for scoped revocation cleanup unless tests prove it redundant.

Add `packages/core/src/sync-pass.test.ts` coverage proving recovery occurs before every initial bootstrap/data-exchange path and cannot turn default-scope data into successful Project setup.

Run:

```sh
pnpm exec vitest run packages/core/src/sync-replication.test.ts packages/core/src/sync-bootstrap.test.ts packages/core/src/sync-pass.test.ts
```

## 4. Reproduce the real ordering end to end

Update `e2e/scenarios/project-sharing.ts` using the existing deterministic fixture.

Exercise this order explicitly:

1. Owner creates selected and unrelated existing memories.
2. Recipient accepts the exact-Project invitation.
3. Recipient restarts and becomes reachable.
4. Sync runs before inviter provisioning advances.
5. Recipient contains neither selected nor unrelated source data.
6. Inviter provisioning creates the managed scope, grants devices, and reassigns selected data.
7. Selected existing data arrives through the managed scope.
8. Selected future data arrives.
9. Unrelated existing and future data never appear.
10. A partial or failed provisioning state remains pending and never broadens access.

Do not weaken fixture isolation or assert only final state; the pre-provisioning transient check is the regression.

Run the repository's existing Project-sharing E2E command discovered from package scripts. Do not invent a parallel harness.

## 5. Validate and review

Run focused tests, then:

```sh
pnpm run tsc
pnpm run lint
pnpm run test
```

Run the Project-sharing E2E scenario separately because it may require its existing build/runtime setup.

Request high-risk review focused on:

- any path that can serve, send, apply, or bootstrap null/`local-default` regular memory data;
- cleanup ownership proof and accidental local deletion;
- control-operation exceptions that could be abused to grant or overwrite data;
- cursor behavior after skipped local-only rows;
- restart and partial-provisioning races;
- backward compatibility limited to explicitly scoped authorized data.

## Exit criteria

- All boundary tests pass.
- The E2E test catches leakage before provisioning and passes with the fix.
- Typecheck, lint, and workspace tests pass.
- No unresolved blocker/high review finding remains.
- `codemem-l72f` records the validation evidence before closure.
