# Signed identity-owned add-device invitations implementation plan

**Date:** 2026-07-25
**Design:** `docs/plans/2026-07-25-signed-add-device-invites-design.md`
**Bead:** `codemem-wosg.2`

## 1. Signed coordinator boundary

- Treat disabled enrollments as unauthorized in `authorizeRequest`.
- Add a fixed-purpose signed add-device invitation endpoint.
- Allowlist body fields and derive the target Identity, creator, policy, and coordinator URL server-side.
- Reuse reviewed-intent verification and existing invite persistence.

## 2. Core client action

- Add a signed add-device invitation action that serializes the body once.
- Sign those exact bytes with the local device key.
- Return the same payload/link shape as admin invitation creation.
- Surface stable coordinator errors without admin fallback.

## 3. Viewer routing

- Split Team admin readiness from add-device signed readiness.
- Keep local preview and reviewed-onboarding digest checks unchanged.
- Route Team creation through the admin action, non-admin add-device creation through the signed action, and explicitly admin-configured owner issuance through the existing admin action.
- Require the requested add-device Identity to equal the current local Identity before signing.

## 4. Tests

- Add coordinator API authorization and input-boundary tests.
- Add core action signing/error tests.
- Add viewer tests for non-admin add-device creation and unchanged Team denial.
- Add real Worker/D1 signed issuance coverage.

## 5. Gate

- Run focused API/action/viewer/Worker tests.
- Run `pnpm run check` and the Worker test suite.
- Run security, coverage, and maintainability reviews before submission.
