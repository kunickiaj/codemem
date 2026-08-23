# Legacy Team Draft Limits Implementation Plan

**Date:** 2026-08-23

**Design:** `2026-08-23-legacy-team-draft-limits-design.md`

## 1. Share limits

- Add an internal module for the 500-Device and 500-Project limits.
- Import those constants from draft and activation code.
- Preserve activation's existing size-check behavior.

## 2. Bound draft refresh

- Validate raw snapshot counts before fingerprints, assignment reads, or transactions that write attempts.
- Before creating a replacement attempt, construct the effective Device union with carried removed Devices and validate it.
- Count carried rows in SQL so pre-limit oversized attempts are not materialized in application memory.
- Perform the union check before inserting the parent draft row.
- Throw `legacy_team_setup_roster_too_large` and leave any current attempt untouched.
- Skip only the oversized coordinator group during multi-candidate discovery; direct single-candidate refresh remains explicit and throws.

## 3. Preserve retryable conflicts

- Keep recording `team_setup_conflict` in `safe_error_code`.
- Remove it from the set of errors that transition the attempt to `stale`.
- Keep roster, projection, and assignment change codes in the terminal set.

## 4. Test and validate

- Add draft boundary, no-partial-write, carried-overflow, and preservation tests.
- Add activation retryability and terminal-staleness tests.
- Run focused Vitest files, TypeScript, lint, core tests, and diff checks.
