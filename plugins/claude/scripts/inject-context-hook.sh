#!/usr/bin/env bash
set -u

print_continue() {
  printf '%s\n' '{"continue":true}'
}

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)}"
PLUGIN_MANIFEST="${PLUGIN_ROOT}/.claude-plugin/plugin.json"
UVX_PACKAGE_SPEC="codemem"

is_truthy() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
  esac
  return 1
}

if [ -f "${PLUGIN_MANIFEST}" ]; then
  PLUGIN_VERSION="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${PLUGIN_MANIFEST}" | sed -n '1p')"
  if [ -n "${PLUGIN_VERSION}" ]; then
    UVX_PACKAGE_SPEC="codemem==${PLUGIN_VERSION}"
  fi
fi

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

if command -v uvx >/dev/null 2>&1 && is_truthy "${CODEMEM_INJECT_ALLOW_UVX:-0}"; then
  if printf '%s' "${payload}" | uvx "${UVX_PACKAGE_SPEC}" claude-hook-inject; then
    exit 0
  fi
fi

print_continue
