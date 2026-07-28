# Recipient managed-Project projection

## Decision

Add-device review must include managed Projects that the reviewing recipient device accepted through a direct Project invitation, even when that device has no owner-policy `project_recipients` rows.

The client will persist a narrow recipient-local projection from the coordinator-confirmed direct-invite acceptance response. It will not infer authorization from copied memories, Project labels, peer discovery, or local inventory heuristics.

## Projection authority

The coordinator already retains the direct invitation's canonical `project_intent_json` and `reviewed_project_set_digest`. After successfully consuming a direct Project invitation, the join response may add an accepted-intent object containing:

- operation ID;
- reviewed Project-set digest;
- canonical Project identities, display names, and reviewed memory counts.

The recipient validates this object against the invitation operation, exact group, and reviewed-set digest before storing it. Older coordinators may omit the additive field; the invite remains usable. For recipients that accepted before projection support, add-device review may recover the same Project only from the local device's active coordinator-authoritative managed scope, current membership, exact Project mapping, and deterministic managed-scope identifier. This compatibility path is read-only and remains fail-closed when any boundary is missing or inconsistent.

## Local state

An additive local table records each accepted managed Project with:

- canonical Project identity;
- deterministic managed scope ID;
- exact coordinator and group;
- recipient Identity and accepting device;
- source operation and reviewed-set digest;
- active/revoked status and timestamps.

This is recipient evidence, not owner policy. It must never write `project_recipients` or `policy_team_memberships`.

Coordinator URLs are compared in normalized base-URL form so equivalent configured and authoritative values (for example, a trailing slash difference) do not hide valid evidence. Group IDs and all other authority fields remain exact comparisons.

## Add-device preview

For an add-device preview, direct inherited Projects are the union of:

1. active owner-policy direct Identity recipients; and
2. active recipient projections where:
   - the projected recipient Identity matches the reviewed Identity;
   - `replication_scopes` contains the same active managed scope under the exact coordinator/group;
   - `scope_memberships` shows the accepting device remains active in that scope.

Team inheritance remains sourced from owner-policy Team rows. Duplicate Project identities merge into one deterministic direct source.

A projected Project with zero local memories still appears because the accepted intent, not copied data, defines the canonical identity. A stale or revoked membership excludes it.

## Review and tamper binding

The existing onboarding preview digest continues to bind:

- device and Identity binding;
- selected canonical Projects and sources;
- excluded Project identities.

Invite creation persists the reviewed intent and digest at the coordinator. Recipient inspection verifies that coordinator-owned reviewed intent and reconstructs the same selected/excluded identities without consulting recipient-local policy facts.

No canonical authority data is added to the bearer invite payload; its existing display summaries remain non-authoritative.

## Excluded Projects

`excludedProjects` means Projects known to the reviewing device but not selected by its current inherited-access evidence. It is not an exhaustive owner-wide denied list. Changing that meaning would require a separate privacy and inventory design.

## Compatibility and migration

- Local database migration is additive and requires no backfill.
- Coordinator storage requires no migration because canonical Project intent is already persisted.
- The join response change is additive; old clients ignore it and old coordinators omit it.
- Invalid accepted-intent data is never persisted.

## Validation

- Core onboarding tests prove projected direct access appears without owner-policy rows and is excluded for wrong Identity, coordinator/group/scope, inactive scope, or revoked membership.
- Coordinator API/action tests prove accepted intent is digest-bound and malformed responses cannot create projections.
- SQLite bootstrap/migration tests prove upgrade safety.
- Viewer route tests prove preview → create → inspect preserves exact selected and excluded identities.
- Project Sharing E2E asserts peer-b reviews the selected Project before creating peer-c's add-device invitation; unrelated Projects remain excluded.
