# Remote MCP OAuth (Phase 1)

This document covers deploying the `codemem mcp http` Streamable HTTP MCP server publicly with OAuth 2.1 protection, registering it as a hosted MCP connector such as Claude or ChatGPT, and validating the handshake end-to-end.

The Phase 1 endpoint is **single-user**. One self-hosted codemem instance, one allowed human identity. Partner access and native multi-tenant MCP authorization are out of scope.

## Boundaries

- Only the MCP HTTP endpoint is exposed publicly. The viewer (`@codemem/viewer-server`) stays Tailscale-private.
- `POST /mcp` requires a valid OAuth bearer token when `--public-url` or OIDC env vars are configured.
- One identity is allowed through `CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT` and/or `CODEMEM_MCP_OAUTH_ALLOWED_EMAIL`.
- Bearer tokens, authorization codes, OIDC ID tokens, and client secrets are never written to logs by the OAuth audit emitter.

## Deployment topology

```
[Claude iOS / web / desktop / mobile]
       │ add custom connector → paste MCP URL
       │ Anthropic OAuth handshake (DCR + PKCE/S256)
       ▼
[Anthropic backend] ──── HTTPS w/ bearer ────►
                                              │
[https://codemem-mcp.example.net/mcp]          │
       ▲                                      │
       │ HTTPS ingress                        │
       │                                      ▼
[Self-hosted machine: codemem mcp http]
       │ /.well-known/oauth-* → metadata
       │ /register → DCR (public-client only)
       │ /authorize → redirect to upstream OIDC
       │ /oauth/callback → verify OIDC ID token, gate on allowlist
       │ /token → PKCE S256 + issue bearer token
       │ /revoke → revoke bearer token
       │ /mcp → require valid Bearer, run MCP tools
       │
       └► reads local SQLite via @codemem/core
```

The viewer process and `codemem mcp http` process must run on different ports. Only the MCP port is exposed through the public ingress.

## Prerequisites

- Node.js 24+ and pnpm or `codemem` installed globally (`npm install -g codemem`).
- The host already runs codemem as a peer with the user's memories synced locally.
- An HTTPS-terminating public ingress such as Tailscale Funnel, Cloudflare Tunnel, or a reverse proxy that preserves the configured Host header.
- An upstream OIDC provider the operator already uses (Google, GitHub via OIDC bridge, Anthropic SSO if available). The OIDC client must allow the `<MCP base URL>/oauth/callback` redirect URI.

## Required environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `CODEMEM_MCP_HTTP_PUBLIC_URL` | yes | Externally reachable `/mcp` URL, e.g. `https://codemem-mcp.example.net/mcp`. Used in OAuth metadata, code redirects, and the Origin gate. |
| `CODEMEM_MCP_OIDC_ISSUER_URL` | yes | OIDC issuer base URL (`https://accounts.google.com`, etc.). |
| `CODEMEM_MCP_OIDC_CLIENT_ID` | yes | OIDC client ID. |
| `CODEMEM_MCP_OIDC_CLIENT_SECRET` | yes | OIDC client secret. |
| `CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT` | one of | Allowed OIDC `sub` claim. |
| `CODEMEM_MCP_OAUTH_ALLOWED_EMAIL` | one of | Allowed verified email. Either subject or email (or both) must be set. |
| `CODEMEM_MCP_HTTP_HOST` | no | Bind host (default `127.0.0.1`). Set to `0.0.0.0` only when serving the Funnel directly. |
| `CODEMEM_MCP_HTTP_PORT` | no | Bind port (default `38889`). |
| `CODEMEM_MCP_HTTP_UNSAFE_PUBLIC` | no | Set to `1` to allow binding non-loopback hosts. Required for direct public binds. |
| `CODEMEM_MCP_AUDIT` | no | `0`, `false`, or `no` disables OAuth audit emission. Defaults to enabled (writes JSON lines to stderr). |
| `CODEMEM_DB` | no | SQLite database path. |

When OIDC env vars or `--public-url` are present the server requires bearer tokens on `POST /mcp`. Without both, the server runs in loopback-only development mode (`localhost`/`127.0.0.1`/`::1` only, no bearer).

Public mode accepts browser CORS preflight requests from trusted hosted connector origins (`https://claude.ai` and `https://chatgpt.com`) on the OAuth and MCP routes while still requiring the request `Host` header to match `CODEMEM_MCP_HTTP_PUBLIC_URL`. Other browser origins remain blocked before OAuth processing.

## Running the server

Direct on the host:

```fish
set -x CODEMEM_MCP_HTTP_PUBLIC_URL https://codemem-mcp.example.net/mcp
set -x CODEMEM_MCP_OIDC_ISSUER_URL https://accounts.google.com
set -x CODEMEM_MCP_OIDC_CLIENT_ID xxxxx.apps.googleusercontent.com
set -x CODEMEM_MCP_OIDC_CLIENT_SECRET xxxxx
set -x CODEMEM_MCP_OAUTH_ALLOWED_EMAIL you@example.com
codemem mcp http --host 127.0.0.1 --port 38889
```

Behind Tailscale Funnel (one supported ingress option):

```sh
sudo tailscale funnel --bg 38889
```

The Funnel will terminate TLS and forward the public hostname/port to your local loopback. Other HTTPS ingress options, such as Cloudflare Tunnel or a reverse proxy, are also valid if they preserve the configured public URL hostname. The bearer-gated `/mcp` route checks that hostname.

For direct public binds (not behind Funnel) set `CODEMEM_MCP_HTTP_UNSAFE_PUBLIC=1` and bind explicitly to the public interface; you are responsible for TLS termination.

## OAuth state persistence

Claude keeps its dynamically-registered `client_id` and refresh token across connector reconnects. The server persists OAuth state to a JSON file so a package upgrade or a routine process restart does not invalidate that client and force the user back through the full OAuth flow.

- **Location:** `~/.codemem/mcp-oauth-state.json` (resolved from `$HOME`).
- **What is persisted:** dynamically-registered public clients, issued access tokens, and refresh-token grants.
- **What is stored:** token and refresh-token values are stored only as SHA-256 hashes — never plaintext. A presented token is matched by re-hashing it and comparing, so the file never contains usable bearer material. Authorization codes remain in-memory only (short-lived, single-use).
- **Restart behavior:** after a restart or upgrade, existing clients keep working and Claude's next refresh succeeds. Without persistence, the prior in-memory-only state made a post-restart refresh look like an unknown client and surfaced as `invalid_client` / `invalid_grant` in the audit log (and "no tools" in Claude).

The file is created on first use and rewritten as state changes; inactive clients and expired tokens are pruned. There is no configuration knob in `codemem mcp http` for the path — it always uses the default location. To force a clean slate (revoking all registered clients and tokens), stop the server and delete the file.

## OIDC provider setup

The provider must support OIDC Discovery (`/.well-known/openid-configuration`) over HTTPS.

1. Create an OAuth 2.0 web client in your provider.
2. Add `<MCP base URL>/oauth/callback` as an authorized redirect URI, e.g.
   `https://codemem-mcp.example.net/oauth/callback`.
3. Note the client ID and secret; set them as env vars above.
4. Set the allowed identity. For Google use the verified Gmail address in `CODEMEM_MCP_OAUTH_ALLOWED_EMAIL` and/or the numeric `sub` in `CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT`.

## Hosted connector registration

Plan tier note: claude.ai custom connectors require Pro / Max / Team / Enterprise.

1. Open the hosted client connector setup flow, such as Claude (web or mobile) → Customize → Connectors → Add custom connector, or ChatGPT connector setup.
2. Paste the MCP URL: `https://codemem-mcp.example.net/mcp`.
3. The hosted client fetches `/.well-known/oauth-protected-resource/mcp`, discovers the authorization server, and posts a DCR registration to `/register`.
4. The hosted client redirects you to `/authorize`. The codemem server bounces you to your OIDC provider; you sign in there.
5. The OIDC provider redirects back to `/oauth/callback`. codemem validates the ID token (signature, issuer, audience, expiry, nonce, allowed subject/email) and issues an authorization code to the registered hosted-client callback.
6. The hosted client exchanges the code at `/token` with PKCE S256 and stores the resulting bearer token.
7. The hosted client calls `POST /mcp` with `Authorization: Bearer <token>`; codemem verifies, runs the MCP tool, and returns the result.

Supported hosted redirect callbacks are currently Claude's fixed MCP callback (`https://claude.ai/api/mcp/auth_callback`), ChatGPT connector callbacks matching `https://chatgpt.com/connector/oauth/<connector-id>`, and ChatGPT's legacy published-app callback (`https://chatgpt.com/connector_platform_oauth_redirect`). Native loopback callbacks remain supported for local MCP clients, including Gemini CLI-style `http://localhost:<port>/oauth/callback` redirects.

The bearer token expires after one hour. Revoke at any time with:

```sh
curl -X POST "https://codemem-mcp.example.net/revoke" \
  -H "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "token=<bearer>"
```

## Messages API (secondary path)

The Anthropic Messages API supports the same MCP endpoint through `mcp_servers` with the `anthropic-beta: mcp-client-2025-11-20` header. Pass the bearer token you obtained interactively via the connector flow as the static `authorization_token`. Anthropic MCP Tunnels are not supported here; the connector path is the primary surface.

## Audit log

When audit is enabled (default) the OAuth event emitter writes one JSON line per OAuth event to stderr. Example:

```json
{"source":"codemem-mcp-oauth-audit","kind":"registration","timestamp":"2026-05-23T03:46:30.927Z","outcome":"success","clientId":"<uuid>","remoteAddress":"127.0.0.1"}
{"source":"codemem-mcp-oauth-audit","kind":"oidc_callback","timestamp":"...","outcome":"denied","reason":"subject_not_allowed","remoteAddress":"..."}
{"source":"codemem-mcp-oauth-audit","kind":"bearer","timestamp":"...","outcome":"denied","reason":"expired_token","remoteAddress":"..."}
{"source":"codemem-mcp-oauth-audit","kind":"bearer","timestamp":"...","outcome":"success","clientId":"<uuid>","remoteAddress":"..."}
```

Event `kind` values: `registration`, `authorize`, `oidc_callback`, `token`, `revocation`, `bearer`. `reason` for bearer denials is one of:

- `missing_authorization_header`
- `malformed_authorization_header`
- `unknown_token`
- `expired_token`
- `revoked_token`

Bearer/access-token values, authorization codes, OIDC ID tokens, and client secrets are never serialized into events; the `buildOAuthAuditEvent` builder throws if a caller tries to attach any forbidden field.

To disable audit output set `CODEMEM_MCP_AUDIT=0`.

Early Host/Origin guard denials happen before OAuth audit events and are always written as one JSON line to stderr so operator logs show browser preflight or proxy-host failures without logging tokens, codes, or request bodies:

```json
{"source":"codemem-mcp-http-guard","outcome":"denied","reason":"host_or_origin_mismatch","method":"OPTIONS","path":"/register","host":"codemem-mcp.example.net","origin":"https://evil.test","expectedOrigin":"https://codemem-mcp.example.net"}
```

## Troubleshooting

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| Claude shows "couldn't reach connector" | Public ingress not running, or hostname mismatch | Check ingress status; confirm public URL hostname matches `CODEMEM_MCP_HTTP_PUBLIC_URL`. |
| `/authorize` returns `temporarily_unavailable` | OIDC env vars not set | Audit log shows `kind=authorize outcome=denied reason=temporarily_unavailable`. Verify `CODEMEM_MCP_OIDC_*` env vars. |
| `/oauth/callback` returns `subject_not_allowed` | OIDC identity not allowlisted | Audit log shows `kind=oidc_callback outcome=denied reason=subject_not_allowed`. Update `CODEMEM_MCP_OAUTH_ALLOWED_SUBJECT` or `CODEMEM_MCP_OAUTH_ALLOWED_EMAIL`. |
| `POST /mcp` returns 401 | No / wrong bearer | Audit log shows `kind=bearer outcome=denied reason=...`. Re-run connector setup or check expired/revoked tokens. |
| `POST /mcp` returns 403 with valid bearer | Host/Origin mismatch with `CODEMEM_MCP_HTTP_PUBLIC_URL` | Confirm the ingress preserves the configured public hostname. Check `codemem-mcp-http-guard` log lines; OAuth audit will not record this because the request is rejected before bearer verification. |
| Connector hangs on registration | DCR rejected | Audit log shows `kind=registration outcome=denied reason=invalid_client_metadata`. Confirm the DCR payload uses one of: `https://claude.ai/api/mcp/auth_callback`, `https://chatgpt.com/connector/oauth/<connector-id>`, `https://chatgpt.com/connector_platform_oauth_redirect`, or a loopback `http://[127.0.0.1|localhost|::1]:<port>/callback` / `/oauth/callback` URI. |
| Claude loses tools / re-prompts for auth after an upgrade or restart | OAuth state not persisted (older builds) or state file removed | Audit log shows `kind=refresh outcome=denied reason=invalid_client`/`invalid_grant`. Confirm `~/.codemem/mcp-oauth-state.json` exists and is writable by the server process; if it was deleted, re-run connector setup once to re-register. |

## Validation checklist

Before announcing the connector ready, run the steps below against the live host. The same code paths are covered by `pnpm exec vitest run packages/mcp-server/src/http.test.ts packages/mcp-server/src/oauth.test.ts packages/mcp-server/src/oidc.test.ts` for unit-level regression. The checklist below confirms the live deployment is wired correctly end-to-end.

- [ ] `/.well-known/oauth-authorization-server` returns metadata pointing at the configured public URL.
- [ ] `/.well-known/oauth-protected-resource/mcp` returns the protected resource document.
- [ ] `POST /register` accepts the hosted connector callback URI and returns a public-client registration.
- [ ] `/authorize` for the registered client redirects to the OIDC provider (302 with location matching `CODEMEM_MCP_OIDC_ISSUER_URL`).
- [ ] OIDC callback with an allowed identity issues an authorization code redirecting back to the registered callback.
- [ ] `/token` exchange with PKCE S256 returns a 43-character base64url bearer token, `token_type: "Bearer"`, `expires_in: 3600`.
- [ ] `POST /mcp` with that bearer + `Authorization: Bearer …` returns `serverInfo.name === "codemem"` on initialize, and at least one of `memory_schema`/`memory_search` returns a successful result.
- [ ] `POST /mcp` without the bearer returns 401 with `WWW-Authenticate: Bearer realm="codemem-mcp"`.
- [ ] `POST /revoke` with the bearer returns 200; subsequent `/mcp` returns 401 with `reason=revoked_token` in the audit log.
- [ ] Audit log shows the expected `kind`/`outcome`/`reason` for each step and contains no token/code/secret material.

Non-goals checked off:

- This document does NOT cover partner access through one MCP endpoint (Phase 2, `codemem-986p.6`).
- This document does NOT cover native multi-tenant MCP authorization (Phase 3, `codemem-986p.7`).
- Anthropic MCP Tunnels are not supported on claude.ai surfaces and are not exercised here.
