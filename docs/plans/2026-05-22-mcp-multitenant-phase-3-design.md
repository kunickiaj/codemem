# Phase 3: native multi-tenant MCP authorization design

Design ADR for `codemem-986p.7`. Plans how to safely serve multiple authenticated human principals through a single codemem MCP endpoint, each constrained to authorized Sharing domains, after Phase 1 (single-user remote MCP) and Phase 2 (partner v1 via two peered endpoints) are in production.

This document does not propose implementation. It defines the authorization model, identifies enforcement points across every MCP tool, and lists follow-up beads that must land before any Phase 3 code ships.

## Status

Draft. Phase 1 and Phase 2 must be running in production before Phase 3 implementation begins. Reviewing for conceptual soundness only; expect significant edits before any code lands.

## Context

| Phase | Shape | Authorization surface |
|---|---|---|
| Phase 1 (`codemem-986p.15` + .16 + .17) | One MCP endpoint, one OIDC subject in the allowlist | OIDC identity → opaque bearer → all local memory |
| Phase 2 (`codemem-986p.6`) | Two MCP endpoints, one per person, peered via Sharing domain | Each endpoint is Phase 1; cross-person memory is replicated, not authorized at MCP layer |
| **Phase 3 (this doc)** | One MCP endpoint, multiple OIDC subjects | OIDC identity → principal → grants → per-tool, per-scope authorization |

Phase 3 must not be smuggled into Phase 1's endpoint; it requires its own authorization stack, enforcement points, audit shape, and migration path.

## Goals

A Phase 3 deployment lets multiple authenticated humans use one MCP endpoint such that each one sees only the memories they have been granted, across every MCP read tool, write tool, and ranking surface.

- Authenticate each request to a stable codemem **principal** that is independent of the OAuth `client_id` or upstream OIDC `sub` rotation.
- Resolve, on every MCP request, the set of **Sharing domains** that principal is currently authorized to read and/or write.
- Enforce that authorization at every retrieval, ranking, and write surface — not only at the tool entry point.
- Make denials observable (in audit events) without leaking memory content, token material, or non-public principal metadata.
- Provide a migration path from Phase 2 partner-v1 deployments that preserves all Phase 2 properties (revocation semantics, replication ownership) and lets operators choose to stay on Phase 2 indefinitely.

## Non-goals

- **No Cloudflare-native SaaS storage decision.** Phase 3 may run on the same self-hosted topology as Phase 1.
- **No encrypted-payload or key-rotation design.** Confidentiality at rest stays out of scope.
- **No erasure guarantee** for memories already copied through P2P sync into another local codemem instance or already pulled into a model context window. Phase 3 inherits Phase 2's honest revocation semantics: stops *future* access.
- **No re-architecture of the existing Sharing-domain (`scope_id`) boundary.** Phase 3 builds on top of it; it does not replace it.
- **No implementation in this document.** Hard enforcement points and tests are identified so they can be filed as separate beads.

## Identity model

### OAuth subject → codemem principal mapping

OIDC `sub` claims may rotate (provider key rolls, account migrations, email changes). MCP authorization must not depend directly on `sub`. Introduce a stable internal **principal** identifier owned by codemem.

```
[OIDC identity]            [codemem principal]              [grants]
  sub=acct-123       ──►   principal=p_adam_xyz       ──►   read/write home-shared
  email=adam@…             primary_email=adam@…             read work-oss
                           created_at=…                     read/write personal-adam (owner)
                           status=active|suspended
```

Identity bindings are explicit, append-only, and reversible:

- A single principal can have multiple OIDC identity bindings (subject + verified email). At least one binding must match for the principal to authenticate.
- A binding can be marked `revoked_at`, which immediately stops future authentication via that identity without losing the principal's history.
- The Phase 1 single-user allowlist becomes a principal with exactly one binding; existing deployments upgrade in place.
- Coordinator group membership is **not** an identity binding and **not** a data access grant — it remains discovery/pairing metadata only.

### Owner principal

Every codemem instance has exactly one **owner principal** corresponding to the human who runs the host. The owner principal:

- Owns every Sharing domain not explicitly created for sharing.
- Is the implicit principal for stdio MCP and viewer-server (which stay un-authenticated).
- Cannot be deleted; it can be renamed or have its identity binding rotated.

## Authorization model

### Grants

A **grant** is a tuple:

```
(principal_id, scope_id, role, granted_by, granted_at, expires_at?, revoked_at?)
```

Where:

- `scope_id` is an existing codemem Sharing-domain identifier — the hard boundary already in use for P2P sync. Project filters cannot appear in grants; they are narrowing only.
- `role` is one of a deliberately small initial set:
  - `read` — principal may read memories in this scope through MCP read tools, but writes that target the scope are rejected.
  - `read_write` — principal may read and may write through `memory_remember` and observer ingestion paths into this scope.
  - `admin` — principal may create / modify / revoke grants for this scope (used by the owner principal and any delegated co-owner). Implies `read_write`.
- `granted_by` is the principal that issued the grant (the owner principal for the initial grant on each scope).
- Optional `expires_at` supports time-boxed access without manual revocation.

Roles are intentionally coarse. Per-tool roles (e.g. "may use `memory_pack` but not `memory_remember`") are deferred until a real use case appears; introducing them later is additive.

### What grants do NOT do

These distinctions matter because the existing codemem domain already has overlapping concepts:

- `trust_state` is descriptive metadata about memory provenance, not authorization. Phase 3 must not conflate it with grants.
- Project filters narrow within an authorized scope. They cannot grant access to memories outside an authorized scope, and they cannot be used as a security boundary.
- Coordinator group membership is irrelevant to MCP authorization. A principal may belong to a group and have zero grants.

## Enforcement points

Authorization must run before any operation that could surface memory data, not only at the MCP tool entrypoint. Below are the surfaces that exist today; every one of them needs a Phase 3 enforcement check.

### Read enforcement

For every authenticated MCP request:

1. Resolve `principal_id` from the bearer token (set at /token issuance after OIDC identity check).
2. Resolve `authorized_read_scopes = {scope_id where grant.role ∈ {read, read_write, admin} ∧ not expired ∧ not revoked}`.
3. Pass `authorized_read_scopes` into every retrieval call as a **mandatory filter**, not an optional one.

Surfaces to instrument:

| Surface | Today | Phase 3 requirement |
|---|---|---|
| `memory_search` | Hybrid BM25 + sqlite-vec merge over all local memories | Filter candidate set to `authorized_read_scopes` **before** ranking, merge, and re-ranking. Authorized scope must be enforced inside the SQL/vector queries, not as a post-filter on already-ranked results. |
| `memory_pack` | Builds packs from search + recency + kind-boosted results | Same filter as `memory_search` applied at candidate construction, plus during near-related expansion and during the second-pass re-rank. |
| `memory_recent` | Most recent memories | SQL `WHERE` on `authorized_read_scopes`. |
| `memory_timeline` | Chronological windows around an anchor | Anchor itself must be in scope; neighborhood expansion must clamp to `authorized_read_scopes`. |
| `memory_get_observations` | Fetches detail rows for a list of IDs | Validate every requested ID belongs to `authorized_read_scopes`; never return partial results that include an unauthorized ID. |
| `memory_expand` | Pulls related memories | Same as timeline. |
| `memory_explain` | Returns the reasoning trail for a result | Trail must redact memories not in `authorized_read_scopes`. If the redaction would change the explanation materially, return a denial reason, not a misleading trail. |
| `memory_schema` | Returns the tool/schema description | No memory content; no scope check required. |
| Plugin/observer-driven pack injection (Phase 1 stdio / viewer) | Reads local DB to build context for the owner | Out of scope — these paths run as the owner principal. Multi-tenant remote MCP is the only Phase 3 enforcement surface. |

The blanket rule: **authorization is a query predicate, not a post-filter.** Phase 3 must not rely on dropping rows after ranking; that pattern leaks data through ranking metadata and pack-size budgets.

### Write enforcement

| Surface | Today | Phase 3 requirement |
|---|---|---|
| `memory_remember` (direct write) | Writes a memory into the caller's project / scope | Scope of the write must be in `authorized_write_scopes` (subset where role ∈ {read_write, admin}). Writes without an explicit scope fall to the principal's owned default scope, never the owner's private scope. |
| `memory_forget` | Soft-deactivates a memory | Only allowed if the memory is in `authorized_write_scopes`. A principal cannot deactivate memories outside their grants even if they can read them. |
| Observer ingestion via remote MCP | Captures session activity | Out of scope for v1 of Phase 3. Observer pipeline stays owner-principal-only; remote principals cannot push raw events. Revisit when a real use case appears. |
| `memory_pack` writes (none today) | n/a | Document explicitly that `memory_pack` is read-only. |

Write tagging: every Phase 3 write records the writing principal in memory metadata (`written_by_principal`). The existing `device_id` / `actor_id` columns remain; principal identity is additive and surfaces in audit and viewer.

### Re-ranking and pack construction

Authorization must hold during **every** re-rank pass and pack-assembly stage, including:

- Initial candidate selection (SQL filter).
- Hybrid lexical + semantic merge.
- Recency / memory-kind boost.
- Near-related compression / expansion.
- Final pack budget trimming.

A unit-test convention should be added: every retrieval surface that takes a scope filter must reject test fixtures that introduce an unauthorized memory, even when ranking would otherwise rank it highly.

## Write semantics

Where do partner principals' writes land?

1. If the request specifies a `scope_id`, the write must succeed only when that scope is in the principal's `authorized_write_scopes`. Otherwise the write is rejected with a denial reason; no fallback scope is used.
2. If the request does not specify a scope, the write lands in the principal's **owned default scope**. Every principal must have exactly one owned scope provisioned at first authentication.
3. The owner principal's owned default scope is the existing pre-Phase-3 behavior. Other principals get their own owned scopes; they never inherit the owner's.
4. Project mapping happens within the chosen scope, never across scopes.

Writes are never reassigned to a different scope by retrieval ranking, observer enrichment, or P2P sync. P2P sync still uses scope as its replication boundary.

## Audit

Phase 3 extends the Phase 1 OAuth audit events with authorization outcomes. New event categories:

| Kind | Outcome | Fields (always redaction-safe) |
|---|---|---|
| `principal_login` | success / denied | `subject_hash`, `principal_id`, `reason?`, `remoteAddress` |
| `tool_authorization` | success / denied | `principal_id`, `tool`, `requested_scopes` (only IDs, never names if names contain PII), `authorized_scopes`, `denied_scopes`, `reason?` |
| `write_authorization` | success / denied | `principal_id`, `tool`, `target_scope`, `reason?` |
| `grant_mutation` | success / denied | `acting_principal_id`, `target_principal_id`, `scope_id`, `role`, `action ∈ {issue, modify, revoke, expire}` |

Bearer events from Phase 1 continue unchanged. Phase 3 events follow the same "no token, no code, no secret, no memory content" rules in [remote-mcp-oauth.md](../remote-mcp-oauth.md#audit-log). The `buildOAuthAuditEvent` redaction guard from `codemem-986p.16` must be extended to cover the new fields with the same forbidden-key check.

## Revocation

Phase 3 inherits Phase 2's honest revocation semantics and adds finer-grained controls:

- Revoking a **grant** stops future access for that principal to that scope. It does not delete memories already replicated to other peers or already pulled into a model context window.
- Revoking an **identity binding** stops future authentication via that OIDC identity. Other bindings on the same principal remain valid.
- Suspending a **principal** invalidates all of its bearer tokens immediately (via the existing `/oauth/revoke` plus an additional principal-wide bearer-revocation path) and rejects future authentication.
- All three actions emit `grant_mutation` audit events.

No revocation operation promises retroactive deletion. Operator docs must surface this in the same place revocation actions are exposed.

## Migration from Phase 2

The Phase 2 partner-v1 deployment must remain a fully-supported configuration after Phase 3 ships. Operators choose; codemem does not deprecate the peered topology.

Migration shape for operators who want to converge two Phase 2 peered instances onto one Phase 3 endpoint:

1. Both sides keep running their Phase 2 endpoints throughout the migration.
2. On the target host, the owner provisions a principal for the partner using their OIDC identity.
3. The owner grants the new principal `read_write` on the shared Sharing domain that was previously replicating between the two instances.
4. The partner reconfigures Claude (or other MCP client) to point at the target endpoint. The previous Phase 2 endpoint stays available as a fallback.
5. Once the partner's traffic has fully shifted, the operator can decommission the second endpoint, leaving the second SQLite database as a passive backup until the operator chooses to retire it.

The migration is reversible at any step. Phase 3 must never require deleting the second Phase 2 deployment.

## When to choose Phase 3 vs Phase 2

The Phase 2 doc (`docs/remote-mcp-partner-v1.md`) explicitly recommends staying on the two-endpoint topology for partner deployments. Phase 3 only pays for itself when:

| Condition | Phase 2 (peered) | Phase 3 (multi-tenant) |
|---|---|---|
| Number of human principals to support | 2 | 3 or more |
| Need to deploy a single public endpoint | optional | required |
| Per-principal scope filtering required at MCP layer | not required | required |
| Operator willing to run two hosts and own two SQLite DBs | yes | no — single host |
| Tolerance for additional authorization-layer code, tests, and audits in MCP | low | high — significant work to maintain |

If two operators are willing to run their own hosts, Phase 2 is the safer choice — it has fewer enforcement points, fewer ways to misconfigure, and zero MCP-level cross-principal trust surface. Phase 3 is preferred only when single-endpoint operation is a hard requirement or when scaling beyond two principals.

## Risks and open questions

These need closure before implementation:

- **Scope-filter primitives in `@codemem/core`.** The current SQL / vector queries take an optional project filter, not a mandatory scope filter. Adding a mandatory filter is a Sharing-domain enforcement bead; Phase 3 depends on it landing first. Confirm with the Sharing-domain track owner that this dependency is acceptable.
- **Vector index scoping.** sqlite-vec embeddings are stored alongside memory rows; scope filtering during ANN search may interact poorly with vec quantization or partition keys. Investigate whether scope must become a vec partition key or whether a post-vec scope filter is acceptable.
- **Per-principal owned scopes.** Provisioning needs a deterministic policy (auto-create on first authentication vs. operator-only). Auto-create simplifies onboarding but conflicts with the "operator chooses" framing; default to operator-only, with a one-command provisioning helper.
- **Bearer token-store sharing.** Phase 1 uses a single in-memory token store. Phase 3 likely needs persistent storage (so principal-wide revocation survives restarts). This is another follow-up bead; out of scope for this design.
- **Grant UI.** Operators must be able to see all grants in one place, see what each principal has access to, and revoke quickly. The viewer is the natural surface but is currently localhost-only. Decide whether grant management runs through viewer, CLI, or both.
- **Audit log volume.** Per-request `tool_authorization` events on a high-traffic endpoint can dominate the stderr stream. Specify rotation, sampling, or a structured sink before Phase 3 ships.
- **Principal proliferation.** What stops the owner from creating dozens of principals to share a single connector with many people? Nothing in the design — by intent. The risk is operator error, not the system enabling it. Document operator responsibility and consider a soft cap with a clear override.

## Follow-up beads to file before implementation

These beads must exist (closed or in-progress) before any Phase 3 code lands. None of them block Phase 1 or Phase 2.

- **Mandatory scope-filter primitives in `@codemem/core`** retrieval/search/pack/expand surfaces. Includes negative tests asserting unauthorized memories never appear in results even with high ranking.
- **Persistent OAuth token + grant store** with principal-wide revocation, replacing the Phase 1 in-memory store. Likely SQLite-backed alongside the existing schema.
- **Principal + identity-binding schema migration** with explicit upgrade path for existing Phase 1 single-user deployments (owner principal auto-created from the existing allowlist).
- **Audit event extensions** (`principal_login`, `tool_authorization`, `write_authorization`, `grant_mutation`) routed through the `codemem-986p.16` audit emitter with the same forbidden-field guard.
- **Phase 3 viewer / CLI** for principal and grant management. May ship behind a feature flag until ready.
- **Phase 3 → Phase 2 fallback runbook** documenting how to revert if Phase 3 causes a security incident.

## Decision summary

Phase 3 is a real product surface and a real security review burden. Adopt it only when the operating constraints (single endpoint, more than two principals) demand it. Until then, Phase 2's peered partner-v1 deployment is the recommended way to share memory between people.

When Phase 3 is built, treat every enforcement point listed above as a hard requirement, not a guideline. Sharing-domain `scope_id` remains the only authorization boundary; project filters, `trust_state`, and coordinator group membership do not authorize anything.

This document closes `codemem-986p.7` as a design ADR. Implementation requires the follow-up beads listed above and a fresh implementation epic at that time.
