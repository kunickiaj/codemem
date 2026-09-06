# Stacked CI Rollback

Status: Superseded by [Native Required Checks Design](./2026-09-05-native-required-checks-design.md).

The stacked CI optimization will be removed because it saves runner time during review but does not shorten Graphite's sequential merge cycle and prevents upstack pull requests from becoming merge-ready.

## Decision

Revert the changes introduced by pull requests #1610 and #1623. Keep pull request #1614's unconditional aggregate `CI Gate`, which remains the required branch-protection check and preserves the existing full-CI safety contract.

The rollback also removes stack classification, conditional job execution, merge-target authorization, merge-queue additions, and their dedicated documentation and tests. Existing CI jobs return to unconditional execution before the aggregate gate evaluates them.

## Validation

Run the aggregate gate tests, TypeScript checks, lint, and the full test suite. Confirm the workflow retains `CI Gate`, no longer conditionally skips expensive jobs, and no longer rejects pull requests solely because they target another stack branch.
