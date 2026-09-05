# Raw-event microbatch terminal-state fix

## Decision

Exhausted raw-event microbatches should complete as no-ops only when they contain at most two events, contain no assistant output, and had no processable input before any observer call. Empty, malformed, or lossy observer responses remain failures.

## Why

Long-running sessions can end with one or two prompt or tool events after the last useful assistant response. Retrying those fragments cannot add missing context, but marking them `gave_up` makes `codemem status` report a global ingestion failure. Provider, authentication, timeout, parse, and lossy-repair failures must remain failures.

## Data flow

The ingest pipeline carries the selected tier observer's status with every observer call failure and assigns stable reasons to output-validation failures. The flush layer records that status and reason on each failed attempt. At retry exhaustion, the flush layer accepts only `no_processable_input`; empty, malformed, unstorable, and lossy observer output remains `gave_up`. Both terminal paths advance the stream cursor as they do today.

## Validation

Focused tests cover assistant-free two-event completion, diagnosed tier-observer failure, substantive or assistant-backed failure, and existing retry behavior. The core TypeScript and lint checks guard the changed interfaces.
