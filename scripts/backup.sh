#!/bin/bash
# Nightly backup of an OverLyX instance: the SQLite database (online backup, consistent) and the
# projects directory (without build products) into <data dir>/backups/<timestamp>/; keeps the
# newest $KEEP backups. Installed by deploy/overlyx-backup.timer.
#
#   OVERLYX_DATA_DIR=/root/lyx/overlyx/data OVERLYX_PROJECTS_DIR=/root/projects scripts/backup.sh
set -euo pipefail
DATA=${OVERLYX_DATA_DIR:-/root/lyx/overlyx/data}
PROJECTS=${OVERLYX_PROJECTS_DIR:-/root/projects}
DEST=${OVERLYX_BACKUP_DIR:-$DATA/backups}
KEEP=${OVERLYX_BACKUP_KEEP:-14}
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
out="$DEST/$stamp"
mkdir -p "$out"
sqlite3 "$DATA/overlyx.sqlite" ".backup '$out/overlyx.sqlite'"
cp -p "$DATA/secret.key" "$out/" 2>/dev/null || true
# the instance secrets (deploy/secrets.env, git-ignored) exist nowhere else
cp -p "$(dirname "$0")/../deploy/secrets.env" "$out/" 2>/dev/null || true
tar --create --gzip --file "$out/projects.tar.gz" -C "$(dirname "$PROJECTS")" \
  --exclude='_build' --exclude='svg-inkscape' --exclude='*.overlyx-tmp' \
  --exclude='*.aux' --exclude='*.log' --exclude='*.fls' --exclude='*.fdb_latexmk' --exclude='*.synctex.gz' \
  "$(basename "$PROJECTS")"
echo "backup written to $out ($(du -sh "$out" | cut -f1))"
# rotation: keep the newest $KEEP
ls -1d "$DEST"/*/ 2>/dev/null | sort | head -n -"$KEEP" | while read -r old; do rm -rf "$old"; echo "removed $old"; done
