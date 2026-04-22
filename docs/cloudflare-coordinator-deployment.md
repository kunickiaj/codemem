# Cloudflare Worker + D1 coordinator deployment

Use this runbook when you specifically want to deploy the coordinator discovery contract on Cloudflare Workers + D1.

This is the canonical Cloudflare deployment reference for the current TypeScript worker path. It is still a secondary
deployment target behind the built-in coordinator service in `codemem sync coordinator serve`, but if you are choosing
the Worker path, this document is the source of truth.

## What this deploys

Current source-of-truth files:

- Worker entrypoint: `packages/cloudflare-coordinator-worker/src/index.ts`
- Worker request verifier: `packages/cloudflare-coordinator-worker/src/request-verifier.ts`
- D1 schema: `packages/cloudflare-coordinator-worker/schema.sql`
- Example Wrangler config wrapper: `examples/cloudflare-coordinator/wrangler.toml.example`

The Worker currently provides:

- signed `POST /v1/presence`
- signed `GET /v1/peers`
- D1-backed device enrollment
- invite creation/import flows
- join request review flows
- reciprocal approval persistence in schema
- nonce replay protection

It does **not** relay memory payloads or replace direct peer-to-peer sync.

## Before you start

Recommended sequence:

1. validate the built-in TypeScript coordinator flow first via `docs/coordinator-e2e-runbook.md`
2. deploy the Worker only after the local TS path is already behaving correctly

If the basic coordinator flow is broken locally, the Worker path will mostly just make the debugging more annoying.

## Prerequisites

- Cloudflare account with Workers + D1 enabled
- Wrangler installed and authenticated
- a local codemem install with a real device identity
- a public or shared-network Worker URL that teammate devices can actually reach

Install and log into Wrangler:

```fish
npm install -g wrangler
wrangler login
```

## 1. Create the D1 database

```fish
wrangler d1 create codemem-coordinator
```

Copy the returned database id.

## 2. Create a real Wrangler config

Start from the example wrapper config:

```fish
cp examples/cloudflare-coordinator/wrangler.toml.example examples/cloudflare-coordinator/wrangler.toml
```

Then replace `REPLACE_WITH_D1_DATABASE_ID` in `examples/cloudflare-coordinator/wrangler.toml` with the real D1 id.

That file points at the live Worker package source, not a separate example implementation:

- `main = "../../packages/cloudflare-coordinator-worker/src/index.ts"`

The current Worker path uses the Worker-native WebCrypto request verifier in
`packages/cloudflare-coordinator-worker/src/request-verifier.ts`, but the checked-in Worker config still keeps
`nodejs_compat` enabled for now because the shared coordinator code path still pulls in some transitive `node:*`
dependencies during Worker startup.

## 3. Set the admin secret

Admin operations use a separate secret header path. Set it before deploy:

```fish
wrangler secret put CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET --config examples/cloudflare-coordinator/wrangler.toml
```

This secret is required for admin routes such as invite creation and join-request review.

## 4. Apply the schema

Use the package schema, not the stale example copy:

```fish
wrangler d1 execute codemem-coordinator --remote --file packages/cloudflare-coordinator-worker/schema.sql
```

The package schema includes the current coordinator tables for invites, join requests, and reciprocal approvals.

## 5. Deploy the Worker

From `examples/cloudflare-coordinator/`:

```fish
wrangler deploy
```

Expected result:

- Wrangler prints a `https://...workers.dev` URL
- that URL becomes `sync_coordinator_url`

## 6. Enroll the first device

The Worker path assumes explicit operator-managed enrollment in D1. The old Python bootstrap helper has been archived with
the legacy runtime, so the current path is manual.

Generate or write SQL that creates the group and inserts the enrolled device row:

```sql
INSERT INTO groups(group_id, display_name, created_at)
VALUES ('team-alpha', 'Team Alpha', CURRENT_TIMESTAMP)
ON CONFLICT(group_id) DO NOTHING;

INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, display_name, created_at)
VALUES (
  'team-alpha',
  'device-1',
  'ssh-ed25519 AAAA... user@host',
  'SHA256:...',
  'laptop',
  CURRENT_TIMESTAMP
);
```

Apply it:

```fish
wrangler d1 execute codemem-coordinator --remote --command "<paste generated SQL here>"
```

## 7. Configure codemem clients

Admin device example:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://your-worker.example.workers.dev",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_timeout_s": 3,
  "sync_coordinator_presence_ttl_s": 180,
  "sync_coordinator_admin_secret": "<same secret you stored with wrangler secret put>"
}
```

Teammate device example:

```json
{
  "sync_enabled": true,
  "sync_coordinator_url": "https://your-worker.example.workers.dev",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_timeout_s": 3,
  "sync_coordinator_presence_ttl_s": 180
}
```

## 8. Validate the deployment

There is no longer a repo-shipped Python smoke-check script. Validate the Worker with real codemem clients instead:

- configure an admin device against the deployed Worker
- confirm the device can complete presence + peer discovery through normal codemem flows
- then run the invite and join checks below

Treat the deployment as minimally valid only when a real client can register, discover peers, and complete the onboarding
flow below.

## 9. Validate invite and join behavior

After smoke validation, confirm the actual onboarding flows.

Expected admin flow:

- admin device can create an invite against the deployed Worker
- invite payload contains the real reachable Worker URL

Expected teammate flow:

- teammate imports the invite successfully
- `sync_coordinator_url` and `sync_coordinator_group` are set automatically
- `auto_admit` invites complete enrollment immediately
- `approval_required` invites leave the teammate pending until review

Expected approval flow:

- admin can list pending join requests
- admin can approve or deny them
- after approval, both devices appear in coordinator-backed discovery

Expected reciprocal-approval behavior:

- devices can progress through the current reciprocal approval flow without schema/runtime errors
- discovery success still does not create a direct `sync_peer` automatically; acceptance and scope review remain separate

If you need the exact end-to-end acceptance path after enrollment, use `docs/coordinator-e2e-runbook.md` for the direct
sync steps.

## Troubleshooting

### `missing_d1_binding`

The Worker is running without the `COORDINATOR_DB` binding.

Check:

- `examples/cloudflare-coordinator/wrangler.toml` has the real D1 id
- you deployed with the right Wrangler config
- the binding name is still `COORDINATOR_DB`

### `missing_headers`

The request did not include the required signed auth headers.

Use codemem-built clients. Plain curl requests against signed endpoints will fail.

### `unknown_device`

The device id is not enrolled in the target group.

Confirm the D1 row exists in `enrolled_devices` for the exact `group_id` and `device_id`.

### `invalid_signature`

The enrolled public key does not match the device actually making the request, or the stale device record is wrong.

Common fixes:

- re-enroll the device with its current public key
- delete stale enrollment rows and bootstrap again cleanly
- confirm the Worker URL and signed path/query are the ones the client is actually using

### Invite import or join request times out

The embedded `sync_coordinator_url` is reachable from your machine but not from the teammate device.

Recreate the invite with the real public/shared-network Worker URL.

### Cloudflare 1010 or other edge-blocking behavior

Cloudflare is blocking the request before it reaches the Worker.

Check Cloudflare security/bot settings for the zone and test again with the same signed request path used by a real
codemem client.

### Wrong schema or partial schema

If invite, join-request, or reciprocal-approval flows fail even though `presence` and `peers` work, you probably
applied the old example schema instead of `packages/cloudflare-coordinator-worker/schema.sql`.

### Placeholder all-zero D1 id still present

If `00000000-0000-0000-0000-000000000000` is still in Wrangler config, you deployed a placeholder config. Replace it
with the real D1 id and redeploy.

## Current limitations

- the Worker path is still secondary to the built-in coordinator runtime
- enrollment remains operator-managed rather than polished end-user onboarding
- direct peer sync is still separate from coordinator discovery
- new coordinator features may land in the built-in runtime first and reach the Worker later
