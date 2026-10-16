# Viewer account API

The My Account API is separate from recipient and access management. Its local
request protection does not grant operator privileges or require Google for
existing coordinator operations.

Account evidence reads do not change database rows, schema, keys or history.
SQLite may still create or update its WAL/SHM coordination files. This is not a
zero-filesystem-write guarantee; reads must see current committed WAL data.

## Local request protection

The account routes are opt-in through `createApp({ accountLink: ... })`. The
trusted `getListenerAddress` callback supplies the actual bound host and port;
requests fail closed before the listener is ready or when it is not loopback-only.
The separate peer-sync listener does not expose these routes.

Requests must use an allowed loopback Host and the actual listener port. An
Origin header, when present, must match the request origin exactly, including
the port. POST requires that header. Fetch metadata, when present, must report
`same-origin`; cross-origin preflight requests are rejected. Other local ports
are not trusted account clients.

Opening the session URL directly in a browser tab normally sends
`Sec-Fetch-Site: none` and is intentionally rejected. The viewer fetches it as a
same-origin API request instead.

Every account response is `no-store`, sends `nosniff` and `no-referrer`, and
contains no CORS permission headers. This protection runs before the viewer's
general loopback-origin middleware; that middleware alone is not sufficient for
account data or private sign-in URLs.

## Account session

`GET /api/account/session` returns `{ "version": 1, "csrfToken": "..." }` after
the local request checks. It accepts no query parameters or body. The token is
random and stays constant for that app instance; a new instance uses a new token.
It is not an operator credential or a Google token.

Every other account route requires `X-Codemem-Account-Csrf`. Browser clients keep
the token only in memory, never in cookies, HTML, Web Storage, URLs or logs. A
viewer restart requires fetching a new session token. A missing or invalid token
returns `403 account_csrf_invalid`.

A successful session does not mean an account is linked or that the current
device is eligible to link one.

## Current account status

`GET /api/account/link-status?group_id=...` requires the account CSRF header. The
optional `group_id` must name a configured group; no other query keys, duplicate
selectors or request bodies are accepted. One configured group is selected
automatically. Multiple groups require an explicit choice before a remote read.
Malformed group lists, including empty entries, fail closed instead of silently
discarding entries.

The route is mounted only when the application supplies a trusted context reader.
That reader uses the running viewer's database, device, Identity, selected config
and keys directory. Browser callers cannot supply paths, coordinator URLs or
Identity IDs. Missing setup, invalid coordinator configuration, unavailable
device evidence and disagreement with the running Identity stop the read.

The exported `AccountLinkViewV1` describes local context, coordinator origin,
remote status, link eligibility and the check time. It contains no local paths
or credentials.

The context ID binds the database file identity, selected paths, coordinator,
group, device key fingerprint and Identity. Normal memory capture does not change
it. The broker reads context before and after the coordinator request; a changed
context removes account metadata and returns `context_changed` instead of attaching
an old response to the new profile.

Google display metadata is returned only for a linked account whose coordinator
Identity matches the running local Identity. `canLink` is true only for a fresh,
matching, unlinked subject authorized by `device_claim` or
`controller_attestation`; the broker never publishes an operator review or grants
access. Unsupported, offline, and rejected reads do not imply that Google is required.

### Linked profile display

`remote.account` contains only optional `displayName`, verified `email`, and
`pictureUrl` display fields. Older responses with no picture remain valid. The
coordinator omits unsafe persisted pictures; its strict status client rejects
unknown account keys and invalid picture URLs. Pictures use the same conservative
Google host policy as the hosted account pages: HTTPS on
`lh3.googleusercontent.com`, without credentials, non-default ports, or fragments.
Revoked links, mismatched Identities, and changed local contexts expose no profile.

The Viewer shows the available name, verified email, and “Linked to Google”, with
Identity, device, and coordinator information below the account summary. Missing
metadata stays missing: existing links need no relink, and the Viewer does not
backfill account data. Missing, blocked, or failed photos fall back to initials
or a generic Google marker.

Avatar requests go directly to Google, which can see the browser's network address.
Images load lazily with `no-referrer` and anonymous CORS (no cross-origin
credentials). Google must allow that CORS request; otherwise the fallback remains.
The Viewer currently sends no document Content Security Policy (CSP); this change
does not add or relax one. Any deployment CSP must permit
`img-src https://lh3.googleusercontent.com` to show photos; a stricter policy keeps
the fallback. No avatar is fetched or proxied by the Viewer server.

### Device-claim status

Version-2 coordinator status sends the running Identity as `identity_id` and the
view includes `remote.authority` (`controller_attestation`, `device_claim`, or
`null`). Device-claim eligibility is not a link: the coordinator reserves nothing
until finalization. A device-claim account is shown as linked by this device and
Google sign-in, never as reviewed by an administrator. The viewer and coordinator
ship together; there is no fallback to the older status shape.

Status reads and link operations do not initialize a store, migrate a schema,
generate keys, or change Identity assignments. Status responses return no private
browser URLs, tokens, or admin credentials.

### Failed status checks

The Viewer reports a rejected linking request (`400`, `coordinator_incompatible`)
separately from a network failure and asks the coordinator operator to update the
service. This does not infer a remote version or whether an account is linked.
Server failures, rate limits, refused device requests, schema upgrades, local
device problems, and changed profile selections each have their own recovery
guidance. Unexpected replies are not described as network outages, and raw
upstream error bodies are never shown.

`review_required` asks the user to check the selected profile and group, then
contact the coordinator operator to check the device and existing links. It does
not prescribe an administrator command as a client onboarding step. Status checks
never start linking automatically; unavailable results keep linking disabled.

## In-process link lifecycle

`createAccountLinkRegistry` permits one active operation in the foreground viewer's
JavaScript runtime, including across groups and registry instances. It captures
the profile context and passes expected
Identity/coordinator pins and a current-context check to the core linking runtime.
The registry rejects changed authority fields even if a caller reuses a context ID.

Public operation snapshots contain only IDs, state, fixed failure codes, times and
browser-link availability. The private URL stays in memory and is never included
in snapshots. Delivery requires the current context, an awaiting-browser operation
and a validated coordinator origin/path; it is limited to five deliveries.
The origin follows core policy: HTTPS, or HTTP on literal `127.0.0.1`/`[::1]` for
local coordinators. Delivery still requires the exact configured origin.
Cancellation and terminal states clear the URL. Invalid URL rejection is retained
while the core runtime finishes cancellation, rather than reporting success early.

`cancellation_unconfirmed` and `receiver_close_failed` mean `outcome_unknown`, not
confirmed cancellation. Shutdown aborts active work and waits at most five seconds;
unfinished work remains unknown, and late callbacks cannot change a terminal
record. Finished records expire after fifteen minutes, with at most eight retained.

Instances share only an opaque busy-owner token, including across duplicate module
loads. Operation records, contexts and browser URLs remain instance-private;
another registry's busy response contains no operation ID. Ownership is released
only when the underlying core work settles, not when a shutdown timeout marks its
public record unknown. This local registry does not coordinate separate workers.

## Protected link operations

Operation routes are mounted only when the app supplies both `readContext` and
`registry`. They require the existing account request protection and CSRF header.
POST bodies must contain exactly the documented object keys and be at most 1 KiB,
read within ten seconds; disconnects stop body reads. Operation routes accept no query parameters.

| Route | Body and result |
| --- | --- |
| `POST /api/account/link-operations` | `{groupId, contextId, coordinatorId, authority}`; fresh matching unlinked status and a final context check precede start. Returns `202 {version:1, operation}`. |
| `GET /api/account/link-operations/:id` | Returns `{version:1, operation, current}` without private URLs. |
| `POST /api/account/link-operations/:id/browser-url` | `{}`; returns `{version:1, url}` only for the current awaiting-browser context. This is the only HTTP response containing the private URL. |
| `POST /api/account/link-operations/:id/cancel` | `{}`; aborts idempotently, returning `202` while pending or `200` once terminal. Cancellation can clean up an old context. |

An active operation blocks another start even in a different group. Status embeds
only a matching-context operation; terminal records do not replace fresh account
status. Start rejects unsupported coordinators and `review_required`, `linked`,
`revoked` or `conflict` states. Unavailable coordinator status returns `503` rather than assuming the
Identity is unlinked. Context changes return `409` without starting another job.

Errors use fixed codes and never include callback exceptions or private URLs.

The viewer supplies the displayed `coordinatorId` and `authority` when the user
clicks **Link Google account**; there is no separate claim checkbox or dialog.
Start re-reads status and verifies both against the complete current context. The
Identity is pinned by `contextId`; the registry passes its expected authority,
coordinator, and context Identity to the core runtime. Public operation snapshots
do not record authority. A status read or poll never starts an operation. Config
and environment Identity selection are both supported; the existing context pins
stop the operation if either changes.

## Foreground viewer binding

Foreground serve binds account reads to its existing store and the config/key
paths selected at startup. Later environment changes cannot switch those paths.
The listener remains unavailable to account requests until its actual port is
known; wildcard bind hosts remain wildcard hosts and are rejected by the guard.

Shutdown closes the account registry before draining listeners and closing the
shared store. Account reads do not initialize another profile or use an admin
credential. The separate sync listener still exposes no account routes.

## Browser handoffs and completion

The Viewer opens an isolated window from the user's **Link Google account** click.
The coordinator start page automatically submits its existing same-origin form;
the start cookie, CSRF token and private device-issued start proof remain required.
With scripts disabled, the same form offers **Continue with Google**. After the
transaction commits, a validated provider URL opens automatically with a manual
fallback. Google authentication and the verified-account confirmation remain
separate from device proof; no account is linked by loading a page alone.

After explicit account confirmation commits, the browser automatically navigates
to the saved literal-loopback receiver, without a referrer. Its receipt says that
the computer is checking the link, not that linking has succeeded. Device
finalization still requires the signed runtime proof. Coordinator website session
redemption remains available separately and is not required to finish Viewer
linking; an existing browser session is never switched automatically.

The Viewer retains the auth window handle without exposing `window.opener`. It
closes it only after its own current operation reports success and a fresh status
read confirms that the same local context and group have a matching linked
Identity. Poll failures, uncertain outcomes and mismatched status cannot close
the window. Provider isolation headers can sever this handle. The loopback receipt
therefore also polls its held listener using a random per-receiver token and
same-origin fetch checks. Only the runtime's successful signed finalization can
mark that result as linked; the receipt then closes itself. Cleanup waits at most
1.5 seconds for that response to flush. Failure or uncertainty never signals
success. Manually opened tabs and browsers that refuse closure retain a check-status
message. Neither popup messages nor receipt content can authorize a link.

Hosted pages and the receipt use Codemem's dark mint palette, sans-serif type,
rounded cards and keyboard focus treatment, with light colors following the OS.
These separate origins cannot read the Viewer's saved theme preference. Inline
styles use exact CSP hashes. The start page permits only its fixed form-submission
script; the receipt permits only its fixed result-checking script and same-origin
connections. No remote scripts or fonts are loaded.
