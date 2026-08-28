#!/bin/bash
# The secrets of an OverLyX instance (Google OAuth client secret, GitHub token, …) live outside the
# repository in deploy/secrets.env — git-ignored, mode 600, read by the systemd unit through
# EnvironmentFile=. So that a fresh clone can be wired up with one command, a copy is kept in a
# *private* GitHub repository and fetched with your GitHub login (`gh auth login` once):
#
#   scripts/secrets.sh pull     # private repo  -> deploy/secrets.env
#   scripts/secrets.sh push     # deploy/secrets.env -> private repo (one commit per push)
#   scripts/secrets.sh edit     # $EDITOR deploy/secrets.env, then push
#   scripts/secrets.sh init     # create the private repository (once)
#
# OVERLYX_SECRETS_REPO selects the repository (default japhba/overlyx-secrets). Only people whose
# GitHub account can read that repository can pull. Never commit secrets.env to *this* repository
# (it is in .gitignore); deploy/secrets.env.example lists the variables.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=${OVERLYX_SECRETS_REPO:-japhba/overlyx-secrets}
FILE=deploy/secrets.env
REMOTE_PATH=secrets.env
cmd=${1:-}

need_gh() { command -v gh >/dev/null || { echo "gh (GitHub CLI) is required: https://cli.github.com" >&2; exit 1; }; gh auth status >/dev/null 2>&1 || { echo "run: gh auth login" >&2; exit 1; }; }

case "$cmd" in
  init)
    need_gh
    if gh repo view "$REPO" >/dev/null 2>&1; then echo "$REPO exists"; else gh repo create "$REPO" --private --description "OverLyX instance secrets (deploy/secrets.env)"; fi
    ;;
  pull)
    need_gh
    tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
    gh api "repos/$REPO/contents/$REMOTE_PATH" -H "Accept: application/vnd.github.raw+json" > "$tmp"
    install -m 600 "$tmp" "$FILE"
    echo "wrote $FILE ($(grep -c '=' "$FILE") variables) from $REPO"
    ;;
  push)
    need_gh
    [ -s "$FILE" ] || { echo "$FILE is empty or missing" >&2; exit 1; }
    sha=$(gh api "repos/$REPO/contents/$REMOTE_PATH" -q .sha 2>/dev/null || true)
    args=(-f message="update $(date -u +%Y-%m-%dT%H:%M:%SZ) from $(hostname)" -f content="$(base64 -w0 "$FILE")")
    [ -n "$sha" ] && args+=(-f sha="$sha")
    gh api -X PUT "repos/$REPO/contents/$REMOTE_PATH" "${args[@]}" -q '.commit.sha' | sed "s/^/pushed $FILE to $REPO @ /"
    ;;
  edit)
    [ -f "$FILE" ] || install -m 600 deploy/secrets.env.example "$FILE"
    "${EDITOR:-nano}" "$FILE"
    "$0" push
    ;;
  *)
    sed -n '2,14p' "$0"; exit 1
    ;;
esac
