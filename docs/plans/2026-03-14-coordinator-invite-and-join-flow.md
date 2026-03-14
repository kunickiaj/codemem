# Coordinator Invite and Teammate Join Flow

**Bead:** `codemem-mc5`  
**Status:** Design  
**Date:** 2026-03-14

## Problem

Coordinator-backed sync now has the right low-level pieces:

- reachable coordinator service
- device enrollment
- coordinator presence and peer lookup
- local and remote admin flows

But the end-user experience is still too operator-heavy and too easy to get wrong.

Today, a teammate often has to understand too many separate concepts:

- deployment target
- enrollment
- pairing
- presence
- local config
- remote admin

That is not an acceptable primary product flow for team onboarding.

## Goal

Design an idiot-proof coordinator invite/join flow for remote teams where:

- a codemem user acting as team admin can stand up or point at a reachable coordinator
- a teammate can connect with minimal manual setup
- the same conceptual flow works across deployment targets (Cloudflare, Fly.io, DO, built-in service)
- direct peer-to-peer sync remains the data path after onboarding

## Product framing

The coordinator should be treated as one product concept:

- **reachable self-hosted coordinator service**

Cloudflare is one deployment target for that concept, not the product itself.

That means the primary UX should optimize for:

- "I have or can get a reachable coordinator endpoint"
- not for any one specific hosting provider

## Primary personas

### Team admin

The codemem user who:

- configures the coordinator for a team
- manages who can join
- wants teammates to get connected quickly

### Teammate

The person who should mostly:

- accept an invite
- connect their device
- pair once
- start syncing

They should not need to understand D1, Wrangler, SQL, or manual enrollment internals.

## Recommended model

### Team-scoped invite payloads first

The first invite model should be **team-scoped**, not device-scoped.

Reason:

- easiest admin mental model
- easiest teammate mental model
- enough for small trusted teams

Device-scoped invite flows can come later for stricter environments or replacement-device stories.

### One canonical invite artifact

Use one logical invite payload that can be represented as:

- a pasteable/importable string
- a link/open target

Recommended first payload contents:

- coordinator base URL
- group identifier
- policy mode (`auto_admit` or `approval_required`)
- enrollment grant or join token
- expiration timestamp
- optional display metadata for the team/coordinator

The exact transport can vary, but the logical payload should stay one thing.

### Entry points

Support both of these, but optimize for paste/import first:

1. paste/import invite string in CLI or UI
2. open/click link that wraps the same payload

Paste/import should be the reference path because it is easier to test and less browser-dependent.

## Admission policy

### Default: auto-admit

For the first product flow, the default should be:

- teammate imports invite
- device is admitted immediately

Why:

- best small-team UX
- lowest friction
- matches the current need for "connect and go"

### Optional: approval-required

For stricter teams, the same invite should support:

- teammate imports invite
- coordinator creates a pending join request
- admin approves before the device becomes active

This should be a policy toggle, not a separate entirely different product.

### Recommended approach

Use a **hybrid** model:

- same invite mechanism
- configurable policy
- default to `auto_admit`

## Admin flow

Recommended first admin flow:

1. choose or connect to a reachable coordinator
2. create/select a team group
3. choose invite policy (`auto_admit` by default)
4. generate invite
5. share invite with teammate
6. inspect join status / enrolled devices / health in one place

The admin should not need to hand-write SQL or manually interpolate device identity in the normal path.

## Teammate flow

Recommended first teammate flow:

1. receive invite
2. paste/import invite or open link
3. codemem configures the coordinator target and group automatically
4. if `auto_admit`, enrollment completes immediately
5. if `approval_required`, codemem shows pending state clearly
6. codemem guides the user through pairing if needed
7. health view confirms discovery + sync status

## What invite import should automate

At minimum, importing an invite should handle:

- coordinator URL configuration
- group selection
- enrollment request or grant redemption

It should not require the teammate to manually edit config files or understand remote admin concepts.

## Pairing relationship to invites

Invite/join does **not** replace peer trust entirely.

Current assumption:

- invite flow gets the device enrolled in the coordinator and visible
- direct sync still requires appropriate trust/pairing flow

However, the UX should make that explicit instead of leaving users to infer it.

Recommended first product behavior:

- after successful invite import, codemem checks whether the expected peer trust relationship exists
- if not, it guides the user into the appropriate pairing step next

## Required UX surfaces

### Admin

- create invite
- choose auto-admit vs approval-required
- view pending joins / active devices
- rename / disable / remove devices

### Teammate

- import invite
- see success/pending state clearly
- be guided into pairing if required

### Shared health/status

One status surface should answer:

- enrolled?
- paired?
- posting presence?
- discovered peers fresh?
- direct sync reachable?

If we do not provide this, the product will continue to feel like guesswork.

## Non-goals for first implementation

- no browser-heavy SaaS account flow
- no full web admin console requirement
- no QR-code onboarding yet
- no relay/proxy transport bundled into invite flow
- no per-device role matrix

## Recommended implementation slices

### Slice 1: invite payload contract

- define payload shape
- define signing/expiration model
- define import parsing path

### Slice 2: admin invite generation

- generate invite for a group
- choose policy mode
- produce paste/import payload and link form

### Slice 3: teammate invite import

- CLI/UI import flow
- apply coordinator config
- perform enrollment or join request

### Slice 4: pending-approval workflow

- pending join records
- admin approve/deny action
- teammate pending state UX

### Slice 5: onboarding status/health walkthrough

- unified status surface for enrollment/pairing/presence/sync

## Acceptance criteria

This design is successful when:

1. The primary user is the codemem team admin, not an abstract infra operator.
2. Team-scoped invites are clearly defined as the first onboarding model.
3. Paste/import and link/open are treated as two entry points for one invite artifact.
4. `auto_admit` is the default and `approval_required` is a policy variation, not a separate product.
5. The next implementation slices are concrete enough to turn into beads immediately.
