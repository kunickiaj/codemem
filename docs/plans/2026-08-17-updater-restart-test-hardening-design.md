# Updater Restart Test Hardening

## Goal

Prevent updater restart regressions by making startup fetch doubles strict and by directly exercising the compatibility-mismatch auto-update path.

## Design

- Keep the change test-only; existing production ownership behavior remains unchanged.
- Use a URL-aware helper that returns a real `Response` only for the expected Viewer health endpoint and throws for every unexpected request.
- Preserve release-update coverage while adding compatibility-mismatch scenarios that simulate an outdated CLI, successful installation, and a compatible refreshed version.
- Verify that compatibility auto-update restarts a Viewer started by the current plugin process and does not restart a Viewer that was already running.

## Validation

Run the focused update-notification test file, followed by the complete OpenCode plugin test suite.
