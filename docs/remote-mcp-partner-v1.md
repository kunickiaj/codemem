# Partner v1: two peered codemem instances

Phase 2 of `codemem-986p`. Use this document to plan a "shared-brain" deployment without building native multi-tenant authorization into a single MCP endpoint.

Phase 1 ([remote-mcp-oauth.md](./remote-mcp-oauth.md)) ships a single-user remote MCP endpoint. Partner v1 composes two of those endpoints — one per person — that exchange selected memories through codemem's existing Sharing-domain (`scope_id`) peer sync.

## Topology

```
[User A Claude] ── OAuth ──► [User A MCP endpoint]   ──►  [User A codemem peer]
                              (User A OIDC subject)        │
                                                         │  Sharing domain
                                                         │  `shared-research`
                                                         │  (explicitly granted
                                                         │   to both peers)
                                                         │
[User B Claude] ─ OAuth ──► [User B MCP endpoint] ───►  [User B codemem peer]
                            (User B OIDC subject)
```

Each side is a complete Phase 1 deployment:

- Own host (home server, VPS, laptop, or other self-hosted machine).
- Own SQLite database under `CODEMEM_DB`.
- Own `codemem mcp http` process with `CODEMEM_MCP_HTTP_PUBLIC_URL`, OIDC client/secret, and a single-user allowlist scoped to **that person only**.
- Own Tailscale Funnel (or equivalent ingress).
- Own bearer tokens.

The two deployments are linked only by the Sharing-domain sync between their codemem cores, not by any MCP-level trust.

## Properties

| Property | Behavior |
|---|---|
| Authentication | Each MCP endpoint authenticates exactly one human (its owner's OIDC subject/email). Partners cannot log in to each other's endpoints. |
| Authorization | Each endpoint reads/writes its own local SQLite. No cross-endpoint MCP authorization exists. |
| Shared memory | Memories tagged with the shared `scope_id` replicate bidirectionally via existing P2P sync. Each side stores its own copy of the shared memories. |
| Write semantics | Either codemem may write to the shared Sharing domain via normal `memory_remember` / observer ingestion. Both sides see those writes after sync. |
| Read semantics | Each side reads its full local DB through its own MCP endpoint, including replicated memories from the shared domain plus everything in its private domains. |
| Revocation | Removing the Sharing-domain grant stops **future** sync. It does not erase memories already replicated to the other peer. There is no "remote wipe" in Phase 2. |
| Audit | Each endpoint emits its own OAuth audit log per [remote-mcp-oauth.md](./remote-mcp-oauth.md#audit-log). Sync-layer events go through codemem's existing sync logging. |

## Setup

The setup below assumes both sides have already completed [Phase 1 deployment](./remote-mcp-oauth.md) on their own host.

### One-time pairing

Establish the codemem peer relationship if it does not already exist. This is the same pairing used for any cross-device sync:

```fish
# On host A
codemem sync enable
codemem sync pair --payload-only > invite.json

# Transfer invite.json to host B (scp, paste, etc.)

# On host B
codemem sync enable
codemem sync pair --accept-file invite.json --name "host-a"

# Equivalent if you'd rather pipe the JSON directly:
#   codemem sync pair --accept-file - --name "host-a" < invite.json
# Or pass the payload inline as a single argument:
#   codemem sync pair --accept '<invite-json>' --name "host-a"
```

See [coordinator-discovery.md](./coordinator-discovery.md) for cross-network setups. Pairing exchanges device public keys and registers the peer; it does **not** grant access to any memory yet.

### Create a shared Sharing domain

Pick a stable, human-readable name (`shared-research`, `family-notes`, etc.). Create the domain on host A and grant it to host B's device key. The viewer UI under Settings → Device Sync exposes Sharing-domain management; the equivalent CLI lives under `codemem sync` and `codemem coordinator` (see [user-guide.md](./user-guide.md#peer-to-peer-sync)).

Both sides must grant the domain to the partner peer for bidirectional replication. A grant in only one direction yields one-way sync.

### Tag memories into the shared domain

Memories can be assigned to the shared domain at write time (`memory_remember` with the shared `scope_id`) or moved into it by editing through the viewer. Project-scoped writes default to the writer's owned scope; only memories explicitly placed in the shared domain replicate.

### Verify replication

On the partner side:

```fish
codemem search "<known shared phrase>"
codemem stats        # confirm memory_items count includes shared rows
codemem recent       # confirm shared memories appear
```

If the shared phrase is missing, run `codemem sync once` to force an immediate pass, then `codemem sync doctor` to diagnose grant or transport issues.

## What partner v1 does NOT do

These guarantees are part of Phase 3 (`codemem-986p.7`) or further out:

- **No partner OAuth login to the owner's MCP endpoint.** Each endpoint stays single-principal. Anthropic-facing OAuth tokens issued by User A's endpoint are bound to User A's identity only.
- **No cross-endpoint authorization checks.** If the operator misconfigures the Sharing-domain grants, the MCP layer cannot detect or correct that.
- **No selective scope read/write per tool.** All MCP tools (`memory_search`, `memory_pack`, `memory_remember`, etc.) see every memory in the local DB, including everything replicated from the shared domain.
- **No partner-tagged writes.** A memory written through User A's endpoint into the shared domain is locally owned by User A and propagates to User B; there is no per-principal write attribution beyond device-level metadata.
- **No erasure guarantee.** Revocation stops future sync but does not roll back memories already copied to the other peer or already pulled into a model context window.
- **No central coordinator that performs authorization.** The coordinator (where used) handles discovery and pairing, not access control.

These constraints are deliberate: partner v1 is product-light precisely so it can ship before native multi-tenant authorization is designed and verified.

## Risks and operator checks

| Risk | Check |
|---|---|
| Product copy implies selective partner access inside one MCP endpoint | Documentation, marketing, and connector descriptions must use the "two peered endpoints" framing. Do not advertise "one MCP, two users" in any surface. |
| Sharing domain treated as a project filter | Sharing domains are the hard boundary; project filters narrow only. Do not document or expose a workflow that mixes them as if they were equivalent. |
| Operator forgets to grant both directions | `codemem sync doctor` should report missing grants. Re-run after every Sharing-domain change. |
| Partner believes revocation erases memory | This document is the canonical place to state the revocation semantic. The viewer Sharing-domain revoke action should link here. |
| Audit logs comingled or confused | Each host's audit log lives on that host. Treat them as two independent records; do not assume a shared timeline. |

## Operator checklist for cutover to partner v1

- [ ] Both sides have a passing [Phase 1 validation checklist](./remote-mcp-oauth.md#validation-checklist) run on their own host.
- [ ] `codemem sync status` shows the partner peer as paired and healthy on both sides.
- [ ] A shared Sharing domain exists and is granted in both directions.
- [ ] A test memory written into the shared domain on host A appears on host B after `codemem sync once`.
- [ ] A test memory removed from the shared domain stops replicating new writes (existing copies remain — see revocation note above).
- [ ] Each side independently rotates / revokes its own bearer tokens through its own `/oauth/revoke` endpoint.
- [ ] The operator has read and acknowledged the non-goals and risks sections above.

## CLI / UX gaps to file as follow-ups

These were noticed while writing this document. None are blockers for partner v1 itself; file as separate beads if you adopt the deployment.

- A single command (`codemem partner setup <peer-id> --shared <domain>`) that combines pairing + Sharing-domain creation + bidirectional grant + verification. Today it takes multiple steps across sync, coordinator, and viewer surfaces.
- Viewer Sharing-domain panel should show explicit reciprocal-grant status and link to the revocation semantics above.
- `codemem sync doctor` should include a "partner-v1 readiness" section that checks bidirectional grants and recent sync activity for a named shared domain.
- A "Memories shared with this partner" filtered viewer tab that scopes to a single shared domain so each side can review what is actually being exchanged.

## Migration toward Phase 3

If/when Phase 3 (`codemem-986p.7`) lands with native multi-tenant MCP authorization, partner v1 deployments can stay as the safe fallback. The Phase 3 design must:

- Treat any partner v1 deployment as a fully-supported configuration, not a deprecated one.
- Define a clean migration path (subject mapping, grant import) so an operator does not have to re-do the device pairing or Sharing-domain setup.
- Preserve every non-goal listed above as an explicit boundary that Phase 3 then expands deliberately, not implicitly.

Until then, partner v1 is the recommended way to share a brain between two people without taking on the security review surface of in-MCP multi-tenancy.
