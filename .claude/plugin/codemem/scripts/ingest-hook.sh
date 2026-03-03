#!/usr/bin/env bash
set -u

LOG_PATH_ENV="${CODEMEM_PLUGIN_LOG_PATH:-${CODEMEM_PLUGIN_LOG:-}}"
case "${LOG_PATH_ENV}" in
  ""|"0"|"false"|"off") LOG_PATH="$HOME/.codemem/plugin.log" ;;
  "1"|"true"|"yes") LOG_PATH="$HOME/.codemem/plugin.log" ;;
  *) LOG_PATH="${LOG_PATH_ENV}" ;;
esac
ALLOW_UVX="${CODEMEM_HOOK_ALLOW_UVX:-0}"

log_line() {
  mkdir -p "$(dirname "${LOG_PATH}")" >/dev/null 2>&1 || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${LOG_PATH}" 2>/dev/null || true
}

payload="$(cat)"
if [ -z "${payload}" ]; then
  exit 0
fi

if command -v codemem >/dev/null 2>&1; then
  (
    if ! printf '%s' "${payload}" | codemem ingest-claude-hook >/dev/null 2>&1; then
      log_line "codemem ingest-claude-hook failed via codemem binary"
    fi
  ) &
  exit 0
fi

if [ "${ALLOW_UVX}" = "1" ] && command -v uvx >/dev/null 2>&1; then
  (
    if ! printf '%s' "${payload}" | uvx --from codemem codemem ingest-claude-hook >/dev/null 2>&1; then
      log_line "codemem ingest-claude-hook failed via uvx"
    fi
  ) &
  exit 0
fi

if [ "${ALLOW_UVX}" = "1" ]; then
  log_line "codemem ingest-claude-hook skipped: codemem and uvx not found"
else
  log_line "codemem ingest-claude-hook skipped: codemem binary not found"
fi

exit 0
