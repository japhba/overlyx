#!/bin/bash
# Set up OverLyX's off-site backup — encrypted with restic on this server, kept in a Hetzner Object
# Storage bucket in another location that even this server cannot purge (scripts/backup-offsite.sh,
# DOCS.md "Backups and restoring"). As root, once; running it again changes nothing that is in place:
#
#   bash /root/lyx/overlyx-production/deploy/setup-backup-offsite.sh
#
# Before: in the Hetzner Console, Object Storage ▸ "Generate credentials" (S3 keys) in the project of
# this server. Write the secret key down — it is shown once. Do NOT create the bucket in the Console:
# Object Lock can only be switched on when a bucket is created, which the Console cannot; this
# script creates it. Settings (environment, or asked for):
#   OVERLYX_BACKUP_BUCKET    the bucket's name (unique across Hetzner; default overlyx-backup-<random>)
#   OVERLYX_BACKUP_LOCATION  hel1 (default: this server is in fsn1), nbg1 or fsn1
#   OVERLYX_BACKUP_LOCK_DAYS 30: how long every stored object cannot be deleted by anyone (COMPLIANCE)
#   S3 access and secret key (asked for when not in /etc/overlyx/backup-offsite.env yet)
#
# It (1) installs restic (Ubuntu's package) and the MinIO client mc (a pinned release, its checksum
# checked); (2) writes /etc/overlyx/backup-offsite.env (0600: the keys, the repository, the
# instance's directories); (3) makes the repository password /etc/overlyx/restic-password (0600) and
# prints it ONCE — keep it in your password manager and on paper: without it the backups cannot be
# read, by anyone; (4) creates the bucket with Object Lock — default COMPLIANCE retention of
# LOCK_DAYS days, versioning, lifecycle rules that let go of a deleted version LOCK_DAYS + 1 days later
# and of dangling delete markers; (5) restic init; (6) installs and starts
# deploy/overlyx-backup-offsite.timer (nightly) and deploy/overlyx-backup-check.timer (weekly restore
# check), and the telemetry wrapper that shows their logs to the development account; (7) runs the
# first backup and the restore check.
#
# Then, once both have succeeded:
#   bash /root/lyx/overlyx-production/deploy/setup-backup-offsite.sh --retire-github-mirror
# turns the GitHub mirror off (its two lines in secrets.env commented out, the service restarted).
# The private repositories already on GitHub stay there until you delete them.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run this as root" >&2; exit 1; }
PROD=$(cd "$(dirname "$0")/.." && pwd)
ETC=/etc/overlyx
ENVF=$ETC/backup-offsite.env
PWF=$ETC/restic-password
MC_URL=https://dl.min.io/aistor/mc/release/linux-amd64/archive/mc.RELEASE.2026-09-19T15-24-59Z
MC_SHA256=83938eded435e7c28c397ece1dc590b2a79626dd9354aae2107060fec559ae2b
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# the instance's own places, as its service has them
unit_env() { systemctl show overlyx -p Environment --value | tr ' ' '\n' | sed -n "s/^$1=//p" | tail -1; }
secrets_file() { systemctl show overlyx -p EnvironmentFiles --value | awk '{print $1}' | tail -1; }

if [ "${1:-}" = "--retire-github-mirror" ]; then
  S=$(secrets_file)
  [ -f "$S" ] || { echo "no secrets file found for overlyx.service" >&2; exit 1; }
  grep -q '"ok":true' /var/lib/overlyx-backup-offsite/backup.json 2>/dev/null || { echo "the off-site backup has not succeeded yet (/var/lib/overlyx-backup-offsite/backup.json) — not retiring the mirror" >&2; exit 1; }
  grep -q '"ok":true' /var/lib/overlyx-backup-offsite/check.json 2>/dev/null || { echo "the restore check has not succeeded yet (/var/lib/overlyx-backup-offsite/check.json) — not retiring the mirror" >&2; exit 1; }
  cp -p "$S" "$S.before-mirror-retired-$(date -u +%Y%m%d)"
  sed -i -E 's/^(GITHUB_MIRROR_(ORG|TOKEN)=)/# retired for the off-site backup: \1/' "$S"
  systemctl restart overlyx
  echo "the GitHub mirror is off (the old $S is kept beside it). The organisation's repositories stay on GitHub until you delete them."
  exit 0
fi

step "1. restic and the MinIO client"
command -v restic >/dev/null || { apt-get update -q && apt-get install -y -q restic; }
restic version
if ! [ -x /usr/local/bin/mc ] || [ "$(sha256sum /usr/local/bin/mc | cut -d' ' -f1)" != "$MC_SHA256" ]; then
  curl -fsSL -o /usr/local/bin/mc.tmp "$MC_URL"
  echo "$MC_SHA256  /usr/local/bin/mc.tmp" | sha256sum -c - >/dev/null || { rm -f /usr/local/bin/mc.tmp; echo "mc: checksum mismatch — not installed" >&2; exit 1; }
  chmod 755 /usr/local/bin/mc.tmp && mv /usr/local/bin/mc.tmp /usr/local/bin/mc
fi
mc --version | head -1

step "2. $ENVF"
install -d -m 700 "$ETC"
# what is there already wins (a second run asks for nothing)
[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
BUCKET=${OVERLYX_BACKUP_BUCKET:-${BUCKET:-}}
LOCATION=${OVERLYX_BACKUP_LOCATION:-${AWS_DEFAULT_REGION:-hel1}}
LOCK_DAYS=${OVERLYX_BACKUP_LOCK_DAYS:-30}
[ -n "$BUCKET" ] || BUCKET="overlyx-backup-$(openssl rand -hex 3)"
case "$LOCATION" in fsn1|nbg1|hel1) ;; *) echo "OVERLYX_BACKUP_LOCATION must be fsn1, nbg1 or hel1" >&2; exit 1 ;; esac
[ -n "${AWS_ACCESS_KEY_ID:-}" ] || read -rp "S3 access key (Hetzner Console ▸ Object Storage ▸ credentials): " AWS_ACCESS_KEY_ID
[ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || { read -rsp "S3 secret key: " AWS_SECRET_ACCESS_KEY; echo; }
ENDPOINT=https://$LOCATION.your-objectstorage.com
DATA=$(unit_env OVERLYX_DATA_DIR); DATA=${DATA:-/root/lyx/overlyx/data}
PROJECTS=$(unit_env OVERLYX_PROJECTS_DIR); PROJECTS=${PROJECTS:-/root/projects}
SECRETS=$(secrets_file)
umask 077
cat > "$ENVF.tmp" <<EOF
# OverLyX off-site backup (deploy/setup-backup-offsite.sh) — root only. Restoring by hand:
#   set -a; . $ENVF; set +a; restic snapshots
BUCKET=$BUCKET
RESTIC_REPOSITORY=s3:$ENDPOINT/$BUCKET
RESTIC_PASSWORD_FILE=$PWF
RESTIC_CACHE_DIR=/var/cache/restic-overlyx
AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY
AWS_DEFAULT_REGION=$LOCATION
OVERLYX_DATA_DIR=$DATA
OVERLYX_PROJECTS_DIR=$PROJECTS
OVERLYX_SECRETS_FILE=$SECRETS
EOF
mv "$ENVF.tmp" "$ENVF"
echo "written (bucket $BUCKET in $LOCATION; data $DATA, projects $PROJECTS, secrets $SECRETS)"

step "3. the repository password"
if [ ! -s "$PWF" ]; then
  openssl rand -base64 33 | tr -d '\n' > "$PWF"; chmod 600 "$PWF"
  printf '\n\033[1;31mThe backup password — store it now, offline (password manager + paper). Without it nobody can read the backups:\033[0m\n\n    %s\n\n' "$(cat "$PWF")"
  read -rp "Press Enter once it is stored … " _
else echo "kept: $PWF"; fi
umask 022

step "4. the bucket, locked"
export MC_CONFIG_DIR=$ETC/mc
mc alias set overlyx-backup "$ENDPOINT" "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" --api S3v4 >/dev/null
chmod -R go-rwx "$MC_CONFIG_DIR"
if mc stat overlyx-backup/"$BUCKET" >/dev/null 2>&1; then echo "bucket $BUCKET exists"
else mc mb --with-lock --region "$LOCATION" overlyx-backup/"$BUCKET"; sleep 20; fi   # (bucket settings take a moment)
# (refused for a bucket made without Object Lock: then choose another OVERLYX_BACKUP_BUCKET — this script makes it with one)
mc retention set --default compliance "${LOCK_DAYS}d" overlyx-backup/"$BUCKET" || {
  echo "bucket $BUCKET takes no default retention — it was made without Object Lock. Run again with another OVERLYX_BACKUP_BUCKET." >&2; exit 1; }
mc version info overlyx-backup/"$BUCKET"
if ! mc ilm rule ls overlyx-backup/"$BUCKET" 2>/dev/null | grep -qi "noncurrent\|expire"; then
  mc ilm rule add --noncurrent-expire-days "$((LOCK_DAYS + 1))" overlyx-backup/"$BUCKET"
  mc ilm rule add --expire-delete-marker overlyx-backup/"$BUCKET"
fi
mc retention info --default overlyx-backup/"$BUCKET"
mc ilm rule ls overlyx-backup/"$BUCKET" || true

step "5. the restic repository"
set -a; . "$ENVF"; set +a
install -d -m 700 /var/cache/restic-overlyx
if restic cat config >/dev/null 2>&1; then echo "the repository exists"; else restic init; fi

step "6. timers, telemetry"
for u in overlyx-backup-offsite.service overlyx-backup-offsite.timer overlyx-backup-check.service overlyx-backup-check.timer; do
  install -m 644 "$PROD/deploy/$u" /etc/systemd/system/$u
done
install -m 755 "$PROD/deploy/overlyx-telemetry" /usr/local/sbin/overlyx-telemetry
systemctl daemon-reload
systemctl enable --now overlyx-backup-offsite.timer overlyx-backup-check.timer
systemctl list-timers 'overlyx-backup*' --no-pager | head -6

step "7. the first backup and the restore check (this takes a while the first time)"
systemctl start overlyx-backup-offsite.service || { journalctl -u overlyx-backup-offsite -n 30 --no-pager; exit 1; }
cat /var/lib/overlyx-backup-offsite/backup.json
systemctl start overlyx-backup-check.service || { journalctl -u overlyx-backup-check -n 30 --no-pager; exit 1; }
cat /var/lib/overlyx-backup-offsite/check.json
echo
echo "Done. Nightly backups to $BUCKET ($LOCATION), a restore check every week."
echo "When you are satisfied: bash $PROD/deploy/setup-backup-offsite.sh --retire-github-mirror"
