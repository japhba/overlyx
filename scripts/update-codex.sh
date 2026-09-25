#!/bin/bash
# Daily codex update for the Agent panel (installed by deploy/overlyx-codex-update.timer): new GPT
# models reach the panel only through a newer codex — its model/list comes from OpenAI's catalogue
# for that client version. Installs the newest @openai/codex when npm has one, checks it with
# scripts/codex-smoke.mjs and reinstalls the previous version when that fails. Running agents move
# to the new codex once they are quiet (server/agent.ts, codexOutdated).
#
#   scripts/update-codex.sh
set -euo pipefail
PKG=@openai/codex
installed() { npm ls -g --depth=0 --json "$PKG" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).dependencies["@openai/codex"].version)}catch{console.log("")}})'; }
cur=$(installed)
latest=$(npm view "$PKG" version)
if [ -z "$latest" ]; then echo "npm did not report a version of $PKG" >&2; exit 1; fi
if [ "$cur" = "$latest" ]; then echo "codex $cur is current"; exit 0; fi
# never downgrade (a dist-tag moved back, or a newer build installed by hand)
if [ -n "$cur" ] && [ "$(printf '%s\n%s\n' "$cur" "$latest" | sort -V | tail -1)" = "$cur" ]; then echo "codex $cur is newer than npm's $latest — left alone"; exit 0; fi
echo "codex ${cur:-(none)} → $latest"
npm install -g --no-fund --no-audit "$PKG@$latest"
if node "$(dirname "$0")/codex-smoke.mjs"; then
  echo "codex $latest installed"
else
  echo "codex $latest failed the smoke test — reinstalling ${cur:-nothing}" >&2
  [ -n "$cur" ] && npm install -g --no-fund --no-audit "$PKG@$cur"
  exit 1
fi
