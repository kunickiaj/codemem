# Coordinator auth account-profile storage

**Status:** Reviewed storage capability; not wired to browser routes.

## Purpose and boundary

This optional store keeps one display-only profile row for each existing account link. It supports a future current-account page; it does not authenticate, create links, select ownership, grant sharing or roles, create actors, or admit sync.

Account ownership remains the active link's exact configured issuer and subject. Names, email addresses, verification flags, and pictures are never account authority.

The first-link confirmation keeps display data only in its rendered response.
The initial redeemed session does not record a profile snapshot; a later normal
sign-in can record one. There is no pending profile table.

## Stored data

Implementation: `packages/core/src/coordinator-auth-account-profile.ts`.

Each `(coordinator_id, link_id)` has at most one row. The row contains only:

| Field | Rule |
| --- | --- |
| `display_name` | Optional bounded display text (1–256 characters). |
| `email` | Optional bounded display text (1–320 characters). |
| `email_verified` | Optional `0` or `1`, and only when email exists. |
| `picture_url` | Optional bounded HTTPS URL (up to 2,048 characters). |
| source session fields | Internal ordering and replay data, not display claims. |

The profile table must never contain raw provider tokens, a claims blob, subjects, issuers, nonce or PKCE values, cookies, credentials, or provider secrets. Storage never fetches image URLs. The reviewed renderer owns the separate image-host policy.

Only bounded optional `displayName` and `email` text, plus a valid HTTPS `pictureUrl`, are kept. `emailVerified` is kept only with a retained email. Missing or invalid fields write `NULL`, replacing older values rather than retaining stale display metadata.

```ts
// Trusted, already-verified callback data; display fields are optional.
await store.recordAuthAccountProfile({ credentialHash, profile: { displayName: "Ada", email: "ada@example.test", emailVerified: true } }, config);
```

## Recording rules

The caller must already have completed trusted OIDC verification. A record is eligible only for a live, unrevoked, normal-sign-in session whose coherent receipt has `source: "signin"` and no attempt ID. First-link `"link_redeem"` sessions cannot write profiles.

The write window is strictly less than 120 seconds after the source session's `created_at_ms`. Freshness uses that source timestamp, never the profile write time. A callback from an older session arriving late cannot replace a newer snapshot; if issuance times are equal, the first writer wins.

Replaying the same session is a no-op. `kind: "recorded"` is advisory: it can
mean that session was already stored, not that this payload changed a row.

```ts
const result = await store.recordAuthAccountProfile({ credentialHash, profile }, config);
// "recorded" can describe a harmless same-session replay.
if (result.kind === "rejected") throw new Error(result.error);
```

## Live reads and internal DTO

`readAuthSessionAccount(credentialHash, config)` uses one shared-guard `SELECT`. It returns the session and profile only while the existing session, link, and configuration are live. A revoked, expired, disabled, or revision-mismatched session returns `null`; profile data never revives it.

If the live session has no profile row, the read still succeeds with `profile: {}`:

```ts
const account = await store.readAuthSessionAccount(credentialHash, config);
// null means not live; a live session without a snapshot has profile: {}.
```

The returned session DTO is internal server metadata. Future handlers must not
blindly serialize its private account references to browsers or other clients.
Extracting the shared live-session guard changes no existing session behavior.
If explicit [guarded-session retention](coordinator-auth-session-retention.md)
later deletes a source session, a profile may retain its dangling source-session
ID. It remains display-only; reads still require a current live session and
configuration, and retention does not erase profiles or change authority.

## Revocation and privacy cleanup

`clearRevokedAuthAccountProfile({ linkId }, { coordinatorId })` deletes display metadata only when that exact link is already revoked. Existing revoke behavior is unchanged: a missing profile table or failed purge cannot keep an account active.

Future authenticated-admin handlers must revoke first, then clear metadata. A cleanup failure needs retry handling and must not roll back revocation. Until those handlers exist, data can remain stored but live reads deny it. This change does no live user-database cleanup; deletion is guarded source code with isolated tests only.

## Schema, integration limits, and validation

The initially empty table has no backfill, startup profile writes, foreign-key dependency, routes, cookies, provider credentials, configuration, deployment, or mandatory sync, recovery, or relay activation. Shared DDL, `migrations/0021_add_auth_account_profiles.sql`, and fresh Worker `schema.sql` must match.

Public browser transaction capacity recovery, failure-secret cleanup,
CSRF/cookies, session-receipt growth, and real-browser completion validation
remain separate gates. Local storage validation does not prove those future
browser integrations or production behavior.
