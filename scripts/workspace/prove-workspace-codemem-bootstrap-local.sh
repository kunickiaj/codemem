#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)

PROOF_ROOT="${CODEMEM_PROOF_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/codemem-workspace-proof.XXXXXX")}" 
KEEP_PROOF_ROOT="${CODEMEM_KEEP_PROOF_ROOT:-0}"
ADMIN_SECRET="${CODEMEM_PROOF_ADMIN_SECRET:-workspace-proof-secret}"
GROUP_ID="${CODEMEM_PROOF_GROUP:-workspace-proof}"
COORDINATOR_PORT="${CODEMEM_PROOF_COORDINATOR_PORT:-47347}"
SEED_SYNC_PORT="${CODEMEM_PROOF_SEED_SYNC_PORT:-47337}"
WORKER_SYNC_PORT="${CODEMEM_PROOF_WORKER_SYNC_PORT:-47338}"
SEED_VIEWER_PORT="${CODEMEM_PROOF_SEED_VIEWER_PORT:-48388}"
WORKER_VIEWER_PORT="${CODEMEM_PROOF_WORKER_VIEWER_PORT:-48389}"
COORDINATOR_DB="$PROOF_ROOT/coordinator/coordinator.sqlite"
COORDINATOR_LOG="$PROOF_ROOT/coordinator/coordinator.log"
SEED_ROOT="$PROOF_ROOT/seed"
WORKER_ROOT="$PROOF_ROOT/worker"
MARKER_TITLE="workspace-proof-sync-marker"
MARKER_BODY="host-workspace verified sync"
MANUAL_BOOTSTRAP_JSON="$PROOF_ROOT/manual-bootstrap.json"
WORKER_FINISH_SUMMARY="$PROOF_ROOT/worker-finish-summary.json"

mkdir -p "$PROOF_ROOT/coordinator"

stop_viewer() {
	db_path="$1"
	host="$2"
	port="$3"
	if [ -f "$db_path" ]; then
		pnpm --dir "$repo_root" exec tsx --conditions source packages/cli/src/index.ts serve stop --db-path "$db_path" --host "$host" --port "$port" >/dev/null 2>&1 || true
	fi
}

cleanup() {
	stop_viewer "$WORKER_ROOT/mem.sqlite" 127.0.0.1 "$WORKER_VIEWER_PORT"
	stop_viewer "$SEED_ROOT/mem.sqlite" 127.0.0.1 "$SEED_VIEWER_PORT"
	if [ -n "${COORDINATOR_PID:-}" ]; then
		kill "$COORDINATOR_PID" >/dev/null 2>&1 || true
	fi
	if [ "$KEEP_PROOF_ROOT" != "1" ]; then
		rm -rf "$PROOF_ROOT"
	fi
}

trap cleanup EXIT INT TERM

codemem() {
	env CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET="$ADMIN_SECRET" pnpm --dir "$repo_root" exec tsx --conditions source packages/cli/src/index.ts "$@"
}

wait_for_http() {
	url="$1"
	node --input-type=module -e "const url = process.argv[1]; for (let i = 0; i < 80; i += 1) { try { const res = await fetch(url); if (res.status >= 100) process.exit(0); } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } process.exit(1);" "$url"
}

read_json_field() {
	file_path="$1"
	field_name="$2"
	python3 - <<'PY' "$file_path" "$field_name"
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(payload[sys.argv[2]])
PY
}

pin_peer() {
	db_path="$1"
	peer_device_id="$2"
	fingerprint="$3"
	public_key="$4"
	address="$5"
	pnpm --dir "$repo_root" exec tsx --conditions source scripts/workspace/pin-peer.ts --db-path "$db_path" --peer-device-id "$peer_device_id" --fingerprint "$fingerprint" --public-key "$public_key" --address "$address" >/dev/null
}

CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET="$ADMIN_SECRET" pnpm --dir "$repo_root" exec tsx --conditions source packages/cli/src/index.ts coordinator serve --db-path "$COORDINATOR_DB" --host 127.0.0.1 --port "$COORDINATOR_PORT" > "$COORDINATOR_LOG" 2>&1 &
COORDINATOR_PID=$!
wait_for_http "http://127.0.0.1:$COORDINATOR_PORT/"

codemem coordinator group-create "$GROUP_ID" --db-path "$COORDINATOR_DB" > "$PROOF_ROOT/group-create.txt" 2>&1

CODEMEM_REPO_ROOT="$repo_root" \
CODEMEM_WORKSPACE_SELECTOR="local-host-workspace" \
CODEMEM_FLEET_NAME="workspace-proof" \
CODEMEM_NODE_ID="seed-main" \
CODEMEM_NODE_ROLE="seed-peer" \
CODEMEM_COORDINATOR_URL="http://127.0.0.1:$COORDINATOR_PORT" \
CODEMEM_COORDINATOR_GROUP="$GROUP_ID" \
CODEMEM_COORDINATOR_ADMIN_SECRET="$ADMIN_SECRET" \
CODEMEM_RUNTIME_ROOT="$SEED_ROOT" \
CODEMEM_SYNC_HOST="127.0.0.1" \
CODEMEM_SYNC_PORT="$SEED_SYNC_PORT" \
CODEMEM_VIEWER_HOST="127.0.0.1" \
CODEMEM_VIEWER_PORT="$SEED_VIEWER_PORT" \
sh "$script_dir/workspace-codemem-bootstrap-local.sh" > "$PROOF_ROOT/seed-summary.json"

SEED_IDENTITY="$SEED_ROOT/artifacts/identity.json"
SEED_DEVICE_ID=$(read_json_field "$SEED_IDENTITY" device_id)
SEED_FINGERPRINT=$(read_json_field "$SEED_IDENTITY" fingerprint)
SEED_PUBLIC_KEY=$(read_json_field "$SEED_IDENTITY" public_key)

codemem coordinator enroll-device "$GROUP_ID" "$SEED_DEVICE_ID" --fingerprint "$SEED_FINGERPRINT" --public-key "$SEED_PUBLIC_KEY" --db-path "$COORDINATOR_DB" --json > "$PROOF_ROOT/enroll-seed.json"
codemem coordinator create-invite "$GROUP_ID" --policy auto_admit --coordinator-url "http://127.0.0.1:$COORDINATOR_PORT" --remote-url "http://127.0.0.1:$COORDINATOR_PORT" --admin-secret "$ADMIN_SECRET" --db-path "$COORDINATOR_DB" --json > "$PROOF_ROOT/create-invite.json"

INVITE=$(python3 - <<'PY' "$PROOF_ROOT/create-invite.json"
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(payload["encoded"])
PY
)

CODEMEM_REPO_ROOT="$repo_root" \
CODEMEM_WORKSPACE_SELECTOR="local-host-workspace" \
CODEMEM_FLEET_NAME="workspace-proof" \
CODEMEM_NODE_ID="worker-main" \
CODEMEM_NODE_ROLE="worker-peer" \
CODEMEM_SWARM_ID="swarm-proof" \
CODEMEM_COORDINATOR_URL="http://127.0.0.1:$COORDINATOR_PORT" \
CODEMEM_COORDINATOR_GROUP="$GROUP_ID" \
CODEMEM_COORDINATOR_ADMIN_SECRET="$ADMIN_SECRET" \
CODEMEM_RUNTIME_ROOT="$WORKER_ROOT" \
CODEMEM_SYNC_HOST="127.0.0.1" \
CODEMEM_SYNC_PORT="$WORKER_SYNC_PORT" \
CODEMEM_VIEWER_HOST="127.0.0.1" \
CODEMEM_VIEWER_PORT="$WORKER_VIEWER_PORT" \
CODEMEM_INVITE="$INVITE" \
CODEMEM_SEED_PEER_DEVICE_ID="$SEED_DEVICE_ID" \
CODEMEM_SEED_PEER_FINGERPRINT="$SEED_FINGERPRINT" \
CODEMEM_SEED_PEER_PUBLIC_KEY="$SEED_PUBLIC_KEY" \
CODEMEM_SEED_PEER_ADDRESS="127.0.0.1:$SEED_SYNC_PORT" \
CODEMEM_BOOTSTRAP_PHASE="join-only" \
sh "$script_dir/workspace-codemem-bootstrap-local.sh" > "$PROOF_ROOT/worker-initial-summary.json"

WORKER_IDENTITY="$WORKER_ROOT/artifacts/identity.json"
WORKER_DEVICE_ID=$(read_json_field "$WORKER_IDENTITY" device_id)
WORKER_FINGERPRINT=$(read_json_field "$WORKER_IDENTITY" fingerprint)
WORKER_PUBLIC_KEY=$(read_json_field "$WORKER_IDENTITY" public_key)

pin_peer "$SEED_ROOT/mem.sqlite" "$WORKER_DEVICE_ID" "$WORKER_FINGERPRINT" "$WORKER_PUBLIC_KEY" "127.0.0.1:$WORKER_SYNC_PORT"
pin_peer "$WORKER_ROOT/mem.sqlite" "$SEED_DEVICE_ID" "$SEED_FINGERPRINT" "$SEED_PUBLIC_KEY" "127.0.0.1:$SEED_SYNC_PORT"

pnpm --dir "$repo_root" exec tsx --conditions source packages/cli/src/index.ts memory remember --db-path "$SEED_ROOT/mem.sqlite" --kind discovery --title "$MARKER_TITLE" --body "$MARKER_BODY" >/dev/null
CODEMEM_REPO_ROOT="$repo_root" \
CODEMEM_WORKSPACE_SELECTOR="local-host-workspace" \
CODEMEM_FLEET_NAME="workspace-proof" \
CODEMEM_NODE_ID="worker-main" \
CODEMEM_NODE_ROLE="worker-peer" \
CODEMEM_SWARM_ID="swarm-proof" \
CODEMEM_COORDINATOR_URL="http://127.0.0.1:$COORDINATOR_PORT" \
CODEMEM_COORDINATOR_GROUP="$GROUP_ID" \
CODEMEM_COORDINATOR_ADMIN_SECRET="$ADMIN_SECRET" \
CODEMEM_RUNTIME_ROOT="$WORKER_ROOT" \
CODEMEM_SYNC_HOST="127.0.0.1" \
CODEMEM_SYNC_PORT="$WORKER_SYNC_PORT" \
CODEMEM_VIEWER_HOST="127.0.0.1" \
CODEMEM_VIEWER_PORT="$WORKER_VIEWER_PORT" \
CODEMEM_SEED_PEER_DEVICE_ID="$SEED_DEVICE_ID" \
CODEMEM_SEED_PEER_FINGERPRINT="$SEED_FINGERPRINT" \
CODEMEM_SEED_PEER_PUBLIC_KEY="$SEED_PUBLIC_KEY" \
CODEMEM_SEED_PEER_ADDRESS="127.0.0.1:$SEED_SYNC_PORT" \
CODEMEM_BOOTSTRAP_PHASE="finish-bootstrap" \
sh "$script_dir/workspace-codemem-bootstrap-local.sh" > "$WORKER_FINISH_SUMMARY"
CODEMEM_KEYS_DIR="$WORKER_ROOT/keys" pnpm --dir "$repo_root" exec tsx --conditions source packages/cli/src/index.ts sync once --db-path "$WORKER_ROOT/mem.sqlite" > "$PROOF_ROOT/worker-sync-once.txt" 2>&1
pnpm --dir "$repo_root" exec tsx --conditions source packages/cli/src/index.ts search "$MARKER_TITLE" --db-path "$WORKER_ROOT/mem.sqlite" --all-projects --json > "$PROOF_ROOT/worker-search.json"

python3 - "$PROOF_ROOT" "$SEED_IDENTITY" "$WORKER_IDENTITY" "$GROUP_ID" "$COORDINATOR_PORT" "$ADMIN_SECRET" "$PROOF_ROOT/worker-sync-once.txt" "$PROOF_ROOT/worker-search.json" "$WORKER_FINISH_SUMMARY" > "$PROOF_ROOT/proof-summary.json" <<'PY'
import json, sys, urllib.request
from pathlib import Path

proof_root = Path(sys.argv[1])
seed_identity = json.loads(Path(sys.argv[2]).read_text())
worker_identity = json.loads(Path(sys.argv[3]).read_text())
group_id = sys.argv[4]
coordinator_port = sys.argv[5]
admin_secret = sys.argv[6]
sync_once_text = Path(sys.argv[7]).read_text()
search_results = json.loads(Path(sys.argv[8]).read_text())
worker_finish = json.loads(Path(sys.argv[9]).read_text())

req = urllib.request.Request(
    f"http://127.0.0.1:{coordinator_port}/v1/admin/devices?group_id={group_id}",
    headers={"X-Codemem-Coordinator-Admin": admin_secret},
)
with urllib.request.urlopen(req) as response:
    coordinator_devices = json.loads(response.read().decode("utf-8"))

device_ids = {item.get("device_id") for item in coordinator_devices.get("items", [])}
search_hit = any(item.get("title") == "workspace-proof-sync-marker" for item in search_results)
sync_ok = f"{seed_identity['device_id']}: ok" in sync_once_text

payload = {
    "proof_root": str(proof_root),
    "coordinator_url": f"http://127.0.0.1:{coordinator_port}",
    "group_id": group_id,
    "seed_identity": seed_identity,
    "worker_identity": worker_identity,
    "coordinator_join_verified": seed_identity["device_id"] in device_ids and worker_identity["device_id"] in device_ids,
    "bootstrap_verified": worker_finish.get("readiness_result") == "ready",
    "sync_once_verified": sync_ok,
    "marker_memory_verified": search_hit,
}
print(json.dumps(payload, indent=2))
PY

cat "$PROOF_ROOT/proof-summary.json"
