#!/usr/bin/env bash
# workspace-bootstrap-template.sh
#
# Template for attaching codemem to a pre-provisioned workspace.
# Implements the contract defined in docs/contracts/pre-provisioned-workspace-runtime-attachment.md.
#
# This is a starting point — adapt it to your runtime environment.
# The script is intentionally explicit and linear so each phase can be
# audited, debugged, or replaced independently.
#
# Required environment variables:
#   CODEMEM_BIN           path to the codemem CLI binary (or "npx codemem")
#   CODEMEM_DB            database path (e.g., /data/mem.sqlite)
#   CODEMEM_KEYS_DIR      keys directory (e.g., /keys)
#   CODEMEM_CONFIG        config file path (e.g., /config/codemem.json)
#   COORDINATOR_URL       coordinator HTTP URL (e.g., http://coordinator:7347)
#   COORDINATOR_GROUP     coordinator group name
#   INVITE_TOKEN          encoded coordinator invite token
#   NODE_ROLE             "seed-peer" or "worker-peer"
#
# Required for worker peers:
#   SEED_PEER_DEVICE_ID   device ID of the seed peer to bootstrap from
#
# Optional:
#   SYNC_HOST             sync listen host (default: 0.0.0.0)
#   SYNC_PORT             sync listen port (default: 7337)
#   SYNC_INTERVAL         sync interval in seconds (default: 5)
#   BOOTSTRAP_FORCE       set to "1" to force-bootstrap even with local data
#   ARTIFACTS_DIR         directory for debug artifacts (default: /tmp/codemem-bootstrap-artifacts)
#
# Exit codes:
#   0  — node is ready (join + bootstrap + sync verification complete)
#   1  — a phase failed (check stderr and artifacts)
#   2  — missing required input

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ARTIFACTS_DIR="${ARTIFACTS_DIR:-/tmp/codemem-bootstrap-artifacts}"
mkdir -p "$ARTIFACTS_DIR"

log()   { echo "[codemem-bootstrap] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >&2; }
fail()  { log "FAIL: $*"; echo '{"state":"failed","error":"'"$1"'"}' > "$ARTIFACTS_DIR/readiness.json"; exit 1; }
phase() { log "=== Phase: $1 ==="; }

record_state() {
  local state="$1" detail="$2"
  log "state=$state detail=$detail"
  cat > "$ARTIFACTS_DIR/readiness.json" <<EOJSON
{
  "state": "$state",
  "node_role": "${NODE_ROLE:-unknown}",
  "coordinator_group": "${COORDINATOR_GROUP:-unknown}",
  "detail": "$detail",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOJSON
}

codemem() { $CODEMEM_BIN "$@"; }

# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------

phase "input validation"

: "${CODEMEM_BIN:?CODEMEM_BIN is required (path to codemem CLI)}"
: "${CODEMEM_DB:?CODEMEM_DB is required (database path)}"
: "${CODEMEM_KEYS_DIR:?CODEMEM_KEYS_DIR is required (keys directory)}"
: "${CODEMEM_CONFIG:?CODEMEM_CONFIG is required (config file path)}"
: "${COORDINATOR_URL:?COORDINATOR_URL is required (coordinator HTTP URL)}"
: "${COORDINATOR_GROUP:?COORDINATOR_GROUP is required (coordinator group)}"
: "${INVITE_TOKEN:?INVITE_TOKEN is required (encoded coordinator invite)}"
: "${NODE_ROLE:?NODE_ROLE is required (seed-peer or worker-peer)}"

if [ "$NODE_ROLE" = "worker-peer" ]; then
  : "${SEED_PEER_DEVICE_ID:?SEED_PEER_DEVICE_ID is required for worker peers}"
fi

SYNC_HOST="${SYNC_HOST:-0.0.0.0}"
SYNC_PORT="${SYNC_PORT:-7337}"
SYNC_INTERVAL="${SYNC_INTERVAL:-5}"

record_state "pending" "Input validation passed."
log "role=$NODE_ROLE group=$COORDINATOR_GROUP db=$CODEMEM_DB"

# ---------------------------------------------------------------------------
# Phase 1: Install verification
# ---------------------------------------------------------------------------

phase "install verification"

if ! command -v "$CODEMEM_BIN" >/dev/null 2>&1 && ! $CODEMEM_BIN --version >/dev/null 2>&1; then
  fail "codemem_not_available" "codemem CLI not found at $CODEMEM_BIN"
fi

CODEMEM_VERSION=$(codemem --version 2>/dev/null || echo "unknown")
log "codemem version: $CODEMEM_VERSION"

# ---------------------------------------------------------------------------
# Phase 2: Configure
# ---------------------------------------------------------------------------

phase "configure"

codemem config workspace "$COORDINATOR_GROUP" \
  --enable-sync \
  --sync-host "$SYNC_HOST" \
  --sync-port "$SYNC_PORT" \
  --coordinator-url "$COORDINATOR_URL" \
  --coordinator-group "$COORDINATOR_GROUP" \
  2>&1 | tee "$ARTIFACTS_DIR/configure.log" || fail "configure_failed" "codemem config workspace failed"

# Export for subsequent commands
export CODEMEM_DB
export CODEMEM_CONFIG

log "config written to $CODEMEM_CONFIG"

# ---------------------------------------------------------------------------
# Phase 3: Identity initialization
# ---------------------------------------------------------------------------

phase "identity initialization"

codemem sync enable \
  --db-path "$CODEMEM_DB" \
  --sync-host "$SYNC_HOST" \
  --sync-port "$SYNC_PORT" \
  --interval "$SYNC_INTERVAL" \
  --json \
  2>"$ARTIFACTS_DIR/enable-stderr.log" \
  > "$ARTIFACTS_DIR/enable.json" || fail "identity_init_failed" "codemem sync enable failed"

DEVICE_ID=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('device_id',''))" < "$ARTIFACTS_DIR/enable.json" 2>/dev/null || echo "")
FINGERPRINT=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('fingerprint',''))" < "$ARTIFACTS_DIR/enable.json" 2>/dev/null || echo "")

if [ -z "$DEVICE_ID" ]; then
  fail "identity_missing" "sync enable did not return a device_id"
fi

log "device_id=$DEVICE_ID fingerprint=$FINGERPRINT"
record_state "joining" "Identity initialized, preparing coordinator join."

# ---------------------------------------------------------------------------
# Phase 4: Coordinator join
# ---------------------------------------------------------------------------

phase "coordinator join"

codemem coordinator import-invite "$INVITE_TOKEN" \
  --db-path "$CODEMEM_DB" \
  --keys-dir "$CODEMEM_KEYS_DIR" \
  --config "$CODEMEM_CONFIG" \
  --json \
  2>"$ARTIFACTS_DIR/import-invite-stderr.log" \
  > "$ARTIFACTS_DIR/import-invite.json" || fail "join_failed" "coordinator import-invite failed"

# Verify the join was admitted (not just pending approval).
# For approval_required invites, the status may be "pending" until an admin approves.
JOIN_STATUS=$(python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('status', d.get('join_request_status', '')))" < "$ARTIFACTS_DIR/import-invite.json" 2>/dev/null || echo "")

if [ "$JOIN_STATUS" = "pending" ] || [ "$JOIN_STATUS" = "pending_approval" ]; then
  fail "join_pending_approval" "Coordinator join request requires admin approval (status=$JOIN_STATUS). Approve via: codemem coordinator approve-join-request <request-id>"
fi

log "invite imported, join status=$JOIN_STATUS"
record_state "joined" "Coordinator join admitted."

# ---------------------------------------------------------------------------
# Phase 5: Bootstrap (worker peers only)
# ---------------------------------------------------------------------------

if [ "$NODE_ROLE" = "worker-peer" ]; then
  phase "bootstrap from seed peer"
  record_state "bootstrapping" "Bootstrapping from seed peer $SEED_PEER_DEVICE_ID."

  BOOTSTRAP_ARGS=(
    sync bootstrap "$SEED_PEER_DEVICE_ID"
    --db-path "$CODEMEM_DB"
    --keys-dir "$CODEMEM_KEYS_DIR"
    --json
  )
  if [ "${BOOTSTRAP_FORCE:-}" = "1" ]; then
    BOOTSTRAP_ARGS+=(--force)
  fi

  codemem "${BOOTSTRAP_ARGS[@]}" \
    2>"$ARTIFACTS_DIR/bootstrap-stderr.log" \
    > "$ARTIFACTS_DIR/bootstrap.json" || fail "bootstrap_failed" "sync bootstrap failed"

  BOOTSTRAP_OK=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',''))" < "$ARTIFACTS_DIR/bootstrap.json" 2>/dev/null || echo "")
  if [ "$BOOTSTRAP_OK" != "True" ] && [ "$BOOTSTRAP_OK" != "true" ]; then
    BOOTSTRAP_ERROR=$(python3 -c "import json,sys; print(json.load(sys.stdin).get('error','unknown'))" < "$ARTIFACTS_DIR/bootstrap.json" 2>/dev/null || echo "unknown")
    fail "bootstrap_rejected" "bootstrap returned ok=false: $BOOTSTRAP_ERROR"
  fi

  log "bootstrap complete"
  record_state "bootstrapped" "Bootstrap from seed peer completed."
else
  log "seed peer — skipping bootstrap phase"
  record_state "bootstrapped" "Seed peer does not require bootstrap."
fi

# ---------------------------------------------------------------------------
# Phase 6: Sync verification
# ---------------------------------------------------------------------------

phase "sync verification"
record_state "sync_verifying" "Running sync verification pass."

codemem sync once \
  --db-path "$CODEMEM_DB" \
  2>"$ARTIFACTS_DIR/sync-once-stderr.log" \
  > "$ARTIFACTS_DIR/sync-once.log"
SYNC_EXIT=$?

# Check stats to capture database state regardless of sync result
codemem stats \
  --db-path "$CODEMEM_DB" \
  --json \
  > "$ARTIFACTS_DIR/stats.json" 2>/dev/null || true

if [ "$SYNC_EXIT" -ne 0 ]; then
  fail "sync_verification_failed" "codemem sync once exited $SYNC_EXIT — node cannot be marked ready without a successful sync pass"
fi

log "sync verification pass completed"

# ---------------------------------------------------------------------------
# Phase 7: Readiness
# ---------------------------------------------------------------------------

phase "readiness"

cat > "$ARTIFACTS_DIR/readiness.json" <<EOJSON
{
  "state": "ready",
  "node_role": "$NODE_ROLE",
  "device_id": "$DEVICE_ID",
  "fingerprint": "$FINGERPRINT",
  "coordinator_group": "$COORDINATOR_GROUP",
  "coordinator_url": "$COORDINATOR_URL",
  "codemem_version": "$CODEMEM_VERSION",
  "detail": "Join, bootstrap, and sync verification completed.",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOJSON

# Copy config snapshot to artifacts (without secrets)
cp "$CODEMEM_CONFIG" "$ARTIFACTS_DIR/config-snapshot.json" 2>/dev/null || true

log "NODE READY: role=$NODE_ROLE device=$DEVICE_ID group=$COORDINATOR_GROUP"
log "artifacts at $ARTIFACTS_DIR"
