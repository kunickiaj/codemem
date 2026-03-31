# Deploying the coordinator on Cloudflare Workers + D1

Use this runbook when you want the coordinator-backed discovery service to run on Cloudflare instead of on a Linux host.

This document describes the **current TypeScript Worker path that was validated against a real deployed Worker + D1 database**.

If you want the canonical product-validation path first, use the built-in Linux/Node coordinator guide in
`docs/coordinator-deployment.md`.

## What this deployment does

The Cloudflare coordinator stores only coordinator metadata:

- groups
- enrolled devices
- presence records
- invite tokens
- join requests
- reciprocal approvals

It does **not** relay memory payloads, queue sync data, or become the source of truth for memories. Direct peer-to-peer
sync remains the data path.

## Current implementation source of truth

Use these files as authoritative for the Worker deployment:

- Worker entrypoint: `packages/cloudflare-coordinator-worker/src/index.ts`
- Wrangler config template: `packages/cloudflare-coordinator-worker/wrangler.toml.example`
- D1 schema: `packages/cloudflare-coordinator-worker/schema.sql`
- Optional helper tooling: `examples/cloudflare-coordinator/bootstrap.py`, `examples/cloudflare-coordinator/smoke_check.py`

Do **not** point Wrangler at an old `examples/.../src/index.mjs` path. The live Worker source is in the package above.

## Prerequisites

- Wrangler installed and authenticated
- access to a Cloudflare account with Workers + D1 enabled
- a local codemem install with a valid sync device identity
- a secret value you will use for `CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET`

Install and verify Wrangler:

```fish
npm install -g wrangler
wrangler login
wrangler whoami
```

## 1. Create the D1 database

From the worker package directory:

```fish
cd packages/cloudflare-coordinator-worker
wrangler d1 create codemem-coordinator
```

Copy the returned `database_id`.

## 2. Create a real Wrangler config

Start from the package template:

```fish
cp wrangler.toml.example wrangler.toml
```

Then edit `wrangler.toml` and replace:

- `REPLACE_WITH_D1_DATABASE_ID`

The current template intentionally includes:

```toml
compatibility_flags = ["nodejs_compat"]
```

Keep that setting unless/until the runtime-boundary follow-up says otherwise.

## 3. Apply the schema

Use the package worker schema, not the older cut-down example schema:

```fish
wrangler d1 execute codemem-coordinator --remote --file schema.sql
```

That schema includes the invite, join-request, and reciprocal-approval tables required by the current Worker runtime.

## 4. Set the admin secret

Create a strong secret value and store it on the Worker:

```fish
python3 - <<'PY'
import secrets
print(secrets.token_urlsafe(32))
PY
```

Then:

```fish
wrangler secret put CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET
```

This secret is required for remote admin endpoints such as:

- create invite
- list join requests
- approve / deny join requests

## 5. Deploy the Worker

From the worker package directory:

```fish
wrangler deploy
```

Wrangler prints the deployed URL, for example:

- `https://codemem-coordinator-worker.<your-subdomain>.workers.dev`

That URL becomes your `sync_coordinator_url`.

## 6. Seed the first group and first enrolled device

Today, Cloudflare deployment still assumes explicit operator enrollment for the first device.

You need:

- local device ID
- local fingerprint
- local public key

You can inspect local sync identity with:

```fish
codemem sync status
cat ~/.config/codemem/keys/device.key.pub
```

Then enroll the first device in D1:

```fish
wrangler d1 execute codemem-coordinator --remote --command "
INSERT INTO groups(group_id, display_name, created_at)
VALUES ('team-alpha', 'Team Alpha', CURRENT_TIMESTAMP)
ON CONFLICT(group_id) DO NOTHING;

INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, display_name, created_at)
VALUES (
  'team-alpha',
  '<device-id>',
  '<ssh-ed25519 public key>',
  '<fingerprint>',
  '<display name>',
  CURRENT_TIMESTAMP
)
ON CONFLICT(group_id, device_id) DO UPDATE SET
  public_key = excluded.public_key,
  fingerprint = excluded.fingerprint,
  display_name = excluded.display_name,
  enabled = 1;
"
```

## 7. Configure the admin codemem device

On the device that will create invites and review joins:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://your-worker.example.workers.dev",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_admin_secret": "<the secret you stored with wrangler secret put>"
}
```

## 8. Smoke validation

Before onboarding real teammates, validate the deployment.

### Unsigned request sanity check

An unsigned peer lookup should fail with `missing_headers`:

```fish
curl -i "https://your-worker.example.workers.dev/v1/peers?group_id=team-alpha"
```

Expected result:

- `401`
- JSON body like `{"error":"missing_headers"}`

### Signed smoke check

Use the helper script against the deployed Worker:

```fish
uv run python examples/cloudflare-coordinator/smoke_check.py \
  --db ~/.codemem/mem.sqlite \
  --url "https://your-worker.example.workers.dev" \
  --group team-alpha
```

Expected result:

- `POST /v1/presence` succeeds
- `GET /v1/peers` succeeds
- returned peers reflect currently enrolled devices

## 9. Validate invite flows

### Auto-admit

Create an auto-admit invite from the admin device:

```fish
codemem sync coordinator create-invite team-alpha
```

Then on a second device:

```fish
codemem sync coordinator import-invite <encoded-invite>
```

Expected behavior:

- join succeeds immediately
- second device can post signed presence
- second device can fetch peers

### Approval-required

Create an approval-required invite:

```fish
codemem sync coordinator create-invite team-alpha --policy approval_required
```

Expected behavior:

- teammate import returns pending state
- admin can list pending join requests
- admin can approve the request
- second device can post signed presence after approval

## 10. Validate reciprocal approval flow

After two devices are enrolled and can post presence:

- device A creates a reciprocal approval targeting device B
- device B sees the pending incoming request
- device B reciprocates toward device A
- the pair converges to `completed`

This is the coordinator-side onboarding trust state used by the current Worker deployment.

## Troubleshooting

### D1 command uses `00000000-0000-0000-0000-000000000000`

You are still using a placeholder Wrangler config.

Fix the real `database_id` in `packages/cloudflare-coordinator-worker/wrangler.toml` before running remote D1 commands.

### Worker returns `missing_d1_binding`

Your Worker deployed without the `COORDINATOR_DB` binding.

Check `wrangler.toml` and redeploy.

### Worker returns `missing_headers`

That is expected for unsigned `presence` / `peers` / reciprocal-approval requests. Use signed codemem requests or the
smoke-check helper.

### Worker returns `unknown_device`

The device is not enrolled in the coordinator group yet. Apply enrollment SQL or complete invite/join flow first.

### Worker returns `invalid_signature`

The enrolled public key/fingerprint does not match the local signing keypair, or the wrong device identity is being used.

### Worker returns Cloudflare `1010`

Cloudflare blocked the request before it reached the Worker. Check Browser Integrity Check, WAF rules, or hostname-level
security settings for the deployed Worker/custom domain.

### Invite or join endpoints fail with SQL errors like `no such table`

You likely applied the wrong schema. Re-apply:

```fish
wrangler d1 execute codemem-coordinator --remote --file schema.sql
```

## Support posture

This path is now **validated on a real deployed Worker + D1 database**, but Linux/Node remains the canonical product
development and dogfooding path.

Use Cloudflare when you want a serverless coordinator-backed discovery deployment. Use Linux/Node first when you want
the fastest path to validate new coordinator product behavior.
