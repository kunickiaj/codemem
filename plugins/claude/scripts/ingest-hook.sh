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
VIEWER_HOST="${CODEMEM_VIEWER_HOST:-127.0.0.1}"
VIEWER_PORT="${CODEMEM_VIEWER_PORT:-38888}"
CLAUDE_HOOK_URL="http://${VIEWER_HOST}:${VIEWER_PORT}/api/claude-hooks"
HTTP_CONNECT_TIMEOUT_S="${CODEMEM_CLAUDE_HOOK_HTTP_CONNECT_TIMEOUT_S:-1}"
HTTP_MAX_TIME_S="${CODEMEM_CLAUDE_HOOK_HTTP_MAX_TIME_S:-2}"

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
LOCK_TTL_S="${CODEMEM_CLAUDE_HOOK_LOCK_TTL_S:-300}"
LOCK_GRACE_S="${CODEMEM_CLAUDE_HOOK_LOCK_GRACE_S:-2}"
SPOOL_DIR="${CODEMEM_CLAUDE_HOOK_SPOOL_DIR:-$HOME/.codemem/claude-hook-spool}"
LOCK_OWNER_TOKEN=""
STALE_CHECK_PID=""
STALE_CHECK_TS=""
STALE_CHECK_OWNER=""
case "${LOCK_TTL_S}" in
  ''|*[!0-9]*) LOCK_TTL_S=300 ;;
esac
case "${LOCK_GRACE_S}" in
  ''|*[!0-9]*) LOCK_GRACE_S=2 ;;
esac

normalize_payload_ts() {
  if ! command -v python3 >/dev/null 2>&1; then
    return
  fi
  payload="$(printf '%s' "${payload}" | python3 -c '
import datetime as dt
import json
import sys

raw = sys.stdin.read()
try:
    obj = json.loads(raw)
except Exception:
    sys.stdout.write(raw)
    raise SystemExit(0)

if isinstance(obj, dict):
    ts = obj.get("ts")
    if not isinstance(ts, str) or not ts.strip():
        timestamp = obj.get("timestamp")
        if isinstance(timestamp, str) and timestamp.strip():
            obj["ts"] = timestamp
        else:
            obj["ts"] = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")

sys.stdout.write(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))
' 2>/dev/null || printf '%s' "${payload}")"
}

spool_payload() {
  spool_payload_text="$1"
  mkdir -p "${SPOOL_DIR}" >/dev/null 2>&1 || true
  spool_tmp="$(mktemp "${SPOOL_DIR}/.hook-tmp-XXXXXX" 2>/dev/null || true)"
  if [ -z "${spool_tmp}" ]; then
    log_line "codemem ingest-claude-hook failed to allocate spool temp file"
    return 1
  fi
  if ! printf '%s' "${spool_payload_text}" >"${spool_tmp}" 2>/dev/null; then
    rm -f "${spool_tmp}" >/dev/null 2>&1 || true
    log_line "codemem ingest-claude-hook failed to spool payload"
    return 1
  fi
  spool_file="${SPOOL_DIR}/hook-$(date +%s)-$$-${RANDOM}.json"
  if mv "${spool_tmp}" "${spool_file}" >/dev/null 2>&1; then
    log_line "codemem ingest-claude-hook spooled payload: ${spool_file}"
    return 0
  fi
  rm -f "${spool_tmp}" >/dev/null 2>&1 || true
  log_line "codemem ingest-claude-hook failed to spool payload"
  return 1
}

enqueue_via_http_payload() {
  enqueue_payload="$1"
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi

  response_file="$(mktemp "${TMPDIR:-/tmp}/codemem-claude-hook-http.XXXXXX" 2>/dev/null || true)"
  if [ -z "${response_file}" ]; then
    return 1
  fi

  status_code="$(
    printf '%s' "${enqueue_payload}" | \
      curl -sS \
        --connect-timeout "${HTTP_CONNECT_TIMEOUT_S}" \
        --max-time "${HTTP_MAX_TIME_S}" \
        -H 'Content-Type: application/json' \
        --data-binary @- \
        -o "${response_file}" \
        -w '%{http_code}' \
        "${CLAUDE_HOOK_URL}" 2>/dev/null
  )"

  case "${status_code}" in
    2*)
      if grep -Eq '"inserted"[[:space:]]*:[[:space:]]*[0-9]+' "${response_file}" && \
         grep -Eq '"skipped"[[:space:]]*:[[:space:]]*[0-9]+' "${response_file}"; then
        rm -f "${response_file}" >/dev/null 2>&1 || true
        return 0
      fi
      if grep -Eq '"skipped"[[:space:]]*:[[:space:]]*[1-9][0-9]*' "${response_file}"; then
        log_line "codemem ingest-claude-hook HTTP accepted but skipped payload"
      else
        log_line "codemem ingest-claude-hook HTTP accepted with unexpected response body"
      fi
      rm -f "${response_file}" >/dev/null 2>&1 || true
      return 1
      ;;
  esac

  rm -f "${response_file}" >/dev/null 2>&1 || true
  return 1
}

enqueue_via_http() {
  enqueue_via_http_payload "${payload}"
}

is_truthy() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
  esac
  return 1
}

should_force_boundary_flush() {
  if ! is_truthy "${CODEMEM_CLAUDE_HOOK_FLUSH:-0}"; then
    return 1
  fi
  case "${payload}" in
    *'"hook_event_name":"SessionEnd"'*) return 0 ;;
    *'"hook_event_name":"Stop"'*)
      if is_truthy "${CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP:-0}"; then
        return 0
      fi
      ;;
  esac
  return 1
}

run_cli_ingest_payload() {
  cli_payload="$1"
  have_backend=0

  if command -v codemem >/dev/null 2>&1; then
    have_backend=1
    if printf '%s' "${cli_payload}" | CODEMEM_PLUGIN_IGNORE=1 CODEMEM_CLAUDE_HOOK_FLUSH="${CODEMEM_CLAUDE_HOOK_FLUSH:-1}" codemem ingest-claude-hook >/dev/null 2>&1; then
      return 0
    fi
    log_line "codemem ingest-claude-hook failed via codemem binary"
  fi

  if command -v uvx >/dev/null 2>&1; then
    have_backend=1
    if printf '%s' "${cli_payload}" | CODEMEM_PLUGIN_IGNORE=1 CODEMEM_CLAUDE_HOOK_FLUSH="${CODEMEM_CLAUDE_HOOK_FLUSH:-1}" uvx "${UVX_PACKAGE_SPEC}" ingest-claude-hook >/dev/null 2>&1; then
      return 0
    fi
    log_line "codemem ingest-claude-hook failed via uvx"
  fi

  if [ "${have_backend}" -eq 0 ]; then
    log_line "codemem ingest-claude-hook skipped: codemem and uvx not found"
  else
    log_line "codemem ingest-claude-hook failed: all fallback attempts failed"
  fi
  return 1
}

run_cli_ingest() {
  run_cli_ingest_payload "${payload}"
}

drain_spool() {
  mkdir -p "${SPOOL_DIR}" >/dev/null 2>&1 || true
  for queued_file in "${SPOOL_DIR}"/*.json; do
    if [ ! -e "${queued_file}" ]; then
      continue
    fi
    if ! queued_payload="$(cat "${queued_file}" 2>/dev/null)"; then
      log_line "codemem ingest-claude-hook failed reading spooled payload: ${queued_file}"
      continue
    fi
    if [ -z "${queued_payload}" ]; then
      if [ ! -s "${queued_file}" ]; then
        rm -f "${queued_file}" >/dev/null 2>&1 || true
      fi
      continue
    fi
    if enqueue_via_http_payload "${queued_payload}" || run_cli_ingest_payload "${queued_payload}"; then
      rm -f "${queued_file}" >/dev/null 2>&1 || true
      continue
    fi
    log_line "codemem ingest-claude-hook failed processing spooled payload: ${queued_file}"
    continue
  done
}

recover_stale_tmp_spool() {
  mkdir -p "${SPOOL_DIR}" >/dev/null 2>&1 || true
  now_epoch="$(date +%s)"
  for tmp_file in "${SPOOL_DIR}"/.hook-tmp-*; do
    if [ ! -e "${tmp_file}" ]; then
      continue
    fi
    tmp_mtime="$(stat -f %m "${tmp_file}" 2>/dev/null || stat -c %Y "${tmp_file}" 2>/dev/null || printf '%s' "${now_epoch}")"
    age="$((now_epoch - tmp_mtime))"
    if [ "${age}" -le "${LOCK_TTL_S}" ]; then
      continue
    fi
    recovered="${SPOOL_DIR}/hook-recovered-$(date +%s)-$$-${RANDOM}.json"
    if mv "${tmp_file}" "${recovered}" >/dev/null 2>&1; then
      log_line "codemem ingest-claude-hook recovered stale temp spool payload: ${recovered}"
    fi
  done
}

lock_is_stale() {
  lock_pid=""
  lock_ts=""
  lock_owner=""
  now_epoch="$(date +%s)"
  lock_mtime="$(stat -f %m "${LOCK_DIR}" 2>/dev/null || stat -c %Y "${LOCK_DIR}" 2>/dev/null || printf '%s' "${now_epoch}")"

  if [ -f "${LOCK_DIR}/pid" ]; then
    lock_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  fi
  if [ -f "${LOCK_DIR}/ts" ]; then
    lock_ts="$(cat "${LOCK_DIR}/ts" 2>/dev/null || true)"
  fi
  if [ -f "${LOCK_DIR}/owner" ]; then
    lock_owner="$(cat "${LOCK_DIR}/owner" 2>/dev/null || true)"
  fi

  case "${lock_ts}" in
    ''|*[!0-9]*) lock_ts="" ;;
  esac

  STALE_CHECK_PID="${lock_pid}"
  STALE_CHECK_TS="${lock_ts}"
  STALE_CHECK_OWNER="${lock_owner}"

  if [ -n "${lock_pid}" ]; then
    if kill -0 "${lock_pid}" >/dev/null 2>&1; then
      lock_cmd="$(ps -p "${lock_pid}" -o command= 2>/dev/null || true)"
      if printf '%s' "${lock_cmd}" | grep -q "ingest-hook.sh"; then
        if [ -n "${lock_ts}" ]; then
          age="$((now_epoch - lock_ts))"
          if [ "${age}" -gt "${LOCK_TTL_S}" ]; then
            return 0
          fi
        fi
        return 1
      fi
      if [ -n "${lock_ts}" ]; then
        age="$((now_epoch - lock_ts))"
        if [ "${age}" -gt "${LOCK_TTL_S}" ]; then
          return 0
        fi
      fi
      return 1
    fi
    return 0
  fi

  if [ -n "${lock_ts}" ]; then
    age="$((now_epoch - lock_ts))"
    if [ "${age}" -gt "${LOCK_GRACE_S}" ]; then
      return 0
    fi
    return 1
  fi

  age="$((now_epoch - lock_mtime))"
  if [ "${age}" -gt "${LOCK_GRACE_S}" ]; then
    return 0
  fi
  return 1
}

write_lock_metadata() {
  LOCK_OWNER_TOKEN="$$-$(date +%s)-${RANDOM}"
  if ! date +%s >"${LOCK_DIR}/ts" 2>/dev/null; then
    LOCK_OWNER_TOKEN=""
    return 1
  fi
  if ! printf '%s\n' "$$" >"${LOCK_DIR}/pid" 2>/dev/null; then
    LOCK_OWNER_TOKEN=""
    return 1
  fi
  if ! printf '%s\n' "${LOCK_OWNER_TOKEN}" >"${LOCK_DIR}/owner" 2>/dev/null; then
    LOCK_OWNER_TOKEN=""
    return 1
  fi
  return 0
}

cleanup_lock_dir() {
  rm -f "${LOCK_DIR}/pid" "${LOCK_DIR}/ts" "${LOCK_DIR}/owner" >/dev/null 2>&1 || true
  rmdir "${LOCK_DIR}" >/dev/null 2>&1 || true
}

cleanup_lock_dir_if_unchanged() {
  current_pid=""
  current_ts=""
  current_owner=""
  if [ -f "${LOCK_DIR}/pid" ]; then
    current_pid="$(cat "${LOCK_DIR}/pid" 2>/dev/null || true)"
  fi
  if [ -f "${LOCK_DIR}/ts" ]; then
    current_ts="$(cat "${LOCK_DIR}/ts" 2>/dev/null || true)"
  fi
  if [ -f "${LOCK_DIR}/owner" ]; then
    current_owner="$(cat "${LOCK_DIR}/owner" 2>/dev/null || true)"
  fi

  if [ "${current_pid}" = "${STALE_CHECK_PID}" ] && \
     [ "${current_ts}" = "${STALE_CHECK_TS}" ] && \
     [ "${current_owner}" = "${STALE_CHECK_OWNER}" ]; then
    cleanup_lock_dir
    return 0
  fi
  return 1
}

acquire_lock() {
  mkdir -p "$(dirname "${LOCK_DIR}")" >/dev/null 2>&1 || true
  attempts=100
  while [ "${attempts}" -gt 0 ]; do
    if mkdir "${LOCK_DIR}" >/dev/null 2>&1; then
      if write_lock_metadata; then
        return 0
      fi
      cleanup_lock_dir
      attempts=$((attempts - 1))
      sleep 0.05
      continue
    fi
    if lock_is_stale; then
      cleanup_lock_dir_if_unchanged || true
      attempts=$((attempts - 1))
      sleep 0.05
      continue
    fi
    attempts=$((attempts - 1))
    sleep 0.05
  done
  return 1
}

release_lock() {
  if [ -z "${LOCK_OWNER_TOKEN}" ]; then
    return
  fi
  current_owner="$(cat "${LOCK_DIR}/owner" 2>/dev/null || true)"
  if [ "${current_owner}" = "${LOCK_OWNER_TOKEN}" ]; then
    cleanup_lock_dir
  fi
}

normalize_payload_ts

if enqueue_via_http; then
  if should_force_boundary_flush; then
    run_cli_ingest || true
  fi
  exit 0
fi

if ! acquire_lock; then
  log_line "codemem ingest-claude-hook lock busy; trying unlocked fallback"
  if ! run_cli_ingest; then
    if ! spool_payload "${payload}"; then
      log_line "codemem ingest-claude-hook failed: fallback and spool failed"
      exit 1
    fi
  fi
  exit 0
fi
trap 'release_lock' EXIT

recover_stale_tmp_spool

drain_spool

if enqueue_via_http; then
  if should_force_boundary_flush; then
    run_cli_ingest || true
  fi
  exit 0
fi

if ! run_cli_ingest; then
  if ! spool_payload "${payload}"; then
    log_line "codemem ingest-claude-hook failed: fallback and spool failed"
    exit 1
  fi
fi

exit 0
