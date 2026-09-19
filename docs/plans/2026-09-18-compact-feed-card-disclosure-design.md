# Compact Feed Card Disclosure Design

The feed will use one compact card and one Summary/Facts/Narrative disclosure model for every memory kind.

## Decision

The default surface prioritizes scanning without hiding provenance or trust signals that change whether a memory is safe to use.

- Every card opens collapsed in its remembered global mode, with `Summary` as the initial default.
- The title toggles the selected mode's detail region; the mode control changes which detail appears.
- Session summaries use the same three modes as observations. They do not add a fourth session-only mode.
- Shared or peer-authored memories always show actor, visibility, and non-trusted trust state while collapsed.
- Per-card expansion remains ephemeral but survives polling, pagination, and filter or project changes during the page lifetime.

## Card Anatomy

The card keeps three skim lines visible and moves secondary provenance and full content behind disclosure.

At wide widths, the card is a three-column grid: a 104 px kind rail, a flexible body, and an action column. It uses a 16 px column gap, 16 px by 20 px padding, `var(--surface-1)`, `var(--border)`, `var(--radius-lg)`, and `var(--shadow-sm)`.

1. The kind rail contains the existing kind `Chip`.
2. The body shows a one-line title, a one-line summary, and a metadata line.
3. The action column shows relative age and the item menu above the view modes and visibility control.

The metadata line contains project, actor, visibility, memory ID, tags, and any required trust chip. Expanded content ends with files and detailed workspace, source, and device provenance.

## Disclosure Model

One mode vocabulary keeps keyboard behavior and user preference consistent across memory kinds.

| Mode | Observations and changes | Session summaries | Legacy records |
| --- | --- | --- | --- |
| Summary | `subtitle`, then semantic summary fallback | First non-duplicate outcome line | Collapsed: first non-empty `subtitle` or `body_text` line. Expanded: full `body_text` |
| Facts | Explicit or derived facts | Structured REQUEST, OUTCOME, PLAN, COMPLETED, LEARNED, INVESTIGATED, NEXT STEPS, and NOTES sections | Derived facts when available |
| Narrative | Distinct `narrative`, then `body_text` fallback | Distinct narrative or `body_text` | Full `body_text` |

Unavailable modes are omitted. If only one mode exists, the mode control is omitted but the title still toggles that mode's detail region.

For a session summary, the collapsed skim line uses the first non-empty item from COMPLETED, LEARNED, INVESTIGATED, NEXT STEPS, then NOTES. If none exists, it uses a non-duplicate REQUEST line, then `body_text`. This order favors outcomes over a repetition of the request.

Telemetry-like records use their existing kind and source, the best available semantic summary, and the same provenance line. They do not synthesize narrative or facts solely to fill every mode.

## Duplicate and Legacy Rules

Duplicate suppression uses semantic fields and normalized full values, not truncation or visual comparison.

- A session title continues to use REQUEST when present, otherwise the stored title.
- The Facts view omits REQUEST when its normalized text equals the normalized displayed title.
- The collapsed summary omits any candidate line equal to the displayed title or an already selected line.
- Normalization trims whitespace, folds repeated whitespace, and compares case-insensitively; it does not remove punctuation or truncate text.
- Missing structured fields never erase legacy content. `body_text` remains the final summary and narrative fallback.

## Provenance and Safety

Safety-relevant context remains visible before expansion.

- Actor is always visible: `You` for self-owned items, otherwise the resolved author label.
- Visibility is always visible as `private` or `shared` provenance.
- A non-self-owned item always shows its trust-state chip unless the state is the ordinary trusted state.
- Project and `#memoryId` remain visible; the ID tooltip reads `Memory database id N`.
- Raw device or internal source identifiers never replace a missing display label.
- Workspace kind, origin source, resolved device detail, files, and extended provenance move to the expanded region.

## Remembered and Ephemeral State

The remembered preference controls presentation defaults, while item identity controls temporary disclosure.

- Store one global preferred mode in local storage under a versioned feed-view key.
- Selecting a mode updates the global preference and that card's active mode.
- A card that lacks the preferred mode chooses Summary, then Facts, then Narrative without overwriting the preference.
- Expansion is keyed only by stable item identity in in-memory UI state. Active mode is stored separately so changing mode replaces detail in place without collapsing an open card.
- Polling with the same identity preserves active mode and expansion. New content for that identity updates inside the open region.
- Pagination, filters, and project changes may temporarily remove a card but do not transfer its state to another item.
- A full page reload preserves only the global preferred mode, not individual expanded cards.
- A new-item pulse does not expand a card or replace its remembered mode.

## Interaction and Accessibility

The title and mode controls provide separate, explicit keyboard operations.

- Render the title as a button with `aria-expanded` and `aria-controls`; Enter or Space toggles detail.
- Render available modes as a labeled radiogroup with one radio per mode. Arrow keys move and select according to the radio pattern.
- Changing mode on a collapsed card does not force it open. Changing mode on an expanded card replaces the detail in place.
- Preserve focus on the title, selected mode, visibility control, and item menu across polling rerenders.
- The detail region has an accessible name derived from the card title and selected mode.
- Reduced-motion mode removes the new-item pulse and disclosure animation.
- Search highlighting remains in the title and skim line. If a match exists only in hidden detail, show and highlight the matching mode excerpt so the result explains the match without permanently expanding it.

## Narrow, Print, and Copy Behavior

The 755 px layout stacks controls without horizontal scrolling or hiding safety context.

At 755 px and below, the first row contains kind, age, and the item menu; title and summary follow; metadata may wrap to two lines; modes and `Visible to` share the final row and wrap when needed. Text truncation uses ellipsis only for the title and collapsed summary. Metadata chips wrap rather than clip.

Print hides menus and editable controls but includes the skim layer and the currently expanded mode. Browser copy includes only visible text; collapsed hidden detail is not inserted into copied content.

## Annotated States

These examples define the minimum information visible before and after disclosure.

### Observation

Collapsed: `BUGFIX` · **Reject duplicate watering commands** · `Retries now reuse an idempotency record` · `garden-api · You · private · #6 · idempotency · retries`.

Expanded Facts: the fact list appears below the skim lines; files and detailed provenance follow it. Narrative replaces Facts in the same region when selected.

### Structured Session Summary

Collapsed: `SESSION SUMMARY` · **Add retry-safe watering** · `Completed idempotency storage and retry tests` · project and provenance.

Expanded Facts: COMPLETED, LEARNED, INVESTIGATED, NEXT STEPS, and NOTES render as structured sections. REQUEST is omitted when it matches the title. Narrative shows distinct session prose or the legacy body fallback.

### Shared Memory

Collapsed: kind · title · summary · `garden-api · Teammate · shared · Review before use · #42`. Actor, shared visibility, and trust state cannot be hidden.

Expanded: selected content appears with resolved source and device detail. A missing display name does not expose a raw identifier.

### Legacy Record

Collapsed: kind · stored title or `(untitled)` · first `body_text` line · project and provenance.

Expanded Summary or Narrative: full `body_text`, not only the collapsed first-line skim. Facts appears only when facts can be derived without inventing content.

## Implementation Boundaries

The implementation should introduce an explicit card view model rather than add more branching to `FeedItemCard`.

- `FeedItemCard.tsx`: card composition, disclosure, visibility, and item actions.
- `FeedTabView.tsx`: stable keyed rendering and search-match disclosure hints.
- `data/observation-view.ts` and a session-summary view helper: mode availability, skim line, and duplicate suppression.
- `state.ts`: versioned global mode preference and per-card ephemeral state.
- `static/index.html`: token-based grid, narrow layout, print rules, focus states, and reduced motion.

No API or stored-memory migration is required. Existing project moves, deletion, visibility updates, Context Inspector, pagination, and new-item identity remain in scope for regression coverage rather than redesign.

## Validation

Tests must prove that compaction does not hide data or transfer state between memories.

- Observation defaults and all available mode changes.
- Session outcome skim order and duplicate REQUEST suppression.
- Shared lower-trust provenance on the collapsed card.
- Legacy `body_text` fallback and absent-mode handling.
- Global preference persistence and unavailable-mode fallback.
- Per-card expansion through polling, pagination, filtering, and project changes.
- Search matches found only in detailed content.
- Keyboard title and radiogroup behavior, focus preservation, and accessible names.
- Reduced-motion, print styling, and 755 px no-overflow layout.
- Existing visibility, move, delete, tags, files, and Context Inspector behavior.
