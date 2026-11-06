# Channel-bound scoped sync dispatch

`createSyncChannelDispatcher({ storeFactory })` supplies a private dispatch
callback for the owned peer HTTP server. Its store factory is required. Creating
the dispatcher opens no database or listener and installs no application route
in the existing runtime.

## Request and channel identity

The callback accepts the server request fields, including the canonical
`peerPin` derived from the authenticated Noise duplex. It constructs one Fetch
Request and associates that exact object with the pin in a private weak map.
The existing sync app receives a trusted `syncChannelPeerPin(Request)` reader.
A configured reader makes the binding mandatory. A missing binding denies
authentication rather than falling back to ordinary listener authentication.

The adapter accepts GET and POST on `/v1/ops`, plus GET on `/v1/status` and
`/v1/snapshot`. Other method/path combinations return the generic 404 before
reading the store. The channel-only app excludes bootstrap and unrelated routes.
The ordinary sync app retains its existing behavior when no channel reader is
configured.

The logical URL must preserve the exact target, including query encoding and
order. Normalized targets and nonempty GET bodies return 400. POST bytes are
copied without parsing or reserialization before signature verification.
Transport-only Host, Content-Length and Connection headers are removed when
constructing the Fetch Request. The HTTP server owns their wire framing.

## Authentication and scope

The existing authorization operation checks the current peer record and its
fingerprint, then compares its canonical SSH algorithm and key blob with the
channel pin. A mismatch denies before signature verification or nonce use.
Both v2 and recipient-bound v3 signatures are required on every channel request,
regardless of prior sticky signature adoption.

Authorization records the existing global nonce once. The dispatcher performs
no separate authentication pass. GET must provide `scope_id` in its query, and
POST must provide it in the signed body. Existing scope checks require current
authorization for both the local and peer signing keys. Missing, empty,
unsupported or unauthorized scopes cannot enter the legacy default-scope path.

## Scoped status and recovery

Status returns the requested scope's reset boundary and one `authorized_scopes`
entry. It does not enumerate other scopes or return the legacy default boundary.
The entry also carries `applied_cursor`: the `created_at|op_id` of the last op
this device applied from the calling peer in that scope, or null. It describes
only the authenticated peer's own ops. The client's push starts after the later
of that cursor and its own saved acknowledgement, so a peer that already pulled
the ops directly is not sent them again. An absent or malformed value changes
nothing, and the saved acknowledgement never moves backwards.

The direct legacy push reads the same `authorized_scopes` entries. For each
scope it drops ops at or before the later of the peer's `applied_cursor` and
the relay channel's saved acknowledgement for that scope, when that
acknowledgement still belongs to the peer's current reset boundary. A device
that returns to direct sync after relaying therefore does not resend what the
relay already delivered.
Snapshot uses the same explicit scope authorization before loading any page,
and preserves the existing generation, snapshot ID and page-token checks.

Both read endpoints authenticate once against the channel before handling scope
or page parameters. Neither attempts bootstrap authentication or refreshes
coordinator membership in response to request headers. Membership maintenance
must update the local cache independently.

Channel scope denials return `409 reset_required` with the scope failure reason
and `scope_id: null`. They omit reset boundary fields because no scope has been
authorized. This also applies to channel ops requests.

## Completion and limits

Each dispatcher instance reuses one sync app and its existing rate limiter for
all exchanges.

Request bodies remain limited to 1 MiB. Response collection stops at 16 MiB and
fails the exchange if the application produces more. Cancellation is checked
before dispatch and during response collection. A committed mutation can still
have an uncertain exchange outcome. Failures cannot trigger an automatic replay
or advance an acknowledgement cursor.

## Scoped client pass

The internal `syncScopedChannelOnce` client uses one explicit scope, logical
origin and owned connection factory for the whole pass. It does not discover
addresses, run a default-scope exchange, refresh coordinator authorization, or
persist the logical origin as a successful peer address.

The client checks current local and peer keys and scope authorization before and
after each exchange. Every connection must carry the authenticated Noise pin for
the selected peer. Status must identify that peer and contain exactly the
selected scope. Snapshot and operation reads retain source and scope checks
before applying data.

The client forms the complete scoped POST body before signing it. It splits
serialized bodies locally to fit the 1 MiB request limit. An operation that
cannot fit fails without advancing the outbound acknowledgement. A complete
application `413` for size or operation count may split a batch further using
fresh signatures. A transport failure never becomes a synthetic `413` and never
triggers an automatic mutation retry or a switch to another transport.

Snapshot recovery reuses the existing scoped pull implementation. The opt-in
client stores completed pull boundaries and outbound acknowledgements in
`sync_channel_progress`, keyed by peer and scope. Acknowledgements cannot replace
the existing bootstrap marker, and another peer's snapshot cannot reset this
peer's upload position. A changed peer boundary clears its previous outbound
acknowledgement. The table is created only after the client authorizes the
requested scope.

When the peer requires reset recovery, the client deletes completion and outbound
acknowledgement state for that peer and scope before clearing the inbound cursor.
The next pass downloads a fresh snapshot even if the peer's snapshot boundary has
not changed. If deleting completion fails, the inbound cursor is preserved.

`runSyncPass` serializes reachability-enabled passes for the same database handle
and peer. Direct callers of the private `syncScopedChannelOnce` must still
serialize the same peer and scope. Neither rule coordinates separate processes.

One absolute deadline covers the pass, including all pages, uploads and fresh
connections. It is at most 60 seconds from invocation, shortened by an earlier
caller deadline.

When `runSyncPass` receives `reachability`, direct sync retains its legacy
full-scope behavior. Direct receives a 10-second status probe budget inside the
60-second absolute pass deadline. A matching pinned fingerprint commits that
route. A network failure before commitment can select the explicit-Space relay
path; after commitment, the pass cannot switch paths or replay an exchange.

The relay client opens a fresh relay route and Noise session for each channel HTTP
request. The synthetic logical origin is used only to construct the request and
is never dialed or persisted. Current selection is direct, relay, then wait
because no approved RTC factory is available.
