#!/usr/bin/env sh
set -eu

# Concrete host-workspace bootstrap flow for attaching codemem to an existing
# developer/agent workspace with a durable HOME directory and a repo checkout.

require_var() {
	name="$1"
	value="$2"
	if [ -z "$value" ]; then
		printf '%s\n' "$name is required" >&2
		exit 1
	fi
}

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root_default=$(CDPATH= cd -- "$script_dir/../.." && pwd)

CODEMEM_REPO_ROOT="${CODEMEM_REPO_ROOT:-$repo_root_default}"
CODEMEM_WORKSPACE_SELECTOR="${CODEMEM_WORKSPACE_SELECTOR:-$(hostname)}"
CODEMEM_FLEET_NAME="${CODEMEM_FLEET_NAME:-workspace-attachment}"
CODEMEM_NODE_ID="${CODEMEM_NODE_ID:-${CODEMEM_WORKSPACE_SELECTOR}}"
CODEMEM_NODE_ROLE="${CODEMEM_NODE_ROLE:-}"
CODEMEM_SWARM_ID="${CODEMEM_SWARM_ID:-}"
CODEMEM_COORDINATOR_GROUP="${CODEMEM_COORDINATOR_GROUP:-}"
CODEMEM_COORDINATOR_URL="${CODEMEM_COORDINATOR_URL:-}"
CODEMEM_COORDINATOR_ADMIN_SECRET="${CODEMEM_COORDINATOR_ADMIN_SECRET:-${CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET:-}}"
CODEMEM_IDENTITY_POLICY="${CODEMEM_IDENTITY_POLICY:-}"
CODEMEM_PERSISTENCE="${CODEMEM_PERSISTENCE:-}"
CODEMEM_RUNTIME_ROOT="${CODEMEM_RUNTIME_ROOT:-}"
CODEMEM_SYNC_HOST="${CODEMEM_SYNC_HOST:-127.0.0.1}"
CODEMEM_SYNC_PORT="${CODEMEM_SYNC_PORT:-7337}"
CODEMEM_SYNC_INTERVAL_S="${CODEMEM_SYNC_INTERVAL_S:-5}"
CODEMEM_VIEWER_HOST="${CODEMEM_VIEWER_HOST:-127.0.0.1}"
CODEMEM_VIEWER_PORT="${CODEMEM_VIEWER_PORT:-38888}"
CODEMEM_START_VIEWER="${CODEMEM_START_VIEWER:-1}"
CODEMEM_VIEWER_STATIC_DIR="${CODEMEM_VIEWER_STATIC_DIR:-}"
CODEMEM_INVITE="${CODEMEM_INVITE:-}"
CODEMEM_SEED_PEER_DEVICE_ID="${CODEMEM_SEED_PEER_DEVICE_ID:-}"
CODEMEM_SEED_PEER_FINGERPRINT="${CODEMEM_SEED_PEER_FINGERPRINT:-}"
CODEMEM_SEED_PEER_PUBLIC_KEY="${CODEMEM_SEED_PEER_PUBLIC_KEY:-}"
CODEMEM_SEED_PEER_ADDRESS="${CODEMEM_SEED_PEER_ADDRESS:-}"
CODEMEM_BOOTSTRAP_PHASE="${CODEMEM_BOOTSTRAP_PHASE:-full}"
CODEMEM_BOOTSTRAP_FORCE="${CODEMEM_BOOTSTRAP_FORCE:-0}"

require_var CODEMEM_NODE_ROLE "$CODEMEM_NODE_ROLE"
require_var CODEMEM_COORDINATOR_URL "$CODEMEM_COORDINATOR_URL"
require_var CODEMEM_COORDINATOR_GROUP "$CODEMEM_COORDINATOR_GROUP"

case "$CODEMEM_BOOTSTRAP_PHASE" in
full | join-only | finish-bootstrap) ;;
*)
	printf '%s\n' "Unsupported CODEMEM_BOOTSTRAP_PHASE: $CODEMEM_BOOTSTRAP_PHASE" >&2
	exit 1
	;;
esac

if [ -z "$CODEMEM_IDENTITY_POLICY" ]; then
	if [ "$CODEMEM_NODE_ROLE" = "seed-peer" ]; then
		CODEMEM_IDENTITY_POLICY="stable"
	else
		CODEMEM_IDENTITY_POLICY="ephemeral"
	fi
fi

if [ -z "$CODEMEM_PERSISTENCE" ]; then
	if [ "$CODEMEM_NODE_ROLE" = "seed-peer" ]; then
		CODEMEM_PERSISTENCE="stable"
	else
		CODEMEM_PERSISTENCE="ephemeral"
	fi
fi

if [ -z "$CODEMEM_RUNTIME_ROOT" ]; then
	if [ "$CODEMEM_PERSISTENCE" = "stable" ]; then
		CODEMEM_RUNTIME_ROOT="$HOME/.codemem/workspaces/stable/$CODEMEM_WORKSPACE_SELECTOR/$CODEMEM_FLEET_NAME/$CODEMEM_NODE_ID"
	else
		tmp_root="${TMPDIR:-/tmp}"
		CODEMEM_RUNTIME_ROOT="${tmp_root%/}/codemem-workspaces/ephemeral/$CODEMEM_WORKSPACE_SELECTOR/$CODEMEM_FLEET_NAME/$CODEMEM_NODE_ID"
	fi
fi

CODEMEM_DB="${CODEMEM_DB:-$CODEMEM_RUNTIME_ROOT/mem.sqlite}"
CODEMEM_CONFIG="${CODEMEM_CONFIG:-$CODEMEM_RUNTIME_ROOT/config/codemem.json}"
CODEMEM_KEYS_DIR="${CODEMEM_KEYS_DIR:-$CODEMEM_RUNTIME_ROOT/keys}"
CODEMEM_ARTIFACTS_DIR="${CODEMEM_ARTIFACTS_DIR:-$CODEMEM_RUNTIME_ROOT/artifacts}"

export CODEMEM_WORKSPACE_SELECTOR CODEMEM_FLEET_NAME CODEMEM_NODE_ID CODEMEM_NODE_ROLE
export CODEMEM_SWARM_ID CODEMEM_IDENTITY_POLICY CODEMEM_PERSISTENCE CODEMEM_RUNTIME_ROOT
export CODEMEM_DB CODEMEM_CONFIG CODEMEM_KEYS_DIR CODEMEM_ARTIFACTS_DIR
export CODEMEM_COORDINATOR_URL CODEMEM_COORDINATOR_GROUP CODEMEM_COORDINATOR_ADMIN_SECRET
export CODEMEM_SYNC_HOST CODEMEM_SYNC_PORT CODEMEM_SYNC_INTERVAL_S CODEMEM_BOOTSTRAP_PHASE
export CODEMEM_BOOTSTRAP_FORCE

mkdir -p "$CODEMEM_RUNTIME_ROOT"
mkdir -p "$(dirname "$CODEMEM_DB")"
mkdir -p "$(dirname "$CODEMEM_CONFIG")"
mkdir -p "$CODEMEM_KEYS_DIR"
mkdir -p "$CODEMEM_ARTIFACTS_DIR"

status_file="$CODEMEM_ARTIFACTS_DIR/status.json"
identity_file="$CODEMEM_ARTIFACTS_DIR/identity.json"
config_snapshot="$CODEMEM_ARTIFACTS_DIR/config.snapshot.json"
summary_file="$CODEMEM_ARTIFACTS_DIR/summary.json"

write_status() {
	state="$1"
	detail="$2"
	STATE="$state" DETAIL="$detail" python3 - <<'PY' >"$status_file"
import json, os
payload = {
    "workspace_selector": os.environ["CODEMEM_WORKSPACE_SELECTOR"],
    "fleet_name": os.environ["CODEMEM_FLEET_NAME"],
    "swarm_id": os.environ.get("CODEMEM_SWARM_ID") or None,
    "node_id": os.environ["CODEMEM_NODE_ID"],
    "node_role": os.environ["CODEMEM_NODE_ROLE"],
    "identity_policy": os.environ["CODEMEM_IDENTITY_POLICY"],
    "persistence": os.environ["CODEMEM_PERSISTENCE"],
    "runtime_root": os.environ["CODEMEM_RUNTIME_ROOT"],
    "db_path": os.environ["CODEMEM_DB"],
    "config_path": os.environ["CODEMEM_CONFIG"],
    "keys_path": os.environ["CODEMEM_KEYS_DIR"],
    "coordinator_url": os.environ["CODEMEM_COORDINATOR_URL"],
    "coordinator_group": os.environ["CODEMEM_COORDINATOR_GROUP"],
    "bootstrap_phase": os.environ["CODEMEM_BOOTSTRAP_PHASE"],
    "state": os.environ["STATE"],
    "detail": os.environ["DETAIL"],
}
print(json.dumps(payload, indent=2))
PY
}

write_summary() {
	state="$1"
	readiness="$2"
	bootstrap_source="$3"
	failure_detail="$4"
	STATE="$state" READINESS="$readiness" BOOTSTRAP_SOURCE="$bootstrap_source" FAILURE_DETAIL="$failure_detail" python3 - <<'PY' >"$summary_file"
import json, os
identity = None
identity_path = os.environ["IDENTITY_FILE"]
if os.path.exists(identity_path):
    with open(identity_path, "r", encoding="utf-8") as handle:
        identity = json.load(handle)
payload = {
    "workspace_selector": os.environ["CODEMEM_WORKSPACE_SELECTOR"],
    "fleet_name": os.environ["CODEMEM_FLEET_NAME"],
    "swarm_id": os.environ.get("CODEMEM_SWARM_ID") or None,
    "node_id": os.environ["CODEMEM_NODE_ID"],
    "node_role": os.environ["CODEMEM_NODE_ROLE"],
    "state": os.environ["STATE"],
    "device_identity": identity,
    "coordinator_group": os.environ["CODEMEM_COORDINATOR_GROUP"],
    "bootstrap_phase": os.environ["CODEMEM_BOOTSTRAP_PHASE"],
    "bootstrap_source": os.environ["BOOTSTRAP_SOURCE"] or None,
    "readiness_result": os.environ["READINESS"],
    "artifact_dir": os.environ["CODEMEM_ARTIFACTS_DIR"],
    "failure_detail": os.environ["FAILURE_DETAIL"] or None,
}
print(json.dumps(payload, indent=2))
PY
}

codemem() {
	env \
		CODEMEM_DB="$CODEMEM_DB" \
		CODEMEM_CONFIG="$CODEMEM_CONFIG" \
		CODEMEM_KEYS_DIR="$CODEMEM_KEYS_DIR" \
		CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET="$CODEMEM_COORDINATOR_ADMIN_SECRET" \
		pnpm --dir "$CODEMEM_REPO_ROOT" exec tsx --conditions source packages/cli/src/index.ts "$@"
}

wait_for_http() {
	url="$1"
	node --input-type=module -e "const url = process.argv[1]; for (let i = 0; i < 80; i += 1) { try { const res = await fetch(url); if (res.status >= 100) process.exit(0); } catch {} await new Promise((resolve) => setTimeout(resolve, 250)); } process.exit(1);" "$url"
}

write_status pending "Preparing workspace attachment paths and config."

python3 - <<'PY' >"$CODEMEM_CONFIG"
import json, os
payload = {
    "sync_enabled": True,
    "sync_host": os.environ["CODEMEM_SYNC_HOST"],
    "sync_port": int(os.environ["CODEMEM_SYNC_PORT"]),
    "sync_interval_s": int(os.environ["CODEMEM_SYNC_INTERVAL_S"]),
    "sync_coordinator_url": os.environ["CODEMEM_COORDINATOR_URL"],
    "sync_coordinator_group": os.environ["CODEMEM_COORDINATOR_GROUP"],
}
secret = os.environ.get("CODEMEM_COORDINATOR_ADMIN_SECRET", "").strip()
if secret:
    payload["sync_coordinator_admin_secret"] = secret
print(json.dumps(payload, indent=2))
PY
python3 - <<'PY' >"$config_snapshot"
import json, os
with open(os.environ["CODEMEM_CONFIG"], "r", encoding="utf-8") as handle:
    payload = json.load(handle)
if "sync_coordinator_admin_secret" in payload:
    payload["sync_coordinator_admin_secret"] = "<redacted>"
print(json.dumps(payload, indent=2))
PY

codemem db init --db-path "$CODEMEM_DB" >"$CODEMEM_ARTIFACTS_DIR/db-init.txt" 2>&1
codemem sync enable --db-path "$CODEMEM_DB" --host "$CODEMEM_SYNC_HOST" --port "$CODEMEM_SYNC_PORT" --interval "$CODEMEM_SYNC_INTERVAL_S" >"$CODEMEM_ARTIFACTS_DIR/sync-enable.txt" 2>&1
pnpm --dir "$CODEMEM_REPO_ROOT" exec tsx --conditions source scripts/workspace/read-peer-identity.ts --db-path "$CODEMEM_DB" --keys-dir "$CODEMEM_KEYS_DIR" >"$identity_file"

if [ "$CODEMEM_START_VIEWER" = "1" ]; then
	if [ -z "$CODEMEM_VIEWER_STATIC_DIR" ]; then
		CODEMEM_VIEWER_STATIC_DIR="$CODEMEM_RUNTIME_ROOT/viewer-static"
		mkdir -p "$CODEMEM_VIEWER_STATIC_DIR"
		python3 - <<'PY' >"$CODEMEM_VIEWER_STATIC_DIR/index.html"
print("<!doctype html><title>codemem workspace bootstrap</title>")
PY
	fi
	export CODEMEM_VIEWER_STATIC_DIR
	env CODEMEM_VIEWER_STATIC_DIR="$CODEMEM_VIEWER_STATIC_DIR" CODEMEM_DB="$CODEMEM_DB" CODEMEM_CONFIG="$CODEMEM_CONFIG" CODEMEM_KEYS_DIR="$CODEMEM_KEYS_DIR" CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET="$CODEMEM_COORDINATOR_ADMIN_SECRET" pnpm --dir "$CODEMEM_REPO_ROOT" exec tsx --conditions source packages/cli/src/index.ts serve start --db-path "$CODEMEM_DB" --host "$CODEMEM_VIEWER_HOST" --port "$CODEMEM_VIEWER_PORT" >"$CODEMEM_ARTIFACTS_DIR/viewer-start.txt" 2>&1
	wait_for_http "http://$CODEMEM_VIEWER_HOST:$CODEMEM_VIEWER_PORT/"
fi

if [ "$CODEMEM_NODE_ROLE" = "seed-peer" ]; then
	write_status ready "Seed peer configured, identity initialized, and sync server activated."
	IDENTITY_FILE="$identity_file" write_summary ready ready none ""
	cat "$summary_file"
	exit 0
fi

if [ "$CODEMEM_NODE_ROLE" != "worker-peer" ]; then
	write_status failed "Unsupported node role."
	IDENTITY_FILE="$identity_file" write_summary failed failed none "unsupported CODEMEM_NODE_ROLE"
	cat "$summary_file"
	exit 1
fi

require_var CODEMEM_SEED_PEER_DEVICE_ID "$CODEMEM_SEED_PEER_DEVICE_ID"
require_var CODEMEM_SEED_PEER_FINGERPRINT "$CODEMEM_SEED_PEER_FINGERPRINT"
require_var CODEMEM_SEED_PEER_PUBLIC_KEY "$CODEMEM_SEED_PEER_PUBLIC_KEY"
require_var CODEMEM_SEED_PEER_ADDRESS "$CODEMEM_SEED_PEER_ADDRESS"

if [ "$CODEMEM_BOOTSTRAP_PHASE" != "finish-bootstrap" ]; then
	require_var CODEMEM_INVITE "$CODEMEM_INVITE"
	write_status joining "Importing coordinator invite and checking admission result."
	codemem coordinator import-invite "$CODEMEM_INVITE" --db-path "$CODEMEM_DB" --keys-dir "$CODEMEM_KEYS_DIR" --config "$CODEMEM_CONFIG" --json >"$CODEMEM_ARTIFACTS_DIR/import-invite.json" 2>&1

	invite_status=$(
		python3 - <<'PY'
import json, os
path = os.environ["CODEMEM_ARTIFACTS_DIR"] + "/import-invite.json"
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print(str(payload.get("status", "")))
PY
)

	if [ "$invite_status" = "pending" ] || [ -z "$invite_status" ]; then
		write_status failed "Worker is not admitted yet; approval-required invites need an external approval step before readiness."
		IDENTITY_FILE="$identity_file" write_summary failed failed none "coordinator join did not complete"
		cat "$summary_file"
		exit 1
	fi
	write_status joined "Worker admitted to coordinator group."
else
	write_status joined "Using existing worker identity and coordinator admission."
fi

pnpm --dir "$CODEMEM_REPO_ROOT" exec tsx --conditions source scripts/workspace/pin-peer.ts --db-path "$CODEMEM_DB" --peer-device-id "$CODEMEM_SEED_PEER_DEVICE_ID" --fingerprint "$CODEMEM_SEED_PEER_FINGERPRINT" --public-key "$CODEMEM_SEED_PEER_PUBLIC_KEY" --address "$CODEMEM_SEED_PEER_ADDRESS" >"$CODEMEM_ARTIFACTS_DIR/pin-seed-peer.json"

if [ "$CODEMEM_BOOTSTRAP_PHASE" = "join-only" ]; then
	write_status joined_pending_seed_trust "Worker identity emitted; waiting for the seed peer to trust this worker before bootstrap."
	IDENTITY_FILE="$identity_file" write_summary joined_pending_seed_trust pending_seed_trust "$CODEMEM_SEED_PEER_DEVICE_ID" "seed peer trust pending"
	cat "$summary_file"
	exit 0
fi

write_status bootstrapping "Bootstrapping local state from the seed peer."
if [ "$CODEMEM_BOOTSTRAP_FORCE" = "1" ]; then
	codemem sync bootstrap --peer "$CODEMEM_SEED_PEER_DEVICE_ID" --db-path "$CODEMEM_DB" --keys-dir "$CODEMEM_KEYS_DIR" --json --force >"$CODEMEM_ARTIFACTS_DIR/bootstrap.json" 2>&1
else
	codemem sync bootstrap --peer "$CODEMEM_SEED_PEER_DEVICE_ID" --db-path "$CODEMEM_DB" --keys-dir "$CODEMEM_KEYS_DIR" --json >"$CODEMEM_ARTIFACTS_DIR/bootstrap.json" 2>&1
fi

bootstrap_ok=$(
	python3 - <<'PY'
import json, os
path = os.environ["CODEMEM_ARTIFACTS_DIR"] + "/bootstrap.json"
with open(path, "r", encoding="utf-8") as handle:
    payload = json.load(handle)
print("true" if payload.get("ok") is True else "false")
PY
)

if [ "$bootstrap_ok" != "true" ]; then
	write_status failed "Bootstrap did not complete successfully."
	IDENTITY_FILE="$identity_file" write_summary failed failed "$CODEMEM_SEED_PEER_DEVICE_ID" "bootstrap failed"
	cat "$summary_file"
	exit 1
fi

write_status sync_verifying "Running one sync pass against the seed peer."
codemem sync once --db-path "$CODEMEM_DB" >"$CODEMEM_ARTIFACTS_DIR/sync-once.txt" 2>&1

if ! grep -q "$CODEMEM_SEED_PEER_DEVICE_ID: ok" "$CODEMEM_ARTIFACTS_DIR/sync-once.txt"; then
	write_status failed "Sync verification did not report success for the seed peer."
	IDENTITY_FILE="$identity_file" write_summary failed failed "$CODEMEM_SEED_PEER_DEVICE_ID" "sync verification failed"
	cat "$summary_file"
	exit 1
fi

write_status ready "Coordinator join, bootstrap, and sync verification completed."
IDENTITY_FILE="$identity_file" write_summary ready ready "$CODEMEM_SEED_PEER_DEVICE_ID" ""
cat "$summary_file"
