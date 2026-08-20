# Global native control baseline

## Problem

The viewer has tokenized component styles, but native form controls only inherit
those styles when each feature remembers to add a component-specific class.
Unclassified selects and checkboxes therefore fall back to browser colors that
can conflict with the active theme.

## Decision

Provide a low-specificity, token-driven baseline for every native form control.
Component styles remain free to override the baseline, while newly added native
controls are usable and visually consistent without feature-specific CSS.

The baseline will:

- declare the active browser `color-scheme` for dark and light themes;
- style buttons, text-like fields, textareas, and selects with existing tokens;
- give checkboxes and radio buttons consistent checked, indeterminate, focus,
  and disabled states;
- cover native file buttons, range controls, and progress indicators; and
- preserve native elements, labels, focus order, and keyboard behavior.

Custom component primitives are intentionally out of scope. They already have
stronger component selectors and continue to override this baseline.

## Verification

- Add a static integration test proving the baseline is loaded and covers the
  supported control families.
- Run the UI tests, typecheck, and production build.
- Inspect representative controls in explicit dark and light themes, including
  keyboard focus, checked, indeterminate, and disabled states.
- Confirm checked-state and focus visibility in Windows forced-colors mode.
