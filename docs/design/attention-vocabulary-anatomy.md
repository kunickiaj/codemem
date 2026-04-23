# Attention vocabulary

> The offline / degraded / attention / syncing visual language. One
> vocabulary across the product so an Attention row and the device row
> it refers to read as the same thing.

## States

```
state       color              behavior      example copy
─────────── ────────────────── ───────────── ────────────────────────────
online      --accent           static        (no meta line shown)
syncing     --accent           pulse 1.2s    "Syncing now…" (not wired today; see Notes)
offline     --accent-warm      static        "Offline · last seen 4/14 2:29PM"
degraded    --accent-warm      static        "Partial sync · peer status failed (401)"
attention   --accent-warm      pulse 2.4s    "Not trusted — accept invite on other device"
unknown     --text-tertiary    static        "Not yet synced"
```

Principle: **pulse conveys urgency; color conveys family.**

- Healthy family (`--accent`): online is static, syncing would pulse if
  a reliable backend signal existed (see Notes).
- Warm family (`--accent-warm`): offline, degraded, and attention share
  this color. Pulse (attention only) is what distinguishes "act on this"
  from "know this." Offline + degraded are informational and stay static.
- Inert (`--text-tertiary`): genuinely unknown state (never synced yet,
  state hasn't loaded). Deliberately low-contrast — not a warning.

## Notes on the `syncing` state

Not currently surfaced in the UI. The Sync tab's per-row Sync-now button
carries its own loading affordance (label + spinner); the PresencePip
is not overridden to `syncing` locally because no backend signal keeps
it honest for global fan-out or background sync. Reintroduce when a
per-peer in-flight field lands in `SyncPeerStatusLike`.

The CSS for `.presence-pip--syncing` stays in place for that future use.

## Pip sizes

| Size  | When to use                                 |
|-------|---------------------------------------------|
| 6px   | In-row status where there's no label paired |
| 8px   | Attention anchors, device-row primary pip   |

Pass as a literal to the `PresencePip` `size` prop (`6 | 8`). Size is
not tokenized today — the prop feeds `--presence-pip-size` inline. If
a third size grows demand, promote to a shared token then.

Pip component: `PresencePip` at
`packages/ui/src/components/primitives/presence-pip.tsx`.

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
