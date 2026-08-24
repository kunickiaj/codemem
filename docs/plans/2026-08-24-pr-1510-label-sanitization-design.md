# PR #1510 label-sanitization fix

## Problem

Team setup labels are coordinator-controlled and must not expose opaque lookup identifiers. Replacement attempts can retain removed rows whose identifiers are absent from the current roster, and stale drafts can retain labels that become unsafe when new identifiers appear. Identifier checks also happened after display-length truncation, allowing a forbidden identifier later in the source label to escape comparison.

## Design

Prepare one forbidden-identifier set for each draft operation. Normalize identifiers with NFKC, case-fold them, remove empty values, and deduplicate them once. Include candidate, coordinator, group, current device, current Project, coordinator-provided identity IDs and public keys, persisted prior/current-attempt assignment identities, and live canonical assignment identities for every row written into a replacement attempt—including carried removed devices. Coordinator identity IDs and public keys are carried only as transient redaction inputs and are never persisted in the draft.

Normalize the full source label and check it against the prepared set before applying the display-length limit. Continue to apply the existing conservative character grammar and generic fallback labels. Re-sanitize every persisted label when a current attempt is reused or returned stale, while leaving its evidence and state unchanged. Persisted identifiers come only from the current attempt; identifiers from unrelated historical attempts must not over-redact labels.

## Validation

Regression tests cover cross-roster identifiers, carried device IDs and fingerprints, assignment identities, Unicode-equivalent identifiers, identifiers beyond the display truncation boundary, stale summary/detail labels, malformed coordinator enabled flags, and mismatched coordinator key fingerprints. Run focused core and viewer-server tests plus the full repository gate before updating the pull request.
