# Legacy Team Setup Dialog Design

**Status:** Approved for implementation on 2026-08-25

## Goal

Add an accessible, resumable viewer dialog that guides a user through reviewing a legacy Team before activating it as canonical Project Sharing state. The dialog must persist each decision immediately, render only server-derived migration evidence, and fail closed when the reviewed state changes.

## Constraints

- The server remains authoritative for setup state, available choices, readiness, access deltas, and confirmation digests.
- The client must use opaque candidate, device, identity, Project, and resolved-Project references without deriving or decoding identifiers.
- Assignment, decision, and Project mapping changes persist immediately. Closing or reloading the dialog must not discard completed work.
- Unresolved devices or Projects block the review step. Missing confirmation evidence blocks finish.
- Stale or conflicting evidence triggers a safe detail reload instead of optimistic continuation.
- The complete server-provided access delta is rendered without filtering or client-side access calculations.
- Existing coordinator, database, and local-path redaction guarantees remain intact.
- Each implementation PR should stay near 800 changed lines and must split before reaching 1,000 changed lines.

## Architecture

The dialog uses a global host mounted alongside the existing recipient-policy management host. Sharing and Projects both call one imperative opener with an opaque candidate reference. Keeping the host outside either tab prevents polling or tab remounts from destroying in-progress dialog state.

The host owns:

- the active candidate reference;
- the latest `LegacyTeamSetupDetailResponseV1`;
- the current step;
- load, mutation, and finish status;
- a safe user-facing error message;
- the element that should receive focus after close.

Every successful mutation is followed by a detail reload. Mutation responses provide authoritative counts but not the complete refreshed rows or access delta, so the dialog never patches local rows optimistically.

## Dialog lifecycle

1. The opener records the currently focused element and opens the global dialog.
2. The dialog focuses its heading and loads candidate detail.
3. The current step is selected from authoritative state:
   - unresolved device work opens the Devices step;
   - otherwise unresolved Project work opens the Projects step;
   - otherwise the dialog opens Review.
4. A successful mutation reloads detail and keeps the user on the current step unless that step is complete.
5. Closing restores focus to the connected trigger when possible, then falls back to the stable active-tab control.
6. Reopening starts from freshly loaded server state rather than stale module state.

## Step 1: Devices

Each device exposes its server-provided display name, assignment evidence, decision, and available identity choices.

- Existing valid assignments are shown without requiring redundant entry.
- Changing an assignment submits the current `attemptId`, target identity reference, and exact assignment expectation.
- Including a device submits the expected target identity reference after assignment succeeds.
- Excluding or removing a device submits only the selected decision.
- Clearing a decision uses the current attempt and reloads the detail.
- Controls are disabled while their mutation is active. Duplicate submissions are rejected locally.
- Assignment and decision remain separate persisted operations. If the second operation fails, the first remains resumable and visible after reload.

The user cannot advance while `unresolvedDeviceCount` is nonzero.

## Step 2: Projects

Each Project displays its server-provided name and current resolution.

- Deterministic mappings are read-only.
- Ambiguous Projects offer only the server-provided opaque mapping choices.
- Selecting a mapping submits `attemptId` and `resolvedProjectRef`, then reloads detail.
- The UI does not infer candidate Projects from local inventory or decode mapping references.

The user cannot advance while `unresolvedProjectCount` is nonzero.

## Step 3: Review and finish

Review is available only when `canFinish` is true and the detail includes `accessDelta`, `finishDigest`, and `accessDeltaDigest`.

The UI renders every entry from the server-provided delta:

- Team changes;
- membership changes;
- Project changes;
- recipient changes;
- device-access changes.

Large deltas remain inside the dialog's scrollable body. No delta entry is silently collapsed or omitted from the accessible DOM.

Finish requires an explicit confirmation control. Submission sends the exact `attemptId`, `finishDigest`, and confirmed access-delta digest from the currently displayed detail. Success announces completion, refreshes Sharing and Projects state, and offers a single close action.

## Error and recovery behavior

Errors use the stable `LegacyTeamSetupApiError` vocabulary and generic safe copy.

- Stale confirmation, assignment change, projection change, or conflict: announce the change and reload detail before allowing more work.
- Roster unavailable or bounded-data failure: retain the dialog, disable mutations, and offer retry.
- Network or unexpected safe API failure: retain the current server-derived view and offer retry.
- Completed setup discovered during retry: transition directly to the completion state.

Raw response bodies, coordinator details, and exception text are never rendered.

## Accessibility

- Use the shared Radix dialog primitive for modal semantics, focus trapping, Escape handling, and background inertness.
- Give the dialog an explicit labelled heading and description.
- Use native buttons, radio inputs, checkboxes, fieldsets, legends, and labels.
- Announce mutation progress politely and errors assertively without moving focus unnecessarily.
- Move focus to the step heading after explicit step navigation and to the first invalid or unresolved group when advancement is blocked.
- Keep visible focus indicators and at least 24 by 24 CSS pixel targets.
- Do not use color as the only status or error indicator.
- Prevent close only during the short interval in which a mutation or finish request is being submitted.
- Preserve usable layout and scrolling at 200% zoom and narrow viewport widths.

## Pull request slices

1. **Accessible host and production wiring**
   - Global host and opener.
   - Loading, retry, step selection, focus restoration, and scoped styles.
   - Sharing and Projects callback wiring.
2. **Device decisions**
   - Assignment, include, exclude, remove, and clear behavior.
   - Immediate persistence, busy guards, reload, and recovery tests.
3. **Project mappings**
   - Deterministic presentation and explicit mapping choices.
   - Immediate persistence, reload, and stale-state tests.
4. **Review and finish**
   - Complete access-delta rendering.
   - Explicit confirmation, finish, completion refresh, and retry tests.

If any slice approaches 1,000 changed lines, split rendering from mutation behavior before submission.

## Validation

Each PR runs focused UI tests, TypeScript, lint, and the UI build. The stack tip also runs the full workspace check. Accessibility validation includes automated semantic assertions plus manual keyboard, focus-restoration, 200% zoom, and VoiceOver checks before the migration E2E/docs slice is declared complete.
