# Native Required Checks Design

GitHub branch protection should require the repository's normal CI jobs directly instead of a custom aggregate gate.

The repository will require `TypeScript Test`, `TypeScript Lint`, and `Plugin Smoke Test`, matching its pre-gate policy. These jobs are unconditional. TypeScript checking, Worker tests, packaged-plugin smoke tests, E2E jobs, and the conditionally skipped Windows smoke job continue to run but remain advisory for pull-request merge protection.

GitHub's native check-result semantics remain authoritative. This accepts the narrower pre-gate protection policy in exchange for removing custom aggregation logic; release workflow calls still require the complete CI workflow to succeed.

The code cleanup removes the `CI Gate` workflow job, implementation, tests, package script, lint configuration, and contributor guidance. The lint-feedback allowlist will no longer accept any deleted CI helper path, with negative assertions preventing classifier, topology, or gate paths from returning.

The migration updates branch protection before removing the gate, preventing a window without required checks. Validation covers the focused lint-feedback suite, the full project check, and the resulting workflow diff.
