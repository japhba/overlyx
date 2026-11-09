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
#   3. checks the commit in a throwaway copy — both typechecks, the unit tests and the client build
#      (OVERLYX_DEPLOY_FULL=1 in the unit's environment: the strict unit matrix and the browser workflows too),
#      with the production node_modules unless the lockfile changed; a `Deploy: no-checks` trailer
#      on the pushed commit (origin/master's tip) skips the typechecks and unit tests — the build
#      and the verification still run;
#   4. on green: fast-forwards the production checkout, `npm ci` when the lockfile changed, builds
#      the client, restarts the unit and verifies that the site serves that commit (/api/version)
#      and that documents open on it (scripts/docs-check.sh: the server's own check after its start).
#      The checks run as the account overlyx-build in a sandbox of their own (systemd-run: /root, /home
#      and /mnt hidden, the system read-only), so a commit's tests, build and install scripts never run
#      as root before it is deployed; deploy/setup-accounts.sh creates the account and switches this on
#      after a trial run (`autodeploy.sh --trial`, the marker $STATE/unprivileged-checks).
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
BUILD_USER=${OVERLYX_BUILD_USER:-overlyx-build}
BUILD_WORK=${OVERLYX_BUILD_WORK:-/var/lib/overlyx-build}
TRIAL=0; [ "${1:-}" = --trial ] && TRIAL=1   # check production's own commit in the sandbox, deploy nothing
mkdir -p "$STATE"
SANDBOX=0
if [ "$TRIAL" = 1 ] || [ -e "$STATE/unprivileged-checks" ]; then
  id -u "$BUILD_USER" >/dev/null 2>&1 && SANDBOX=1 || { echo "no account $BUILD_USER: run deploy/setup-accounts.sh" >&2; exit 1; }
fi

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*"; }
repo_slug() { git -C "$PROD" remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##'; }
# GitHub commit status for the pusher (best effort: a GitHub hiccup must not stop a deploy)
status() {   # state description
  local sha=$1 state=$2 desc=$3
  [ "$TRIAL" = 0 ] || return 0
  gh api -X POST "repos/$(repo_slug)/statuses/$sha" -f state="$state" -f context="$CONTEXT" -f description="${desc:0:135}" -f target_url="$SITE" >/dev/null 2>&1 \
    || log "could not post the $state status to GitHub"
}

exec 9>"$LOCK"
if [ "$TRIAL" = 1 ]; then flock 9   # (a trial waits its turn: its result switches the sandbox on)
else flock -n 9 || { log "another deploy holds $LOCK — skipping this run"; exit 0; }; fi

current=$(git -C "$PROD" rev-parse HEAD)
if [ "$TRIAL" = 1 ]; then
  target=$current
else
  git -C "$PROD" fetch origin --quiet
  target=$(git -C "$PROD" rev-parse origin/master)
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
fi

# The copy lives next to the production checkout (same filesystem): its node_modules are hardlink
# copies of production's (`cp -al`, seconds, no extra disk) — symlinks would make Node resolve the same
# package under two paths and load prosemirror twice, which breaks the tests. In the sandbox the copy is
# a shallow clone of its own (the tests ask git about the tree; production's .git stays root's) owned
# by the build account; the linked files stay root's and read-only to it, only their folders are its.
if [ "$SANDBOX" = 1 ]; then
  WT=$BUILD_WORK/$target
  cleanup() { rm -rf "$WT"; }
else
  WT=${OVERLYX_AUTODEPLOY_WORK:-$(dirname "$PROD")/.overlyx-autodeploy}/$target
  cleanup() { git -C "$PROD" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; git -C "$PROD" worktree prune; }
fi
cleanup; mkdir -p "$(dirname "$WT")"
if [ "$SANDBOX" = 1 ]; then
  git init --quiet "$WT"
  git -C "$WT" fetch --quiet --depth 1 "file://$PROD" "$target"
  git -C "$WT" -c advice.detachedHead=false checkout --quiet --detach FETCH_HEAD
  [ "$(git -C "$WT" rev-parse HEAD)" = "$target" ] || { log "the copy is not at ${target:0:10}"; exit 1; }
  mkdir -p "$WT/.home" "$WT/.reports"
  printf '[user]\n\tname = OverLyX build\n\temail = build@localhost\n' > "$WT/.home/.gitconfig"
  chown -R "$BUILD_USER:$BUILD_USER" "$WT"; chmod 700 "$WT"
else
  git -C "$PROD" worktree add --detach --quiet "$WT" "$target"
fi
trap cleanup EXIT
# build command... — in the copy; in the sandbox as the build account, with a fresh home and nothing of
# root's to see: no state survives from one commit's checks to the next
build() {
  if [ "$SANDBOX" = 1 ]; then
    systemd-run --quiet --wait --pipe --collect --service-type=exec --uid="$BUILD_USER" --gid="$BUILD_USER" \
      --working-directory="$WT" --nice=5 -p ProtectSystem=strict -p ReadWritePaths="$WT" -p ProtectHome=yes \
      -p InaccessiblePaths=-/mnt -p InaccessiblePaths=-/var/lib/overlyx-autodeploy -p PrivateTmp=yes -p ProtectProc=invisible \
      -p NoNewPrivileges=yes -p RestrictSUIDSGID=yes -p ProtectKernelTunables=yes -p ProtectKernelModules=yes \
      -p ProtectControlGroups=yes -p BindReadOnlyPaths="$(dirname "$LYX_LAYOUT_DIR"):/opt/lyx/lib" \
      -E HOME="$WT/.home" -E PATH=/usr/local/bin:/usr/bin:/bin -E LYX_LAYOUT_DIR=/opt/lyx/lib/layouts \
      ${PLAYWRIGHT_BROWSERS_PATH:+-E PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH"} "$@"
  else
    (cd "$WT" && "$@")
  fi
}
lockfile_changed=0
git -C "$PROD" diff --quiet "$current" "$target" -- package-lock.json || lockfile_changed=1
if [ "$lockfile_changed" = 0 ]; then
  cp -al "$PROD/node_modules" "$WT/node_modules" 2>/dev/null || cp -a "$PROD/node_modules" "$WT/node_modules"
  for d in "$PROD"/packages/*/node_modules; do
    [ -d "$d" ] || continue
    dest="$WT/packages/$(basename "$(dirname "$d")")/node_modules"
    cp -al "$d" "$dest" 2>/dev/null || cp -a "$d" "$dest"
  done
  if [ "$SANDBOX" = 1 ]; then
    find "$WT/node_modules" "$WT"/packages/*/node_modules -type d -exec chown "$BUILD_USER:$BUILD_USER" {} + 2>/dev/null || true
  fi
else
  log "lockfile changed: npm ci in the copy"
  build npm ci --no-audit --no-fund > "$STATE/$target-npm-ci.log" 2>&1 || { status "$target" failure "npm ci failed"; touch "$STATE/failed-$target"; log "npm ci failed; inspect $STATE/$target-npm-ci.log"; exit 1; }
fi

check() {   # name command...
  local name=$1; shift
  local logf="$STATE/$target-${name// /-}.log"
  log "check: $name"
  if ! build "$@" > "$logf" 2>&1; then
    log "FAILED: $name — $(wc -l < "$logf") lines in $logf"
    status "$target" failure "$name failed on the production server"
    touch "$STATE/failed-$target"
    exit 1
  fi
}
# testing is kept to a minimum unless asked for (OVERLYX_DEPLOY_FULL=1); a pusher reasonably
# confident of the change skips the typechecks and unit tests with a `Deploy: no-checks` trailer
FULL=${OVERLYX_DEPLOY_FULL:-0}
trailer=$(git -C "$PROD" log -1 --format='%(trailers:key=Deploy,valueonly)' "$target" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
if [ "$trailer" = no-checks ] && [ "$FULL" != 1 ] && [ "$TRIAL" = 0 ]; then
  log "Deploy: no-checks — typechecks and unit tests skipped"
else
  check "client typecheck" npx tsc -p packages/client/tsconfig.json --noEmit
  check "extension typecheck" npx tsc -p packages/vscode/tsconfig.json --noEmit
  if [ "$FULL" = 1 ]; then check "unit tests" bash scripts/check-unit-release.sh; else check "unit tests" npx vitest run; fi
fi
REPORTS=$STATE/$target-browser; [ "$SANDBOX" = 1 ] && REPORTS=$WT/.reports
check "$([ "$FULL" = 1 ] && echo "browser workflows" || echo "client build")" env OVERLYX_BETA_BROWSER="$FULL" OVERLYX_BETA_REPORT_DIR="$REPORTS" OVERLYX_BETA_BUILD_DIR="$WT/packages/client/dist.beta" OVERLYX_BETA_ASSET_PROOF="$WT/packages/client/dist.beta-proof.json" node scripts/check-beta.mjs
rm -f "$STATE/$target-"*.log
# the build account's output becomes the site: plain files and folders only
if [ "$SANDBOX" = 1 ] && [ -n "$(find "$WT/packages/client/dist.beta" ! -type f ! -type d -print -quit)" ]; then
  log "the build left links or devices in dist.beta"; status "$target" failure "the build output holds links"; touch "$STATE/failed-$target"; exit 1
fi
if [ "$TRIAL" = 1 ]; then log "trial: the checks of ${target:0:10} pass$([ "$SANDBOX" = 1 ] && echo " as $BUILD_USER")"; exit 0; fi

log "checks passed — deploying ${target:0:10}"
status "$target" pending "checks passed — deploying"
git -C "$PROD" merge --ff-only --quiet "$target"
if [ "$lockfile_changed" = 1 ]; then (cd "$PROD" && npm ci --no-audit --no-fund); fi
# Publish the compiled assets built (and, with OVERLYX_DEPLOY_FULL=1, browser-tested) above.
# (copied as root's files: -a would keep the build account as their owner)
(cd "$PROD/packages/client" && rm -rf dist.new && cp -R --preserve=mode,timestamps "$WT/packages/client/dist.beta" dist.new && rm -rf dist && mv dist.new dist) \
  || { status "$target" failure "could not publish tested client assets"; touch "$STATE/failed-$target"; exit 1; }
systemctl restart "$UNIT"
for i in $(seq 1 20); do
  sleep 3
  systemctl is-active --quiet "$UNIT" || continue
  served=$(curl -s --max-time 5 "$SITE/api/version" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
  if [ "$served" = "$target" ]; then
    # (the scripts from production, now at the same commit: root runs nothing the build could rewrite)
    if ! node "$PROD/scripts/verify-release-assets.mjs" "$WT/packages/client/dist.beta" "$SITE" "$WT/packages/client/dist.beta-proof.json"; then
      status "$target" failure "served assets differ from the tested candidate"
      touch "$STATE/failed-$target"
      exit 1
    fi
    # (deployed either way — no rollback: a version may have converted stored documents — but said loudly)
    if ! docs=$(bash "$PROD/scripts/docs-check.sh" "$SITE" 2>&1); then
      log "deployed ${target:0:10}, but $docs"
      status "$target" failure "deployed, but $docs"
      exit 1
    fi
    log "$docs"
    log "deployed ${target:0:10}: $SITE serves the tested assets"
    status "$target" success "deployed to $SITE"
    exit 0
  fi
done
log "restarted, but $SITE/api/version reports '${served:-nothing}' instead of ${target:0:10}"
status "$target" failure "restarted, but the site does not report the new commit"
touch "$STATE/failed-$target"
exit 1
