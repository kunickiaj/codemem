# Viewer component styling

Use shared primitives for interactive controls so the header, Settings, and other tabs keep the same appearance and keyboard behavior.

## Shared controls gallery

The local gallery is a visual check for the actual shared primitives: Buttons, Selects, Fields, Choices, Tabs, Indicators, Overlays, and Loading. It uses synthetic local fixtures and interactions, so it does not read memories or call the viewer API.

Run it during control work:

```text
pnpm --filter @codemem/ui gallery:dev
```

It serves only on `127.0.0.1:38922`; open `/gallery.html`. Use the gallery theme toggle, then check light and dark themes at desktop and narrow widths. Exercise opened, disabled, loading, and long-label states.

```text
pnpm --filter @codemem/ui gallery:build
```

The build produces an ignored gallery-only output. Generated HTML and extracted CSS stay under the UI package's ignored `.tmp` directory; the dev URL remains `/gallery.html`. They do not replace the normal dev entry or become production viewer assets.

The gallery reuses the canonical inline viewer CSS and pinned local Geist and JetBrains Mono font sources, so it makes no Google Fonts requests. Its own stylesheet may arrange gallery sections, but must not copy or redefine shared-control styling.

The extractor recognizes HTML tags and stylesheet attributes regardless of case, skips comments and script bodies, and preserves the real CSS bytes. It reads the repository's canonical HTML; it is not a sanitizer for untrusted HTML.

### Visual regression checks

Use the visual commands after changing shared controls or their gallery fixtures. Docker is required: `visual:test`, `visual:control`, and `visual:update` run a read-only copy of the tracked public sources using the pnpm version pinned in the root `packageManager` field inside `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27` for Linux amd64.

```text
pnpm --filter @codemem/ui visual:test
pnpm --filter @codemem/ui visual:control
pnpm --filter @codemem/ui visual:typecheck

# Optional harness-policy check
pnpm --filter @codemem/ui visual:test-harness
```

`visual:test` is the canonical comparison. It runs six gallery screenshots in four projects—dark and light themes at 1280 px and 390 px—for 24 cases; the Playwright configuration accepts only Linux x64. Local fonts are pinned at version 5.3, and the fixture blocks API, WebSocket, and external requests.

Each run writes fresh ignored output under `.tmp/visual/run-*/results`, including `report/` and `test-results/`. The runner never copies that output into its source input; CI uploads its ignored results only after a failure, and the only approved baselines are tracked synthetic PNGs in `packages/ui/visual/__screenshots__/`.

Staging excludes `.npmrc` at every depth, including case variants, before reading source contents. The disposable container generates a registry-only `/work/.npmrc` for `https://registry.npmjs.org/` and explicitly uses that public registry for installation; it does not mount home configuration or forward host npm credentials. Existing workspace install policy and frozen-lockfile checks still apply.

Local run folders also retain their public-source staging copy for debugging and can accumulate disk usage. They are not cleaned automatically; on Linux, container-created results may be owned by root. Inspect old run folders before removing them.

Ordinary comparisons never create or update a golden. A missing baseline or a pixel mismatch fails, while `visual:control` proves this with a scratch mutation and a missing-baseline case without changing a source baseline.

Comparisons allow no differing-pixel count, with a `0.01` perceptual color threshold to ignore single-channel rounding in blurred backgrounds and antialiased edges. The comparator controls verify that a meaningful control change still fails; this does not mask or omit any component.

### Update a golden intentionally

Only an author running locally may update goldens; CI rejects updates. Update a baseline only after reviewers accept an intentional default-style change or a visual bug fix—not as an automatic result of ordinary test runs. Review the actual images and the control baseline hash before updating, then inspect the committed PNG diff and run the comparison twice after the update.

```text
pnpm --filter @codemem/ui visual:control
pnpm --filter @codemem/ui visual:update
pnpm --filter @codemem/ui visual:test
pnpm --filter @codemem/ui visual:test
```

Do not add masks or use private data or APIs to make a comparison pass. Keep a real component's overflow in the capture when it occurs; correct its cleanup in the next implementation stage instead of hiding it in the visual test.

### Gallery reload behavior

The live gallery reuses canonical viewer CSS. When `static/index.html` changes, its Vite plugin regenerates the gallery page before a full reload, so ephemeral gallery state resets; other assets use native HMR without regeneration.

## Selects

Use `RadixSelect` from `packages/ui/src/components/primitives/radix-select.tsx`. Its default styles own the trigger, chevron, menu, options, and long-label truncation. Use its compact size for toolbar controls; keep the default size for forms.

Caller classes should adjust layout or a specific variant, not repeat the select's colors, padding, focus state, or menu surface. Keep project-filter changes in the existing application state and refresh flow.

Use `NativeSelect` when existing forms need the native value/change contract or platform picker. It forwards attributes, events, and refs to a real `<select>` and supplies the shared styling class. Single-selects receive trigger styling from `controls.css`; do not add a separate screen-specific chevron. Hidden controls, multiple-selection controls, and visible listboxes retain native rendering.

Selects fill their container by default. Caller layout classes can set `--select-width` and `--select-min-width` to keep a picker content-sized beside its action buttons without overriding shared geometry or state styles.

### Control sizes

`RadixSelect` accepts `size="default"` or `size="compact"`; its trigger exposes that value through `data-size`. `NativeSelect` forwards `data-size` to the real `<select>`, so use `data-size="compact"` for visual density and reserve the HTML `size` attribute for native listbox semantics.

The shared compact rule gives eligible `RadixSelect` triggers and single-picker `NativeSelect` controls a 30 px minimum height. It does not apply to `NativeSelect` controls that are `multiple`, hidden, `aria-hidden`, or have a listbox `size` greater than 1.

Default fields share the 38 px `--control-height` minimum. Named text actions and square icon buttons use the 36 px `--control-button-height`; compact selects use the 30 px `--control-compact-height`. Geometry stays on these explicit families rather than a blanket button rule that would resize radios and switches.

## Choice rows and chips

Choice lists retain semantic fieldsets and legends without browser-default borders or minimum widths that force the dialog to overflow. Put a choice's label and supporting text in the shared stacked copy container so long names wrap within the row. Checkbox and radio rows share selected and disabled treatments; a disabled option must not look clickable.

Use `Chip` for standard badges rather than repeating the badge class and tone assembly. Keep genuinely different layout variants explicit instead of adding a new shared variant for a single screen.

`Chip` with `variant="scope"` uses `peer-scope-chip`; keep scope-chip labels wrapping within the chip and let `peer-scope-chips` wrap chips across lines.

## Menus and help

Use the shared `ActionMenu` primitive for row actions. Keep action handlers and confirmation dialogs in the owning screen; the primitive owns opening, keyboard navigation, disabled items, dismissal, and focus return. Its `feed-menu-panel` is portaled, collision-padded by 12 px, and limited to Radix's available width and height; `feed-menu-item` labels wrap rather than clip. Destructive actions must retain their danger treatment when highlighted.

Give each autocomplete its own listbox and option IDs. An input's active-descendant relationship must point to an option in its own open list. Help text must expose a tooltip role and a description relationship to the active help button without removing other descriptions.

Keep `.tooltip-content` relatively positioned so its arrow keeps the same positioning parent while the opening transform animation runs and after it finishes. Otherwise the arrow can jump when the browser recalculates popup placement.

Use `DialogCloseButton` for dialog headers rather than a separately styled character button. Preserve the caller's busy/disabled state and accessible name.

## Buttons, inputs, and popup surfaces

Text actions share their default geometry. Icon buttons, tabs, and segmented controls may keep their own geometry; use explicit variants for smaller text actions.

Keep keyboard focus visible and use the shared input treatment rather than adding a screen-specific ring. Use theme tokens for popup surfaces, corner radii, spacing, and shadows. Popup layers may differ when a menu must appear above a dialog.

## Validate changes

Run the affected UI tests and build `@codemem/ui` before previewing. Check dark and light themes, narrow layouts, long labels, disabled controls, and keyboard opening, navigation, dismissal, and focus return. Functional tests alone do not catch chevron alignment or clipped menus.
