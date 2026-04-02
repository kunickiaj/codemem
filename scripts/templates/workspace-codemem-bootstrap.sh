#!/usr/bin/env sh
set -eu

# Public-safe template for attaching codemem to a pre-provisioned workspace runtime.
#
# This script is intentionally generic. It assumes the workspace already exists and
# that agent execution is handled elsewhere. Its only job is to install/configure
# codemem, initialize identity, join the correct coordinator group, bootstrap from
# the seed peer when needed, and verify readiness.

require_var() {
  name="$1"
  value="$2"
  if [ -z "$value" ]; then
    printf '%s\n' "$name is required" >&2
    exit 1
  fi
}

CODEMEM_NODE_ROLE="${CODEMEM_NODE_ROLE:-}"
CODEMEM_DB="${CODEMEM_DB:-}"
CODEMEM_CONFIG="${CODEMEM_CONFIG:-}"
CODEMEM_KEYS_DIR="${CODEMEM_KEYS_DIR:-}"
CODEMEM_COORDINATOR_URL="${CODEMEM_COORDINATOR_URL:-}"
CODEMEM_COORDINATOR_GROUP="${CODEMEM_COORDINATOR_GROUP:-}"
CODEMEM_SYNC_HOST="${CODEMEM_SYNC_HOST:-0.0.0.0}"
CODEMEM_SYNC_PORT="${CODEMEM_SYNC_PORT:-7337}"
CODEMEM_INVITE="${CODEMEM_INVITE:-}"
CODEMEM_SEED_PEER_DEVICE_ID="${CODEMEM_SEED_PEER_DEVICE_ID:-}"
CODEMEM_SEED_PEER_FINGERPRINT="${CODEMEM_SEED_PEER_FINGERPRINT:-}"
CODEMEM_SEED_PEER_PUBLIC_KEY="${CODEMEM_SEED_PEER_PUBLIC_KEY:-}"
CODEMEM_SEED_PEER_ADDRESS="${CODEMEM_SEED_PEER_ADDRESS:-}"

require_var CODEMEM_NODE_ROLE "$CODEMEM_NODE_ROLE"
require_var CODEMEM_DB "$CODEMEM_DB"
require_var CODEMEM_CONFIG "$CODEMEM_CONFIG"
require_var CODEMEM_KEYS_DIR "$CODEMEM_KEYS_DIR"
require_var CODEMEM_COORDINATOR_URL "$CODEMEM_COORDINATOR_URL"
require_var CODEMEM_COORDINATOR_GROUP "$CODEMEM_COORDINATOR_GROUP"

mkdir -p "$(dirname "$CODEMEM_DB")"
mkdir -p "$(dirname "$CODEMEM_CONFIG")"
mkdir -p "$CODEMEM_KEYS_DIR"

cat > "$CODEMEM_CONFIG" <<EOF
{
  "sync_enabled": true,
  "sync_host": "$CODEMEM_SYNC_HOST",
  "sync_port": $CODEMEM_SYNC_PORT,
  "sync_interval_s": 5,
  "sync_coordinator_url": "$CODEMEM_COORDINATOR_URL",
  "sync_coordinator_group": "$CODEMEM_COORDINATOR_GROUP"
}
EOF

printf '%s\n' '{"status":"configured"}'

if [ "$CODEMEM_NODE_ROLE" = "seed-peer" ]; then
  pnpm run codemem -- sync enable --db-path "$CODEMEM_DB" --host "$CODEMEM_SYNC_HOST" --port "$CODEMEM_SYNC_PORT" --interval 5
  printf '%s\n' '{"status":"ready","role":"seed-peer"}'
  exit 0
fi

if [ "$CODEMEM_NODE_ROLE" = "worker-peer" ]; then
  require_var CODEMEM_INVITE "$CODEMEM_INVITE"
  require_var CODEMEM_SEED_PEER_DEVICE_ID "$CODEMEM_SEED_PEER_DEVICE_ID"
  require_var CODEMEM_SEED_PEER_FINGERPRINT "$CODEMEM_SEED_PEER_FINGERPRINT"
  require_var CODEMEM_SEED_PEER_PUBLIC_KEY "$CODEMEM_SEED_PEER_PUBLIC_KEY"
  require_var CODEMEM_SEED_PEER_ADDRESS "$CODEMEM_SEED_PEER_ADDRESS"

  pnpm run codemem -- sync coordinator import-invite "$CODEMEM_INVITE" --db-path "$CODEMEM_DB" --keys-dir "$CODEMEM_KEYS_DIR" --config "$CODEMEM_CONFIG" --json
  pnpm run codemem -- sync enable --db-path "$CODEMEM_DB" --host "$CODEMEM_SYNC_HOST" --port "$CODEMEM_SYNC_PORT" --interval 5
  node --input-type=module -e "import Database from 'better-sqlite3'; const db = new Database(process.env.CODEMEM_DB); const now = new Date().toISOString(); const addrJson = JSON.stringify([process.env.CODEMEM_SEED_PEER_ADDRESS]); db.prepare(\"INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, addresses_json, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(peer_device_id) DO UPDATE SET pinned_fingerprint = excluded.pinned_fingerprint, public_key = excluded.public_key, addresses_json = excluded.addresses_json, last_seen_at = excluded.last_seen_at\").run(process.env.CODEMEM_SEED_PEER_DEVICE_ID, process.env.CODEMEM_SEED_PEER_FINGERPRINT, process.env.CODEMEM_SEED_PEER_PUBLIC_KEY, addrJson, now, now); db.close();"
  pnpm run codemem -- sync bootstrap --peer "$CODEMEM_SEED_PEER_DEVICE_ID" --db-path "$CODEMEM_DB" --keys-dir "$CODEMEM_KEYS_DIR" --json --force
  pnpm run codemem -- sync once --db-path "$CODEMEM_DB"
  printf '%s\n' '{"status":"ready","role":"worker-peer"}'
  exit 0
fi

printf '%s\n' "Unsupported CODEMEM_NODE_ROLE: $CODEMEM_NODE_ROLE" >&2
exit 1
