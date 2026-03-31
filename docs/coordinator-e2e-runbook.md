# Linux Coordinator E2E Runbook

Use this runbook to validate the built-in TypeScript coordinator on Node/Linux before adapting the flow to Cloudflare.

This is the current reference path for proving the product works end-to-end:

1. start the coordinator
2. create a group
3. generate an invite
4. join from a second device
5. accept the discovered peer
6. review sync scope
7. run a direct sync

If this flow does not work on a clean Linux/Node setup, fix that first. Do not blame Cloudflare for bugs that already
exist locally.

## Assumptions

- one reachable Linux machine will run the coordinator
- two codemem devices will join the same coordinator group
- the coordinator is reachable from both devices (direct IP, Tailscale Funnel, or Cloudflare Tunnel)

## 1. Start from clean coordinator state

On the coordinator host:

```fish
rm ~/.codemem/coordinator.sqlite
codemem sync coordinator group-create my-team --db-path ~/.codemem/coordinator.sqlite
set -x CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET (openssl rand -base64 32)
codemem sync coordinator serve --db-path ~/.codemem/coordinator.sqlite --host 0.0.0.0 --port 7347
```

If you do not want to expose the raw host directly, put it behind Tailscale Funnel or Cloudflare Tunnel and use that
public URL in the next steps.

## 2. Configure the admin device

On the device that will create invites:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://coord.example.com",
  "sync_coordinator_group": "my-team",
  "sync_coordinator_admin_secret": "<same admin secret from the coordinator host>"
}
```

Use a coordinator URL the teammate device can actually reach.

If you create an invite with a LAN-only, localhost, or Tailnet-only URL, codemem now warns about that, but it will not
block you because private-network deployments can still be valid.

## 3. Create and share an invite

On the admin device:

```fish
codemem sync coordinator create-invite my-team --db-path ~/.codemem/coordinator.sqlite
```

This returns:

- a pasteable encoded invite string
- a link form of the same payload
- optional warnings if the coordinator URL looks network-scoped

Share the encoded invite with the teammate device.

## 4. Join from the teammate device

On the teammate device:

```fish
codemem sync coordinator import-invite <encoded-invite>
```

Expected result:

- `sync_coordinator_url` is configured automatically
- `sync_coordinator_group` is configured automatically
- if the invite uses `auto_admit`, enrollment completes immediately
- if the invite uses `approval_required`, the teammate sees a pending state until approval

The invite import path now uses a more reasonable timeout than the old brittle 3-second default, but if it still times
out, check reachability of the invite’s `coordinator_url` from the teammate machine before doing anything else.

## 5. Approve join requests if needed

If the invite policy is `approval_required`, on the admin host:

```fish
codemem sync coordinator list-join-requests my-team --db-path ~/.codemem/coordinator.sqlite
codemem sync coordinator approve-join-request <request-id> --db-path ~/.codemem/coordinator.sqlite
```

## 6. Accept the discovered peer

After both devices are enrolled and posting presence, open the Sync tab.

Expected state:

- the teammate appears in **Coordinator-discovered devices**
- they are not yet an active sync peer until explicitly accepted

On the device that should pair with the teammate:

1. click **Accept peer** in Team sync
2. codemem creates the local `sync_peer`
3. the UI hands you off to the existing scope editor in **People**

If the discovered peer conflicts with stale local state, Team sync currently shows a note that the repair/removal needs
to happen in **People**. Fix or remove the conflicting local peer there, then return to Team sync and accept the
discovered device again once the row refreshes.

## 7. Review sync scope

In **People**, the accepted peer now shows a pending scope review state until you explicitly review it.

Options:

- save a device-specific scope override
- reset to global scope if the defaults are already correct

Nothing magical happens here. The point is to make sure you look at the sharing rules before relying on the first sync.

## 8. Trigger a sync

In **People**, click **Sync now** for the new peer.

Current behavior:

- a successful click means the sync run was started, not that it has already completed
- the UI refreshes local sync status once after the trigger
- if scope review is still pending, the People card currently warns **after** the trigger that sync started before scope review was finished

## 9. Verify the result

Good signals:

- the peer moves from stale/offline to healthier status over time
- sync attempts appear in the diagnostics surface
- the receiving device actually gets the expected memories

Useful checks:

```fish
codemem sync peers
codemem sync attempts --limit 10
curl "http://127.0.0.1:38888/api/sync/status?includeDiagnostics=1"
```

## Common failure modes

### Invite imports but join times out

The invite probably embeds a coordinator URL the joining machine cannot reach.

Recreate the invite with the real public or shared-network URL.

### Join succeeds but coordinator requests return `invalid_signature`

You likely have stale coordinator enrollment state for that device id.

Reset or repair the coordinator DB entry and try again from a clean state.

### Peer is discovered but still not syncing

That can still mean:

- the peer was not accepted yet
- scope review is still pending
- the local peer entry is stale or conflicting
- the direct peer address is unhealthy even though coordinator discovery works

Use the Team sync note plus the People card to inspect and repair the actual peer state.

## Exit criteria

Treat the Linux/Node path as validated only when all of this is true:

- teammate can import the invite successfully
- devices appear in coordinator discovery
- discovered device can be accepted into `sync_peers`
- scope review handoff works
- a direct sync run is triggered successfully
- data actually replicates between devices

Once this flow is solid, the next step is a Cloudflare compatibility/adaptation pass rather than more guesswork on the
basic coordinator behavior.
