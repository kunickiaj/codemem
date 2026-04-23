# Attention vocabulary

> The offline / degraded / attention / syncing visual language. One
> vocabulary across the product so an Attention row and the device row
> it refers to read as the same thing.

## States

```
state       color                        behavior      example copy
─────────── ──────────────────────────── ───────────── ────────────────────────────
online      --accent                     static        (no meta line shown)
syncing     --accent                     pulse 1.2s    "Syncing now…"
offline     --accent-warm                static        "Offline · last seen 4/14 2:29PM"
degraded    --accent-warm                static        "Partial sync · peer status failed (401)"
attention   --accent-warm-strong         pulse 2.4s    "Not trusted — accept invite on other device"
unknown     --text-tertiary              static        "Not yet synced"
```

Principle: **color conveys the family, pulse conveys urgency.**

- Healthy family (`--accent`): online static, syncing pulses because
  something is actively in flight.
- Warm family (`--accent-warm`): offline + degraded share this color;
  both mean "not healthy but user action not required." Attention uses
  the stronger warm variant AND pulses to signal "act on this."
- Inert (`--text-tertiary`): genuinely unknown state (never synced yet,
  state hasn't loaded). Deliberately low-contrast — it's not a warning.

## Pip sizes

| Size  | Token          | When to use                                 |
|-------|----------------|---------------------------------------------|
| 6px   | `--pip-size-sm`| In-row status where there's no label paired |
| 8px   | `--pip-size-md`| Attention anchors, device-row primary pip   |

Pip component: `PresencePip` at `packages/ui/src/components/primitives/
presence-pip.tsx`.

## Pulse timing

```
attention: 2.4s ease-in-out, opacity 0.60 → 1.00 → 0.60, scale 1 → 1.15 → 1
syncing:   1.2s ease-in-out, opacity 0.55 → 1.00 → 0.55, no scale
```

Both animations are gated by `prefers-reduced-motion: reduce`. When
reduced motion is active, the pip still changes color to convey state —
the pulse is purely a secondary signal.

## Gestalt pairing

When an Attention row refers to a specific device, both rows show the
same pip (size, color, pulse timing). This links them visually without
duplicating copy.

```
┌─────────────────────────────────────────────────────┐
│ ●  Work is offline              [Open device]      │  ← attention row, 8px warm pulse
│    This device is offline right now. Retry later.   │
└─────────────────────────────────────────────────────┘
  …
┌─────────────────────────────────────────────────────┐
│ ●  Work                  [Offline]   Sync: 2:29PM ▸│  ← device row, same 8px warm pulse
└─────────────────────────────────────────────────────┘
```

## Anti-patterns

- **Don't color the row background.** Surfaces stay `--surface-1`; the
  color signal lives in the pip, not the chrome.
- **Don't invent new degraded-state colors.** Reuse `--accent-warm` and
  `--accent-warm-strong` from the handoff; variation belongs in pulse,
  not hue.
- **Don't use red.** Red is reserved for destructive confirmation
  dialogs (per the handoff voice — "Warnings are phrased as facts, not
  alarms").
- **Don't replace the pip with a text-only badge.** The pip's
  advantage is that it compresses status into a glance without eating
  horizontal space.

## Related

- `device-row-anatomy.md` — pip placement in a list row.
- `disclosure-region-anatomy.md` — attention rows often link to a
  device row which expands on click.
