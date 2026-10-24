#!/bin/bash
# Is the off-site backup (scripts/backup-offsite.sh) still good? Weekly (deploy/overlyx-backup-check.timer):
#   - restic check, reading a sample of the stored data back (OVERLYX_BACKUP_CHECK_SUBSET, 5 %);
#   - the newest snapshot is at most two days old;
#   - a restore of its database and of one project, picked at random, into scratch: the database
#     passes integrity_check and has its users, the project has its files.
# Status for the development account (no names, no secrets): /var/lib/overlyx-backup-offsite/check.json.
set -euo pipefail
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set (/etc/overlyx/backup-offsite.env)}"
PROJECTS=$(readlink -f "${OVERLYX_PROJECTS_DIR:-/root/projects}")
STATUS=${OVERLYX_BACKUP_STATUS:-/var/lib/overlyx-backup-offsite}
log() { echo "[backup-check] $*"; }
mkdir -p "$STATUS"; chmod 755 "$STATUS"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
result() {
  printf '{"ok":%s,"started":"%s","finished":"%s","note":"%s"}\n' "$1" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" > "$STATUS/check.json.tmp"
  chmod 644 "$STATUS/check.json.tmp"; mv "$STATUS/check.json.tmp" "$STATUS/check.json"
}
fail() { log "FAILED: $1"; result false "$1"; exit 1; }

restic check --read-data-subset "${OVERLYX_BACKUP_CHECK_SUBSET:-5%}" >/dev/null 2>&1 || fail "restic check found a problem — run it by hand: restic check"
latest=$(restic snapshots --host overlyx --tag nightly --latest 1 --json)
time=$(sed -n 's/.*"time":"\([^"]*\)".*/\1/p' <<<"$latest" | head -1)
id=$(sed -n 's/.*"short_id":"\([0-9a-f]*\)".*/\1/p' <<<"$latest" | head -1)
[ -n "$id" ] || fail "there is no snapshot"
age=$(( ($(date -u +%s) - $(date -u -d "$time" +%s)) / 3600 ))
[ "$age" -le 48 ] || fail "the newest snapshot ($id) is $age hours old"

work=$(mktemp -d "$(dirname "$PROJECTS")/overlyx-backup-check.XXXXXX")
trap 'rm -rf "$work"' EXIT
# one project of those in the snapshot, by chance (owner/name — logged by its position only)
mapfile -t all < <(restic ls --json --recursive "$id" "$PROJECTS" 2>/dev/null | grep '"type":"dir"' | sed -n "s|.*\"path\":\"$PROJECTS/\\([^/\"]*/[^/\"]*\\)\".*|\\1|p" | sort -u)
[ "${#all[@]}" -gt 0 ] || fail "snapshot $id lists no projects"
pick=${all[$((RANDOM % ${#all[@]}))]}
restic restore "$id" --host overlyx --target "$work" --include '/**/overlyx-backup-manifest.json' --include '/**/overlyx.sqlite' --include "$PROJECTS/$pick" >/dev/null
db=$(find "$work" -name overlyx.sqlite -print -quit)
[ -n "$db" ] || fail "snapshot $id restored no database"
[ "$(sqlite3 "$db" 'PRAGMA integrity_check')" = ok ] || fail "the restored database of $id fails integrity_check"
users=$(sqlite3 "$db" 'SELECT COUNT(*) FROM users')
[ "$users" -gt 0 ] || fail "the restored database of $id has no users"
n=$(find "$work$PROJECTS/$pick" -type f -not -path '*/.git/*' | wc -l)
[ "$n" -gt 0 ] || fail "project $(( $(printf '%s\n' "${all[@]}" | grep -nxF "$pick" | cut -d: -f1) )) of ${#all[@]} restored empty from $id"
log "snapshot $id (${age} h old) restores: database ok ($users users), a project of ${#all[@]} with $n files"
result true "snapshot $id, ${age} h old: database ok, a project restored with $n files"
