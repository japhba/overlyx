#!/bin/bash
# Off-site backup of an OverLyX instance: restic, encrypted on this server before anything leaves
# it, into a Hetzner Object Storage bucket in another location (deploy/setup-backup-offsite.sh sets
# it up). The bucket has Object Lock in compliance mode: every object restic writes is kept at
# least OVERLYX_BACKUP_LOCK_DAYS (30) days — whatever this server does, a compromised one included,
# it cannot remove history younger than that; restic's own deletes leave delete markers over
# versions the bucket still holds (DOCS.md "Backups and restoring": recovering from them).
#
# Each run (deploy/overlyx-backup-offsite.timer, nightly) backs up
#   - the SQLite database (an online backup, consistent), secret.key and deploy/secrets.env, staged
#     in OVERLYX_BACKUP_STAGE with a manifest that says where things were;
#   - the projects directory with their git histories (without build products);
#   - the agents' homes (sign-ins, transcripts; not their working copies);
# then forgets snapshots beyond KEEP (14 daily, 8 weekly, 3 monthly: about three months — the
# privacy notice says so) and any other snapshot (one made by hand) after OTHERS_DAYS (92), and
# prunes on Sundays — completely (--max-unused 0), so that no remnant of deleted data outlives the
# snapshots that held it by more than the lock's days. Status for the development account (no secrets):
# /var/lib/overlyx-backup-offsite/backup.json. Configuration: /etc/overlyx/backup-offsite.env
# (RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION).
#
#   OVERLYX_DATA_DIR=… OVERLYX_PROJECTS_DIR=… scripts/backup-offsite.sh
set -euo pipefail
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is not set (/etc/overlyx/backup-offsite.env)}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is not set (/etc/overlyx/backup-offsite.env)}"
DATA=${OVERLYX_DATA_DIR:-/root/lyx/overlyx/data}
PROJECTS=${OVERLYX_PROJECTS_DIR:-/root/projects}
PROJECTS=$(readlink -f "$PROJECTS")
AGENTS=${OVERLYX_AGENT_DIR:-$(dirname "$PROJECTS")/agents}
STAGE=${OVERLYX_BACKUP_STAGE:-$(dirname "$PROJECTS")/backup-stage}
STATUS=${OVERLYX_BACKUP_STATUS:-/var/lib/overlyx-backup-offsite}
SECRETS=${OVERLYX_SECRETS_FILE:-$(dirname "$0")/../deploy/secrets.env}
KEEP=${OVERLYX_BACKUP_KEEP:---keep-daily 14 --keep-weekly 8 --keep-monthly 3}
OTHERS_DAYS=${OVERLYX_BACKUP_OTHERS_DAYS:-92}

log() { echo "[backup-offsite] $*"; }
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
mkdir -p "$STATUS"; chmod 755 "$STATUS"
status() {   # what the development account may see: when, whether, how much — nothing else
  printf '{"ok":%s,"started":"%s","finished":"%s","snapshot":"%s","added":"%s","files":"%s","note":"%s"}\n' \
    "$1" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-}" "${3:-}" "${4:-}" "${5:-}" > "$STATUS/backup.json.tmp"
  chmod 644 "$STATUS/backup.json.tmp"; mv "$STATUS/backup.json.tmp" "$STATUS/backup.json"
}
trap 'status false "" "" "" "the backup failed — journalctl -u overlyx-backup-offsite"' ERR
# the staged copies exist only while a run lasts
trap 'rm -f "$STAGE"/overlyx.sqlite "$STAGE"/secret.key "$STAGE"/secrets.env "$STAGE"/telemetry-pseudonyms.key' EXIT

# the database, consistently, and the secrets that exist nowhere else
install -d -m 700 "$STAGE"
rm -f "$STAGE/overlyx.sqlite"
sqlite3 "$DATA/overlyx.sqlite" ".backup '$STAGE/overlyx.sqlite'"
sqlite3 "$STAGE/overlyx.sqlite" "PRAGMA quick_check" | grep -qx ok || { log "the staged database fails quick_check"; exit 1; }
for f in "$DATA/secret.key" "$SECRETS" "$DATA/telemetry-pseudonyms.key"; do [ -f "$f" ] && install -m 600 "$f" "$STAGE/$(basename "$f")"; done
printf '{"format":1,"data":"%s","projects":"%s","agents":"%s","stage":"%s","host":"%s","at":"%s"}\n' "$DATA" "$PROJECTS" "$AGENTS" "$STAGE" "$(hostname)" "$started" > "$STAGE/overlyx-backup-manifest.json"

paths=("$STAGE" "$PROJECTS")
[ -d "$AGENTS/agent-home" ] && paths+=("$AGENTS/agent-home")
excludes=(--exclude '_build' --exclude 'svg-inkscape' --exclude '*.overlyx-tmp' --exclude '*.aux' --exclude '*.log' --exclude '*.fls'
  --exclude '*.fdb_latexmk' --exclude '*.synctex.gz' --exclude 'keeper.sock')

out=$(restic backup --quiet --json --tag nightly --host overlyx "${excludes[@]}" "${paths[@]}" | grep '"message_type":"summary"' | tail -1)
snap=$(sed -n 's/.*"snapshot_id":"\([0-9a-f]*\)".*/\1/p' <<<"$out")
added=$(sed -n 's/.*"data_added":\([0-9]*\).*/\1/p' <<<"$out")
files=$(sed -n 's/.*"total_files_processed":\([0-9]*\).*/\1/p' <<<"$out")
log "snapshot ${snap:0:8}: $files files, $(numfmt --to=iec "${added:-0}" 2>/dev/null || echo "${added:-0} B") new"

# the history kept: about three months; the bucket keeps what restic forgets for the lock's 30 days more
restic forget --quiet --host overlyx --tag nightly $KEEP
# snapshots made by hand (another tag, other paths) go after OTHERS_DAYS: one group, so the age counts from tonight's snapshot
restic forget --quiet --host overlyx --group-by host --keep-tag nightly --keep-within "${OTHERS_DAYS}d"
if [ "$(date -u +%u)" = 7 ] || [ "${OVERLYX_BACKUP_PRUNE:-}" = 1 ]; then restic prune --quiet --max-unused 0 && log "pruned"; fi
trap - ERR
status true "$snap" "${added:-0}" "${files:-0}"
log "done"
