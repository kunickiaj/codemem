# Legacy Team Draft Limits and Retryability

**Date:** 2026-08-23

**Status:** Approved

## Problem

Legacy Team activation rejects drafts with more than 500 Devices or 500 Projects, but draft creation currently accepts unbounded snapshots. That can create an attempt that can never activate and lets Project-based readiness queries exceed SQLite's bound-parameter limit. Refresh also carries reviewed removed Devices into replacement attempts, so the effective row count can exceed the raw coordinator roster.

Activation also marks every `team_setup_conflict` attempt stale. Canonical conflicts remain fail-closed, but many can clear when external canonical state changes. Staling the attempt discards valid review work without improving authorization safety.

## Decision

Use shared internal limits of 500 Devices and 500 Projects in both draft and activation paths.

Draft refresh will reject an oversized snapshot with `legacy_team_setup_roster_too_large` before fingerprinting, assignment lookups, or draft row creation. Replacement attempts will also validate the effective Device union after adding previously reviewed removed Devices. An oversized refresh leaves the current attempt unchanged.

Multi-candidate discovery treats that error as local to the oversized coordinator group and continues returning other reviewable candidates. Carried Device rows are not silently discarded to fit the limit: they represent unresolved or reviewed removal work required by the all-Devices-accounted invariant. A candidate remains bounded and blocked until its current roster plus required carried rows fit the shared limit.

`team_setup_conflict` remains an activation error and continues to block all writes. Persisting that safe error will no longer mark the attempt stale. Roster, Project-inventory, and assignment evidence changes remain terminal for the reviewed snapshot and continue to stale it.

## Boundaries

- The limits helper remains internal to `packages/core`.
- The error string remains one bounded snapshot error for both Device and Project overflow.
- `refreshLegacyTeamSetupDraft` exposes the new bounded error to direct callers; multi-candidate discovery handles it per group.
- No schema or public response shape changes.
- Retryability changes only attempt preservation; it does not bypass preview, confirmation, canonical validation, or locked revalidation.
- Existing exact replay and confirmation-staleness behavior is unchanged.

## Verification

Tests will cover:

- exactly 500 and 501 Devices;
- exactly 500 and 501 Projects;
- overflow caused by carried removed Devices;
- pre-limit attempts that already contain more than 500 stored Device rows;
- discovery and direct refresh rejecting before assignment reads;
- no partial attempt rows after rejection;
- preservation of an existing reviewed attempt after oversized refresh;
- preservation of review state after `team_setup_conflict`; and
- continued staling after roster, projection, or assignment evidence changes.
