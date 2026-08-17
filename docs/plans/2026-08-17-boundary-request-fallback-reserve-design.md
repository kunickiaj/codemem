# Boundary request fallback reserve

## Context

Boundary hook timeouts reserve command-fallback time from the configured host budget. Input reading, normalization, and session-state cleanup happen after the deadline starts, so the initial boundary request can still consume the entire live remaining budget when preprocessing takes long enough.

## Design

- Apply the existing fallback reserve to the initial boundary HTTP request using the live remaining budget.
- Keep the configured boundary timeout as an upper bound.
- Preserve the existing reserve on the durable HTTP retry.
- Leave ordinary non-boundary ingestion unchanged.
- Add a deterministic regression that advances the hook clock during input processing and verifies command fallback retains the full reserve.

## Consequences

Boundary requests may receive a shorter timeout after expensive preprocessing, but command fallback remains available before the host deadline. The reserve calculation and overall deadline remain unchanged.
