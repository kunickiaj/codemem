# Cloudflare Worker reference coordinator

This is helper tooling around the Cloudflare Worker deployment path for the coordinator-backed discovery contract. For the
canonical product docs, start with:

- `docs/cloudflare-coordinator-deployment.md` for the Worker + D1 runbook
- `docs/coordinator-deployment.md` for the canonical Linux/Node coordinator path

If you want the current Cloudflare Workers + D1 deployment instructions, use
`docs/cloudflare-coordinator-deployment.md`. This README is now intentionally focused on the example wrapper tooling.

The product is now TS-first. The live Worker implementation source lives in
`packages/cloudflare-coordinator-worker/src/index.ts`. This example directory now exists to provide:

- bootstrap helpers
- smoke-check tooling
- a local `wrangler.toml` wrapper for deploying the package worker source with D1 bindings
- schema/bootstrap guidance for the experimental Worker path

It remains useful for experimenting with Workers + D1, but it is not the mainline coordinator runtime and should not be
assumed to have feature parity with the built-in coordinator.

It is intentionally narrow:

- device-key authenticated presence registration
- peer lookup within an explicitly enrolled group
- D1-backed enrollment, presence, and nonce replay protection

It is not a relay, queue, or central memory store.

## Files

- `../../packages/cloudflare-coordinator-worker/src/index.ts` - Worker implementation source used by this example's Wrangler config
- `../../packages/cloudflare-coordinator-worker/schema.sql` - D1 schema used by the package worker
- `wrangler.toml.example` - example Wrangler config that points at the package worker source
- `bootstrap.py` - guided bootstrap helper for local device enrollment
- `smoke_check.py` - live smoke-check script for deployed endpoints

## First-time setup

The short version:

1. follow `docs/cloudflare-coordinator-deployment.md`
2. use this directory only for the Wrangler wrapper config and helper scripts

The remaining sections here are reference notes for those helper tools.

### 1. Install and authenticate Wrangler

```fish
npm install -g wrangler
wrangler login
```

### 2. Create the D1 database

```fish
wrangler d1 create codemem-coordinator
```

Copy the returned D1 database ID into a real `wrangler.toml` created from `wrangler.toml.example`.

### 3. Create a real `wrangler.toml`

```fish
cp examples/cloudflare-coordinator/wrangler.toml.example examples/cloudflare-coordinator/wrangler.toml
```

Then edit `examples/cloudflare-coordinator/wrangler.toml` and replace:

- `REPLACE_WITH_D1_DATABASE_ID`

with the actual D1 database ID from step 2.

That `wrangler.toml` already points at the package worker source:

- `../../packages/cloudflare-coordinator-worker/src/index.ts`

So you are deploying the current TS Worker implementation, not a dead copy in this examples directory.

### 4. Apply the schema

```fish
wrangler d1 execute codemem-coordinator --remote --file packages/cloudflare-coordinator-worker/schema.sql
```

Use the package worker schema here, not the older cut-down example schema. The package worker includes invite, join,
and reciprocal-approval tables that the old example-only schema does not.

### 5. Deploy the Worker

```fish
wrangler deploy
```

Wrangler prints the deployed Worker URL, for example:

- `https://codemem-coordinator.<your-subdomain>.workers.dev`

That URL becomes your `sync_coordinator_url`.

## Bootstrap enrollment

The easiest path is the bootstrap helper:

```fish
uv run python examples/cloudflare-coordinator/bootstrap.py
```

It will:

- detect your local codemem device identity
- create or reuse the named D1 database when requested
- write `wrangler.toml` once it knows the D1 database id
- apply schema and enrollment SQL remotely when requested
- generate D1 enrollment SQL for the selected group
- print a config snippet for `sync_coordinator_url` and `sync_coordinator_group`
- optionally run the smoke check

The script automates most of the flow once `wrangler login` is already complete, but the manual steps below are still
useful if you want to inspect or repair the setup by hand.

For automation, use non-interactive JSON output:

```fish
uv run python examples/cloudflare-coordinator/bootstrap.py \
  --group team-alpha \
  --worker-url "https://your-worker.example.workers.dev" \
  --non-interactive \
  --format json
```

If you want to follow the manual path, the details are below.

The first slice assumes explicit operator enrollment.

You need to create a group and enroll device public keys manually in D1 before devices can use the coordinator.

Example bootstrap SQL:

```sql
INSERT INTO groups(group_id, display_name, created_at)
VALUES ('team-alpha', 'Team Alpha', '2026-03-12T00:00:00Z');

INSERT INTO enrolled_devices(group_id, device_id, public_key, fingerprint, display_name, created_at)
VALUES (
  'team-alpha',
  'device-1',
  'ssh-ed25519 AAAA... user@host',
  'SHA256:...',
  'laptop',
  '2026-03-12T00:00:00Z'
);
```

Apply manual enrollment against the remote D1 database:

```fish
wrangler d1 execute codemem-coordinator --remote --command "<paste generated SQL here>"
```

## Configure codemem

Point codemem at the deployed coordinator:

```json
{
  "sync_coordinator_url": "https://your-worker.example.workers.dev",
  "sync_coordinator_group": "team-alpha",
  "sync_coordinator_timeout_s": 3,
  "sync_coordinator_presence_ttl_s": 180
}
```

## Smoke check

Use the included smoke-check script against a deployed Worker:

```fish
uv run python examples/cloudflare-coordinator/smoke_check.py \
  --db ~/.codemem/mem.sqlite \
  --url "https://your-worker.example.workers.dev" \
  --group team-alpha
```

The script:

- loads your device identity from the local codemem DB and key store
- sends a signed `POST /v1/presence`
- sends a signed `GET /v1/peers`
- prints both responses

## Current limitations

- enrollment is operator-managed SQL, not a polished product flow
- no relay or queueing support
- no server-side search or memory storage
- this Worker verifies the current SSH-signed request format and stores only coordinator metadata
