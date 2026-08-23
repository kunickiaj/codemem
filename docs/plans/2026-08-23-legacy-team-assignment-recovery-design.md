# Legacy Team assignment recovery design

## Goal

Keep malformed persisted assignment expectations fail-closed without permanently stranding a legacy Team setup attempt, and make removed-device confirmation state independent of stale identity selections.

## Decision

Draft reuse validates the complete stored assignment expectation, not only the copied live assignment fields. A row is reusable only when:

- its copied identity, assignment version, and active-evidence marker match the live assignment;
- an existing assignment has `expected_assignment_kind = 'existing'` and the same valid assignment version; or
- an absent assignment has `expected_assignment_kind = 'absent'` and no expected version.

Malformed or contradictory stored expectations therefore force the normal immutable replacement path. The old attempt remains fail-closed and the new attempt snapshots valid current evidence.

If the canonical assignment version itself cannot be represented as a safe non-negative integer, refresh keeps the current attempt stable rather than creating identical replacements. The attempt remains non-finishable until canonical data is repaired.

Saving either `excluded` or `removed` clears `target_identity_id`. Neither decision grants access, and retaining a prior selected identity would make the confirmation digest depend on data irrelevant to the decision.

## Compatibility

- No schema or public response-shape changes.
- Valid in-progress review state continues to be reused.
- Corrupt attempts remain immutable history rather than being repaired in place.
- Included-device assignment CAS behavior is unchanged.

## Verification

- Corrupt existing and absent expectations cause a replacement attempt with normalized evidence.
- The corrupt attempt cannot finish before replacement.
- A removed decision clears the selected target and produces the same target-free digest regardless of the prior selection.
- Focused draft and activation tests continue to pass.
