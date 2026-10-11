# Viewer component styling

Use shared primitives for interactive controls so the header, Settings, and other tabs keep the same appearance and keyboard behavior.

## Selects

Use `RadixSelect` from `packages/ui/src/components/primitives/radix-select.tsx`. Its default styles own the trigger, chevron, menu, options, and long-label truncation. Use its compact size for toolbar controls; keep the default size for forms.

Caller classes should adjust layout or a specific variant, not repeat the select's colors, padding, focus state, or menu surface. Keep project-filter changes in the existing application state and refresh flow.

Use `NativeSelect` when existing forms need the native value/change contract or platform picker. It forwards attributes, events, and refs to a real `<select>` and supplies the shared styling class. Single-selects receive trigger styling from `controls.css`; do not add a separate screen-specific chevron. Hidden controls, multiple-selection controls, and visible listboxes retain native rendering.

Selects fill their container by default. Caller layout classes can set `--select-width` and `--select-min-width` to keep a picker content-sized beside its action buttons without overriding shared geometry or state styles.

## Choice rows and chips

Choice lists retain semantic fieldsets and legends without browser-default borders or minimum widths that force the dialog to overflow. Put a choice's label and supporting text in the shared stacked copy container so long names wrap within the row. Checkbox and radio rows share selected and disabled treatments; a disabled option must not look clickable.

Use `Chip` for standard badges rather than repeating the badge class and tone assembly. Keep genuinely different layout variants explicit instead of adding a new shared variant for a single screen.

## Menus and help

Use the shared action-menu primitive for row actions. Keep action handlers and confirmation dialogs in the owning screen; the primitive owns opening, keyboard navigation, disabled items, dismissal, and focus return. Menu surfaces should not be clipped by their parent rows. Destructive actions must retain their danger treatment when highlighted.

Give each autocomplete its own listbox and option IDs. An input's active-descendant relationship must point to an option in its own open list. Help text must expose a tooltip role and a description relationship to the active help button without removing other descriptions.

Use `DialogCloseButton` for dialog headers rather than a separately styled character button. Preserve the caller's busy/disabled state and accessible name.

## Buttons, inputs, and popup surfaces

Text actions share their default geometry. Icon buttons, tabs, and segmented controls may keep their own geometry; use explicit variants for smaller text actions.

Keep keyboard focus visible and use the shared input treatment rather than adding a screen-specific ring. Use theme tokens for popup surfaces, corner radii, spacing, and shadows. Popup layers may differ when a menu must appear above a dialog.

## Validate changes

Run the affected UI tests and build `@codemem/ui` before previewing. Check dark and light themes, narrow layouts, long labels, disabled controls, and keyboard opening, navigation, dismissal, and focus return. Functional tests alone do not catch chevron alignment or clipped menus.
