#!/usr/bin/env bash
set -u

LOG_PATH_ENV="${CODEMEM_PLUGIN_LOG_PATH:-${CODEMEM_PLUGIN_LOG:-}}"
case "${LOG_PATH_ENV}" in
  ""|"0"|"false"|"off") LOG_PATH="$HOME/.codemem/plugin.log" ;;
  "1"|"true"|"yes") LOG_PATH="$HOME/.codemem/plugin.log" ;;
  *) LOG_PATH="${LOG_PATH_ENV}" ;;
esac
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "${PLUGIN_ROOT}" ]; then
  SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
  PLUGIN_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
fi
PLUGIN_MANIFEST="${PLUGIN_ROOT}/.claude-plugin/plugin.json"
UVX_PACKAGE_SPEC="codemem"

if [ -f "${PLUGIN_MANIFEST}" ]; then
  PLUGIN_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${PLUGIN_MANIFEST}" | sed -n '1p')"
  if [ -n "${PLUGIN_VERSION}" ]; then
    UVX_PACKAGE_SPEC="codemem==${PLUGIN_VERSION}"
  fi
fi

log_line() {
  mkdir -p "$(dirname "${LOG_PATH}")" >/dev/null 2>&1 || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${LOG_PATH}" 2>/dev/null || true
}

payload="$(cat)"
if [ -z "${payload}" ]; then
  exit 0
fi

case "${CODEMEM_PLUGIN_IGNORE:-}" in
  "1"|"true"|"yes"|"on")
    exit 0
    ;;
esac

LOCK_DIR="${CODEMEM_CLAUDE_HOOK_LOCK_DIR:-$HOME/.codemem/claude-hook-ingest.lock}"
acquire_lock() {
  mkdir -p "$(dirname "${LOCK_DIR}")" >/dev/null 2>&1 || true
  attempts=100
  while [ "${attempts}" -gt 0 ]; do
    if mkdir "${LOCK_DIR}" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.05
  done
  return 1
}

release_lock() {
  rmdir "${LOCK_DIR}" >/dev/null 2>&1 || true
}

if ! acquire_lock; then
  log_line "codemem ingest-claude-hook skipped: lock busy"
  exit 0
fi
trap 'release_lock' EXIT

if command -v codemem >/dev/null 2>&1; then
  if ! printf '%s' "${payload}" | CODEMEM_PLUGIN_IGNORE=1 codemem ingest-claude-hook >/dev/null 2>&1; then
    log_line "codemem ingest-claude-hook failed via codemem binary"
  fi
  exit 0
fi

if command -v uvx >/dev/null 2>&1; then
  if ! printf '%s' "${payload}" | CODEMEM_PLUGIN_IGNORE=1 uvx "${UVX_PACKAGE_SPEC}" ingest-claude-hook >/dev/null 2>&1; then
    log_line "codemem ingest-claude-hook failed via uvx"
  fi
  exit 0
fi

log_line "codemem ingest-claude-hook skipped: codemem and uvx not found"

exit 0
