#!/bin/bash
# Pull-based deployment of OverLyX: whatever reaches origin/master is checked and deployed by the
# production server itself, so a push from any machine (the VS Code extension's development
# computer, a laptop, this box) deploys the website — no SSH into the server, no secrets in CI.
#
# Run by deploy/overlyx-autodeploy.timer every couple of minutes (as root, from the production
# checkout). Each run:
#   1. fetches origin; nothing to do when production already is at origin/master;
#   2. reports a "deploy/overlyx.app" commit status on GitHub (pending → success / failure), so the
#      pusher sees the outcome with `gh api repos/<repo>/commits/<sha>/status`;
#   3. checks the commit in a throwaway worktree — client + extension typecheck and `npm test`,
#      with the production node_modules unless the lockfile changed;
#   4. on green: fast-forwards the production checkout, `npm ci` when the lockfile changed, builds
#      the client, restarts the unit and verifies that the site serves that commit (/api/version).
# A commit that fails is not retried (a marker under $OVERLYX_AUTODEPLOY_STATE); the next push is.
# scripts/deploy.sh (a deploy from the development tree on this box) shares the lock, so the two
# never run at once. Logs: `journalctl -u overlyx-autodeploy`.
set -euo pipefail
PROD=${OVERLYX_PRODUCTION:-/root/lyx/overlyx-production}
SITE=${OVERLYX_SITE_URL:-https://overlyx.app}
UNIT=${OVERLYX_UNIT:-overlyx}
STATE=${OVERLYX_AUTODEPLOY_STATE:-/var/lib/overlyx-autodeploy}
LOCK=${OVERLYX_DEPLOY_LOCK:-/run/lock/overlyx-deploy.lock}
CONTEXT=deploy/overlyx.app
export LYX_LAYOUT_DIR=${LYX_LAYOUT_DIR:-/root/lyx/lib/layouts}
export HOME=${HOME:-/root}
mkdir -p "$STATE"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
repo_slug() { git -C "$PROD" remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##'; }
# GitHub commit status for the pusher (best effort: a GitHub hiccup must not stop a deploy)
status() {   # state description
  local sha=$1 state=$2 desc=$3
  gh api -X POST "repos/$(repo_slug)/statuses/$sha" -f state="$state" -f context="$CONTEXT" -f description="${desc:0:135}" -f target_url="$SITE" >/dev/null 2>&1 \
    || log "could not post the $state status to GitHub"
}

exec 9>"$LOCK"
flock -n 9 || { log "another deploy holds $LOCK — skipping this run"; exit 0; }

git -C "$PROD" fetch origin --quiet
target=$(git -C "$PROD" rev-parse origin/master)
current=$(git -C "$PROD" rev-parse HEAD)
[ "$target" = "$current" ] && exit 0
if [ -e "$STATE/failed-$target" ]; then exit 0; fi   # already failed once: wait for a new push
log "origin/master is at ${target:0:10}, production at ${current:0:10}"
if ! git -C "$PROD" merge-base --is-ancestor "$current" "$target"; then
  log "production is not an ancestor of origin/master — deploy by hand (scripts/deploy.sh)"
  status "$target" failure "production has commits origin/master lacks — deploy by hand"
  touch "$STATE/failed-$target"
  exit 1
fi
status "$target" pending "checks are running on the production server"

WT=/tmp/overlyx-autodeploy/$target
cleanup() { git -C "$PROD" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; }
cleanup; mkdir -p "$(dirname "$WT")"
git -C "$PROD" worktree add --detach --quiet "$WT" "$target"
trap cleanup EXIT
lockfile_changed=0
git -C "$PROD" diff --quiet "$current" "$target" -- package-lock.json || lockfile_changed=1
if [ "$lockfile_changed" = 0 ]; then
  ln -s "$PROD/node_modules" "$WT/node_modules"
  for d in "$PROD"/packages/*/node_modules; do [ -d "$d" ] && ln -s "$d" "$WT/packages/$(basename "$(dirname "$d")")/node_modules"; done
else
  log "lockfile changed: npm ci in the worktree"
  (cd "$WT" && npm ci --no-audit --no-fund > "$STATE/$target-npm-ci.log" 2>&1) || { status "$target" failure "npm ci failed"; touch "$STATE/failed-$target"; tail -20 "$STATE/$target-npm-ci.log"; exit 1; }
fi

check() {   # name command...
  local name=$1; shift
  local logf="$STATE/$target-${name// /-}.log"
  log "check: $name"
  if ! (cd "$WT" && "$@" > "$logf" 2>&1); then
    log "FAILED: $name — $(wc -l < "$logf") lines in $logf"
    tail -30 "$logf"
    status "$target" failure "$name failed on the production server"
    touch "$STATE/failed-$target"
    exit 1
  fi
}
check "client typecheck" npx tsc -p packages/client/tsconfig.json --noEmit
check "extension typecheck" npx tsc -p packages/vscode/tsconfig.json --noEmit
check "unit tests" npx vitest run
rm -f "$STATE/$target-"*.log

log "checks passed — deploying ${target:0:10}"
status "$target" pending "checks passed — deploying"
git -C "$PROD" merge --ff-only --quiet "$target"
if [ "$lockfile_changed" = 1 ]; then (cd "$PROD" && npm ci --no-audit --no-fund); fi
(cd "$PROD/packages/client" && npx vite build --outDir dist.new > "$STATE/$target-build.log" 2>&1 && rm -rf dist && mv dist.new dist) \
  || { tail -20 "$STATE/$target-build.log"; status "$target" failure "client build failed"; touch "$STATE/failed-$target"; exit 1; }
rm -f "$STATE/$target-build.log"
systemctl restart "$UNIT"
for i in $(seq 1 20); do
  sleep 3
  systemctl is-active --quiet "$UNIT" || continue
  served=$(curl -s --max-time 5 "$SITE/api/version" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
  [ "$served" = "$target" ] && { log "deployed ${target:0:10}: $SITE serves it"; status "$target" success "deployed to $SITE"; exit 0; }
done
log "restarted, but $SITE/api/version reports '${served:-nothing}' instead of ${target:0:10}"
status "$target" failure "restarted, but the site does not report the new commit"
touch "$STATE/failed-$target"
exit 1
