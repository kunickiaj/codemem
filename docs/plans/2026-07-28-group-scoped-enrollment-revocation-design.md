# Group-scoped enrollment revocation

## Decision

Disabling a coordinator enrollment revokes access only within that enrollment's coordinator group. It must not globally revoke the device or remove access granted through another active group.

## Why

Coordinator enrollment identity is `(coordinator, group, device)`, while `identity_devices` is a global owner-policy edge keyed only by device. Marking that global edge revoked after one group disables the device would collapse independent trust domains and remove unrelated Project access.

The managed Project boundary already retains its exact coordinator and group in `replication_scopes`. Recipient-policy reconciliation is therefore the correct authority for applying an explicit disabled enrollment to one Project scope.

## Reconciliation contract

For each managed Project reconciliation pass:

1. Read the authoritative scope-membership snapshot for the Project boundary.
2. Apply owner-policy removals first, preserving the existing fail-closed deny-before-revoke ordering.
3. Read the complete enrollment snapshot for the boundary's exact coordinator and group, including disabled enrollments.
4. Interpret enrollment state as follows:
	- enabled with the expected Identity binding: eligible for retention or grant;
	- enabled with a conflicting Identity binding: deny and revoke within this scope;
	- enabled with no Identity binding: cannot receive a new grant, but is not authoritative evidence for revoking an existing membership;
	- explicitly disabled: deny and revoke within this scope, regardless of the global `identity_devices` edge;
   - omitted from a successful snapshot: not eligible for a new grant, but not a revocation signal by itself.
5. Persist a deny overlay before invoking the coordinator membership revoke.
6. Refresh the local scope-membership cache and coordinator-policy peer trust after effects complete.
7. Verify parity from a fresh authoritative scope snapshot before clearing deny overlays.

The global `identity_devices` row remains active. Another managed Project in a different group independently evaluates its own enrollment snapshot and can retain access.

## Failure and retry behavior

- Enrollment reads request disabled rows explicitly and fail closed if the response is malformed.
- A failed or stale enrollment read does not infer revocation from absence.
- Coordinator membership mutations retain deterministic effect identities and existing receipt validation.
- Repeated disabled snapshots are idempotent: once the scope membership is revoked, later passes perform no additional revoke effect.
- A device that becomes disabled during grant preflight is not granted.
- A device that becomes disabled immediately after grant receives a deny overlay and compensating revoke before reconciliation returns stale.

## Data and API impact

No schema migration or coordinator API change is required. The existing device-list API already supports `include_disabled=1`, recipient-policy deny overlays already carry scope identity, and coordinator-policy trust cleanup already preserves manual and invite-derived trust.

## Validation

- Core tests prove explicit disabled enrollment revokes a current scope member, omission does not revoke, retry is idempotent, and other Project boundaries remain unaffected.
- Viewer effect tests prove the exact group read includes disabled enrollments and preserves enabled state in the effect contract.
- Runtime tests continue proving coordinator-policy trust cleanup does not remove manual/invite trust.
- Project-sharing E2E disables the second device, waits for owner maintenance, and proves it no longer receives new data from the revoked Project while unrelated group access remains intact.
