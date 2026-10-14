# Viewer account API

The My Account API is separate from recipient and access management. Its local
request protection does not grant operator privileges or require Google for
existing coordinator operations.

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

This slice exposes only the session route. Status, linking operations and viewer
startup wiring follow separately; a successful session does not mean an account
is linked or that the current device has passed an operator review.
