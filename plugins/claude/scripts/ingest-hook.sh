#!/usr/bin/env bash
set -u

LOG_PATH_ENV="${CODEMEM_PLUGIN_LOG_PATH:-${CODEMEM_PLUGIN_LOG:-}}"
case "${LOG_PATH_ENV}" in
  ""|"0"|"false"|"off") LOG_PATH="$HOME/.codemem/plugin.log" ;;
  "1"|"true"|"yes") LOG_PATH="$HOME/.codemem/plugin.log" ;;
  *) LOG_PATH="${LOG_PATH_ENV}" ;;
esac

log_line() {
  mkdir -p "$(dirname "${LOG_PATH}")" >/dev/null 2>&1 || true
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >>"${LOG_PATH}" 2>/dev/null || true
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)}"
PLUGIN_MANIFEST="${PLUGIN_ROOT}/.claude-plugin/plugin.json"

# Portable millisecond-resolution clock.
#
# - bash 5+ exposes `EPOCHREALTIME` (fractional epoch seconds). Zero subshells.
# - GNU date supports `%N` for nanoseconds; BSD date (macOS default) does not
#   and would print a literal `N`, breaking downstream arithmetic.
# - Fall back to second-precision epoch (ms ends in 000) if neither is
#   available.
now_ms() {
  if [ -n "${EPOCHREALTIME:-}" ]; then
    # "1744300000.123456" → "1744300000123456" → drop last 3 digits = ms
    local raw="${EPOCHREALTIME/./}"
    printf '%s' "${raw%???}"
    return
  fi
  # Probe once per call — cheap vs forking date twice in the caller.
  local probe
  probe="$(date +%N 2>/dev/null)"
  if [ "${probe}" != "N" ] && [ -n "${probe}" ] && [ "${probe}" != "%N" ]; then
    printf '%s' "$(( $(date +%s%N) / 1000000 ))"
    return
  fi
  printf '%s' "$(( $(date +%s) * 1000 ))"
}

# Resolve the codemem version to pin `npx -y codemem@<version>` against.
# Reads `plugins/claude/.claude-plugin/plugin.json`; intentionally uses a
# sed fallback instead of jq so the pin works in minimal environments (Cowork
# sandbox VMs don't ship jq by default). The plugin manifest is controlled by
# this repo, so the narrow sed pattern is sufficient.
resolve_pinned_version() {
  if [ ! -r "${PLUGIN_MANIFEST}" ]; then
    printf 'latest'
    return
  fi
  local v=""
  if command -v jq >/dev/null 2>&1; then
    v="$(jq -r '.version // empty' "${PLUGIN_MANIFEST}" 2>/dev/null)"
  fi
  if [ -z "${v}" ] || [ "${v}" = "null" ]; then
    v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${PLUGIN_MANIFEST}" 2>/dev/null | head -n1)"
  fi
  if [ -n "${v}" ]; then
    printf '%s' "${v}"
  else
    printf 'latest'
  fi
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

# Run a codemem ingest attempt and capture the return code, wall time, and
# first chunk of stderr so failures show something diagnosable in plugin.log
# instead of a generic "failed via npx" line.
#
# Log format: `codemem claude-hook-ingest failed via <label> rc=<N> ms=<N> stderr=<excerpt>`
# IMPORTANT: `stderr=` must stay the LAST field — the value is raw freeform
# text and any future key=value field must be inserted before it so parsers
# can treat everything after `stderr=` as the excerpt.
run_ingest() {
  local impl_label="$1"
  shift
  local stderr_file="" rc=0 start_ms=0 end_ms=0 elapsed_ms=0 stderr_excerpt=""

  stderr_file="$(mktemp "${TMPDIR:-/tmp}/codemem-hook-stderr-XXXXXX" 2>/dev/null || true)"
  start_ms="$(now_ms)"

  if [ -n "${stderr_file}" ]; then
    printf '%s' "${payload}" | "$@" >/dev/null 2>"${stderr_file}"
  else
    printf '%s' "${payload}" | "$@" >/dev/null 2>&1
  fi
  rc=$?

  end_ms="$(now_ms)"
  elapsed_ms=$(( end_ms - start_ms ))

  if [ "${rc}" -eq 0 ]; then
    [ -n "${stderr_file}" ] && rm -f "${stderr_file}"
    return 0
  fi

  if [ -z "${stderr_file}" ]; then
    # Explicit degraded path — don't pretend everything was captured.
    log_line "codemem claude-hook-ingest failed via ${impl_label} rc=${rc} ms=${elapsed_ms} stderr=<unavailable: mktemp failed>"
    return "${rc}"
  fi

  if [ -s "${stderr_file}" ]; then
    # Strip ALL C0 control chars (including ESC for ANSI, NUL for truncation
    # attacks, plus newline/CR/tab for single-line log format). head -c 400
    # is available on modern BSD + GNU coreutils.
    stderr_excerpt="$(head -c 400 "${stderr_file}" 2>/dev/null | LC_ALL=C tr '\000-\037\177' ' ')"
  fi
  log_line "codemem claude-hook-ingest failed via ${impl_label} rc=${rc} ms=${elapsed_ms} stderr=${stderr_excerpt:-<empty>}"
  rm -f "${stderr_file}"
  return "${rc}"
}

if command -v codemem >/dev/null 2>&1; then
  run_ingest "codemem binary" codemem claude-hook-ingest && exit 0
fi

if command -v npx >/dev/null 2>&1; then
  pinned_version="$(resolve_pinned_version)"
  run_ingest "npx (codemem@${pinned_version})" npx -y "codemem@${pinned_version}" claude-hook-ingest && exit 0
fi

log_line "codemem claude-hook-ingest failed: all command attempts failed"
exit 1
