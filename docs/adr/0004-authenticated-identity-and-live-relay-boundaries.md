# ADR 0004: Authenticated Identity and live-relay boundaries

**Date:** 2026-10-01  
**Status:** Accepted for architecture boundaries; implementation gates remain;
partly amended by [ADR 0005](0005-authenticated-identity-device-and-membership-lifecycle.md) (2026-10-05)

> **Amendment note:** ADR 0005 replaces the trusted-device approval requirement
> for every additional device with verified-owner enrollment, clarifies that
> login alone never writes device bindings, and narrows admin-assisted
> replacement. See its "Amendments to ADR 0004" table. The text below is kept
> as the original decision record.

## Context

Codemem is local-first. Current direct sync carries signed, scoped replication
between devices. Coordinator enrollment is not a Project grant; future login
must not become one either.
This ADR records approved boundaries for an auth-first slice and a possible
future live relay. Later product approvals below cover migration and recovery
rules, not a completed security protocol or provider deployment.

## Accepted decisions

### Identity, devices, and access

- An **Identity** is backed by one canonical actor ID. Each runtime uses one Identity; it
  can have many devices and belong to many Teams.
- Personal and Work are distinct Identities, even when one person controls
  both. Their privileges never union automatically.
- Separate runtime contexts must use separate databases and key directories.
  Changing the database alone does not isolate the existing default key store.
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
  or merge authority (ADR 0001, Decision 1). Persistence, enforcement, and
  revocation propagation remain implementation decisions.
- The initial account rule is one Google account to one existing actor-backed
  Identity per coordinator, with one account link per Identity and no
  multiplicity flag. See the inert metadata contract in
  [`../contracts/coordinator-auth-account-link.md`](../contracts/coordinator-auth-account-link.md).
- The first provider is configurable Google OIDC using `openid email profile`
  scopes. Name and picture are optional display metadata, with a fallback avatar;
  they never prove ownership. GitHub OAuth is not treated as generic OIDC automatically.
- Do not request Google offline access or retain Google access, refresh, or ID
  tokens after the login ceremony. Store the verified issuer/subject link and
  permitted display metadata, not a reusable Google credential. Profile metadata
  may be refreshed at a later sign-in; it need not remain current between logins.
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

### Approved product flow

- Sign-in belongs to an auth-enabled coordinator, not to local Codemem use.
  Existing direct sync without mandatory coordinator authentication remains
  available. No separate Codemem password registration is introduced.
- Successful login creates a Codemem-owned account-management session, not just
  a permanent account attestation. Sign-out ends that session; it does not remove
  the account link, revoke enrolled devices, or stop their approved background sync.
  Device revocation is a separate explicit action. Session access still requires
  the existing account-link and authorization checks; login cannot claim an Identity.
- Optional sign-in/linking implementation is approved under the reviewed ownership,
  browser-completion, and transactional mapping safeguards below. This approval
  does not cover production configuration or deployment, mandatory-auth activation,
  recovery activation, or relay. Detailed protocol validation and security review
  remain engineering gates, not substitutes for these product rules.
- Migration starts with optional linking from an existing enrolled device.
  Preserve Teams, actor IDs, device keys, Project grants, and memory authorship;
  do not reinvite existing members. Missing or uncertain Identity links need
  explicit review, not email matching or automatic actor adoption.
- The existing mixed Identity keeps its actor ID; do not force a personal/work
  split or change reinvites or default sharing. A future split is explicit and
  reviewed, never inferred from historical authorship.
  Invitation-derived actor claims are not independent account ownership proof;
  derived add-device invitations do not upgrade that proof automatically.
- Additional devices require explicit approval from an existing trusted device,
  using the reviewed add-device invitation. Login alone cannot enroll them.
- If all trusted device keys are lost, the coordinator admin can explicitly
  approve a replacement for the existing Identity and disable lost enrollments.
  Reuse add-device invitations. Do not restore old signing keys or source-device
  deletion authority through Google login. Restore backups if admin authority
  is also lost; do not introduce a separate recovery framework.
- Mandatory authentication for affected Project sync is a separate admin choice.
  The approved policy uses 24-hour signed device permissions checked by peers,
  in addition to Project authorization. Existing enrolled, non-revoked devices
  renew automatically with device-key proof, without routine login or approval.
  If permissions expire while the coordinator is unreachable, affected sync
  waits; local use continues. Offline peers can accept a revoked device's old
  permission until expiry unless they learn its revocation sooner.

These are product rules. The proof, signing, policy-binding, migration, and
anti-downgrade protocols still need approval before runtime changes.

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
The proposed local-browser flow requires both a verifier kept by the initiating
runtime and a separate one-time completion secret delivered only through the
browser's loopback callback. The coordinator validates and fixes that destination
when the attempt starts: literal `127.0.0.1` or `[::1]`, a fixed callback path,
and a runtime-selected port. Reject hostnames and non-loopback destinations;
the destination cannot change after creation. Finalization signs both proofs with that runtime's
device key and binds them to the same short-lived attempt. Polling an attempt
must never reveal the browser completion secret. The loopback listener accepts
only its own outstanding attempt; no binding is written at the OIDC callback.

Both proofs matter: an attacker who starts a login already holds the initiating
verifier and device key. Those alone cannot show that the account owner finished
login on that runtime. The exact finalization protocol still needs security
review; binding an existing Identity also requires its controller's approval.

The browser confirmation must name the account, Identity, and requesting device
and warn against sharing callback URLs. Short-lived, single-use completion
secrets must be stored hashed and kept out of polling, logs, and referrers.
Loopback alone does not protect against someone pasting the secret to an attacker
or a compromised/shared local host; do not claim it does.

The [optional account-link protocol](../contracts/coordinator-auth-protocol.md)
now specifies initial binding, controller attestations, browser sessions, and
guarded persistence. Its focused security review permits the optional store
implementation; backend and browser integration tests still gate runtime use.
The earlier metadata helper alone authorizes no binding. Additional-device
enrollment and recovery activation remain separate reviewed work.

## Deferred decisions and required gates

The authentication decision task owns first-account binding, additional
providers, device enrollment, and account linking. Lost-key recovery remains
tracked in `codemem-79h7`. Do not guess historical ownership or run cleanup
from inferred identity matches.

Trusted-device approval, admin-assisted recovery, and the 24-hour offline window
are approved product rules. Optional first-account binding and account-session
revocation follow the reviewed protocol above. Additional-device enrollment,
mandatory sync enforcement, and recovery proofs still need security validation
before their separate runtime changes.

Coordinator mapping authority and account-session revocation are specified in
the optional protocol. Mandatory sync revocation propagation, including what
an offline peer can enforce, remains a separate activation gate. Do not claim
that provider logout revokes direct-sync keys or that optional login activates
mandatory sync policy.

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
