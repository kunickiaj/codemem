#!/usr/bin/env bash
# Dev runner with HMR.
#
# Starts two processes:
#   1. tsx --watch CLI/viewer on CODEMEM_DEV_VIEWER_PORT (default 38899)
#      — restarts on any TS change in the dep graph (core, viewer-server,
#      cli, etc.)
#   2. Vite dev server on :5173 — serves packages/ui/index.html (regenerated
#      by scripts/make-dev-html.mjs from the canonical static/index.html),
#      HMRs changes to src/app.ts and its imports, proxies /api and /assets
#      to the viewer.
#
# Open the Vite URL (printed below); Vite handles HMR and forwards API
# calls to the Node viewer transparently.
set -euo pipefail

viewer_port="${CODEMEM_DEV_VIEWER_PORT:-38899}"
vite_port="${CODEMEM_DEV_VITE_PORT:-5173}"
# By default the dev viewer opens the user's real db (~/.codemem/mem.sqlite)
# so you see real memories while iterating on the UI. Override with
# CODEMEM_DEV_DB_PATH if you want isolation.
db_path="${CODEMEM_DEV_DB_PATH:-}"

if [ -n "$db_path" ]; then
  mkdir -p "$(dirname "$db_path")"
  db_label="$db_path"
else
  db_label="default (~/.codemem/mem.sqlite)"
fi

# Preflight: the viewer guards ~/.codemem from concurrent managers. If
# another viewer (e.g. a globally-installed `codemem serve start`) is
# already running against that runtime folder, dev mode using the same
# default db will fail immediately. Warn up front.
if [ -z "$db_path" ] && [ -f "$HOME/.codemem/viewer.pid" ]; then
  echo "[dev] ⚠ Detected existing viewer at ~/.codemem/viewer.pid — it owns the"
  echo "       default runtime, so dev mode will fail to open the same db."
  echo "       Either stop that viewer (the installed \`codemem\` on 38888) or point"
  echo "       dev at an isolated db:"
  echo "         CODEMEM_DEV_DB_PATH=\$PWD/.dev-data/mem.sqlite pnpm dev"
  echo "       (copy your real db there first if you want real memories:"
  echo "        mkdir -p .dev-data && cp ~/.codemem/mem.sqlite .dev-data/)"
fi

echo "[dev] Viewer: tsx --watch → http://127.0.0.1:$viewer_port (db: $db_label)"
echo "[dev] UI: Vite dev server → http://localhost:$vite_port (HMR enabled)"
echo "[dev] Open http://localhost:$vite_port to use the app."
echo "[dev] Ctrl-C to stop both."

# The viewer refuses to start when packages/viewer-server/static/index.html
# is missing. On a clean checkout that directory is empty (generated +
# gitignored), so stage the canonical static assets from packages/ui/static
# before the watched viewer boots. Vite handles /src/app.ts and proxies
# everything else through to the viewer.
node packages/ui/scripts/stage-viewer-static.mjs

export CODEMEM_DEV_VIEWER_PORT="$viewer_port"
export CODEMEM_DEV_VITE_PORT="$vite_port"

if [ -n "$db_path" ]; then
  pnpm exec tsx --watch --conditions source packages/cli/src/index.ts \
    serve start --foreground --host 127.0.0.1 --port "$viewer_port" --db-path "$db_path" &
else
  pnpm exec tsx --watch --conditions source packages/cli/src/index.ts \
    serve start --foreground --host 127.0.0.1 --port "$viewer_port" &
fi
viewer_pid=$!

pnpm --filter @codemem/ui run dev &
ui_pid=$!

cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "[dev] Stopping (viewer=$viewer_pid, ui=$ui_pid)..."
  kill "$viewer_pid" "$ui_pid" 2>/dev/null || true
  # Clean up children that survived the direct kill (tsx spawns a child).
  pkill -P "$viewer_pid" 2>/dev/null || true
  pkill -P "$ui_pid" 2>/dev/null || true
  wait "$viewer_pid" "$ui_pid" 2>/dev/null || true
  exit 0
}

trap cleanup EXIT INT TERM

# macOS bash 3.2 has no `wait -n`, so poll instead.
while kill -0 "$viewer_pid" 2>/dev/null && kill -0 "$ui_pid" 2>/dev/null; do
  sleep 1
done
cleanup
