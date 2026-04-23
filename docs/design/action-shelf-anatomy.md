# Action-shelf anatomy

> Toolbar pattern for placing 1–N actions at the top of a list or region.
> Enforces the "at most one filled-primary button per line of sight"
> rule so visual hierarchy stays intact when features accrete.

## When to use

- A list region needs a title + one or more list-level actions
  ("Invite a teammate", "Join another team", "Create person").
- A section region needs trailing utility controls that should read as
  peer in importance but not compete with the primary action.

If there's only one action and no sibling actions within the same
region, a standalone `<button class="settings-button sync-btn-primary">`
is fine — you don't need an ActionShelf wrapper.

## Anatomy

```
┌────────────────────────────────────────────────────────────────┐
│  People & devices                [Join another team] [Invite] │
└────────────────────────────────────────────────────────────────┘
   ↑                                       ↑              ↑
   h2 section title                 secondary ghost   primary filled
```

Layout:

- Region heading on the left. Uses the T1 section-title treatment
  (16px / 600 / text-primary).
- Actions on the right. Right-aligned at ≥ 900px; wraps to next line
  below 900px.
- Gap between actions: `var(--sp-2)` (8px).

Button prominence rules:

| Tier            | Class                                       | Count per shelf |
|-----------------|---------------------------------------------|-----------------|
| primary-filled  | `settings-button sync-btn-primary`          | **at most 1**   |
| primary-ghost   | `settings-button` (accent on border/hover)  | 0–1 encouraged  |
| secondary-ghost | `settings-button` (default neutral border)  | 0–N             |
| text-link       | `sync-diagnostics-link` or similar          | 0–1, utility-only |

If you find yourself wanting two filled-primary buttons in the same
shelf, one of them is not actually primary — pick and demote the other.

## Responsive behavior

- ≥ 900px: title row + actions row side by side (`grid-template-columns:
  1fr auto`).
- < 900px: title and actions stack; shelf itself wraps with
  `flex-wrap: wrap` if the actions row can't fit.

If a shelf grows past 3 actions, consider collapsing the excess into a
"More ▾" popover or splitting into two regions rather than letting the
shelf grow unbounded.

## Props (reference implementation)

```ts
interface ActionShelfAction {
  label: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  "aria-label"?: string;
}

interface ActionShelfProps {
  primary?: ActionShelfAction;       // at most one filled-accent button
  secondary?: ActionShelfAction[];   // 0–N ghost buttons
  align?: "start" | "end";           // default "end" for toolbars
}
```

## Accessibility

- Render as `<div role="toolbar" aria-label="...">`.
- Each button uses plain `<button type="button">` with `aria-busy` when
  the action is in flight.
- Do not put the region `<h2>` inside the shelf; the shelf is siblings
  to the heading so heading landmarks still work.

## Related

- `device-row-anatomy.md` — uses the action-shelf above the device list.
- `disclosure-region-anatomy.md` — for shelves that need to toggle a
  region rather than fire a one-shot action.
