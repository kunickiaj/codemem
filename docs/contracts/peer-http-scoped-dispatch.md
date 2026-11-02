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

The adapter accepts only GET and POST on exactly `/v1/ops`. Other paths return
the generic 404 before reading the store. The channel-only app also excludes
status, snapshot, bootstrap and unrelated routes. The ordinary sync app retains
its existing behavior when no channel reader is configured.

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

## Completion and limits

Each dispatcher instance reuses one sync app and its existing rate limiter for
all exchanges.

Request bodies remain limited to 1 MiB. Response collection stops at 16 MiB and
fails the exchange if the application produces more. Cancellation is checked
before dispatch and during response collection. A committed mutation can still
have an uncertain exchange outcome. Failures cannot trigger an automatic replay
or advance an acknowledgement cursor.

The dispatcher supplies no runtime wiring, transport selection, status exchange
or snapshot support. Those require separate integration before dogfooding.
