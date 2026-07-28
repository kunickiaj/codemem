# Pre-0.40 product completion

## Goal

Reach a feature-complete, known-bug-free product state before starting the stable 0.40 release process. Release evaluation and attestation are deliberately outside the critical path until product correctness work is complete.

## Current state

- The recipient-policy and second-device provisioning stacks are merged on `main`.
- Main CI, including the three-device Project-sharing scenario, is green.
- Several product correctness fixes exist only in the separate release-evaluation worktree.
- Three sharing lifecycle gaps remain tracked as `codemem-8x4i`, `codemem-97si`, and `codemem-10qd`.
- Several older beads describe behavior already fixed by merged code and need evidence-based closure.

## Approaches considered

### Restack and merge the complete release-evaluation stack first

This preserves the existing branch structure but puts roughly 13,000 lines of evaluation and release-gate work ahead of product bug fixes. It also couples product fixes to release policy that is not currently the priority.

Rejected because it expands review scope and delays product correctness.

### Extract product fixes into focused stacks

Forward-port only the production-facing observer and embedding fixes onto current `main`, then complete sharing lifecycle behavior in one PR per tracked issue. The evaluation stack can later restack over the merged fixes and drop duplicate patches.

Selected because each PR has a narrow behavior contract, independent validation, and a clear rollback boundary.

### Defer the fixes until release preparation

This keeps `main` unchanged but would knowingly enter release preparation with parser, onboarding-review, and stale-access gaps.

Rejected because release preparation must validate a product candidate, not become the place where product behavior is finished.

## Delivery structure

### Stack 1: core correctness

1. Forward-port observer correctness fixes:
   - preserve the 0.39.1 XML prompt-shape fix on main;
   - normalize observer prompt Unicode safely;
   - retain valid observer content when XML shape repair is required;
   - keep extraction replay behavior consistent with live ingestion.
2. Validate embedding tensor conversion before accepting model output.

These changes remain separate because observer parsing and embedding conversion have different failure modes and test surfaces.

### Stack 2: sharing completion

1. Reconcile disabled coordinator enrollments and revoke stale device access (`codemem-8x4i`).
2. Carry the exact inherited Project set through add-device preview, signed intent, and recipient inspection (`codemem-97si`).
3. Persist enrollment reconciliation issues with an actionable lifecycle (`codemem-10qd`).

Each issue gets its own PR so security-sensitive revocation can land independently of review-state UX.

## Safety rules

- Enrollment and policy decisions fail closed.
- Revocation is idempotent and does not affect unrelated devices.
- Reviewed Project intent is bound to stable canonical Project identities.
- Reconciliation issue persistence is additive and upgrade-safe.
- Existing databases require no manual migration.
- No private evaluation corpus or local artifact path enters the repository.

## Validation

Each PR runs focused tests plus the workspace gate. The completed product state must also pass:

- fresh install and identity bootstrap;
- direct Identity and Team sharing;
- second-device onboarding and inherited Project review;
- disabled-device revocation and convergence;
- unrelated-Project isolation;
- offline retry and recovery;
- migration and older-peer compatibility;
- packaged OpenCode, Claude, and Codex plugin smoke checks.

After these checks pass, stale beads are closed or explicitly superseded. Stable 0.40 release preparation begins only after that backlog and dogfood review.
