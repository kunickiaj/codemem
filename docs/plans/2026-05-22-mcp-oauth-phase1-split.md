# MCP OAuth Phase 1 Implementation Split

## Goal

Split Phase 1 remote MCP OAuth work into reviewable PR-sized beads after the MCP refactor, Streamable HTTP transport, and CLI surface are in place.

Phase 1 remains a **single-user endpoint**: one self-hosted codemem instance, one allowed human identity, public reachability through Tailscale Funnel, and OAuth protecting only the MCP HTTP surface. The viewer stays private. Partner access and native multitenant authorization stay out of scope.

## Boundaries

- Use Streamable HTTP `POST /mcp`; do not revive the deprecated standalone SSE transport.
- Keep `codemem mcp` stdio behavior unchanged.
- Protect only the MCP HTTP endpoint. Do not add auth to the viewer server in this track.
- Enforce one allowed owner identity for Phase 1. No partner login to this endpoint.
- Store no bearer tokens, auth codes, client secrets, or upstream secrets in plaintext logs.

## Bead stack

1. `codemem-986p.12` — MCP OAuth metadata and dynamic client registration
   - Adds OAuth server metadata and Dynamic Client Registration for claude.ai custom connectors.
   - Finalizes Phase 1 DCR vs CIMD behavior.
   - Does not implement authorize/token exchange or protect `/mcp` yet.

2. `codemem-986p.13` — MCP OAuth authorize and token exchange with PKCE
   - Adds `/authorize` and `/token` with authorization-code flow and PKCE S256.
   - Covers redirect validation, state, code expiry, single-use codes, and token response shape.
   - Depends on registration/metadata.

3. `codemem-986p.14` — MCP OAuth upstream identity and single-user allowlist
   - Wires authorization to the chosen upstream identity provider.
   - Allows only configured owner subject/email values.
   - Explicitly excludes partner access and Sharing-domain grants.

4. `codemem-986p.15` — MCP bearer enforcement, token storage, and revocation
   - Requires valid bearer tokens for `POST /mcp`.
   - Adds hashed token persistence, expiry, and revocation behavior.
   - Keeps authorization single-principal; no per-tool multitenant policy.

5. `codemem-986p.16` — MCP OAuth audit logging and operator diagnostics
   - Adds privacy-safe security event logging and diagnostics.
   - Redacts tokens, authorization codes, secrets, and memory contents.
   - Helps operators debug registration, authorization, token, and bearer failures.

6. `codemem-986p.17` — claude.ai remote MCP connector handshake validation
   - Documents and validates the self-hosted MCP endpoint + HTTPS ingress + claude.ai custom connector path.
   - Requires authenticated `POST /mcp` smoke coverage, at least `memory_schema` or `memory_search`.
   - Runs after bearer enforcement and diagnostics exist.

## Dependency order

```text
codemem-986p.12
  -> codemem-986p.13
  -> codemem-986p.14
  -> codemem-986p.15
     -> codemem-986p.16
     -> codemem-986p.17
codemem-986p.16 -> codemem-986p.17
```

## Before claude.ai handshake testing

The connector validation bead should not start until these are true:

- OAuth metadata and registration are served from the public MCP base URL.
- Authorization-code + PKCE S256 flow works with a registered client.
- Upstream identity succeeds only for the configured owner identity.
- Bearer tokens are required on `POST /mcp` and can be revoked/expired.
- Logs can distinguish registration, authorize, token, and bearer failures without leaking secrets.

## Explicit non-goals

- Native multitenant MCP authorization.
- Partner access inside one MCP endpoint.
- Sharing-domain grant enforcement by OAuth principal.
- Auth for the viewer server.
- MCP Tunnels as the primary path.
