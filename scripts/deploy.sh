#!/bin/bash
# Deploy OverLyX: the web site AND the VS Code extension from one commit.
#
#   scripts/deploy.sh              # deploy the current master of this checkout
#   scripts/deploy.sh --no-push    # web only (the extension release needs the push)
#
# What runs where:
#   1. this checkout (development, /root/lyx/overlyx): master must be committed and must contain
#      origin/master — the GitHub Action that releases the extension builds origin/master, so the
#      two histories have to be one (a divergence here is how the extension once lagged the web
#      by a week).
#   2. origin: `git push` — this triggers .github/workflows/extension-release.yml, which tests,
#      packages and publishes the extension as release 0.3.<run>; the extension's self-updater
#      and Help ▸ "OverLyX for VS Code" (/api/vscode-extension) both point at that latest release.
#   3. the production checkout (OVERLYX_PRODUCTION, default /root/lyx/overlyx-production, run by the
#      systemd unit): fast-forwarded to the same commit, dependencies installed when the lockfile
#      changed, client built, server restarted, site checked.
#
# Both typechecks and the unit tests must pass before the push or production checkout changes;
# the client built for that check is the one deployed. Testing is kept to a minimum unless asked
# for: OVERLYX_DEPLOY_FULL=1 adds the strict unit matrix (npm run test:release) and the isolated
# browser workflows (npm run test:beta, ~35 min).
set -euo pipefail
cd "$(dirname "$0")/.."
DEV=$(pwd)
PROD=${OVERLYX_PRODUCTION:-/root/lyx/overlyx-production}
SITE=${OVERLYX_SITE_URL:-https://overlyx.app}
UNIT=${OVERLYX_UNIT:-overlyx}
PUSH=1
for a in "$@"; do case "$a" in --no-push) PUSH=0 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# one deploy at a time: scripts/autodeploy.sh (the timer) takes the same lock
exec 9>"${OVERLYX_DEPLOY_LOCK:-/run/lock/overlyx-deploy.lock}"
flock -n 9 || { echo "another deploy is running (the autodeploy timer?) — waiting for it"; flock 9; }

step "development checkout: $DEV"
[ "$(git rev-parse --abbrev-ref HEAD)" = master ] || { echo "deploy from master (on $(git rev-parse --abbrev-ref HEAD))" >&2; exit 1; }
node scripts/release-guards.mjs clean "$DEV"
git fetch origin --quiet
if ! git merge-base --is-ancestor origin/master master; then
  echo "master and origin/master have diverged — merge origin/master (git merge origin/master), test, then deploy again" >&2
  git log --oneline master..origin/master | sed 's/^/  origin only: /' >&2
  exit 1
fi
HEAD=$(git rev-parse HEAD)
echo "commit $HEAD"

step "check the release candidate before pushing or changing production"
npx tsc -p packages/client/tsconfig.json --noEmit
npx tsc -p packages/vscode/tsconfig.json --noEmit
FULL=${OVERLYX_DEPLOY_FULL:-0}
if [ "$FULL" = 1 ]; then bash scripts/check-unit-release.sh; else npx vitest run; fi
candidate=$(mktemp -d /tmp/overlyx-deploy-candidate.XXXXXX)
trap 'rm -rf "$candidate"' EXIT
OVERLYX_BETA_BROWSER="$FULL" OVERLYX_BETA_BUILD_DIR="$candidate/dist" OVERLYX_BETA_ASSET_PROOF="$candidate/asset-proof.json" node scripts/check-beta.mjs
node scripts/release-guards.mjs clean "$DEV" "$HEAD"

if [ "$PUSH" = 1 ]; then
  step "origin: push master (starts the extension release workflow)"
  git push origin "$HEAD:refs/heads/master"
else
  step "origin: not pushed (--no-push): the extension keeps its last release"
fi

step "production checkout: $PROD"
[ -d "$PROD/.git" ] || { echo "$PROD is not a git checkout" >&2; exit 1; }
git -C "$PROD" fetch --quiet "$DEV" "$HEAD"
git -C "$PROD" merge --ff-only FETCH_HEAD
[ "$(git -C "$PROD" rev-parse HEAD)" = "$HEAD" ] || { echo "production is at $(git -C "$PROD" rev-parse HEAD), not $HEAD" >&2; exit 1; }
if [ ! -d "$PROD/node_modules" ] || { git -C "$PROD" rev-parse -q --verify ORIG_HEAD >/dev/null 2>&1 && [ -n "$(git -C "$PROD" diff --name-only ORIG_HEAD HEAD -- package-lock.json)" ]; }; then
  step "production: npm ci (lockfile changed)"
  (cd "$PROD" && npm ci --no-audit --no-fund)
fi

step "production: publish the tested client"
(cd "$PROD/packages/client" && rm -rf dist.new && cp -a "$candidate/dist" dist.new && rm -rf dist && mv dist.new dist)

step "production: restart $UNIT"
systemctl restart "$UNIT"
sleep 2
systemctl is-active --quiet "$UNIT" || { echo "$UNIT is not active; inspect its private service log" >&2; exit 1; }

step "check $SITE"
# the restarted server takes a moment to listen; the reverse proxy answers 502 until then
code=000
for _ in $(seq 1 15); do
  code=$(curl -s --max-time 5 -o /tmp/overlyx-deploy-index.html -w '%{http_code}' "$SITE/")
  [ "$code" = 200 ] && break
  sleep 2
done
[ "$code" = 200 ] || { echo "$SITE answered $code" >&2; exit 1; }
served=$(grep -o 'assets/index-[^"]*' /tmp/overlyx-deploy-index.html | head -1)
built=$(grep -o 'assets/index-[^"]*' "$PROD/packages/client/dist/index.html" | head -1)
[ -n "$served" ] && [ "$served" = "$built" ] || { echo "served bundle ($served) differs from the built one ($built)" >&2; exit 1; }
for i in 1 2 3 4 5; do
  live=$(curl -s --max-time 5 "$SITE/api/version" | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p')
  [ "$live" = "$HEAD" ] && break
  sleep 2
done
[ "$live" = "$HEAD" ] || { echo "$SITE/api/version reports '${live:-nothing}', not $HEAD" >&2; exit 1; }
node scripts/verify-release-assets.mjs "$candidate/dist" "$SITE" "$candidate/asset-proof.json"
echo "site OK: $served, commit $live"

if [ "$PUSH" = 1 ] && command -v gh >/dev/null 2>&1; then
  step "extension release workflow"
  gh run list -R "$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')" --workflow extension-release.yml -L 1 2>/dev/null || echo "(gh could not list the runs — check GitHub ▸ Actions)"
  echo "the extension becomes release 0.3.<run> once the workflow has passed; Help ▸ OverLyX for VS Code serves it"
fi

step "deployed $HEAD"
