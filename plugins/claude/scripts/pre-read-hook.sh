#!/usr/bin/env sh
# Compatibility entrypoint for previously installed hook registrations.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "${SCRIPT_DIR}/pre-read-hook.mjs"
