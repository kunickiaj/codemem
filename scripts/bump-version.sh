#!/usr/bin/env bash
# Bump the version across all packages atomically.
# Usage: ./scripts/bump-version.sh 0.20.0-alpha.5
set -euo pipefail

NEW_VERSION="${1:?Usage: bump-version.sh <version>}"

# Find the current version from the core package
CURRENT_VERSION=$(node -e "console.log(require('./packages/core/package.json').version)")

if [ "$CURRENT_VERSION" = "$NEW_VERSION" ]; then
	echo "Already at $NEW_VERSION"
	exit 0
fi

echo "Bumping $CURRENT_VERSION → $NEW_VERSION"

# All files that contain the version string
FILES=(
	packages/core/package.json
	packages/cli/package.json
	packages/opencode-plugin/package.json
	packages/mcp-server/package.json
	packages/viewer-server/package.json
	packages/core/src/index.ts
	packages/core/src/index.test.ts
	packages/opencode-plugin/.opencode/plugins/codemem.js
)

for f in "${FILES[@]}"; do
	if [ -f "$f" ]; then
		node -e "const fs=require('fs');fs.writeFileSync('$f',fs.readFileSync('$f','utf8').replaceAll('$CURRENT_VERSION','$NEW_VERSION'))"
		echo "  updated $f"
	else
		echo "  WARN: $f not found"
	fi
done

echo "Done. Run 'pnpm install' to update the lockfile."
