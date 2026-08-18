# Feed identity presentation hardening

**Date:** 2026-08-18
**Status:** Approved
**Related:** `codemem-g9sp`, `2026-07-21-project-recipient-sharing-identity-design.md`

## Problem

Direct Project acceptance can replace an owner-reviewed pending Identity name with a recipient-supplied machine identifier. Viewer memory responses do not resolve trusted local actor and device facts, and Feed consequently renders raw actor IDs and device UUIDs as ordinary labels. Existing malformed rows need a safe presentation path without rewriting historical provenance.

## Decisions

1. Preserve a human-shaped pending or existing actor name during direct Project reconciliation instead of overwriting it with a machine-shaped accepted name.
2. Add a dedicated human-presentation name validator. Apply it to invitation acceptance, actor rename, and device rename, but not to Project names.
3. Keep stored memory provenance unchanged. Viewer memory responses add resolved actor and device display fields derived from trusted local identity records.
4. Resolve author labels from an active actor first. For an unknown actor, use a fingerprint-bound peer actor; for a known merged actor, follow its active merge target. Use a human-shaped stored memory label only when trusted local facts do not resolve.
5. Resolve device labels from an active identity device first, then a fingerprint-bound peer with a human-shaped name.
6. Feed uses resolved fields and neutral fallbacks. Raw actor and device identifiers remain available only to explicit diagnostics.

## API and presentation contract

Memory responses may add:

- `resolved_actor_display_name`
- `resolved_device_display_name`

The fields are additive and optional for compatibility. Feed falls back to `Teammate` or `Unknown author` for unresolved authors and `Shared device` for unresolved remote devices. It never promotes `local:*`, UUIDs, identity IDs, or hostname-like hexadecimal values to normal labels.

## Validation

Human presentation names continue to use the existing structural limits and additionally reject machine-shaped values. Validation failures return the existing client-error response shape with a clear request-boundary message. Project names retain their current normalization behavior.

Automatically derived device names skip machine-shaped hostnames and fall back to `Codemem device <seed>`, so container and cloud installs remain enrollable without promoting host identifiers to display names.

Mixed-version installations should upgrade accepting clients before coordinators. An upgraded coordinator intentionally rejects machine-shaped names sent by older clients; these validation codes remain explicit and map to actionable Viewer guidance.

## Tests

- Direct Project reconciliation preserves the pending human actor name when acceptance supplies a machine-shaped fallback.
- Invitation acceptance, actor rename, and device rename reject representative machine-shaped values.
- Viewer memory endpoints resolve trusted actor and device facts in batches and return neutral results when no trusted fact exists.
- Feed renders resolved names or neutral fallbacks and does not render raw actor/device identifiers.
- Existing memory-ID diagnostics remain unchanged.

## Non-goals

- No historical identity backfill or provenance rewrite.
- No redesign of Sharing, Devices, or Feed.
- No changes to Project-name validation.
- No expansion of Team or add-device journey coverage already present elsewhere.
