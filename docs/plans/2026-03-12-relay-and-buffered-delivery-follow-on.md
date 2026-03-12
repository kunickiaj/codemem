# Relay and Buffered Delivery Follow-on After Coordinator MVP

**Bead:** `codemem-0wl`  
**Status:** Design  
**Date:** 2026-03-12

## Why this is deferred

The coordinator MVP solves the immediate problem users are actually hitting today:

- unstable peer addresses across VPN/network boundaries
- weak or absent cross-network discovery beyond LAN mDNS

Relay/proxy transport and offline buffering are still important, but they are not the first pain to solve.

## Follow-on scope

After coordinator-backed discovery ships, the next transport questions are:

1. should the coordinator also proxy sync traffic when direct dial fails?
2. should the coordinator buffer sync payloads briefly when peers are not online at the same time?

Those should remain a separate track.

## Design constraints inherited from the coordinator MVP

The coordinator MVP should preserve these extension points for later work:

- device-key auth remains the trust model
- group membership remains explicit and reusable
- capability flags can later advertise relay or queue support
- local databases stay authoritative

## Recommended next-step criteria

Relay/proxy transport becomes justified when coordinator-backed discovery still leaves too many direct-dial failures even
with fresh addresses.

Buffered delivery becomes justified when:

- peers are frequently not online at the same time
- direct sync works when both peers are live, but operational usefulness suffers because updates wait too long

## Future prototype boundaries

When this track starts, the first relay/buffer slice should still avoid:

- server-authoritative memory state
- central retrieval/search
- hosted account system
- retroactive data deletion guarantees

The likely first prototype should be:

- optional relay transport for replication payload delivery only
- short-lived queueing for offline recipients
- explicit retention window and failure semantics

## Success criteria for taking this on later

- coordinator-backed discovery has shipped and been dogfooded
- direct-dial failure patterns or offline gaps are well understood
- we can name the specific user pain the relay/buffer layer is solving rather than building it preemptively
