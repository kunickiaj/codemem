# Relay

When two of your devices can't reach each other directly, a relay lets them sync anyway. The relay runs on your team's coordinator. It only passes encrypted traffic between two devices that are online at the same time. It never stores memories, decides who may see them, or shares anything the devices didn't already share.

This page covers what relay does and doesn't do, how to turn it on and off, and what its status messages mean. For the protocol and the runtime API, see [Relay runtime](relay-runtime.md).

## What relay is

- **Optional.** A coordinator serves relay only after its operator turns it on. A device uses relay automatically when its coordinator offers it, and you can turn that off on any device. Without relay, sync works exactly as before.
- **Live only.** Both devices must be online and running `codemem serve`. The relay holds no copy of anything, so when the other device is offline the sync attempt fails and nothing waits in a queue. The next pass, two minutes later by default, tries again.
- **End-to-end encrypted.** The two devices authenticate each other with the keys they pinned when they paired, and encrypt everything between them. The relay forwards ciphertext. It sees which enrolled devices are talking, in which coordinator group, when, and how many bytes they send. It doesn't see memory content, titles, or which Space a sync is for.
- **Not in charge of access.** The coordinator decides who may connect: every relayed sync needs separate approval for the sending device, the relay, and the receiving device, based on current group enrollment. The receiving device then checks Space membership itself, as it does for direct sync. A relay can refuse traffic, but it can't let anyone in.
- **Not a sharing grant.** A device relays only for Spaces that it and the other device already share through the coordinator. Relay never adds a Space, a peer, or a member.

## When codemem uses relay

Each sync pass with a peer tries the peer's direct addresses first. Relay is used only when every direct address fails, the coordinator offers relay for the group that owns a Space both devices share, and the device trusts that coordinator's relay key. A peer that shares no coordinator-managed Space with you syncs directly or not at all.

Relay doesn't replace an always-on device. These three situations look similar but behave differently:

| Situation | What happens |
| --- | --- |
| The other device is online but unreachable directly | The pass syncs through the relay. |
| The other device is offline | The pass fails and nothing is stored anywhere. The devices sync on the first pass after both are online again. |
| You need memories to reach a device that is rarely online | Run an always-on member of the Space, such as an [anchor peer](anchor-peer-deployment.md). It keeps a full copy, and other devices sync with it whenever they come online. |

## Devices

Relay needs `sync_enabled`, `sync_coordinator_url` set to an `https://` origin with no path, and at least one group in `sync_coordinator_groups`. With those set, `codemem serve` checks each group with the coordinator after every coordinator refresh. You don't need any relay setting.

The first time a device sees a group's relay key, it pins that key. If the coordinator later offers a different key, relay pauses for that group and sync stays direct until you approve the new key:

```fish
codemem sync relay-keys
codemem sync approve-relay-key <group> --key <candidate>
```

Check the new key with your coordinator operator before you approve it. A key change you didn't expect can mean the coordinator was changed by someone else.

To skip trusting the first key a device sees, set `sync_relay_service_key` (or `CODEMEM_SYNC_RELAY_SERVICE_KEY`) to the key your operator gives you. The device then pins that key and ignores the one the coordinator offers.

To turn relay off on a device, set `sync_relay_enabled` to `false` (or `CODEMEM_SYNC_RELAY_ENABLED=0`) and restart `codemem serve`. The viewer reads the setting only when it starts.

## Status and troubleshooting

`codemem serve` logs each group's relay state once when it changes:

| Log line | Meaning | What to do |
| --- | --- | --- |
| `relay for group <group>: ready` | Relay is available for this group. | Nothing. |
| `paused: the relay service key changed` | The coordinator offers a different key than the one this device pinned. | Confirm the key with the operator, then run `codemem sync approve-relay-key`. |
| `disabled: relay_opt_out` | `sync_relay_enabled` is `false` on this device. | Set it to `true` and restart `codemem serve` if you want relay. |
| `disabled: info_unavailable` | The coordinator didn't offer relay for this group. Relay may be off, this group may not be configured, or the coordinator may be unreachable. | Nothing, if your coordinator doesn't run relay. Otherwise ask the operator. |
| `disabled: info_invalid` | The coordinator's relay reply didn't match this coordinator and group. | Ask the operator. Sync stays direct. |
| `disabled: service_key_invalid` | `sync_relay_service_key` on this device isn't an `ssh-ed25519` key. | Fix or remove the setting. |
| `disabled: coordinator_url_unsupported` | `sync_coordinator_url` isn't an `https://` origin with no path. | Fix the URL. |
| `disabled: device identity missing` or `device private key unavailable` | This device can't load its sync identity. | Run `codemem sync doctor`. |

When a relayed pass fails, `codemem sync attempts` shows an error ending in a reason code, such as `scoped channel exchange failed: relay_rejected`. The common ones:

| Code | Usual cause | What to do |
| --- | --- | --- |
| `relay_rejected` | The other device isn't connected to the relay, or the coordinator didn't approve the route. | Make sure the other device is online with `codemem serve` running. The next pass retries. |
| `relay_unavailable` | This device couldn't reach or register with the relay. | Check that the coordinator is reachable. The operator may have turned relay off for the group. |
| `relay_admission_failed` | The coordinator didn't approve this device for relay, or couldn't be reached. | Check that the device is still enrolled in the group. Right after an operator turns relay on, approvals fail for about six minutes while relay health warms up. |
| `relay_expired` | The relayed sync ran out of time. | Retry. If it keeps happening, tell the operator. |
| `relay_frame_invalid`, `relay_handshake_failed`, `relay_record_invalid` | Something changed the traffic between the devices and the relay. | Report it to the coordinator operator. |
| `relay_peer_revoked` | The other device's key changed since the pass started. | Pair the device again if the change is expected. |

A pass makes several exchanges in order: status, then pull, then push in batches. A failed exchange never moves a cursor or marks memories as delivered, so the next pass sends whatever it didn't. Exchanges that finished earlier in the same pass keep their progress. For example, a pass that pulled successfully and then failed while pushing keeps the memories it pulled. The [relay runtime reference](relay-runtime.md#relay-failure-reasons) lists every code.

## Operators

Relay is off until you turn it on.

- **Cloudflare coordinator.** The relay runs in the coordinator Worker as one Durable Object per group. Follow [Optional relay host](cloudflare-coordinator-deployment.md#optional-relay-host-off-by-default) to apply the migrations, set the service key and health probe secrets, deploy, and provision each group. One Worker serves up to 8 groups.
- **Self-hosted coordinator.** The Node relay runs on the coordinator's own HTTP server, or as a separate process behind the same hostname. [Relay runtime](relay-runtime.md) covers composing it. Both layouts pass the same [acceptance run](relay-runtime.md#compare-relay-hosts-end-to-end) as the Cloudflare relay.

Admission approvals start only after relay health has seen five healthy minutes, so expect about six minutes between turning relay on and the first relayed sync.

### Turning relay off

| Scope | How | Takes effect |
| --- | --- | --- |
| One group, Cloudflare | `POST /v1/admin/relay/quota` with `"enabled": false` for the group's realm | Immediately. Open connections close. |
| Every group, Cloudflare | Set `CODEMEM_RELAY_ENABLED` to anything other than `"true"` and deploy | After the deploy. Each connection closes on its next event. |
| One group, self-hosted | Call `disable()` on that group's relay runtime | Immediately. |
| One device | `sync_relay_enabled: false`, then restart `codemem serve` | After the restart. |

Turning relay off never affects direct sync or the coordinator's other routes.

### What an operator can see

The relay sees enrolled device IDs, the coordinator group, connection times, and byte counts. For fairness limits it keeps client network addresses, grouped by IPv6 /64, in memory only, and never writes them to storage or logs. An address stays in memory while its connection is open, and its attempt counter stays until the next connection attempt after a minute without one. Everything held in memory goes when the relay restarts or is evicted. It can't read memory content or tell which Space a sync is for, because the devices encrypt everything end to end.

### Rotating the service key

A new service key pauses relay on every device that pinned the old one, until each user approves the new key with `codemem sync approve-relay-key`. Tell users the new key through a channel other than the coordinator, so they can check it before approving.

### Limits

- 8 groups per Worker.
- Each relayed exchange carries at most 2 MiB. Sync pages stop at 1 MiB, so this matters only for a single memory larger than 2 MiB, which can't sync over relay.
- Each client address may hold two connections that haven't registered yet, and make ten connection attempts a minute.
- A device opens at most one relayed exchange with the same peer every six seconds.
