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
device has passed an operator review.

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
Identity matches the running local Identity. A missing controller review is
`review_required`, not unlinked. Unsupported, offline and rejected reads do not
imply that Google is required. `canLink` is true only for a fresh, matching,
unlinked subject; the broker never publishes an operator review or grants access.

Link operations and viewer startup wiring follow separately. The status broker
does not initialize a store, migrate a schema, generate keys or change Identity
assignments. It returns no private browser URLs, tokens or admin credentials.

## In-process link lifecycle

`createAccountLinkRegistry` permits one active operation per viewer process,
including across groups. It captures the profile context and passes expected
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

## Protected link operations

Operation routes are mounted only when the app supplies both `readContext` and
`registry`. They require the existing account request protection and CSRF header.
POST bodies must contain exactly the documented object keys and be at most 1 KiB,
read within ten seconds; disconnects stop body reads. Operation routes accept no query parameters.

| Route | Body and result |
| --- | --- |
| `POST /api/account/link-operations` | `{groupId, contextId}`; fresh matching unlinked status and a final context check precede start. Returns `202 {version:1, operation}`. |
| `GET /api/account/link-operations/:id` | Returns `{version:1, operation, current}` without private URLs. |
| `POST /api/account/link-operations/:id/browser-url` | `{}`; returns `{version:1, url}` only for the current awaiting-browser context. This is the only HTTP response containing the private URL. |
| `POST /api/account/link-operations/:id/cancel` | `{}`; aborts idempotently, returning `202` while pending or `200` once terminal. Cancellation can clean up an old context. |

An active operation blocks another start even in a different group. Status embeds
only a matching-context operation; terminal records do not replace fresh account
status. Start rejects unsupported coordinators and `review_required`, `linked`,
`revoked` or `conflict` states. Unavailable coordinator status returns `503` rather than assuming the
Identity is unlinked. Context changes return `409` without starting another job.

Errors use fixed codes and never include callback exceptions or private URLs.

## Foreground viewer binding

Foreground serve binds account reads to its existing store and the config/key
paths selected at startup. Later environment changes cannot switch those paths.
The listener remains unavailable to account requests until its actual port is
known; wildcard bind hosts remain wildcard hosts and are rejected by the guard.

Shutdown closes the account registry before draining listeners and closing the
shared store. Account reads do not initialize another profile or use an admin
credential. The separate sync listener still exposes no account routes.
