#!/bin/bash
# Restore the projects mirrored in the GitHub organisation (packages/server/src/mirror.ts) into a
# projects directory — the disaster-recovery path for a fresh server:
#
#   GITHUB_MIRROR_ORG=… GITHUB_MIRROR_TOKEN=… scripts/restore-from-mirror.sh [/root/projects]
#
# Every non-archived repository of the organisation is cloned under its original project name (kept
# in the repository description; the repository name itself is the GitHub-safe form). Directories
# that exist already are left alone. INCLUDE_ARCHIVED=1 also restores deleted projects. Afterwards
# start the server (or open the project list): the directories are adopted for the instance owner
# (OVERLYX_OWNER_EMAIL). Users, sharing and named versions live in the database — restore that
# from the nightly backup (scripts/backup.sh) separately.
set -euo pipefail
: "${GITHUB_MIRROR_ORG:?set GITHUB_MIRROR_ORG}" "${GITHUB_MIRROR_TOKEN:?set GITHUB_MIRROR_TOKEN}"
DEST=${1:-/root/projects}
API=${GITHUB_API_URL:-https://api.github.com}
mkdir -p "$DEST"
export GITHUB_MIRROR_TOKEN
page=1
while :; do
  json=$(curl -sS -H "Authorization: Bearer $GITHUB_MIRROR_TOKEN" -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
    "$API/orgs/$GITHUB_MIRROR_ORG/repos?per_page=100&type=all&page=$page")
  list=$(printf '%s' "$json" | INCLUDE_ARCHIVED="${INCLUDE_ARCHIVED:-0}" python3 -c '
import json, os, re, sys
data = json.load(sys.stdin)
if not isinstance(data, list): sys.exit("GitHub: " + str(data.get("message", data)))
for r in data:
    if r.get("archived") and os.environ.get("INCLUDE_ARCHIVED") != "1": continue
    m = re.match(r"OverLyX mirror of \"(.+)\"$", r.get("description") or "")
    print(r["name"] + "\t" + (m.group(1) if m else r["name"]))
')
  [ -z "$list" ] && break
  while IFS=$'\t' read -r repo project; do
    [ -z "$repo" ] && continue
    if [ -e "$DEST/$project" ]; then echo "skip   $project (exists)"; continue; fi
    echo "clone  $project  ←  $GITHUB_MIRROR_ORG/$repo"
    git -c credential.helper= -c 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_MIRROR_TOKEN"; }; f' \
      clone -q "https://github.com/$GITHUB_MIRROR_ORG/$repo.git" "$DEST/$project"
    git -C "$DEST/$project" remote rename origin mirror >/dev/null 2>&1 || true
  done <<< "$list"
  page=$((page + 1))
done
echo "done — start the server or open the project list; the directories are adopted for the instance owner"
