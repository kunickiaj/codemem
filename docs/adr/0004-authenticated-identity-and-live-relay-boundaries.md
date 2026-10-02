# ADR 0004: Authenticated Identity and live-relay boundaries

**Date:** 2026-10-01  
**Status:** Accepted for architecture boundaries; implementation gates remain

## Context

Codemem is local-first. Current direct sync carries signed, scoped replication
between devices. Coordinator enrollment is not a Project grant; future login
must not become one either.
This ADR records approved boundaries for an auth-first slice and a possible
future live relay. It does **not** approve a general login rollout, account
recovery, account linking, or provider deployment.

## Accepted decisions

### Identity, devices, and access

- An **Identity** is backed by one canonical actor ID. Each runtime uses one Identity; it
  can have many devices and belong to many Teams.
- Personal and Work are distinct Identities, even when one person controls
  both. Their privileges never union automatically.
- Work receives an OSS or personal Project through an explicit share with that
  Identity or a Team it belongs to. Sharing with the Work Identity does not
  share the Project with its Work Team.
- Coordinator membership, device enrollment, and login remain separate from
  Project authorization. Login never writes `identity_devices`. After explicit
  device binding, a device inherits direct Identity grants and Team grants
  according to each Team's device-eligibility mode.
- Existing device and provenance-based deletion authority stays unchanged.

Example: signing in as a Work Identity may make its Teams visible, but it does
not make a personal Project visible unless that Project was explicitly shared
with the Work Identity or an eligible Team.

### Provider verification

- A provider identity key is the exact configured issuer plus subject. Names
  and email addresses never auto-link an Identity. Email is display-only, not
  an authorization credential.
- A provider link references an actor; it has no separate Identity lifecycle
  or merge authority (ADR 0001, Decision 1). Mapping authority, uniqueness,
  and revocation remain implementation decisions.
- The first provider is configurable Google OIDC using only `openid` and
  `email` scopes. GitHub OAuth is not treated as generic OIDC automatically.
- Use a mature, portable OIDC verifier. Do not parse JWTs or implement crypto
  by hand for coordinator auth. The existing MCP verifier is not a reference
  implementation to copy; changing that separate flow is out of scope.
- A failed login cannot rewrite Identity ownership, erase local data, or
  silently change legacy sync. Offline login failure leaves local-only work
  available.

### Sync and future relay

- Auth must work with existing direct sync. Local-only and relay-free paths
  remain available; direct and LAN paths are always preferred.
- A future relay is optional and live-only, with end-to-end encryption between
  peers: the relay cannot decrypt memory payloads. It retains no payloads or
  peer decryption keys. TLS to the relay alone is insufficient. Choose a vetted
  encryption construction at the relay security gate, not custom crypto.
  The relay does not replace direct sync.
- Both endpoints must trust and permit each other. An operator can disable the
  relay.
- The live protocol multiplexes named peers while preserving the current
  signature, scope, nonce/replay, cursor, and apply-acknowledgement checks.
- The recommended relay host is a hibernating Durable Object isolated from the
  coordinator. A future implementation must not use timers to keep it alive.
  Clients retain the existing 120-second reconciliation default and persisted
  sync state.

For a new coordinator setup, relay fallback may default to allowed only after
dogfood validation, clear disclosure, and an off switch. Existing setups stay
explicit opt-in.

## Threat and decision matrix

| Risk | Boundary | Required outcome |
| --- | --- | --- |
| Same email on two accounts | Issuer + subject only | No automatic Identity merge |
| Work account reaches personal data | Explicit Project sharing | No privilege union or Team shortcut |
| Login silently adds a device | Separate login from reviewed device assignment | Login alone creates no binding and gains no grants |
| Relay replay or peer confusion | Signed named-peer protocol | Scope, nonce, cursor, and apply acknowledgements survive multiplexing |
| Relay retention | Live-only end-to-end encrypted transport | No retained payloads or peer decryption keys |
| Offline/provider failure | Local-first behavior | Local data and legacy sync remain intact |

## Proposed mechanism, not a final contract

The initial binding policy is a proposal for the implementation design review:

1. An existing actor cannot be claimed from a matching email or name.
2. Provider login proves only the provider identity.
3. Binding that identity to an existing Identity requires proof from a device
   that already controls that Identity and a reviewed enrollment flow.
4. The current single-user MCP login flow is not evidence that it can authorize
   a multi-user binding.

This proposal must also cover the first binding of an existing actor ID. A
caller-supplied actor ID and a new device signature do not prove ownership,
even if the coordinator has never seen that actor before. Do not let a first
login claim an arbitrary unregistered actor ID.

The OIDC callback must not make an ownership binding or device grant durable.
Finalization requires single-use proof from the initiating runtime, bound to
its login attempt and device key, using a secret unavailable to someone who
merely follows the browser authorization URL. A loopback redirect alone is
not sufficient. The exact finalization protocol still needs security review;
binding an existing Identity also requires its controller's approval.

The proposal does not decide enrollment UX, recovery evidence, or the
account-linking protocol. No binding behavior is approved by this ADR.

## Deferred decisions and required gates

The authentication decision task owns first-account binding, additional
providers, device enrollment, and account linking. Lost-key recovery remains
tracked in `codemem-79h7`. Do not guess historical ownership or run cleanup
from inferred identity matches.

The proposed safe default is to require explicit approval from an already
trusted Identity-controlling device when adding a device. Login alone does
not enroll it. First-account binding, revocation propagation, and fully lost
device recovery need separate approved proof rules before runtime changes.

The authentication decision task also owns coordinator mapping authority and
revocation propagation, including what an offline peer can enforce. Do not
claim that provider logout revokes direct-sync keys. These decisions block
runtime authentication; they are not deferred implementation details.

Before an auth rollout, validate:

- exact issuer/subject matching, token signature and claim validation, and
  no-email-link regression cases;
- binding attempts from an untrusted device, a failed login, and an offline
  device leave ownership and local data unchanged;
- direct sync, local-only use, provenance, deletion authority, scope checks,
  cursors, and apply acknowledgements retain their current behavior; and
- first binding, controller approval, mapping authority, revocation/offline
  behavior, recovery, and account-linking architecture receive their separate
  security approval.

Before relay availability or a default fallback, validate:

- end-to-end encrypted live forwarding retains no payloads or peer decryption keys;
- both endpoint permissions, operator disablement, disclosure, and off-switch
  behavior fail closed;
- multiplexed peers retain signatures, scopes, nonce rejection, cursors, and
  apply acknowledgements; and
- dogfood proves hibernation and 120-second persisted client reconciliation
  without timers that keep the relay alive.

## Consequences

After the auth gates above pass, implementation can add an auth-first path
without changing who can read a Project. Relay work remains a later,
separately approved security boundary.
No live provider or relay deployment was performed for this ADR.
