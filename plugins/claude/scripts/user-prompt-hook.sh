#!/usr/bin/env bash
set -u

print_continue() {
  printf '%s\n' '{"continue":true}'
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
payload="$(cat)"

if [ -z "${payload}" ]; then
  print_continue
  exit 0
fi

payload_file="$(mktemp "${TMPDIR:-/tmp}/codemem-user-prompt-XXXXXX" 2>/dev/null || true)"
if [ -n "${payload_file}" ] && printf '%s' "${payload}" >"${payload_file}" 2>/dev/null; then
  if [ -x "${SCRIPT_DIR}/ingest-hook.sh" ]; then
    nohup bash -c '"$1" <"$2" >/dev/null 2>&1 || true; rm -f "$2" >/dev/null 2>&1 || true' _ \
      "${SCRIPT_DIR}/ingest-hook.sh" "${payload_file}" >/dev/null 2>&1 &
  else
    nohup bash -c 'bash "$1" <"$2" >/dev/null 2>&1 || true; rm -f "$2" >/dev/null 2>&1 || true' _ \
      "${SCRIPT_DIR}/ingest-hook.sh" "${payload_file}" >/dev/null 2>&1 &
  fi
else
  if [ -x "${SCRIPT_DIR}/ingest-hook.sh" ]; then
    (printf '%s' "${payload}" | "${SCRIPT_DIR}/ingest-hook.sh" >/dev/null 2>&1 || true) &
  else
    (printf '%s' "${payload}" | bash "${SCRIPT_DIR}/ingest-hook.sh" >/dev/null 2>&1 || true) &
  fi
fi

if [ -x "${SCRIPT_DIR}/inject-context-hook.sh" ]; then
  if ! printf '%s' "${payload}" | "${SCRIPT_DIR}/inject-context-hook.sh"; then
    print_continue
  fi
else
  if ! printf '%s' "${payload}" | bash "${SCRIPT_DIR}/inject-context-hook.sh"; then
    print_continue
  fi
fi
