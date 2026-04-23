# Sync tab redesign

> Scope: codemem viewer Sync tab only. Full information-architecture pass,
> not a spacing nudge. Extends `design_handoff_codemem_viewer/` (does not
> replace it).

## Problem

Dogfood screenshots on 2026-04-23 show six peer-level regions stacked on the
Sync tab:

1. Team sync header + global `Sync now`
2. Needs attention
3. Add devices & teammates (Join / Invite rows)
4. Team status > Overview
5. People & devices (per-device mini-form: 8+ affordances per card)
6. Advanced diagnostics (5 stat cards + recent-attempts log)

No primacy hierarchy. Progressive disclosure is missing from the two
biggest-density regions (Advanced diagnostics, per-device sharing scope).
The Team status > Overview card triplicates information already surfaced
in the header chip and in Needs attention. User feedback: "busy af."

The existing design handoff covers tokens, voice, spacing, and the
feed-item pattern. It has no list-item density pattern, no disclosure
region pattern, and no device-row pattern. This redesign fills those gaps.

## Gate decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| Q1 | Advanced diagnostics moves to its own sub-route (`/#sync/diagnostics` or `Settings → Sync diagnostics`). Main Sync tab links to it with "View diagnostics →". | Users who never debug sync never see this surface. Biggest density win available. |
| Q2 | Per-device card becomes a single-line row + click-to-open detail drawer. Row = name + trust badge + online status + kebab. Drawer owns name edit, assignment, sharing scope, remove. | 8+ controls × N devices was the dominant visual weight. A row list scales cleanly to 10+ devices. Matches the memory feed's row-plus-detail idiom. |
| Q3 | Kill Team status > Overview card entirely. | Its data is already in the header chip ("Online") and the Needs attention section ("1 device issue to review"). Pure redundancy. |

## Non-goals

- No changes to other tabs in this pass.
- No changes to the sync wire protocol or data model.
- No new Radix primitives unless an existing one doesn't cover the need.
- No changes to the design token palette — the redesign uses what's already
  in `static/index.html` / `design_handoff_codemem_viewer/tokens/`.

## Skill sequence

Path B (orchestrator) adapted to this single-tab scope:

1. **layout-system** — define the top-level grid for the Sync tab post-Q1/Q3.
   Primary column vs. secondary actions vs. secondary links. Decide whether
   the device list is a full-width region or shares with "Add devices &
   teammates." Output: target DOM skeleton + breakpoint strategy.
2. **visual-hierarchy-refactoring** — once IA is set, apply size/weight/
   contrast so the device list reads first and actions read second.
   Output: type scale decisions for this tab, which sections get a section
   heading vs. a small-caps eyebrow vs. nothing.
3. **component-architecture** — extract:
   - `DeviceRow` (the single-line row)
   - `DeviceDetailDrawer` (expanded detail, slid in as a popover or
     inline-expand — pick one during this skill)
   - `ActionShelf` (Join another team / Invite / future: Pair device)
   - `DisclosureRegion` (the pattern for Advanced sharing scope and any
     future progressive-disclosure section)
   - `StatTile` (for the new sync-diagnostics sub-route)
   Output: component boundaries + prop shapes, written to
   `packages/ui/src/components/primitives/` following existing conventions.
4. **design-foundation** — formalize the patterns from step 3 into named
   tokens or recipes so future Sync-adjacent work follows them. Output:
   additions/updates to `design_handoff_codemem_viewer/reference/` covering
   device-row anatomy, disclosure-region anatomy, and action-shelf anatomy.
5. **loading-states** — unify the three inconsistent offline / degraded /
   needs-attention treatments currently in use (Needs attention row style,
   `.peer-card Offline` badge, `Degraded` stat card). Output: a single
   offline/degraded/attention visual vocabulary reused everywhere.

Each skill's findings land in its own section below, in this file, so the
doc grows with the redesign.

## PR plan

Anticipating ~4 PRs, stacked:

1. **ui(sync): move Advanced diagnostics to `/#sync/diagnostics`.** Largest
   single visual cut. Q1 + removal of Q3 card. Add the "View diagnostics"
   link from the main Sync tab.
2. **ui(sync): DeviceRow + DeviceDetailDrawer.** Q2 implementation. Keep
   backend contracts identical; this is a rendering-layer refactor.
3. **ui(sync): unify offline / degraded / attention treatment.** The
   loading-states pass.
4. **docs(design): device-row, disclosure-region, action-shelf patterns.**
   Update the handoff so future work inherits this redesign's vocabulary.

## Scope boundary with handoff

| Area | Handoff source of truth | Redesign adds |
|------|-------------------------|---------------|
| Color tokens | `colors_and_type.css` | — (reuse) |
| Type scale | Handoff Typography section | — (reuse, but may lean on existing 13/14/16/18 tiers more aggressively for hierarchy) |
| Spacing scale | `--sp-1..6` | — (reuse) |
| Feed item pattern | Handoff "Feed item" | — (out of scope) |
| List-item density | — | Device row pattern |
| Disclosure regions | — | DisclosureRegion primitive + anatomy |
| Action shelves | — | ActionShelf primitive + anatomy |
| Offline / degraded state vocabulary | — | Unified treatment |

## Skill outputs

_Sections below are filled as each skill runs. The plan gets amended in
place so the final doc is the design record._

### layout-system

#### Region inventory (post-Q1/Q2/Q3)

Starting from six peer regions, three gates collapse the surface to **three
persistent + two conditional** regions:

| Region | Source | Today | After |
|--------|--------|-------|-------|
| Header (title · presence · Sync now · View diagnostics) | (a) | top block, two lines | single toolbar, right-side actions |
| Needs attention | (b) | always-visible section | **conditional** (renders only when `attention_items.length > 0`) |
| Team switcher | (c) | plaintext `Team: nerdworld` in header copy | **conditional** dropdown above the device list, only when device is in ≥2 groups |
| People & devices + inline action shelf | (d)+(e) | two stacked regions ("Add devices & teammates" over "People & devices") | **one region.** Action shelf lives inside the list toolbar, not as a standalone card. |
| View diagnostics | (f) | — (new) | text link in the header, right-aligned |
| ~~Team status > Overview~~ | Q3 | separate block | removed |
| ~~Advanced diagnostics~~ | Q1 | in-tab | moved to `/#sync/diagnostics` |

Rationale for folding (e) into (d): "Join another team" and "Invite a
teammate" are list-level affordances for People & devices, not a separate
topic. Every other list UI in the app puts list actions in the list's own
toolbar (e.g. Feed's project selector + filters); the Sync tab was the
outlier. This is one of the two biggest density wins available.

#### Grid decisions

Viewer shell is `max-width: 1100px` centered. That's never wide enough
to support a true sidebar layout without starving the primary region.
The Sync tab stays single-column, with internal horizontal splits via
flex inside each section.

```
┌─ .sync-tab ───────────────────────── max-width: 1100px ──┐
│  .sync-header           [title · chip] ║ [sync · diag]   │
│  .sync-needs-attention  (conditional)                    │
│  .sync-team-switcher    (conditional)                    │
│  .sync-devices                                           │
│    .sync-devices-toolbar   [h2] ║ [join · invite]        │
│    .device-list                                          │
│      .device-row (× N)                                   │
└──────────────────────────────────────────────────────────┘
```

Inter-region gap: `var(--sp-6)` (24px). Section-internal gap:
`var(--sp-4)` (16px). Device row gap inside the list: `var(--sp-2)` (8px)
— rows carry their own border+padding, so they don't need much separation.

#### Breakpoint strategy

Only one breakpoint on this tab: **900px**, matching the viewer shell's
existing column-collapse point. Below 900px, horizontal toolbars wrap
to stacked; above, they sit side-by-side.

| Surface | ≥900px | <900px |
|---------|--------|--------|
| `.sync-header` | `grid-template-columns: 1fr auto` | single column stack |
| `.sync-header-actions` | inline flex, right-aligned | inline flex, wraps to new line |
| `.sync-devices-toolbar` | `grid-template-columns: 1fr auto` | single column stack |
| `.sync-devices-actions` | inline flex, right-aligned | inline flex, wraps; "Join another team" may hide behind a "More" affordance if two buttons overflow |
| `.device-row` | fixed single-line layout | **still single-line** — row density is the point; long names truncate with ellipsis |
| `.sync-team-switcher` | inline row | full-width select |

No container queries needed; the viewport breakpoint is sufficient given
the capped shell width.

#### Needs attention placement — stack above, not banner

Evaluated three options:

1. **Stack above primary region** (today's pattern, kept) — each attention
   item gets its own row with concise copy + action button.
2. Banner overlay at top of primary region.
3. Inline within the offending device row (e.g., offline badge on the row).

Kept option 1 because:
- Banners get dismissed/ignored more than they get acted on.
- Inline-only would orphan system-level issues (e.g., "coordinator
  unreachable") that don't belong to a specific device.
- The zero-attention case costs nothing: the section renders only when
  `attention_items.length > 0`, so a healthy sync shows no block at all.

To solve the double-display problem (currently "work is offline" appears
both in Needs attention AND as an "Offline" chip on the device card):
the attention row carries the canonical copy + action; the device row
shows only a compact attention pip (•) that visually ties to the item
above. Details for that unification belong in the **loading-states** pass.

#### View diagnostics placement — header text link

`View diagnostics →` lives in the page header's right side, next to the
`Sync now` button but styled as a text link, not a button. Rationale:

- Diagnostics is a navigation affordance (go to a different surface), not
  a CRUD action — shouldn't visually peer with `Sync now` or the Join /
  Invite buttons.
- Header-right is the conventional slot for "related surface" links in
  existing apps users know (GitHub repo "Insights", Stripe dashboard
  "Logs", etc.).
- Keeping it near `Sync now` means troubleshooting flow is one glance
  away without it competing for primary attention.

#### Team switcher placement

V1: single team → static text in the header (`Team sync · nerdworld`).
V2 (when device is in ≥2 groups): the team name becomes a `<select>`
dropdown. Future-V3 (≥4 groups): promote to a tab bar or a dedicated
`Teams` sub-surface.

Important: **do not** introduce tabs INSIDE the Sync tab yet. The viewer
already uses top-level tabs for Feed / Sync / Settings; nesting tabs
inside Sync is confusing.

#### Target DOM skeleton

```html
<section class="sync-tab" id="tab-sync">
  <header class="sync-header">
    <div class="sync-header-title">
      <h1>Team sync</h1>
      <span class="sync-presence-chip" data-state="online">Online</span>
      <!-- when multi-team: -->
      <!-- <select class="sync-team-switcher-inline">…</select> -->
    </div>
    <div class="sync-header-actions">
      <button class="sync-now-btn" type="button">Sync now</button>
      <a class="sync-diagnostics-link" href="#sync/diagnostics">
        View diagnostics →
      </a>
    </div>
  </header>

  <!-- conditional: only when attention_items.length > 0 -->
  <section class="sync-needs-attention"
           aria-labelledby="sync-needs-attention-h">
    <h2 id="sync-needs-attention-h" class="sync-eyebrow">Needs attention</h2>
    <ul class="attention-list">
      <li class="attention-row">…</li>
    </ul>
  </section>

  <section class="sync-devices" aria-labelledby="sync-devices-h">
    <div class="sync-devices-toolbar">
      <h2 id="sync-devices-h">People &amp; devices</h2>
      <div class="sync-devices-actions">
        <button type="button">Join another team</button>
        <button type="button" class="sync-btn-primary">Invite a teammate</button>
      </div>
    </div>
    <ul class="device-list">
      <li class="device-row" data-device-id="…">
        <!-- full detail opens in a drawer on click — see
             component-architecture output -->
      </li>
    </ul>
  </section>
</section>
```

Total DOM regions: 3 persistent, 1 conditional, versus the previous 6
peer regions + 1 embedded in Team sync card header.

#### Accessibility checks done in this pass

- Each section uses `<section aria-labelledby>` pointing at its `h2` so
  landmark navigation announces the purpose.
- The `<a>` to `/#sync/diagnostics` is a link, not a button — the hash
  actually changes the route, so semantics match behavior.
- Attention items use `<ul>` / `<li>` so screen readers announce count.
- Device rows will be `<li>` with an interactive child (button or
  `role="button"` on the row) — **do not** put `role="button"` on the
  `<li>` itself because it breaks list semantics. Decision for the
  DeviceRow primitive: the row contains a `<button class="device-row-open">`
  that spans the row's clickable surface, with actions (kebab) inside a
  separate `<div>` not nested in the expand button. Detail in
  component-architecture.
- Touch targets: 44×44px minimum applies to the row-open button, kebab,
  and all header actions. Row height target: 56px (comfortable + hits
  the 44px minimum).

#### Hand-offs to the next skills

- **visual-hierarchy-refactoring** — decide the type scale for `h1`
  (Team sync), `h2` (Needs attention, People & devices), the eyebrow,
  and the row-internal name/meta. The current file uses 18px `h3` for
  the tab title; bump to 20-22px for `h1` so it outweighs the section
  `h2`s at 16-18px.
- **component-architecture** — DeviceRow + DeviceDetailDrawer anatomy,
  kebab menu contents, row-click vs. kebab-click hit targets.
- **design-foundation** — formalize `sync-eyebrow`, `sync-header`,
  `sync-devices-toolbar` as named layout recipes in the handoff.
- **loading-states** — unified attention pip on the device row, coupling
  it visually to its owning Needs attention row without duplicating copy.

### visual-hierarchy-refactoring

#### Voice calibration

The skill's "start with too much space, aim for 1.5–2× size ratio between
tiers" guidance is tuned for marketing surfaces. The handoff explicitly
describes the viewer as *"sizes are small and dense — 14px body, 16–18px
headings"* because the product voice is **"plain, declarative, slightly
dry"** and the user is a developer comfortable with IDE-density UIs.

This pass leans on **weight + color combinations** to establish hierarchy
within the tighter size range that the voice allows, rather than blowing
the scale up. Sizes climb 1.14–1.25× per step (Minor Third-ish), weights
and colors do the remaining hierarchy work.

#### Type scale (Sync tab)

| Tier | Size | Weight | Color | Treatment | Usage |
|------|------|--------|-------|-----------|-------|
| T0 | 20px | 700 | `--text-primary` | line-height 1.2 | `<h1>` "Team sync" |
| T1 | 16px | 600 | `--text-primary` | line-height 1.3 | `<h2>` "People & devices" (section prominent) |
| T2 | 11px | 600 | `--text-tertiary` | uppercase, tracking 0.06em | `<h2 class="sync-eyebrow">` "Needs attention" |
| T3 | 14px | 600 | `--text-primary` | line-height 1.4 | Device row primary name; attention row title |
| T4 | 13px | 400 | `--text-secondary` | line-height 1.5 | Attention row body copy, helper text |
| T5 | 12px | 400 | `--text-tertiary` | `font-feature-settings: 'tnum' 1` | Timestamps, inline meta, row sync/ping times |
| T6 | 11px | 500 | chip-specific | caps off, tracking 0 | Chip/pill labels (trust, presence, state) |

Adjacent-tier ratios: T0→T1 = 1.25, T1→T3 = 1.14, T3→T4 = 1.08, T4→T5 =
1.08, T5→T6 = 1.09. The tight ratios are compensated for by making sure
**adjacent tiers in the DOM always differ on at least two axes** (size +
weight, or size + color, or weight + case). No two tiers are
distinguished by size alone.

#### Weight vs. color emphasis — per-region decisions

Principle from the skill: *establish hierarchy first through size + weight
+ contrast; reserve color for interactive elements and semantic status.*

| Element | Hierarchy signal | Color role |
|---------|------------------|------------|
| Page title `Team sync` | size (T0) + weight (700) | — (neutral primary text) |
| `Sync now` button | weight 600 + accent border | accent **only** on border, not filled — ghost primary |
| `View diagnostics →` link | size (T4) + underline on hover | accent **only** on hover + focus; resting state inherits `--text-secondary` |
| `Needs attention` h2 | case + tracking (T2 eyebrow) | `--text-tertiary` — intentionally de-emphasized header because the **rows** carry the signal, not the section |
| Attention row title (T3) | weight 600 | — (primary text) |
| Attention row body (T4) | regular weight | `--text-secondary` |
| Attention row pip | — | accent-warm filled circle, 8px — the **only** color cue that says "act" |
| Attention row button | weight 500 | accent border, no fill — ghost primary |
| `People & devices` h2 | size (T1) + weight (600) | `--text-primary` — this is the page's primary visual anchor, it gets the strongest heading |
| `Join another team` | weight 500 + neutral border | — (secondary ghost) |
| `Invite a teammate` | weight 600 + accent-filled background | **the only filled accent button on the page** |
| Device row name | size (T3) + weight (600) | `--text-primary` |
| Device row trust chip | — (chip tone carries it) | accent-subtle background, T6 text; color conveys state (green = two-way, warm = one-way, warm-deep = not-trusted) |
| Device row presence pip | — | 6px dot: accent (online), accent-warm (offline), accent-deep (attention) |
| Device row meta (last sync) | size (T5) + color (tertiary) | — |
| Device row kebab | — | `--text-tertiary` icon, hover to `--text-primary` |

Rule: **any given line-of-sight contains at most one filled-accent element.**
If the eye lands on "Invite a teammate" (filled accent button), that's the
strongest pull in the People & devices region. The Sync now button (ghost)
reads quieter because its border-only treatment signals "available
utility" rather than "do this now." The attention pip is small enough
(8px) that it doesn't out-shout buttons even though it shares the
accent-warm tone.

#### Device-row internal hierarchy

Left-to-right layout, ~56px row height, single-line:

```
┌───────────────────────────────────────────────────────────────────┐
│ ●  Work                                   Two-way trust   ⋮  │  ← T3 name, T6 chip, kebab
│    Offline · last sync 4/14 2:29 PM                               │  ← T5 meta line, muted
└───────────────────────────────────────────────────────────────────┘
```

- **Primary read** (T3 name at 14px/600/primary) anchors the left. The
  8px presence pip sits in the gutter to its left, on-axis with the name.
- **Secondary read** (T6 trust chip at 11px/500/tinted-bg) floats right,
  balanced by the ⋮ kebab far right. Chip reads as status, not action.
- **Tertiary read** (T5 meta at 12px/400/tertiary) sits on the second
  line below the name, indented in-line with the name start. Meta is
  *present but not demanding* — per the skill, tertiary info uses low
  contrast and regular weight so it stays scannable but quiet.

On devices that don't need the meta line (two-way trust, online, recent
sync), the row **collapses to single-line** (no second line rendered).
This is a quiet win: healthy rows compress, degraded rows reveal detail
organically.

#### Needs-attention visual vocabulary (preview for loading-states)

Attention rows use a shared visual language with degraded device rows:

- Attention-warm pip (●, accent-warm, 8px) on the far left of both
  attention rows AND the device row owning the issue. Same color, same
  size, same pulse timing. Gestalt similarity: eye links them without
  extra copy.
- Action button on the attention row (e.g., "Open device") uses the
  **ghost primary** treatment (accent border, no fill) to differ from
  the "Invite a teammate" filled-primary below. Two primaries in different
  contexts don't fight because their **fill state** differentiates them.

loading-states pass will formalize this: today the codebase has three
inconsistent treatments for "offline/degraded/attention," which must
collapse to one vocabulary with three color stops.

#### Whitespace decisions (calibrated to voice)

Starting from the skill's "be generous" principle, then pulled tighter
where dense-voice wins:

| Gap | Token | Why |
|-----|-------|-----|
| Between top-level regions (header → needs attention → devices) | `var(--sp-6)` (24px) | Signals region separation without shouting; half of the skill's default but twice what the current Sync tab uses between `peer-card`s. |
| Within a region (section h2 → first content) | `var(--sp-3)` (12px) | Tight enough to group, loose enough to breathe. |
| Between device rows | `var(--sp-2)` (8px) | Each row is its own bordered card, so the gap only needs to separate — not to create rhythm. |
| Row internal padding | `var(--sp-3)` (12px) vertical, `var(--sp-4)` (16px) horizontal | Compact density; still hits 44×44 touch target via 56px row height. |
| Header h1 line-height | 1.2 | Tighter impact on the page title. |
| Body line-height | 1.5 | Standard readability for dense copy. |
| Section-heading margin-bottom | `var(--sp-2)` (8px) | Heading hugs its content tightly (proximity). |

Global gap between sections (`--sp-6` = 24px) instead of the previous
`--sp-2` (8px) between `.peer-card`s is the single biggest density win
of this pass — three-regions × 24px creates two 24px breathing seams
that make the page *scannable* instead of *readable-only*.

#### Pills / chips reuse

Per the handoff, chips/pills use `--radius-pill` with accent-subtle
backgrounds. No new chip styles needed for this redesign. Trust states
map to existing accent families:

| Trust state | Background | Text | Border |
|-------------|------------|------|--------|
| Two-way trust | accent-subtle (evergreen/mint 12%) | accent-strong | transparent |
| You trust them | accent-cool-subtle (ink-blue 12%) | accent-cool-strong | transparent |
| They trust you | accent-cool-subtle (ink-blue 12%) | accent-cool-strong | transparent |
| Not trusted | accent-warm-subtle (copper/peach 14%) | accent-warm-strong | transparent |

These map to `codemem-agent-policy-file` memory's four status labels.

#### Gestalt principles applied

- **Proximity** — section h2 margin-bottom = `--sp-2` (tight to its
  content), between sections = `--sp-6` (loose). Eye parses regions.
- **Similarity** — attention pip and device-row pip share size/color/
  pulse so the eye pairs them; all chips share pill radius + subtle-bg
  treatment so the eye groups them as "status indicators."
- **Common region** — each device row has its own bordered card. The
  attention section has its own bordered container. Regions are
  **enclosed**, reinforcing the IA.
- **Figure / ground** — the page background is `--surface-0` (warm paper
  or warm charcoal). Rows + cards use `--surface-1` with a 1px border —
  a subtle lift, not a dramatic elevation. Matches handoff principle:
  *"cards are bordered first, shadowed second."*
- **Closure** — the presence pip is a 6–8px dot, not a full status pill;
  the brain completes "this device has a status" from the dot alone
  without the extra label. Frees horizontal space for the name.

#### Hand-offs to the next skills

- **component-architecture** needs:
  - DeviceRow composition: 2-line variant (with meta) vs. 1-line variant
    (when meta is absent), pip + name + chip + kebab arrangement, and
    the kebab-vs-row-open hit-target split called out in layout-system.
  - AttentionRow composition: pip + title (T3) + body (T4) + action
    (ghost primary button).
  - Button primitives: confirm we have `primary-filled`, `primary-ghost`,
    `secondary-ghost`, and text-link variants wired in the existing
    button system. If not, extend.
- **design-foundation** should capture the T0–T6 scale as named tokens
  (e.g. `--type-tier-page-title`, `--type-tier-row-name`) so future
  surfaces inherit this without re-deriving sizes from ratios.
- **loading-states** pass owns the unified attention-pip treatment plus
  the three-stop color stops across online/offline/degraded/attention.

### component-architecture

#### Component inventory

Atomic-design tier per component, plus whether it's Sync-tab-specific or a
shared primitive:

| Tier | Component | Shared? | File path |
|------|-----------|---------|-----------|
| Atom | PresencePip | shared primitive | `packages/ui/src/components/primitives/presence-pip.tsx` |
| Molecule | TrustChip | shared primitive (wraps Chip) | `packages/ui/src/components/primitives/trust-chip.tsx` |
| Molecule | ActionShelf | shared primitive | `packages/ui/src/components/primitives/action-shelf.tsx` |
| Molecule | AttentionRow | Sync-specific | `packages/ui/src/tabs/sync/components/attention-row.tsx` |
| Organism | DeviceRow | Sync-specific | `packages/ui/src/tabs/sync/components/device-row.tsx` |
| Organism | DeviceDetailDrawer | Sync-specific | `packages/ui/src/tabs/sync/components/device-detail-drawer.tsx` |
| Sub-molecule (drawer internals) | DeviceNameField | Sync-specific | `packages/ui/src/tabs/sync/components/device-detail/device-name-field.tsx` |
| Sub-molecule | DeviceAssignmentField | Sync-specific | `…/device-detail/device-assignment-field.tsx` |
| Sub-molecule | DeviceScopeField | Sync-specific (reuses ChipInput) | `…/device-detail/device-scope-field.tsx` |
| Sub-molecule | DeviceSyncAction | Sync-specific | `…/device-detail/device-sync-action.tsx` |
| Sub-molecule | DeviceRemoveButton | Sync-specific | `…/device-detail/device-remove-button.tsx` |

Existing primitives reused without change: Chip (for the trust chip tone
mapping), ChipInput (the scope include/exclude inputs), TextInput (name
edit), RadixSwitch (advanced toggles in drawer, if any).

#### Key decision — DeviceDetailDrawer presentation: inline expand

Three options evaluated:

| Option | Pros | Cons |
|--------|------|------|
| **Inline expand** (row expands downward, pushing siblings) | Preserves list context. Matches the Feed tab's existing row→detail pattern. No portal/positioning fragility. Scales to ~10 devices comfortably. | Long device lists with multiple expansions would be unwieldy — solved by the "only one expanded at a time" guard. |
| Popover | Keeps list position fixed. | Cramped for a multi-field form. Positioning fragile next to a kebab menu. Clicking away dismisses context. |
| Modal | Clean separation. | Breaks list context entirely. Overkill for a per-row action. |

**Chosen: inline expand**, with a `expandedDeviceId: string | null`
module-level state (matches the existing `teamInvitePanelOpen` pattern).
Only one row is expanded at a time; opening a different row collapses the
previous one. The row is the `<li>`; the drawer is a sibling `<div
role="region">` inside the same `<li>` rendered conditionally.

No separate kebab menu needed for v1: every device-specific action lives
inside the drawer. The row itself is one big button with `aria-expanded`.

#### Prop shapes

**PresencePip** (atom):

```ts
export type PresenceState = "online" | "offline" | "degraded" | "attention";

export interface PresencePipProps {
  state: PresenceState;
  size?: 6 | 8;            // px; default 8
  pulse?: boolean;          // default true for "attention", else false
  "aria-label"?: string;    // default derives from state
}
```

Single responsibility: render a small dot with a semantic color. Used by
DeviceRow, AttentionRow, and the future Sync-diagnostics sub-route.

**TrustChip** (molecule wrapping Chip):

```ts
import type { Chip as BaseChip } from "./chip";

export type TrustState =
  | "two-way"           // full trust established
  | "you-trust-them"    // you've accepted, they haven't
  | "they-trust-you"    // they've accepted, you haven't
  | "not-trusted";      // neither side has accepted

export interface TrustChipProps {
  state: TrustState;
  compact?: boolean;    // use short label e.g. "Mutual" vs "Two-way trust"
}
```

Composition: renders `<Chip variant="scope" tone={mapToneFor(state)}>`
with the label string derived from the state. Tone mapping:
`two-way → "ok"`, `you-trust-them | they-trust-you → "pending"`,
`not-trusted → "warn"`.

**ActionShelf** (molecule):

```ts
export interface ActionShelfAction {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  "aria-label"?: string;
}

export interface ActionShelfProps {
  primary?: ActionShelfAction;          // at most one filled-primary button
  secondary?: ActionShelfAction[];      // 0..N ghost buttons
  align?: "start" | "end";              // default "end" for toolbars
}
```

Renders a flex row. Buttons inherit the T3 body copy and 600-weight label
treatment from visual-hierarchy. The toolbar placement in a devices
toolbar uses `align: "end"`, while the attention-row inline action uses
its own inline layout (not ActionShelf).

**AttentionRow** (molecule):

```ts
export interface AttentionRowAction {
  label: string;
  onClick: () => void | Promise<void>;
  busy?: boolean;
}

export interface AttentionRowProps {
  kind: "attention" | "degraded";       // color stop for the pip
  title: string;                        // T3
  body?: string;                        // T4
  action?: AttentionRowAction;          // ghost primary button
  deviceId?: string;                    // if set, clicking the row scrolls its device row into view and highlights it
}
```

Composition: `PresencePip (state=kind, pulse=true)` + title + body +
inline action button. No ActionShelf — the action is structurally part
of the row, not a separate shelf.

**DeviceRow** (organism):

```ts
export interface DeviceRowProps {
  deviceId: string;
  name: string;
  trust: TrustState;
  presence: PresenceState;              // "attention" overrides to warn tone
  lastSyncAt?: string;                  // ISO; formats to T5 meta
  lastError?: string;                   // if set, replaces sync time with error summary
  expanded: boolean;
  onToggleExpanded: () => void;
  renderDrawer: () => VNode;            // lazy — drawer only mounts when expanded
}
```

The row owns only its *interaction* (expand/collapse). It does NOT own the
drawer's state or submit logic — `renderDrawer` is a function the parent
passes that returns the drawer VNode. This keeps DeviceRow's
responsibility narrow: "show a device summary and toggle." The parent
renders <DeviceDetailDrawer /> with the right props and passes `() =>
<DeviceDetailDrawer {...} />` as `renderDrawer`.

Accessibility:
- The clickable surface is a `<button>` wrapping name + chip + meta
- `aria-expanded={expanded}`, `aria-controls={drawerId}`
- On expand, focus moves to first interactive element in drawer; on
  collapse, focus returns to the row button (managed inside DeviceRow
  with a ref passed through `renderDrawer` context)

**DeviceDetailDrawer** (organism, composes sub-molecules):

```ts
export interface DeviceDetailDrawerProps {
  deviceId: string;
  name: string;
  onSaveName: (next: string) => Promise<void>;

  assignment: {
    selectedActorId: string | null;
    options: Array<{ actorId: string; label: string }>;
    onChange: (actorId: string | null) => Promise<void>;
  };

  scope: {
    include: string[];
    exclude: string[];
    onChange: (next: { include: string[]; exclude: string[] }) => Promise<void>;
    inheritsGlobal: boolean;            // when true, shows "inherits global defaults" helper
  };

  addresses: string[];
  addressesAreRedacted?: boolean;

  onSyncNow: () => Promise<void>;
  onRemove: () => Promise<void>;

  lastSyncAt?: string;
  lastError?: string;
}
```

Renders stacked sub-molecules with `--sp-4` gaps:

1. DeviceNameField (name + inline save)
2. DeviceAssignmentField (select + save, or "You" static if `selectedActorId === local`)
3. DeviceSyncAction (Sync now button + last attempt summary)
4. DeviceScopeField (ChipInput × 2 + inherits-global helper)
5. DeviceRemoveButton (danger-tone button with confirmation dialog)

Each sub-molecule is independently testable and can evolve without
touching the drawer orchestrator.

**Sub-molecule sketches:**

```ts
// DeviceNameField
interface DeviceNameFieldProps {
  value: string;
  onSave: (next: string) => Promise<void>;
}
// Renders TextInput + "Save name" ghost button; disables save when value === original.

// DeviceAssignmentField
interface DeviceAssignmentFieldProps {
  selectedActorId: string | null;
  options: Array<{ actorId: string; label: string }>;
  onChange: (actorId: string | null) => Promise<void>;
}
// Renders native <select> + save button; shows "This device belongs to you" helper when current user is selected.

// DeviceScopeField
interface DeviceScopeFieldProps {
  include: string[];
  exclude: string[];
  inheritsGlobal: boolean;
  onChange: (next: { include: string[]; exclude: string[] }) => Promise<void>;
}
// Renders two ChipInputs (reusing the existing primitive). "Inherits
// global defaults" helper text when both are empty AND inheritsGlobal.

// DeviceSyncAction
interface DeviceSyncActionProps {
  onSyncNow: () => Promise<void>;
  lastSyncAt?: string;
  lastError?: string;
}
// Ghost-primary "Sync now" button + T5 meta line below summarizing last
// attempt. Color on the meta line follows loading-states vocabulary.

// DeviceRemoveButton
interface DeviceRemoveButtonProps {
  deviceName: string;
  onRemove: () => Promise<void>;
}
// Danger-tone ghost button. On click, opens openSyncConfirmDialog with
// deviceName interpolated; only calls onRemove when confirmed.
```

#### Composition graph

```
TeamSyncPanel (Sync tab)
├── SyncHeader              (h1 + presence-chip + Sync now + View diagnostics)
├── NeedsAttentionSection   (conditional)
│   └── AttentionRow × N
│       ├── PresencePip
│       └── inline action button
├── TeamSwitcher            (conditional — multi-team future)
└── DevicesSection
    ├── SyncEyebrow         (T1 h2 "People & devices")
    ├── ActionShelf         (primary: Invite; secondary: [Join])
    └── <ul class="device-list">
        └── <li> DeviceRow × N
            ├── PresencePip
            ├── TrustChip
            └── (expanded) DeviceDetailDrawer
                ├── DeviceNameField       (uses TextInput)
                ├── DeviceAssignmentField (native <select>)
                ├── DeviceSyncAction
                ├── DeviceScopeField      (uses ChipInput × 2)
                └── DeviceRemoveButton    (uses openSyncConfirmDialog)
```

#### Migration strategy (imperative → Preact)

The current Sync tab renders via `render-team-sync.ts` using a mix of
imperative `el()` helpers and portal-hoisted existing DOM elements. The
new components are all Preact.

Strategy: introduce the new components **alongside** the existing render
path, not as a big-bang rewrite. In the first PR (move diagnostics +
kill overview):

- Leave the existing device-card render as-is temporarily.
- Introduce the header + diagnostics-link changes with small Preact
  components inserted into the existing mount points.

In the second PR (DeviceRow + Drawer), the device-list render path
switches to Preact; imperative `el()` calls for devices are deleted.
This bounds the rewrite to one file + one PR per migrated surface.

#### Hand-offs to the next skills

- **design-foundation** should formalize PresencePip, TrustChip, and
  ActionShelf in the handoff's `reference/` directory with anatomy
  diagrams and token usage, since these are new **shared** primitives
  that other tabs will need.
- **loading-states** owns the PresencePip state→color mapping, the pulse
  timing, and the coupling between an attention row and its device row
  (same color, same size, same pulse).

### design-foundation

#### Token strategy: extend, do not mutate

Three layers from the skill apply here:

| Layer | Meaning | Redesign action |
|-------|---------|-----------------|
| L1 Global | raw values (colors, sp-*, radii, shadows) | **freeze** — existing values used across every tab |
| L2 Semantic | meaning on top of raw (text-primary, accent) | **freeze** existing; **add** type-tier + pip-size + row-geometry primitives |
| L3 Component | component-specific (button, card) | **add** new component tokens only when the value is reused across ≥2 components |

Rule of thumb for "does this deserve a token": used in 2+ places AND
crosses component boundaries AND is semantic (conveys meaning, not
just a raw value).

#### Do NOT change

Existing L1/L2 tokens that must remain stable because other tabs depend
on them:

- `--sp-1` through `--sp-6` (4/8/12/16/20/24 px)
- `--surface-0`, `--surface-1`, `--surface-2`
- `--text-primary`, `--text-secondary`, `--text-tertiary`
- `--accent`, `--accent-warm`, `--accent-cool`, and their `-subtle` /
  `-strong` variants
- `--border`, `--border-hover`
- `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-pill`

Every token below is **new**. None override existing values.

#### New semantic tokens (L2)

**Type tiers** — one token per size/weight/line-height trio is verbose;
prefer utility classes that bundle the whole tier. Tokens are added only
where a primitive needs to compose the size without the full class.

```css
/* Utility classes: canonical type-tier treatments */
.type-tier-page-title    { font-size: 20px; font-weight: 700; line-height: 1.2; color: var(--text-primary); }
.type-tier-section-title { font-size: 16px; font-weight: 600; line-height: 1.3; color: var(--text-primary); }
.type-tier-eyebrow       { font-size: 11px; font-weight: 600; line-height: 1.3; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; }
.type-tier-row-name      { font-size: 14px; font-weight: 600; line-height: 1.4; color: var(--text-primary); }
.type-tier-body          { font-size: 13px; font-weight: 400; line-height: 1.5; color: var(--text-secondary); }
.type-tier-meta          { font-size: 12px; font-weight: 400; line-height: 1.4; color: var(--text-tertiary); font-feature-settings: 'tnum' 1; }
.type-tier-chip          { font-size: 11px; font-weight: 500; line-height: 1.3; letter-spacing: 0; }

/* Raw tokens: exposed only for primitives that need to compose sizes */
--type-size-row-name: 14px;
--type-size-meta: 12px;
--type-size-chip: 11px;
```

The utility classes ARE the semantic tier token — no `--type-tier-*-size/
weight/line-height` custom-property triples. This is a deliberate
departure from the skill's token-per-property guidance, because the
viewer's tightness means tier values rarely get composed individually;
components either adopt the whole tier or override one value with an
inline rule.

**Pip sizes** — shared across PresencePip, attention rows, and (future)
notification surfaces:

```css
--pip-size-sm: 6px;   /* in-row status: compact, no label needed */
--pip-size-md: 8px;   /* attention anchor: paired with copy */
```

**Row geometry**:

```css
--row-min-height: 56px;                   /* hits 44px touch target with 12px/12px padding */
--row-padding-y: var(--sp-3);             /* 12px */
--row-padding-x: var(--sp-4);             /* 16px */
--row-gap: var(--sp-2);                   /* 8px — between rows in a list */
```

#### Inline values, NOT tokens

Everything below stays at the call site because it doesn't cross
component boundaries:

- Specific line-heights per tier (already folded into the utility classes)
- Uppercase + tracking 0.06em (folded into `.type-tier-eyebrow`)
- Chip tone mappings (TrustChip's internal state→tone logic)
- Drawer expansion animation timing (owned by interaction-physics if we
  ever do that pass; for v1 use a literal 140ms)
- Button primary-filled vs. primary-ghost vs. secondary-ghost
  distinctions — these belong in the button system's variant vocabulary,
  not in design tokens

#### "Semantic gap aliases" — declined

Considered adding `--gap-region: var(--sp-6)` / `--gap-section:
var(--sp-3)` / `--gap-row: var(--sp-2)` to express intent at call sites.
**Declined** for v1 because:

- The sp-* scale is small (6 tiers); reaching for the wrong one is rare.
- The aliases add a layer of indirection without adding information
  that isn't already in the nearby selector name (e.g. `.sync-tab {
  gap: var(--sp-6); }` is clear without the alias).
- Easy to add later if dogfood surfaces consistent mistakes.

#### Handoff additions (reference/ pages to write)

Four new pages in `design_handoff_codemem_viewer/reference/` that document
the patterns introduced by this redesign. Each is spec-only here; the
actual handoff pages get written when the implementation lands.

**`device-row-anatomy.html`** — the list-item density pattern
- Purpose: how to render a per-entity row in a list, with an optional
  inline-expand detail drawer.
- Contents:
  - Annotated DOM diagram: pip gutter · name+chip · meta line · kebab
    slot (kebab optional for v2)
  - Row states table: default / hover / expanded / attention
  - Compact row height = `--row-min-height` (56px), padding breakdown
  - Single-line vs. two-line variant (meta line only when degraded)
  - Drawer expansion rules: only-one-at-a-time, focus management,
    aria-expanded wiring
  - Links: PresencePip, TrustChip, ChipInput (for sub-fields)
- Audience: anyone building a similar row-based list on a future tab
  (e.g. Memory feed today uses a slightly different pattern — this
  page gives a target convergence point)

**`action-shelf-anatomy.html`** — the toolbar pattern
- Purpose: how to place 1-N actions at the top of a list or region.
- Contents:
  - Annotated layout: title left + actions right on ≥900px, stacked
    on <900px
  - Button prominence rules: "at most one filled-primary per line of
    sight"; primary-ghost, secondary-ghost, text-link hierarchy
  - When an ActionShelf wraps → overflow strategy (wrap vs. collapse
    to "More" popover, which is a v2 consideration)
  - Examples from Sync tab (Invite + Join) and where else this pattern
    applies (Feed tab's filter bar is a close sibling — may converge
    in a later pass)
- Audience: anyone introducing toolbar controls to a list.

**`attention-vocabulary-anatomy.html`** — the offline/degraded/attention
visual language
- Purpose: ensure any surface showing "something is wrong / needs
  review" speaks the same visual language.
- Contents:
  - The three color stops: online (accent), degraded (accent-warm),
    attention (accent-warm + pulse)
  - Pip sizes (6px and 8px) and when to use each
  - Pulse timing (specified in loading-states pass)
  - Gestalt pairing: an attention row and the device row it refers to
    share pip size + color + pulse so the eye links them
  - Anti-patterns: don't color row background; don't invent new
    degraded-state colors; don't use red (save for destructive
    confirmation, not status)
- Audience: anyone surfacing health/state information anywhere in the
  viewer.

**`disclosure-region-anatomy.html`** — the inline-expand pattern
- Purpose: how to reveal detail for a row or a section without
  navigating away or opening a modal.
- Contents:
  - Inline expand mechanics: row → drawer inside the same list item
  - Only-one-open guard: how to enforce across rows
  - aria-expanded / aria-controls wiring
  - Focus management on expand/collapse
  - When to use inline-expand vs. popover vs. modal (decision table)
  - Examples: DeviceDetailDrawer; Coordinator Admin scope-defaults
    drawer (the existing scope-defaults editor is a smaller version
    of this pattern — eventually should converge)
- Audience: anyone adding progressive disclosure anywhere in the
  viewer.

#### Governance for new primitives

PresencePip + TrustChip + ActionShelf live in
`packages/ui/src/components/primitives/` because they're generically
useful. Rule going forward: a primitive lands there only if either
(a) it's used on ≥2 tabs, or (b) it's imported from the handoff's
documented pattern pages.

Sync-specific organisms (DeviceRow, DeviceDetailDrawer, AttentionRow)
live in `packages/ui/src/tabs/sync/components/` because they encode
Sync-specific behavior (trust model, sync timestamps, coordinator
routing). Moving one to `primitives/` requires rewriting the handoff
anatomy page to generalize it first.

#### Hand-offs to the next skill

- **loading-states** owns the attention-vocabulary-anatomy page's
  color-stop + pulse-timing details. Also owns the pip state→color
  mapping for PresencePip (this is a design decision, not a token
  decision, and belongs with loading-states since it's how we
  communicate "waiting for something" or "something went wrong").

### loading-states

#### PresencePip state matrix

Six states, three color families, one behavior axis (static vs. pulse).
Pulse carries the "something is happening or needs action" signal;
static states are passive facts.

| State       | Color source          | Pulse? | When shown | Meta line copy |
|-------------|-----------------------|--------|------------|----------------|
| `online`    | `--accent`            | no     | Peer reachable, recent ping | — (hidden) |
| `syncing`   | `--accent`            | **yes** (1.2s) | This peer is being contacted right now | "Syncing now…" |
| `offline`   | `--accent-warm`       | no     | Peer unreachable, informational | "Offline · last seen {timestamp}" |
| `degraded`  | `--accent-warm`       | no     | Sync returned errors or cursor is falling behind, but user action not required | "Partial sync · {short error}" |
| `attention` | `--accent-warm-strong`| **yes** (2.4s) | User must act (trust request, re-pair, unauthorized, etc.) | Title of the linked Attention row |
| `unknown`   | `--text-tertiary`     | no     | Never synced, or state not yet loaded | "Not yet synced" or "Status unknown" |

Rationale for offline + degraded sharing one color: both are "not
healthy, not urgent." They differ only in *why*, which the meta line
conveys. The pulse, not the hue, distinguishes "act on this" from
"know this."

Accessibility:
- Every pip carries an `aria-label` derived from state (e.g., "Online",
  "Sync in progress", "Action required").
- The pulse animation is decorative; the label carries the semantic.

#### Pulse timing + easing

Two cadences, both symmetric ease-in-out opacity breathe:

```css
/* Attention — slow, non-distracting, matches the handoff's 2.4s
   existing convention for attention dots */
@keyframes pip-attention {
  0%, 100% { opacity: 0.60; transform: scale(1); }
  50%      { opacity: 1.00; transform: scale(1.15); }
}
.presence-pip--attention {
  animation: pip-attention 2.4s ease-in-out infinite;
}

/* Syncing — faster so it reads as "active right now" vs.
   "waiting for you". No scale change; syncing is expected activity,
   not an alert. */
@keyframes pip-syncing {
  0%, 100% { opacity: 0.55; }
  50%      { opacity: 1.00; }
}
.presence-pip--syncing {
  animation: pip-syncing 1.2s ease-in-out infinite;
}

@media (prefers-reduced-motion: reduce) {
  .presence-pip--attention,
  .presence-pip--syncing {
    animation: none;
    opacity: 1.0;
    transform: none;
  }
}
```

Attention and syncing pips exist in different contexts (rarely on the
same row simultaneously) so cadence conflict isn't a real concern.
If they do overlap during a sync that reveals a new attention state,
the resolved state replaces the syncing state at 140ms fade (see below).

#### DeviceRow meta-line show/hide rules

Row stays single-line unless the user needs to see something beyond
the name. Meta shows when ANY of:

- `presence !== "online"` (offline, degraded, attention, syncing, unknown)
- `lastError` is non-empty
- `lastSyncAt` is null (never synced)

For an `online` device with no error and a recent sync, the row renders
as a single 56px line — healthy devices compress.

The meta line itself uses the `.type-tier-meta` utility (12px,
tertiary color, tnum features on). Content truncates with ellipsis
after ~80 chars horizontally; the full string is available in the
expanded drawer.

#### Skeleton states

Only the device list gets a skeleton. Everything else either loads
instantly (<100ms) or conditionally renders (needs-attention section
doesn't take space when empty).

**Device list skeleton** — 3 rows shaped like a DeviceRow:

```
[ ○ ]  [████████████████  ]  [ ████████████ ]
       [██████      ]
```

```css
.device-row-skeleton {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--row-padding-y) var(--row-padding-x);
  min-height: var(--row-min-height);
}
.device-row-skeleton .skel-pip    { width: var(--pip-size-md); height: var(--pip-size-md); border-radius: 50%; }
.device-row-skeleton .skel-name   { flex: 1; max-width: 180px; height: 14px; border-radius: var(--radius-sm); }
.device-row-skeleton .skel-chip   { width: 80px; height: 18px; border-radius: var(--radius-pill); }

/* Shimmer (motion-aware) */
.skel-pip, .skel-name, .skel-chip {
  background: linear-gradient(90deg,
    color-mix(in srgb, var(--surface-2) 82%, var(--surface-1)) 25%,
    color-mix(in srgb, var(--surface-2) 60%, var(--surface-1)) 50%,
    color-mix(in srgb, var(--surface-2) 82%, var(--surface-1)) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s ease-in-out infinite;
}
@keyframes shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .skel-pip, .skel-name, .skel-chip { animation: none; }
}
```

Skeleton dismisses as soon as `syncView.devices.length !== undefined`
(even if the list is empty — in that case, render the empty state
instead, not skeleton). Mark the container `aria-busy="true"` while
loading; flip to `aria-busy="false"` once resolved.

#### Sync now → per-row behavior

When user clicks **Sync now**:

1. The button enters loading state: label swaps to "Syncing…", spinner
   appears inline, button becomes `aria-busy="true"`. (This uses the
   button primitive's loading variant from the handoff — not a new
   pattern.)
2. Per-row: each DeviceRow whose peer is being contacted transitions
   its pip from its current state → `syncing`. The meta line updates
   to "Syncing now…" if it was previously hidden (online rows reveal
   the meta line briefly during an active sync).
3. When each peer resolves, its pip transitions to the resolved state
   (online / offline / degraded / attention). Transition: 140ms fade
   matching the handoff's 140-160ms vocabulary.
4. If no peers resolve within 15s, the button also surfaces a non-
   blocking toast via `showGlobalNotice`: "Sync is taking longer than
   usual — check View diagnostics." That's the "> 10s" threshold from
   the skill.

Rows NOT included in the current sync pass (e.g., a specific peer is
paused) retain their prior state; only actively-contacted peers flip
to syncing.

Reduced-motion: the pip state color still changes, only the pulse
animation is suppressed. State changes without pulse still convey the
information (online green → offline warm is visible without motion).

#### Empty states

**A. Zero devices (user is enrolled but no peers paired yet)**

Not a dead end — push toward invite.

```
       ┌─────────────┐
       │ [users icon] │
       │             │
       │  No teammates yet
       │
       │  Invite someone from another device to start
       │  syncing, or ask them to share an invite with you.
       │
       │    [Invite a teammate]   [Paste an invite]
       └─────────────┘
```

- Icon: Lucide `users`, 32px, `--text-tertiary`
- Title: T1 "No teammates yet"
- Description: T4, max-width 48ch, `--text-secondary`
- Actions: ActionShelf (primary: Invite a teammate; secondary: Paste an invite)
- Vertical padding: `var(--sp-6) var(--sp-4)` so it doesn't feel like
  a dialog dropped in the list; it's a genuine full-section empty state.

**B. Zero attention items (healthy system)**

The section does not render. No eyebrow, no container, no "You're all
caught up" copy — absence is the signal. This is the common case and
should be visually silent.

**C. Zero teams (device not enrolled)**

Entire Sync tab body replaces the People & devices section with a
join flow. Today's `presenceStatus === "not_enrolled"` branch handles
this; the redesign inherits it. The join flow uses an Invite-paste
ChipInput (existing primitive) in a centered single-column layout:

```
       ┌─────────────────────────┐
       │ [link-2 icon]
       │
       │ Join a team
       │
       │ Paste an invite below to add this device
       │ to an existing team.
       │
       │ [ chip input — paste invite here          ]
       │
       │ [Join team]
       └─────────────────────────┘
```

The `Needs attention` section can still render above this when there's
a system-wide issue (e.g., the coordinator is unreachable) — the join
flow only replaces the devices list.

#### Error states inside loading-states

Errors from a sync attempt surface in two places:

1. **AttentionRow** — if the error requires action (e.g., auth failure,
   peer needs re-approval). Action button = "Retry" or "Open device"
   depending on recoverability.
2. **DeviceRow meta line** — for informational errors (partial sync,
   transient timeout). No separate attention row; the meta line's
   truncated error string + full detail in the drawer is enough.

Rule: an error creates an Attention row if and only if the user has a
direct action to take. Otherwise it's a row meta line only.

#### Accessibility checklist for this section

- [x] `aria-busy` on the device-list container during skeleton
- [x] `aria-label` on every PresencePip derived from state
- [x] Pulse animations gated by `prefers-reduced-motion`
- [x] Shimmer gated by `prefers-reduced-motion`
- [x] Loading button carries `aria-busy` + accessible label
- [x] Empty-state icons are `aria-hidden` (decorative); the title
      carries the semantic
- [x] Error messages in AttentionRow link to the offending DeviceRow
      via `deviceId` so assistive tech users can navigate the
      relationship without duplicate copy

#### Hand-offs

No more skill passes. The next step is implementation:

- PR 1: move Advanced diagnostics to `/#sync/diagnostics`, kill Team
  status > Overview card, adjust header (View diagnostics link).
- PR 2: DeviceRow + DeviceDetailDrawer (Preact rewrite of device cards).
- PR 3: PresencePip + state matrix + skeleton + empty states.
- PR 4: Handoff additions (device-row, action-shelf, attention-
  vocabulary, disclosure-region anatomy pages).
