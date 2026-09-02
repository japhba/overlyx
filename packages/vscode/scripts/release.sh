#!/bin/bash
# Release the VS Code extension: package the current source and publish a GitHub release with
# BOTH asset names — the versioned one and the stable `overlyx-vscode.vsix` that the README
# one-liner and /releases/latest/download/ depend on. The extension's self-updater reads
# /releases/latest of this repository.
#
#   packages/vscode/scripts/release.sh          # uses the version in package.json
#
# Bump "version" in packages/vscode/package.json first; commit before releasing (the tag points
# at HEAD).
set -euo pipefail
cd "$(dirname "$0")/.."
V=$(node -p "require('./package.json').version")
REPO=${OVERLYX_RELEASE_REPO:-japhba/overlyx}
git -C ../.. diff --quiet || { echo "commit your changes first (the tag points at HEAD)" >&2; exit 1; }
npm run build
npx vsce package --no-dependencies
cp "overlyx-vscode-$V.vsix" overlyx-vscode.vsix
trap 'rm -f overlyx-vscode.vsix' EXIT
gh release create "v$V" "overlyx-vscode-$V.vsix" overlyx-vscode.vsix --repo "$REPO" \
  --title "OverLyX for VS Code $V" --generate-notes
echo "released v$V — stable URL: https://github.com/$REPO/releases/latest/download/overlyx-vscode.vsix"
