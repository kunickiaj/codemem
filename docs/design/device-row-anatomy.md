# Device-row anatomy

> List-item density pattern for the Sync tab's People & devices list.
> Scales to ~10 devices comfortably; expands in place to reveal per-row
> detail without leaving the list.

## When to use

Any time you render a list of entities where each entity has:

- A single-line primary identifier (device name, peer id, person name).
- A compact health/status signal.
- A small set of secondary status tags (trust, direction, provenance).
- Per-entity actions that don't fit on a single line.

If your list items only need a name + one or two chips with no detail
drawer, use a plain `.peer-card` instead.

## Anatomy

```
┌─────────────────────────────────────────────────────────────┐
│ ●  Work   ↕   [Two-way trust]   [via team-alpha]   Sync: 2:31PM ▸│  ← compact row
└─────────────────────────────────────────────────────────────┘
  ┌─────────────────────────────────────────────────────────┐
  │  [Sync now]  [Device name ____]  [Save name]  [Remove] │  ← drawer (on expand)
  │                                                         │
  │  Device details                                         │
  │  192.168.42.123:7337                                    │
  │  Sync: 2:31PM · Ping: 2:31PM                            │
  │                                                         │
  │  Who this device belongs to                             │
  │  This device belongs to you.                            │
  │  [You ▾]  [Save assignment]                             │
  │                                                         │
  │  Advanced sharing scope ▸                               │
  └─────────────────────────────────────────────────────────┘
```

Left to right in the compact row:

1. **PresencePip** — 8px dot. Color + pulse convey state. See
   `attention-vocabulary-anatomy.md`.
2. **Name** — T3 row name (14px / 600 / text-primary). Truncates with
   ellipsis on overflow.
3. **Direction glyph** (optional) — ↑ / ↓ / ↕ for the last 24h direction.
4. **Trust chip** — `.badge` today, will migrate to `TrustChip` primitive.
5. **Provenance chips** (optional) — "via {group-id}", "Needs scope
   review", etc. Each uses `.badge` styling.
6. **Meta** — T5 (12px / 400 / text-tertiary). Sync timestamp.
7. **Chevron** — ▸ collapsed / ▾ expanded. Decorative (aria-hidden).

Row height: **56px minimum** (hits the 44px touch target with 10px
top/bottom padding).

## States

| State        | Trigger                                       | Visual |
|--------------|-----------------------------------------------|--------|
| default      | row rendered, mouse away                      | transparent bg |
| hover        | mouse over, not focused                       | `surface-2` 60% |
| focus-visible| tab navigation                                | 2px accent outline |
| expanded     | clicked or activated via keyboard             | drawer visible, chevron rotated |
| attention    | owning device has pending user action         | pip pulses warm |
| syncing      | device is actively being contacted            | pip pulses mint |

Only **one row's drawer is open at a time.** Clicking a different row
collapses the previous one. State lives at the render module level
(e.g. `expandedPeerId` in `sync-peers.tsx`).

## Accessibility

- The row itself is a `<button aria-expanded aria-controls>` with the
  full compact header as its clickable target.
- The drawer is a `<section aria-label="Device actions for {name}">`.
- Focus management: on expand, default browser focus handling is fine
  (drawer sub-controls take focus when activated). On collapse, focus
  returns to the row button.
- Touch targets: row header ≥ 56px, all drawer buttons ≥ 28px (extended
  by padding to meet 44px recommended minimum on touch devices).
- `prefers-reduced-motion` disables pip pulse + hover transitions.

## Props (reference implementation)

```ts
interface DeviceRowProps {
  deviceId: string;
  name: string;
  trust: TrustState;                // see trust-chip tone mapping
  presence: PresenceState;          // see attention-vocabulary
  lastSyncAt?: string;              // ISO timestamp, shown as T5 meta
  lastError?: string;               // degraded / offline detail
  expanded: boolean;
  onToggleExpanded: () => void;
  renderDrawer: () => VNode;        // lazy — only mounts when expanded
}
```

## Related

- `action-shelf-anatomy.md` — for the toolbar pattern used to place
  list-level actions above the device row list.
- `disclosure-region-anatomy.md` — for the expand mechanics generalized
  beyond the device row.
- `attention-vocabulary-anatomy.md` — for the pip state matrix.
