# Legacy Team Canonical Preflight Reuse

**Date:** 2026-08-23

**Status:** Approved

## Problem

Legacy Team setup drafts can report `canFinish: true` while activation will reject the same reviewed state with `team_setup_conflict`. Draft readiness currently checks that a Project has an active coordinator scope, but activation also rejects ambiguous multi-scope mappings, conflicting mappings, foreign-Team recipient claims, and unsupported recipient kinds.

That disagreement is both confusing and costly: a user can finish reviewing a draft only to have activation reject it. Activation must still repeat every canonical check under its write lock because canonical state can change after preview.

## Decision

Extract the read-only Project canonical-state rules into an internal data-only preflight module. Both draft readiness and activation validation will call the same predicate.

The shared predicate will evaluate:

- whether existing mappings can safely be preserved or superseded by this coordinator group;
- whether creating or retargeting a mapping is ambiguous across multiple active scopes;
- whether another active Team already claims the resolved Project; and
- whether an active recipient uses an unsupported kind.

Direct Identity recipients remain compatible with the reviewed Team edge. Revoked recipients remain irrelevant. A setup-owned mapping may be superseded only when it belongs to this coordinator group's current or historical scopes.

## Boundaries

- The helper remains internal to `packages/core`; it is not exported from `packages/core/src/index.ts`.
- Draft readiness loads only the canonical facts required by the predicate and folds its result into `canFinish`.
- Activation continues to call canonical validation from `loadModel` before preview and again inside `BEGIN IMMEDIATE` before any writes.
- Post-write selected-mapping precedence remains activation-only; a higher-priority selected mapping can still reject activation after `canFinish` was true.
- No schema, API contract, authorization, or persistence behavior changes.

## Verification

Focused tests will prove draft readiness and activation agree for:

- a new mapping with multiple active scopes;
- a Project claimed by another active Team;
- an active recipient with an unsupported kind; and
- canonical state that changes after preview but before locked activation validation.

Existing positive coverage for an already-selected mapping across multiple scopes and direct Identity recipient coexistence must remain green.
