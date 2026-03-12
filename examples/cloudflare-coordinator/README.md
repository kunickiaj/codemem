# Cloudflare Worker reference coordinator

This is the canonical low-cost reference deployment for the coordinator-backed discovery contract.

It is intentionally narrow:

- device-key authenticated presence registration
- peer lookup within an explicitly enrolled group
- D1-backed enrollment, presence, and nonce replay protection

It is not a relay, queue, or central memory store.

## Files

- `src/index.mjs` - Worker implementation
- `schema.sql` - D1 schema
- `wrangler.toml.example` - example Wrangler config
- `smoke_check.py` - live smoke-check script for deployed endpoints

## Create the D1 database

```fish
wrangler d1 create codemem-coordinator
wrangler d1 execute codemem-coordinator --file examples/cloudflare-coordinator/schema.sql
```

Copy the returned D1 database ID into `wrangler.toml.example` or your real `wrangler.toml`.

## Bootstrap enrollment

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

## Deploy

```fish
wrangler deploy
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
