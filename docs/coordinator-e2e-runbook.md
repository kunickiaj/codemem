# Linux Coordinator E2E Runbook

Use this runbook to validate the built-in TypeScript coordinator on Node/Linux before adapting the flow to Cloudflare.

This is an **Advanced/operator** validation path. The normal user workflow is **Projects → Sharing → Devices → Health**; coordinator groups and direct sync are compatibility and deployment mechanics.

Use this path to prove the coordinator-assisted delivery path end-to-end:

1. start the coordinator
2. create a group
3. generate an invite
4. join from a second device
5. inspect the discovered device in Advanced
6. confirm Project access and delivery in Devices/Health
7. run a direct sync only when diagnosing

## Optional auth browser check

The local browser fixture completed a real cmux WKWebView link flow over both IPv4
and IPv6 in separate fresh fixtures. It kept the original browser binding through
session completion and used one existing Identity without changing its device
assignment. This is **not** a real provider pilot, deployment,
dogfood-ready result, or a claim about production configuration.

Run the local-only fixture on Node 24:

```fish
node packages/cloudflare-coordinator-worker/test/browser-auth-browser-fixture.mjs
```

The script starts two owned local services, prints a `READY` HTTPS origin,
certificate fingerprint, certificate path, and control URLs. It stays running
until stopped with SIGINT or SIGTERM; `--sanity` stops it automatically.
An expected SIGTERM/Node exit `143` during owned-server cleanup is not a failure.
Use `--sanity` to run its 10 assertions without the browser flow. Retain its ignored
`.tmp` artifacts for debugging; do not treat them as test inputs or publish them.

### Safety boundary

- The fixture uses a local fake provider, local D1 state, a demo actor, temporary
  device keys, a signed runtime, and a loopback Node receiver.
- Node clients pin the specific public certificate reported by `READY`; TLS
  validation stays enabled.
- The browser needs explicit permission for the disposable local certificate.
  Do not add a CA, change system trust, disable TLS checks, import profiles or
  cookies, or use real user keys.
- The TLS sanity check requires `Secure`, `HttpOnly`, and `SameSite=Lax` on the
  source cookie; raw browser cookie values are not inspected or recorded.
- The provider step extracts the provider link from the DOM but never navigates to
  a real provider. A local authorize endpoint validates that link and returns the
  local callback instead.
- Do not visit, resolve, or override a real provider domain, including HSTS. The
  fixture loads no external assets.

### Control sequence and expected result

1. POST to the `READY` start control URL, choosing `host=127.0.0.1` or `host=::1`.
   Use the reported certificate as the client's specific CA. Open the private
   start URL printed to terminal stderr in the browser; do not share or log it.
2. Submit the CSRF-protected form with its normal `Origin`; the local provider
   continuation must omit link secrets and completion material.
3. Follow the local callback. The SDK verifies its token and JWKS against the
   signed fake provider; the confirmation view names the account, Identity, and
   device.
4. Confirm with CSRF protection. The saved receiver is IPv4 HTTP; a fresh fixture
   can save the IPv6 HTTP receiver.
5. Click the receiver's `Finish linking` link back to the pinned coordinator's
   `/auth/link/complete` page. The return link contains only the public attempt ID
   and sends no referrer; an early click may show a read-only waiting page.
6. Redeem from the original cookie and confirm the account reports one session.
   `document.cookie` being empty is expected because the browser cookie is
   `HttpOnly`.

The browser retains its original secure coordinator cookie during the loopback
hop; the receiver does not read or set that cookie. A normal fresh
sign-in after logout displays the fake profile, while the first link does not
persist that profile. This checks the fixture's intended account behavior, not
provider account merging or memory-rights changes.

### Repeat and failure interpretation

Use a different database for an independent initial-link test: one account-to-
Identity mapping is unique. Repeating IPv6 on the already-used database should
finalize with `409`; a fresh fixture should pass.

The fixture also checks one benign race: two submissions sharing the same
pre-start cookie yield `200` and `409`, and the browser winner completes. That is
not proof that every cookie race is resolved. A replayed callback is rejected while
the existing browser session can still open its account page.

Occasional browser wait-script completion-handler errors or timeouts can occur
after navigation has already arrived. Confirm the resulting URL and accessibility
snapshot before calling that an application failure; do not relax browser or TLS
security to work around it.

### Remaining gates

This fixture does not cover enrollment review, migration UX, real provider
configuration or consent, independent key provisioning, remote database checks,
migrations, isolated deployment, or separate approval. Relay-after-auth is not
started. Existing plugin smoke-test flakiness has an unconfirmed cause and is not
masked by this fixture.

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
codemem coordinator group-create my-team --db-path ~/.codemem/coordinator.sqlite
set -x CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET (openssl rand -base64 32)
codemem coordinator serve --db-path ~/.codemem/coordinator.sqlite --coordinator-host 0.0.0.0 --coordinator-port 7347
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
codemem coordinator create-invite my-team --db-path ~/.codemem/coordinator.sqlite
```

This returns:

- a pasteable encoded invite string
- a link form of the same payload
- optional warnings if the coordinator URL looks network-scoped

Share the encoded invite with the teammate device.

## 4. Join from the teammate device

On the teammate device:

```fish
codemem coordinator import-invite <encoded-invite>
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
codemem coordinator list-join-requests my-team --db-path ~/.codemem/coordinator.sqlite
codemem coordinator approve-join-request <request-id> --db-path ~/.codemem/coordinator.sqlite
```

## 6. Inspect the discovered device (Advanced)

After both devices are enrolled and posting presence, open **Advanced → Sync** (or the compatible `#sync` route).

Expected state:

- the teammate appears in **Coordinator-discovered devices**
- the coordinator's group membership does not itself grant Project access

For a legacy/direct-peer workflow, on the device that should pair with the teammate:

1. click **Accept peer** in Team sync
2. codemem creates the local `sync_peer`
3. the UI hands you off to the legacy scope editor in **Advanced**

If the discovered peer conflicts with stale local state, Team sync currently shows a note that the repair/removal needs
to happen in **Advanced**. Fix or remove the conflicting local peer there, then return to Team sync and accept the
discovered device again once the row refreshes.

## 7. Confirm Project delivery

For the normal teammate workflow, share exact Projects in **Sharing**, then inspect **Devices** and **Health**:

- the device has an owning **Identity**
- Projects shared directly appear in **Devices** under **Direct Projects**
- Team recipient intent appears in **Sharing**; authoritative per-device Team eligibility remains in Team policy administration
- an unavailable device is **Waiting**, not failed
- **Needs attention** means a terminal setup failure and exposes a retry action

Coordinator enrollment, `sync_peers`, scopes, Space grants, addresses, fingerprints, filters, epochs, and cursors are Advanced/operator diagnostics. They must not be used as the proof of normal Project access.

Removing Project access prevents future delivery; it cannot retract memories already delivered to a device.

## 8. Trigger a direct sync (Advanced diagnostics)

In **Advanced**, click **Sync now** for the new peer.

Current behavior:

- a successful click means the sync run was started, not that it has already completed
- the UI refreshes local sync status once after the trigger
- legacy scope review can still warn after the trigger; resolve it in Advanced before relying on the direct-peer path

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
- legacy scope review is still pending
- the local peer entry is stale or conflicting
- the direct peer address is unhealthy even though coordinator discovery works

Use the Team sync note plus Advanced diagnostics to inspect and repair the actual peer state.

## Exit criteria

Treat the Linux/Node path as validated only when all of this is true:

- teammate can import the invite successfully
- devices appear in coordinator discovery
- discovered device can be accepted into `sync_peers`
- Devices shows the owning Identity and direct Project access; Sharing shows Team inheritance
- Health distinguishes waiting from needs-attention recovery
- a direct sync run is triggered successfully
- data actually replicates between devices

Once this flow is solid, the next step is a Cloudflare compatibility/adaptation pass rather than more guesswork on the
basic coordinator behavior.
