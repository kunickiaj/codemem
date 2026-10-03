# Coordinator browser-auth configuration capture

**Status:** Pure configuration capability; browser routes remain unmounted.

## Boundary

`captureCoordinatorBrowserAuthConfig` captures trusted server configuration.
It does not load environment variables, construct an OIDC client, discover a
provider, fetch anything, or change coordinator routes. It is not exported from
the package entrypoints yet.

```ts
const settings = captureCoordinatorBrowserAuthConfig(serverConfiguration);
// { kind: "disabled" }
// { kind: "invalid", field: "redirectUri" }
// { kind: "enabled", publicOrigin, store, oidc }
```

Absent configuration returns `disabled`. An own data property `enabled: false`
also returns `disabled` without inspecting other configuration fields. This
allows credentials to remain absent while the feature is off.

Enabled configuration accepts only these seven own data fields:

| Field | Requirement |
| --- | --- |
| `enabled` | Exactly `true`; `false` takes the disabled path. |
| `coordinatorId` | Existing validated opaque coordinator namespace, not a URL. |
| `issuer` | Exactly `https://accounts.google.com`. |
| `clientId` | Nonempty, already trimmed, at most 256 characters; no control or format characters. |
| `clientSecret` | Same credential rules, at most 4,096 characters. |
| `redirectUri` | Exact canonical HTTPS URL, without credentials, query, fragment, backslashes, or control characters. |
| `revision` | Exactly 64 lowercase hexadecimal characters, supplied by the trusted operator. |

Plain objects and null-prototype objects are supported. Arrays, class instances,
custom prototypes, unknown fields, symbols, accessors, and coerced values are
not enabled configurations. Getters are never evaluated. Proxy reflection traps
can run during inspection; their exceptions become a redacted `invalid/config`
result rather than escaping.

## Captured outputs and secrets

The result and its two projections are new, frozen objects. Changing the input
after capture cannot change them. `store` is storage **configuration**, not a
store capability; `oidc` is the existing provider-configuration shape.

`publicOrigin` comes only from the configured callback URL. Neither a coordinator
namespace nor an HTTP Host, Origin, or forwarding header supplies it.

Enabled `oidc` settings intentionally contain the client secret for the trusted
SDK caller. Never serialize them to HTTP responses or logs. Invalid results
contain only a fixed field label and never include supplied values or exception
details. This function logs nothing.

## Integration gates

The generic OIDC adapter and existing coordinator constructors are unchanged.
This Google policy applies only to the new browser-config capture layer. The
function does not choose a callback path or derive a configuration revision.

Before handlers are mounted, client ID, callback, and secret rotation must also
change the effective revision. An explicit revision string alone does not
enforce that relationship.

Future mounting must fail closed for invalid browser configuration with a
redacted diagnostic, while preserving the independent signed-device and direct
APIs. Cookie, CSRF, Origin, limiter, retention, enrollment, and real-browser
completion checks remain separate requirements. This capability does not
authorize live provider setup, configuration changes, or deployment.
