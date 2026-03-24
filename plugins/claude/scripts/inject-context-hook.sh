#!/usr/bin/env bash
set -u

print_continue() {
  printf '%s\n' '{"continue":true}'
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)}"
PLUGIN_MANIFEST="${PLUGIN_ROOT}/.claude-plugin/plugin.json"
payload="$(cat)"
if [ -z "${payload}" ]; then
  print_continue
  exit 0
fi

case "${CODEMEM_PLUGIN_IGNORE:-}" in
  "1"|"true"|"yes"|"on")
    print_continue
    exit 0
    ;;
esac

if command -v codemem >/dev/null 2>&1; then
  if printf '%s' "${payload}" | codemem claude-hook-inject; then
    exit 0
  fi
fi

if command -v npx >/dev/null 2>&1; then
  if printf '%s' "${payload}" | npx -y codemem claude-hook-inject; then
    exit 0
  fi
fi

print_continue
