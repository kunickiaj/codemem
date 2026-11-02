# Offline traversal Noise preparation

The local traversal Noise API prepares a held opening before a message channel
exists. It uses the existing pinned Noise implementation and Ed25519 identities,
with prologue transport label `0x03`. It creates no RTC engine, network socket,
coordinator request, or persisted key.

## Source preparation and attachment

`prepareTraversalNoiseInitiator` generates a fresh 16-byte session ID and starts
one Noise attempt over an unattached byte Duplex. The existing Noise wire holds
the exact 34-byte Message A. Preparing the opening sends no transport bytes.
The `sessionId` getter returns an independent copy, and the opening promise
returns a copy of the held bytes with their digest.

The caller binds this session ID and digest in its signaling transcript. Before
calling `attachAndRelease`, the caller must complete its own coordinator check,
pin and packet-chain validation, remote-description checks, and channel setup.
This API does not verify those prerequisites or authorize a peer.

`attachAndRelease` accepts one open source-side `TraversalByteStream` with empty,
compatible buffers. It attaches the stream and synchronously releases the held
opening from the same Noise attempt. A second attachment, a late attachment after
cancellation or expiry, an ended stream, a target-side stream, or buffered early
data ends the attempt. The call takes ownership of the supplied Duplex even when
it fails, so a rejected late channel is destroyed rather than left open.

The absolute monotonic deadline includes offline preparation and rendezvous.
The existing Noise handshake limit starts at attachment and cannot extend that
deadline. `cancel` terminates the attempt before or after attachment.

## Target opening check

`acceptTraversalNoiseResponder` requires a target-side `TraversalByteStream`,
the session ID from the caller's checked packet chain, and the expected Message A
digest. It fixes label `0x03` and uses the existing Noise opening gate.

The target checks the complete opening and its digest before creating the inbound
Noise factory or sending Message B. A mismatched digest, malformed or truncated
opening, or extra early bytes ends the attempt. A matching digest binds bytes
only. It does not prove authorization, freshness, or a coordinator decision.

## Byte queues and shutdown

The deferred transport rejects writes and EOF before attachment. After attachment
it copies bytes, enforces its read and write queue caps, and propagates
backpressure. It rejects read encodings so Node continues to count queued bytes.
Its buffer limit may only reduce the existing 256 KiB Noise maximum. A limit too
small for the 34-byte opening rejects preparation. Smaller limits may also reject
larger Noise records after attachment.

The wrapper preserves source-first causal shutdown. It waits for the attached
stream's close before completing its own destruction and reports premature close
as failure. Buffered readable bytes remain available after clean inner closure.
The underlying stream's `disposed` promise reports resource release only. HTTP
completion and clean I/O completion still require separate checks.

These modules are internal source APIs without a package index export. They do
not activate traversal, validate SDP candidates, enforce RTC engine resource
limits, or implement authenticated signaling and scoped HTTP dispatch.
