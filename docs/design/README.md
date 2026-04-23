# codemem design patterns

Documentation for design patterns that extend beyond a single component.
These complement the broader codemem design handoff (lives separately)
by documenting patterns this repo's UI introduces or refines.

## Anatomy pages

- [`device-row-anatomy.md`](./device-row-anatomy.md) — list-item
  density pattern: compact row + click-to-expand drawer. Used by the
  Sync tab's People & devices list.
- [`attention-vocabulary-anatomy.md`](./attention-vocabulary-anatomy.md) —
  offline / degraded / attention / syncing visual language. Pip sizes,
  pulse timing, Gestalt pairing rules.
- [`disclosure-region-anatomy.md`](./disclosure-region-anatomy.md) —
  inline-expand vs. popover vs. modal decision table; focus
  management; anti-patterns.

These landed with the 2026-04-23 Sync tab redesign; see
[`docs/plans/2026-04-23-sync-tab-redesign.md`](../plans/2026-04-23-sync-tab-redesign.md)
for the design history and PR sequence.

A toolbar / action-shelf anatomy page was drafted but removed during
Ramsay review because no concrete primitive consumes it yet — will
return when we have a real component to describe.

## Scope

These pages document **reusable patterns**, not component internals.
When something here needs to become a shared primitive (e.g.
`PresencePip` used on a second tab), the pattern description here
stays stable even as the implementation evolves.

Token values, color palettes, and typography scales remain in the
design handoff's `colors_and_type.css` — these pages reference
tokens but don't redefine them.
