# Sharing and Devices loading states

## Problem

Sharing and Devices currently replace their card content with plain loading text. The text
confirms that work is happening, but the abrupt shape change makes both tabs feel unfinished and
causes avoidable layout movement. Sharing also discards previously loaded cards when a background
refresh fails, even though the last successful data remains useful.

## Decision

Use content-shaped card skeletons for the first unresolved load only. The skeletons reuse the
Viewer's existing shimmer timing, surfaces, borders, radii, and reduced-motion behavior. They
approximate the final card anatomy—title, badge, and detail rows—without implying exact content.

After content has loaded once, background refreshes keep the existing cards visible. A failed
refresh adds an assertive message above the stale content instead of replacing it. Initial failures
still render the existing unavailable state because there is no trustworthy content to preserve.

## Accessibility

- Screen-reader-only text provides one dedicated loading `role="status"` announcement; the
  decorative skeleton list separately exposes `aria-busy="true"`. Devices also retains its
  existing persistent commit-status region.
- Skeleton geometry is decorative and hidden from assistive technology.
- Shimmer stops under `prefers-reduced-motion: reduce`.
- Refresh failures use `role="alert"`; retained cards remain navigable.

## Non-goals

- No API, data model, or navigation changes.
- No skeletons during mutations or short button-level operations.
- No loading overlay once either tab has resolved its first data set.
