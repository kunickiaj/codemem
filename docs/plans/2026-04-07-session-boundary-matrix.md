# Injection-First Session Boundary Matrix

**Status:** Draft
**Date:** 2026-04-07
**Parent policy:** `docs/plans/2026-04-07-track-3-injection-first-memory-policy.md`
**Primary bead:** `codemem-fbpg`

## Purpose

Turn Track 3 sessionization policy into a concrete, implementation-oriented
matrix that determines:

- what class of session codemem is observing
- whether that session should emit no summary, delayed recap, or durable summary
- how automatic injection should treat memories from that session class

The objective is not to maximize summary coverage. The objective is to reduce
rediscovery, scouting, and repeated work during automatic injection.

## Available Signals Today

The current raw-event / ingest path already derives these useful signals:

- `promptCount`
- `toolCount`
- `durationMs`
- `filesModified`
- `filesRead`
- `firstPrompt`
- whether the latest prompt is trivial (`yes`, `ok`, `approved`, etc.)
- whether any typed observations were produced
- whether only a summary would be stored

This matrix is intentionally grounded in those existing signals so the first
implementation slice can be small and testable.

## Session Classes

### 1. Trivial turn / acknowledgement

#### Typical signals

- trivial prompt or acknowledgement
- `promptCount <= 1`
- `toolCount == 0`
- no file modifications
- duration very short
- no typed observations

#### Default storage policy

- no durable summary
- no recap
- session may exist structurally, but should not emit reusable memory by default

#### Automatic injection treatment

- never a preferred source
- effectively ignored unless linked to a later richer session artifact

#### Why

These events do not reduce future scouting or decision rediscovery. They are
almost pure prompt noise.

---

### 2. Micro-session (low-value)

#### Typical signals

- duration `< 1 minute`
- `promptCount <= 1`
- `toolCount <= 2`
- no file modifications
- no typed observations
- maybe one assistant response and a summary-like observer output

#### Default storage policy

- suppress summary-only output by default
- keep no durable summary unless explicit recap request or unusually strong evidence

#### Automatic injection treatment

- recap from this class should be strongly demoted or absent
- typed outputs from this class should only survive if they contain unusually high-value learning

#### Why

This is the class most likely to flood the system with recap sludge while adding
little scouting or decision value.

---

### 3. Micro-session (high-signal)

#### Typical signals

- duration still short, but one or more of:
  - typed observations were produced
  - meaningful file modification occurred
  - strong troubleshooting / decision / discovery content is present
  - explicit summary request

#### Default storage policy

- allow typed observations
- summary optional, but should be concise and justified by strong evidence

#### Automatic injection treatment

- typed observations may be eligible
- summary/recap should still be conservative unless explicitly requested

#### Why

Short sessions are not inherently useless. Some concentrated fixes or decisions
really do happen quickly. The key is whether the output reduces future effort.

---

### 4. Working session

#### Typical signals

- duration roughly `1–10 minutes`
- multiple prompts and/or multiple tool events
- some work movement, maybe file reads/modifications
- likely multiple substeps in one coherent thread

#### Default storage policy

- allow typed observations when present
- allow summary only if it adds orientation or outcome value
- prefer observations over broad recap

#### Automatic injection treatment

- durable observations are good candidates
- summaries are secondary support artifacts, not the main payload

#### Why

This is the main middle category. It should produce reusable memory when it
contains real progress, but it should not default to summary-first behavior.

---

### 5. Durable work session

#### Typical signals

- duration `> 10 minutes` or clearly substantial multi-step work
- meaningful tool + prompt depth
- multiple decisions, discoveries, fixes, or implementation steps
- file modifications and coherent thread continuity

#### Default storage policy

- allow multiple typed observations
- allow durable `session_summary`
- summary should reflect the primary thread and outcomes, not generic process narration

#### Automatic injection treatment

- strong candidate source for future decisions, code scouting, and troubleshooting reuse
- summaries may be included, but typed durable observations should remain primary

#### Why

This is the intended summary-producing class.

---

## Decision Matrix

| Session class | Summary-only output | Typed observations | Default summary behavior | Automatic injection treatment |
|---|---:|---:|---|---|
| Trivial turn / acknowledgement | suppress | suppress | none | ignore |
| Micro-session (low-value) | suppress | usually suppress | none or explicit-only | heavily demote |
| Micro-session (high-signal) | allow only with strong evidence | allow | optional, narrow | prefer typed output over recap |
| Working session | usually avoid summary-only | allow | conditional | durable typed output preferred |
| Durable work session | allow | allow multiple | durable summary allowed | good source for injection |

## Concrete Rule Proposals

### Rule A — summary-only output requires stronger evidence than today

Do not store summary-only output unless at least one of the following is true:

- explicit summary / recap request
- non-trivial duration and activity
- meaningful file modification
- strong completed/learned/investigated content with future-use value

### Rule B — typed observations are the main reusable artifact

For working and durable sessions, extraction should favor multiple durable typed
observations over one broad recap whenever the session contains multiple distinct
high-signal outcomes.

### Rule C — automatic injection should trust session class

Session class should influence injection defaults:

- trivial + low-value micro sessions should rarely inject directly
- working sessions should prefer typed durable outputs
- durable sessions may contribute summaries, but only as support for the main
  observations

### Rule D — explicit recap mode is different

Some recap content is acceptable for `summary of X` or `catch me up`, even when it
would be too noisy for default automatic injection.

## Edge Cases

### Fast but meaningful fix

A short session that contains a real bugfix or decision should not be discarded
just because it is short. This is why the matrix distinguishes low-value and
high-signal micro-sessions.

### Long but low-value session

Duration alone is not enough. A long session with mostly administrative chatter
should not automatically earn a durable summary if it still does not reduce
future effort.

### Multi-thread session

If a session covers multiple substantive threads, extraction should not collapse
everything into one generic summary. The model should produce multiple typed
observations when justified.

## Known pressure from current dogfooding

The captured rich-session under-extraction case (`codemem-31ha`) is a good
example of why this matrix matters. A long, high-signal session produced too few
durable memories and an overly narrow summary. That failure suggests:

- current extraction is too lossy for rich sessions
- typed observations are under-produced relative to session richness
- summary-only or summary-dominant behavior still needs stronger controls

## First Implementation Slice

Keep the first slice small and grounded in current signals:

1. Formalize the session classes in code-level helper logic
2. Strengthen summary-only gating using the matrix above
3. Add explicit tests for:
   - trivial turn suppression
   - low-value micro-session suppression
   - high-signal short-session preservation
   - working session with typed observations
   - durable session producing multiple typed outputs + summary
4. Feed the rich-session eval case into `codemem-24q2`

## Open Questions

- Should delayed recap exist as a separate artifact from durable `session_summary`?
- How should the system merge conceptually continuous work across local session rows?
- Which parts of session class should be persisted as metadata for later injection/ranking?
- How much should session class affect retrieval weighting directly versus write-time filtering?
