#!/bin/bash
# After a deploy: whether documents open — the server's own check after its start (server
# selfcheck.ts, GET /api/health): a .tex document, a markdown file, an HTML deck and a whiteboard,
# opened over its websocket as their editors open them. Waits for it (it starts a few seconds after
# the server) and exits 1 when one did not open. Used by scripts/autodeploy.sh and scripts/deploy.sh.
set -uo pipefail
SITE=${1:?usage: docs-check.sh <site URL>}
for _ in $(seq 1 45); do
  body=$(curl -s --max-time 5 -w '\n%{http_code}' "$SITE/api/health" || true)
  code=${body##*$'\n'}; body=${body%$'\n'*}
  # (a version without the check: nothing to wait for)
  [ "$code" = 404 ] && { echo "(no document check on this version)"; exit 0; }
  docs=$(printf '%s' "$body" | sed -n 's/.*"docs":"\([a-z]*\)".*/\1/p')
  case "$docs" in
    ok) echo "documents open: a .tex document, a markdown file, a deck and a whiteboard"; exit 0 ;;
    off) echo "(the server's document check is off)"; exit 0 ;;
    failed) echo "documents do not open: $(printf '%s' "$body" | sed -n 's/.*"detail":"\([^"]*\)".*/\1/p')" >&2; exit 1 ;;
  esac
  sleep 2
done
echo "the server's document check did not finish within 90 s ($SITE/api/health)" >&2
exit 1
