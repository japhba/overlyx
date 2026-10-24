#!/bin/bash
# Restore from the off-site backup (scripts/backup-offsite.sh) the way scripts/restore.sh restores a
# nightly one — it puts the snapshot together in restore.sh's layout and hands it over:
#
#   scripts/restore-offsite.sh <snapshot id | latest> <data dir> <projects dir> [--force]
#
# The repository and its keys come from /etc/overlyx/backup-offsite.env (as root:
# `set -a; . /etc/overlyx/backup-offsite.env; set +a` first). For a drill, restore into scratch
# directories and start an isolated instance on them (DOCS.md "Backups and restoring"); for the real
# thing stop the service, restore into the production directories with --force, start it. The agents'
# homes (ChatGPT sign-ins, transcripts) are restored beside the target as agent-home/ — move them to
# <agents dir>/agent-home if wanted. `restic snapshots --host overlyx` lists what there is.
set -euo pipefail
snap=${1:?snapshot id or latest}; data=${2:?data dir}; projects=${3:?projects dir}; force=${4:-}
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set — source /etc/overlyx/backup-offsite.env}"
work=$(mktemp -d "${OVERLYX_RESTORE_TMP:-$(dirname "$(readlink -f "$projects" 2>/dev/null || echo "$projects")")}/overlyx-restore.XXXXXX")
trap 'rm -rf "$work"' EXIT
echo "restoring snapshot $snap from $RESTIC_REPOSITORY …"
restic restore "$snap" --host overlyx --target "$work/tree"
manifest=$(find "$work/tree" -name overlyx-backup-manifest.json -print -quit)
[ -n "$manifest" ] || { echo "the snapshot has no overlyx-backup-manifest.json — not an OverLyX off-site backup" >&2; exit 1; }
field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" "$manifest"; }
stage=$(dirname "$manifest")
echo "the snapshot was taken on $(field host) at $(field at)"
b="$work/backup"; mkdir -p "$b"
for f in overlyx.sqlite secret.key secrets.env; do [ -f "$stage/$f" ] && cp -p "$stage/$f" "$b/"; done
[ -d "$work/tree$(field projects)" ] || { echo "the snapshot holds no projects directory ($(field projects))" >&2; exit 1; }
mv "$work/tree$(field projects)" "$b/projects"
"$(dirname "$0")/restore.sh" "$b" "$data" "$projects" $force
if [ -d "$work/tree$(field agents)/agent-home" ]; then
  dest="$(dirname "$projects")/agent-home.restored-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
  mv "$work/tree$(field agents)/agent-home" "$dest"
  echo "  the agents' homes are in $dest"
fi
