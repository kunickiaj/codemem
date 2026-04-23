# Disclosure-region anatomy

> How to reveal detail for a row or section without navigating away or
> opening a modal. The codemem viewer uses this pattern for device
> rows, coordinator-group scope defaults, and advanced diagnostics
> toggles.

## Decision table — which disclosure pattern?

| Situation                                        | Pattern             |
|-------------------------------------------------|---------------------|
| Row in a list needs per-row detail              | **Inline expand**   |
| Secondary option that lives next to a control  | Collapsible disclosure (inline) |
| Heavyweight workflow, user must focus on it    | Modal (`RadixDialog`) |
| Short ephemeral actions (menu, tooltip)        | Popover (`RadixPopover`) |

When in doubt, start with inline expand. It preserves context.

## Inline expand (rows)

Mechanics:

- Row renders as `<button aria-expanded aria-controls>`.
- Drawer renders as a sibling `<section aria-label>` inside the same
  list-item `<li>` / `<div>`, conditionally mounted when expanded.
- **Only one row open at a time.** State lives at the module level
  (e.g. `let expandedPeerId: string | null`) with a small subscribe
  hook so components re-render when the pointer changes.
- Collapsing the previous row and expanding the new one happens
  atomically via the setter.

```
.list
├── .row (aria-expanded=false)           ← clickable header
├── .row (aria-expanded=true)            ← clickable header
│   └── <section> drawer contents
└── .row (aria-expanded=false)
```

## Inline disclosure (sections)

For sections that need a "hide/show more" affordance without list-item
semantics, use a plain `<button aria-controls aria-expanded>` toggle
next to a region that conditionally renders. Examples in the codebase:

- "Advanced sharing scope" in the device detail drawer.
- "Show archived" groups toggle in Coordinator Admin.
- Coordinator Admin "Scope defaults" drawer inside each group card.

Use `var(--sp-3)` gap between the toggle and its revealed region, and
keep the region inside the same card when possible so proximity
signals they belong together.

## Focus management

Rule of thumb: **don't fight the browser.**

- On expand: default focus stays on the row button. Sub-controls take
  focus when activated.
- On collapse via button: focus stays on the row button.
- On collapse via another row expanding: because the new row's button
  receives the click, focus naturally moves there — this is emergent,
  not imperative. If you add programmatic focus restoration, write a
  test.
- For keyboard users, `Tab` enters the drawer in DOM order. `Escape`
  is NOT wired by default (inline expand is not modal; Escape should
  not close it unless the user specifically requests it).

## Animation

Keep it boring. Inline expand should feel like "the list grew a row,"
not "a panel slid in." Use a 140ms ease height transition on the
drawer OR no transition at all if it's janky with variable content.
The drawer exists inline in the DOM — tying animation to data load is
fine; animating the drawer itself often isn't worth the complexity.

## Anti-patterns

- **Don't put a drawer inside a popover.** Popovers have positioning
  and focus semantics that conflict with form controls.
- **Don't nest two row-level drawers.** A row-drawer-inside-a-row-drawer
  is a routing mistake wearing a toggle — promote the inner one to a
  modal or a dedicated route. An **inline sub-disclosure** inside a
  drawer is fine (e.g. "Advanced sharing scope" inside the device
  detail drawer) — those are small toggles for deeply secondary options,
  not full row detail surfaces.
- **Don't make the entire row a link.** A link leaves the page; an
  expand toggle doesn't. Use the right semantics.

## Related

- `device-row-anatomy.md` — the canonical inline-expand example.
