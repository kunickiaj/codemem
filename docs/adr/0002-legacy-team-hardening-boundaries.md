# ADR 0002: Legacy Team hardening boundaries

**Date:** 2026-08-23
**Status:** Accepted

## Context

Legacy Team discovery and enrollment reconciliation need deterministic evidence across runtimes. The hardening review also raised whether confirmation should bind a narrower canonical snapshot and whether a repaired Project identity must already appear in discovered evidence.

## Decisions

### Keep the existing broad canonical confirmation binding

Confirmation continues to bind the broad canonical snapshot used by activation: Teams, memberships, device assignments and decisions, Project recipients, mappings, identities, historical resolutions, and active group scopes. This can conservatively stale an in-flight confirmation after an unrelated canonical write, but narrowing the snapshot without a proven dependency closure could accept an outdated access review. Completed setups continue to use their separate authoritative Ready checks rather than this in-flight confirmation digest.

### Allow bounded new Project identity targets

A repaired Project mapping may target a new canonical remote or workspace identity that was not present in the displayed discovery evidence. Legitimate repairs can introduce that identity, so core validation must not require evidence-set membership. The target remains bounded by canonical identity parsing and shareability checks, is persisted in the draft, participates in the finish and access-delta digests, passes canonical preflight, and is applied atomically. The viewer API must preserve those bounds without inventing a narrower evidence allowlist.

### Use locale-independent protocol ordering

Persisted evidence, digests, and protocol-facing arrays use the existing `compareCodepoints` rule. Despite its historical name, the rule compares JavaScript strings by UTF-16 code units (`<` and `>`), not Unicode scalar values or locale collation. Presentation-only ordering may continue to use locale-aware comparison and is outside this decision.

## Consequences

- Canonical enrollment digest objects are serialized by sorted UTF-16 code-unit keys and remain domain-separated raw SHA-256 hex.
- Canonical eligibility, discovery, and enrollment reconciliation share one strict identifier grammar: nonempty, already trimmed, at most 256 UTF-16 units, with control and format characters rejected.
- Pre-existing canonical rows outside that grammar become ineligible on upgrade; this is a deliberate fail-closed tightening.
- Discovery rejects malformed coordinator, group, or device identifiers rather than normalizing them; malformed enrollment fingerprints become isolated device issues.
- Unrelated canonical writes may conservatively require the user to refresh an in-flight confirmation.
- No schema, API, UI, or generated-asset change is required.
