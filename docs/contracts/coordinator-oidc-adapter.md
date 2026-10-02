# Coordinator OIDC adapter contract

**Status:** Reviewed verifier; browser integration remains disabled. This portable Node 24 and Workers adapter does not enable routes, persistence, provider registration, deployment, or credentials.

## 1. Purpose

`createCoordinatorOidcClient` discovers one configured HTTPS provider and returns a client that starts and verifies an authorization-code flow. It authenticates a provider account only; it creates no actor, device enrollment, Project grant, database row, source key, admin role, or ownership decision.

The account key is the exact configured issuer plus the verified opaque subject. Email, name, picture, and other profile data are display-only and never prove ownership.

## 2. Dependencies and health

The pinned dependency path is `openid-client` 6.8.8, with `jose` 6.2.12 and `oauth4webapi` 3.8.8. The package registry published `openid-client` 6.8.8 on September 5; its version and integrity were checked, and an exact OSV query returned no advisories.

Snyk returned insufficient package information on both checks; it did not provide a health assessment. The OSV result is a point-in-time advisory check, not a security guarantee. The [official `openid-client` 6.8.8 tag](https://github.com/panva/openid-client/tree/v6.8.8) and the package's shipped documentation are authoritative for SDK behavior.

## 3. Factory contract

```ts
const result = await createCoordinatorOidcClient(
  {
    issuer: "https://accounts.example.test",
    clientId: "coordinator-test-client",
    clientSecret: "test-secret",
    redirectUri: "https://coordinator.example.test/auth/oidc/callback",
  },
  { timeoutSeconds: 10 },
);

if (!result.ok) throw new Error(result.error);
const client = result.client;
```

`createCoordinatorOidcClient({ issuer, clientId, clientSecret, redirectUri }, { fetch?, timeoutSeconds? })` returns `{ ok: true, client }`, `{ ok: false, error: "invalid_provider_configuration" }`, or `{ ok: false, error: "oidc_discovery_failed" }`. `timeoutSeconds` defaults to 10; the optional `fetch` is trusted runtime wiring, not request JSON.

Issuer and redirect URI must be configured HTTPS URLs without credentials, fragments, or queries. The redirect URI must already equal its parsed URL's canonical form, so authorization and token exchange send the same value; the issuer must exactly match provider metadata. Discovery accepts only HTTPS authorization, token, JWKS, and optional UserInfo endpoints from the trusted configured provider, not callback input.

This is not a general destination allowlist: future routes must never accept provider configuration from a browser request.

Discovery uses `ClientSecretPost` with the configured secret. It enables `enableNonRepudiationChecks`; JWS validation is mandatory under this policy, so TLS alone is not enough.

## 4. Authorization request

```ts
const { authorizationUrl, material } = await client.createAuthorizationRequest();
// Store material only in the trusted transaction store for at most 10 minutes.
```

The request uses SDK CSPRNG values, S256 PKCE, `state`, and `nonce`; it does not derive values with HKDF. It requests `openid email profile`, `response_mode=query`, and `access_type=online`, and does not request offline access.

Request generation can throw the redacted `Error("oidc_request_failed")` if crypto or URL generation fails. Future handlers must handle that failure without logging transaction material.

`material` contains `state`, `nonce`, and `pkceVerifier`. Keep the full object in a trusted, durable future transaction store for no more than 10 minutes; never put it in public JSON or logs. The authorization URL carries state, nonce, and the PKCE challenge, but never the verifier.

## 5. Callback verification

```ts
const verified = await client.verifyCallback({ callbackUrl, material }, { fetchUserInfo: false });
if (!verified.ok) throw new Error(verified.error);
// verified.account: { issuer, subject }; verified.profile is display metadata only.
```

`verifyCallback` returns either `{ ok: true, account: { issuer, subject }, profile }`, `{ ok: false, error: "invalid_callback" }`, or `{ ok: false, error: "oidc_verification_failed" }`. The callback must use the configured HTTPS origin and path; query parameters carry the provider response, but callers cannot override the configured URI or add a fragment.

The SDK validates the code flow with the callback-bound PKCE verifier and expected state and nonce. The adapter requires an ID token, exact issuer, client audience, expiry, nonce, and signed response checks; the initial provider policy expects RS256, with zero clock tolerance.

Google's legacy unprefixed `accounts.google.com` issuer claim is rejected instead of normalized. Zero clock tolerance also denies tokens outside their valid time window, including failures caused by clock skew; no permissive fallback is enabled.

When `fetchUserInfo` is true, UserInfo is optional enrichment only. The SDK receives the already verified subject as the expected subject; a mismatch or failure rejects verification.

The result projects only issuer, subject, and known display fields: name, email, boolean email verification, and an optional HTTPS picture URL. It never returns raw claims, access tokens, refresh tokens, ID tokens, bearer credentials, or failure causes; errors must also omit secrets, authorization codes, and callback URLs.

Email and its verification flag stay paired to the same response. An email supplied by UserInfo without a verification flag does not inherit the ID token's flag; a flag without an email is ignored.

### 5.4 Profile display (held)

No profile UI exists yet. If it is added, treat the picture URL as untrusted: allowlist the provider host, require HTTPS, escape displayed text, use a restrictive CSP, and use `noreferrer`; do not fetch arbitrary image URLs on the server or cache tokens for an icon.

## 6. Integration boundary

The adapter is stateless. A future transaction and routes layer must own durable cookie and CSRF checks, state and code replay prevention, the client runtime verifier, and completion by the original browser; callback verification alone implements none of those controls.

It does not implement dual completion, browser sessions, account linking, account recovery, device approval, or admin authorization. Those features need their own transaction, route, and authorization contracts.
